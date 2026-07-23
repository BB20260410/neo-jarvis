// @ts-check
// NoeVectorOrphanCleanup — 向量索引孤儿 / 废维清理（P8）。
//
// 背景：embeddings(kind='noe_memory') 与 noe_memory 行一一对应（UNIQUE(kind,ref_id)）。但 merge/hide
// 等路径历史上漏删向量（见 MemoryCore.merge 注释「~465 条 merged_into 孤儿，占向量 top-K 一半名额」），
// 加上 provider 切换留下的低维（hash-128 vs ollama-1024）废维向量——这些向量永远指向看不见的行 /
// 永远不被同维查询命中，却白占 semanticSearch 的候选池，把真 insight 挤出召回。
//
// 本模块只做两件纯事：① 识别孤儿（ref_id 指向 hidden=1 的 noe_memory 行）② 识别废维（dim 不等于库内
// 主导维度）。识别只读、可独立单测；删除复用 embeddings/VectorIndex 的 deleteEmbedding（按 kind+ref_id），
// 删的是 hidden 行的向量与废维向量，绝不动 visible 行的当维向量（visible 召回零回归）。
//
// 设计：纯函数 + 注入 db / deleteFn（DI），默认 dry-run（不删，只报）。CLI 在 scripts/noe-vector-orphan-cleanup.mjs。
// 可逆性：删的全是「指向 hidden 行」或「废维」的向量。hidden 行 unhide 时 MemoryCore.unhide 会重建当维
// 向量（见其注释「复活记忆时重建向量索引」）；废维向量本就该由 backfill 以正确维度重嵌。故删除不丢任何
// 可恢复信息——被删向量要么随行复活重建、要么由 backfill 重嵌。

const DEFAULT_KIND = 'noe_memory';

/**
 * 统计某 kind 下 embeddings 的维度分布，返回主导维度（出现最多的 dim）。
 * 用于自适应判定「废维」：不写死 1024，避免 provider 升级后阈值过时。
 * 平票时取计数最大里的最大 dim（高维通常是当前 provider 的主体维度，更稳）。
 * @param {Array<{dim:number,c:number}>} dimRows GROUP BY dim 的结果 [{dim,c}]
 * @returns {number|null} 主导维度；空表返回 null
 */
export function dominantDim(dimRows = []) {
  const rows = (Array.isArray(dimRows) ? dimRows : [])
    .map((r) => ({ dim: Number(r.dim), c: Number(r.c) || 0 }))
    .filter((r) => Number.isFinite(r.dim) && r.dim > 0 && r.c > 0);
  if (!rows.length) return null;
  let best = rows[0];
  for (const r of rows) {
    if (r.c > best.c || (r.c === best.c && r.dim > best.dim)) best = r;
  }
  return best.dim;
}

/**
 * 判定一条向量记录是否为「孤儿」（其 ref_id 指向 hidden=1 的 noe_memory 行，或该行已不存在）。
 * 纯函数，便于单测。hiddenRefIds / missingRefIds 由调用方（或 SQL）预先备好。
 * @param {string} refId 向量的 ref_id
 * @param {Set<string>} hiddenRefSet hidden=1 行的 id 集合
 * @returns {boolean}
 */
export function isOrphanVector(refId, hiddenRefSet) {
  if (refId == null) return false;
  return hiddenRefSet instanceof Set && hiddenRefSet.has(String(refId));
}

/**
 * 判定一条向量是否为「废维」（dim 与主导维度不符）。expectedDim 为 null（无法判定主导维度）时一律不判废维，
 * 宁可漏删不可误删。
 * @param {number} dim 该向量维度
 * @param {number|null} expectedDim 主导维度
 * @returns {boolean}
 */
export function isDeadDimVector(dim, expectedDim) {
  if (expectedDim == null) return false;
  const d = Number(dim);
  if (!Number.isFinite(d)) return true; // 维度缺失/非法本身就是废维
  return d !== Number(expectedDim);
}

/**
 * 只读扫描：找出某 kind 下所有待清理向量（孤儿 ∪ 废维），并给出可验证的分母拆解。
 * 不修改任何状态。dim 用 SQL GROUP BY 取分布；孤儿/废维候选用单条 JOIN/子查询 SQL 取，避免全表 BLOB 解码。
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db better-sqlite3 句柄（DI；CLI 传副本库句柄，绝不碰 live）
 * @param {string} [args.kind] embeddings.kind，默认 'noe_memory'
 * @param {number|null} [args.expectedDim] 显式指定的「当维」；不传则按主导维度自适应
 * @returns {{
 *   kind:string, expectedDim:number|null, dimDistribution:Array<{dim:number,c:number}>,
 *   total:number, orphanRefIds:string[], deadDimRefIds:string[], deleteRefIds:string[],
 *   counts:{ total:number, orphan:number, dead_dim:number, overlap:number, to_delete:number,
 *            dead_dim_pointing_visible:number, keep:number }
 * }}
 */
