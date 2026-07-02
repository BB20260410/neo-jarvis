// @ts-check
// NoeMemoryIntegrityCheck（P3-5）——记忆层一致性自检：检测「合并目标悬挂引用」。
//
// 背景：记忆合并时被替换的旧条记 merged_into:<targetId>（hidden_reason 或列）指向合入的目标条。若 target
// 后续被删/不存在 → 悬挂引用（指向已消失的目标，溯源断链）。MemoryCore 写 merged_into 时不校验 target 存在、
// 后续也无扫描器。本模块补一个**纯只读**自检：扫所有条目，验证其 merge 目标仍在库内，列出悬挂项。
// 纯函数（checkDanglingMergeRefs 接 rows，可单测）+ 薄 DB runner（只读 SELECT，零写、零风险）。

// 从一条记录解析它的合并目标 id（mergedInto 列优先；否则从 hidden_reason 'merged_into:X' 解析）。
function mergeTargetOf(row = {}) {
  const direct = row.mergedInto ?? row.merged_into;
  if (direct) return String(direct).trim();
  const reason = String(row.hiddenReason ?? row.hidden_reason ?? '');
  const m = reason.match(/merged_into:\s*([\w-]+)/i);
  return m ? m[1] : '';
}

/**
 * 纯检测：给定全部记录行，找出 merge 目标指向不存在 id 的悬挂引用。
 * @param {Array<{id:string, mergedInto?:string, merged_into?:string, hiddenReason?:string, hidden_reason?:string}>} rows
 * @returns {{ok:boolean, scanned:number, danglingCount:number, dangling:Array<{id:string, missingTarget:string}>}}
 */
export function checkDanglingMergeRefs(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = new Set(list.map((r) => String(r && r.id)).filter(Boolean));
  const dangling = [];
  for (const row of list) {
    if (!row || !row.id) continue;
    const target = mergeTargetOf(row);
    if (target && !ids.has(target)) dangling.push({ id: String(row.id), missingTarget: target });
  }
  return { ok: dangling.length === 0, scanned: list.length, danglingCount: dangling.length, dangling: dangling.slice(0, 200) };
}

/**
 * DB runner（只读）：查 noe_memory 全表的 id/merged_into/hidden_reason，跑悬挂自检。
 * @param {{ db: { prepare: Function }, projectId?: string }} deps
 */
export function runDanglingMergeRefCheck({ db, projectId = null } = {}) {
  if (!db || typeof db.prepare !== 'function') return { ok: false, reason: 'no_db', scanned: 0, danglingCount: 0, dangling: [] };
  try {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    // 只读窄列；merged_into 可能是列也可能编码在 hidden_reason，两者都取（容缺列）。
    let rows;
    try {
      rows = db.prepare(`SELECT id, merged_into, hidden_reason FROM noe_memory ${where}`).all(...args);
    } catch {
      // 容某些 schema 无 merged_into 列：退而只取 hidden_reason。
      rows = db.prepare(`SELECT id, hidden_reason FROM noe_memory ${where}`).all(...args);
    }
    return checkDanglingMergeRefs(rows);
  } catch (e) {
    return { ok: false, reason: 'query_failed', error: String(e?.message || e).slice(0, 160), scanned: 0, danglingCount: 0, dangling: [] };
  }
}
