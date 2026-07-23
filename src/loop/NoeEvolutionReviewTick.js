// @ts-check
// NoeEvolutionReviewTick — Step1 自我复盘心跳(让循环随时间自转)。
//
// 「每天都比昨天更强」只有可测才有意义。此 tick 由 Neo 持久心跳低频(默认每天)驱动:读 panel.db 的
//   evolution_outcome/goals/lessons → 建一份仪表盘快照 → append 到 history.jsonl。时间序列自动累积,
//   自我复盘(scripts/noe-evolution-review.mjs)据此算「真进步率随时间是升是降」。
// 全 DI(query*/appendSnapshot/now 注入),纯逻辑可测;全程 fail-open——复盘失败绝不阻断心跳/飞轮。

import { buildEvolutionDashboard } from './NoeEvolutionDashboard.js';

/**
 * @param {object} deps
 * @param {() => Array<{verdict?:string,applied?:number|boolean,reason?:string}>} deps.queryOutcomes evolution_outcome 行
 * @param {() => Array<{signal?:string,status?:string}>} deps.queryGoals self_evolution goals
 * @param {() => number} deps.queryLessonCount 失败/reject 教训条数
 * @param {(snapshot:object) => void} deps.appendSnapshot 落一份快照(append jsonl)
 * @param {() => number} [deps.now] ms
 */
export function createEvolutionReviewTick({ queryOutcomes, queryGoals, queryLessonCount, appendSnapshot, now = () => Date.now() } = {}) {
  return function runOnce() {
    let outcomes;
    let goals;
    let lessonCount;
    try {
      outcomes = typeof queryOutcomes === 'function' ? (queryOutcomes() || []) : [];
      goals = typeof queryGoals === 'function' ? (queryGoals() || []) : [];
      lessonCount = typeof queryLessonCount === 'function' ? (Number(queryLessonCount()) || 0) : 0;
    } catch (e) {
      return { ok: false, skipped: 'query_failed', error: (e && e.message) || String(e) };
    }
    const snap = buildEvolutionDashboard({ outcomes, goals, lessonCount, at: new Date(now()).toISOString() });
    try {
      if (typeof appendSnapshot === 'function') appendSnapshot(snap);
    } catch { /* fail-open：快照落盘失败不阻断心跳 */ }
    return { ok: true, realProgressRate: snap.outcomes.realProgressRate, total: snap.outcomes.total };
  };
}
