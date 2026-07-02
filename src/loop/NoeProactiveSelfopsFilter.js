// @ts-check
// #16 子改动2：proactive innerBrief 选「刚完成可回报」goal——过滤 system_repair/self_learning/self_evolution（Neo 内部
//   自动循环的"完成"，不该当陪伴素材主动播报自我表扬，否则 self_learning 刷量→反复自夸刷存在感；self_evolution 同属内部自进化，多模型审 P2-1）。
//   保留 owner（主人交办该回报）+ 其他真陪伴/探索源（surprise 等）。flag 由调用方传 filterSelfops，默认 OFF=零回归。

const SELFOPS_SOURCES = new Set(['system_repair', 'self_learning', 'self_evolution']);

/**
 * 从最近完成的 goal 列表里选第一个「可口头回报」的：未报告过 + maxAgeMs 内 + （filterSelfops 时）非 selfops 源。
 * @param {Array<{id?:string, source?:string, updated_at?:number}>} doneGoals
 * @param {{lastReportedId?:string, now?:()=>number, filterSelfops?:boolean, maxAgeMs?:number}} [opts]
 * @returns {object|null}
 */
export function selectFreshReportableGoal(doneGoals, { lastReportedId = '', now = () => Date.now(), filterSelfops = false, maxAgeMs = 24 * 3600_000 } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now) || Date.now();
  const list = Array.isArray(doneGoals) ? doneGoals : [];
  return list.find((g) => g
    && g.id !== lastReportedId
    && nowMs - (g.updated_at || 0) < maxAgeMs
    && !(filterSelfops && g.source && SELFOPS_SOURCES.has(g.source))) || null;
}