export function scanVectorOrphans({ db, kind = DEFAULT_KIND, expectedDim } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('db required');
  const k = String(kind);

  const dimRows = db.prepare(
    'SELECT dim, COUNT(*) AS c FROM embeddings WHERE kind = ? GROUP BY dim'
  ).all(k).map((r) => ({ dim: Number(r.dim), c: Number(r.c) }));

  const total = dimRows.reduce((s, r) => s + r.c, 0);
  // P8-fix(三方审一致,数据安全):多维分布下 auto dominantDim 会在 provider 迁移期翻转、误删 visible 当维向量。
  //   显式 expectedDim → 锁维清废维;未指定时仅单维分布才自适应(无歧义);多维则 expDim=null=跳过废维(只清孤儿),
  //   需显式 --expected-dim 才清废维。孤儿清理不依赖 expDim,任何分布都安全执行。
  let expDim;
  let expectedDimSource;
  if (expectedDim != null) {
    expDim = Number(expectedDim);
    expectedDimSource = 'explicit';
  } else if (dimRows.length <= 1) {
    expDim = dominantDim(dimRows);
    expectedDimSource = 'auto-single';
  } else {
    expDim = null; // 多维 + 未指定:不自动判废维(防 dominantDim 多数票翻转误删 visible 当维),只清孤儿
    expectedDimSource = 'skipped-multidim';
  }

  // 孤儿：ref_id 指向 hidden=1 的 noe_memory 行（NOT IN 子查询语义已含「行不存在」——
  //   但实测真悬空=0，且 NOT EXISTS 行不存在更稳妥，这里专取「行存在且 hidden=1」，
  //   与可逆性论证一致：hidden 行 unhide 会重建向量）。
  // P8-fix(Codex):孤儿 = 指向 hidden 行 OR 指向已不存在行（NOT EXISTS 兑现注释承诺的 missing row；当前 missing=0，防御）。
  const orphanRefIds = db.prepare(`
    SELECT e.ref_id AS refId FROM embeddings e
    WHERE e.kind = ?
      AND (EXISTS (SELECT 1 FROM noe_memory m WHERE m.id = e.ref_id AND m.hidden = 1)
           OR NOT EXISTS (SELECT 1 FROM noe_memory m WHERE m.id = e.ref_id))
  `).all(k).map((r) => String(r.refId));

  // 废维：dim != 主导维度（含 dim 为 NULL）。expectedDim=null 时跳过废维识别。
  let deadDimRefIds = [];
  let deadDimPointingVisible = 0;
  if (expDim != null) {
    deadDimRefIds = db.prepare(
      'SELECT ref_id AS refId FROM embeddings WHERE kind = ? AND (dim IS NULL OR dim != ?)'
    ).all(k, expDim).map((r) => String(r.refId));
    // 废维里有多少指向 visible 行（删它们会移除 visible 行的向量——但那是个永不命中的废维向量，
    //   删后由 backfill 以当维重嵌，仍属可逆；单列出来供报告透明）。
    deadDimPointingVisible = db.prepare(`
      SELECT COUNT(*) AS c FROM embeddings e
      WHERE e.kind = ? AND (e.dim IS NULL OR e.dim != ?)
        AND e.ref_id IN (SELECT id FROM noe_memory WHERE hidden = 0)
    `).get(k, expDim).c;
  }

  const orphanSet = new Set(orphanRefIds);
  const deadSet = new Set(deadDimRefIds);
  const deleteSet = new Set([...orphanRefIds, ...deadDimRefIds]);
  let overlap = 0;
  for (const id of orphanSet) if (deadSet.has(id)) overlap += 1;

  return {
    kind: k,
    expectedDim: expDim,
    expectedDimSource,
    dimDistribution: dimRows,
    total,
    orphanRefIds,
    deadDimRefIds,
    deleteRefIds: [...deleteSet],
    counts: {
      total,
      orphan: orphanSet.size,
      dead_dim: deadSet.size,
      overlap,
      to_delete: deleteSet.size,
      dead_dim_pointing_visible: deadDimPointingVisible,
      keep: total - deleteSet.size,
    },
  };
}

/**
 * 执行清理。默认 apply=false（dry-run，只返回扫描结果不删）。apply=true 时对 deleteRefIds 逐条
 * 调用 deleteFn（默认 embeddings/VectorIndex.deleteEmbedding，按 kind+refId 删），统计实删行数。
 *
 * deleteFn 注入便于单测（不触真 VectorIndex 单例）。CLI 必须先 initSqlite(副本路径) 再调，保证
 * deleteEmbedding 的内部 getDb() 命中副本而非 live（见 SqliteStore.initSqlite 切库语义）。
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db better-sqlite3 句柄（DI；只读扫描用）
 * @param {string} [args.kind]
 * @param {boolean} [args.apply] 默认 false=dry-run
 * @param {number|null} [args.expectedDim]
 * @param {(arg:{kind:string,refId:string})=>number} [args.deleteFn] 删除单条，返回 changes
 * @returns {{ scan:ReturnType<typeof scanVectorOrphans>, applied:boolean, deleted:number, attempted:number }}
 */
export function cleanupVectorOrphans({ db, kind = DEFAULT_KIND, apply = false, expectedDim, deleteFn } = {}) {
  const scan = scanVectorOrphans({ db, kind, expectedDim });
  if (!apply) return { scan, applied: false, deleted: 0, attempted: 0 };
  if (typeof deleteFn !== 'function') throw new Error('deleteFn required when apply=true');
  let deleted = 0;
  let attempted = 0;
  for (const refId of scan.deleteRefIds) {
    attempted += 1;
    try { deleted += Number(deleteFn({ kind: scan.kind, refId })) || 0; }
    catch { /* 单条删除失败不阻断其余（孤儿清理幂等，下轮可补） */ }
  }
  return { scan, applied: true, deleted, attempted };
}
