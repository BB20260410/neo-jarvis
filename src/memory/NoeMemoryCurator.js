// NoeMemoryCurator — 记忆库 GC：把过期 / 久未命中的低价值记忆挑出来交调用方处理。
//
// 与 NoeFusionRanker 同域，互补：FusionRanker 管「召回什么」，Curator 管「遗忘什么」——
// 记忆库只进不出会被低价值噪声淹没，拉低召回信噪比。
//
// 保护铁律：salience>=5（身份级，见 MemoryCore.js 注释「5=身份级受保护」）与 pinned 永不入 GC；
// 已 hidden 的不重复处理。纯逻辑 + 注入 now、不碰 db、不直接删——只产出「GC 计划」，
// 实际 hide/demote/delete 由波次6 接线时执行（默认建议 hide，保守可逆）。
//
// 2026-06-10 经 M3 对抗式审查后强化：布尔字段兼容原始 row 的 1/0/'true'（不只 ===true）；
// now 在 planMemoryGc 入口一次性计算避免逐条漂移；parseTs 类型守卫防布尔被当 1ms epoch；
// counts 命名与 buckets 统一 snake_case；minHitCount→maxHitCount 名实相符。

const DAY_MS = 86400000;

/** 布尔真值判定：兼容 bool / 1 / '1' / 'true'（原始 DB row 常存 INTEGER 1/0 或字符串）。 */
function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** 容错时间解析：仅接受 number(ms,>0) / 数值字符串 / Date；布尔等非法类型 → null（防 Number(true)===1 被当 1ms epoch）。 */
function parseTs(v) {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string') { const p = Date.parse(v); return Number.isFinite(p) ? p : null; }
  return null;
}

/**
 * 对单条记忆判定 GC 归类。字段兼容 camelCase（MemoryCore 对外）与 snake_case（原始 row），
 * 布尔字段兼容 true/1/'1'/'true'。
 * @param {object} entry {id, salience, hitCount, expiresAt, expired, confidence, updatedAt, hidden, pinned}
 * @param {object} [opts]
 * @param {number} [opts.now] 当前时间（ms，须与 updatedAt 同单位；默认 Date.now）
 * @param {number} [opts.staleMs] 久未更新阈值（默认 90 天，>= 触发，与 expired 的 <= 对齐）
 * @param {number} [opts.lowSalience] 低显著上限（默认 2，含）
 * @param {number} [opts.maxHitCount] 命中数上限（默认 0，含；<= 此值才算低命中）
 * @param {number} [opts.minConfidence] 低置信阈值（默认 0.3，< 则计）
 * @returns {'protected'|'expired'|'stale'|'low_confidence'|'keep'}
 */
export function classifyMemory(entry = {}, { now = Date.now(), staleMs = 90 * DAY_MS, lowSalience = 2, maxHitCount = 0, minConfidence = 0.3 } = {}) {
  const salience = Number(entry.salience) || 0;
  if (salience >= 5 || isTruthy(entry.pinned ?? entry.is_pinned)) return 'protected';   // 铁律：身份级 / 置顶永不 GC
  if (isTruthy(entry.hidden ?? entry.is_hidden)) return 'keep';                          // 已隐藏，不重复处理
  const expiresAt = parseTs(entry.expiresAt ?? entry.expires_at);
  if (isTruthy(entry.expired) || (expiresAt != null && expiresAt <= now)) return 'expired';
  const hitCount = Number(entry.hitCount ?? entry.hit_count) || 0;
  const updatedAt = parseTs(entry.updatedAt ?? entry.updated_at);
  // 缺失 → NaN（跳过 low_confidence）；不把"字段缺失"等同于"显式 0"
  const confidence = typeof entry.confidence === 'number' ? entry.confidence : NaN;
  // 久未更新 + 低显著 + 低命中 → stale
  if (updatedAt != null && (now - updatedAt) >= staleMs && salience <= lowSalience && hitCount <= maxHitCount) return 'stale';
  // 低置信 + 从未命中 + 低显著 → low_confidence
  if (Number.isFinite(confidence) && confidence < minConfidence && hitCount === 0 && salience <= lowSalience) return 'low_confidence';
  return 'keep';
}

/**
 * 规划记忆库 GC：分桶 + GC 候选 id 清单（已去重）。不修改任何状态。
 * now 在入口一次性计算并透传，保证同批所有条目用同一时刻判定（避免逐条 Date.now 漂移）。
 * @param {Array} entries 记忆条目数组
 * @param {object} [opts] 透传 classifyMemory（now 缺省/非法时入口兜为 Date.now）
 * @returns {{buckets:object, gcCandidates:string[], counts:object}}
 *   counts: { total(输入总数,含跳过), classified, protected, expired, stale, low_confidence, keep, gc_candidates, skipped }
 */
export function planMemoryGc(entries = [], opts = {}) {
  const now = (typeof opts.now === 'number' && Number.isFinite(opts.now) && opts.now > 0) ? opts.now : Date.now();
  const o = { ...opts, now };
  const buckets = { protected: [], expired: [], stale: [], low_confidence: [], keep: [] };
  const list = Array.isArray(entries) ? entries : [];
  let skipped = 0;
  for (const e of list) {
    if (!e || e.id == null || e.id === '') { skipped += 1; continue; }   // 无效 id 跳过并计数（不静默吞）
    buckets[classifyMemory(e, o)].push(e.id);
  }
  const gcCandidates = [...new Set([...buckets.expired, ...buckets.stale, ...buckets.low_confidence])];  // 去重
  const classified = gcCandidates.length + buckets.protected.length + buckets.keep.length;
  return {
    buckets,
    gcCandidates,
    counts: {
      total: list.length,             // 输入总数（含被跳过的），与 entries.length 一致，不误导
      classified,                     // 实际分类数（= total - skipped，去重后）
      protected: buckets.protected.length,
      expired: buckets.expired.length,
      stale: buckets.stale.length,
      low_confidence: buckets.low_confidence.length,
      keep: buckets.keep.length,
      gc_candidates: gcCandidates.length,
      skipped,
    },
  };
}
