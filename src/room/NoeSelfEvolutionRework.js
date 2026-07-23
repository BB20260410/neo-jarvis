// @ts-check
// Step 3 返工闭环的纯函数 helper（从 NoeSelfEvolutionTrigger 抽出：降文件行数 + 独立可测）。
//   信号判定全走 normalizeConsensusDecision（与 gate 同一真相源，兼容本地模型输出的 Request_Changes/request-changes/REJECTED 变体）；
//   blocker 脱敏 = redactSensitiveText（具名 secret）+ URL query token（?token=… 等，redactSensitiveText 不覆盖 query 形）。
// 无副作用、无闭包依赖——副作用部分（applyReworkAdvance 写 cycleStore）仍留在 trigger（依赖注入的 store/now）。

import { normalizeConsensusDecision } from './NoeConsensusGate.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const decisionOf = (r) => normalizeConsensusDecision(r && r.decision);

/** 实时复核要求返工（任一 request_changes 且无 reject）。reject 优先走学习路径，不返工。 */
export function completionRequestsChanges(completion) {
  if (!completion || completion.ok !== false || completion.reason !== 'post_review_not_approved') return false;
  const reviews = Array.isArray(completion.reviews) ? completion.reviews : [];
  return reviews.some((r) => decisionOf(r) === 'request_changes') && !reviews.some((r) => decisionOf(r) === 'reject');
}

/** 返工超限：返工开启 + 上限>0 + request_changes（无 reject）+ 已达上限 → 转 terminal 学习+释放。 */
export function isReworkExhausted(completion, { reworkEnabled, reworkRounds, maxReworkRounds } = {}) {
  if (reworkEnabled !== true || !(maxReworkRounds > 0)) return false;
  if (!completion || completion.ok !== false || completion.reason !== 'post_review_not_approved') return false;
  const reviews = Array.isArray(completion.reviews) ? completion.reviews : [];
  const hasRequestChanges = reviews.some((r) => decisionOf(r) === 'request_changes');
  const hasReject = reviews.some((r) => decisionOf(r) === 'reject');
  return hasRequestChanges && !hasReject && Number(reworkRounds || 0) >= Number(maxReworkRounds || 0);
}

/** 返工 blocker 来源合并：completion.errors（整体问题）+ 每个 request_changes review 的 evidence_gaps/blockers（要改点）。 */
export function collectCompletionBlockers(completion) {
  const out = [...(Array.isArray(completion && completion.errors) ? completion.errors : [])];
  const reviews = Array.isArray(completion && completion.reviews) ? completion.reviews : [];
  for (const r of reviews) {
    if (!r || decisionOf(r) !== 'request_changes') continue;
    if (Array.isArray(r.evidence_gaps)) out.push(...r.evidence_gaps);
    if (Array.isArray(r.blockers)) out.push(...r.blockers);
  }
  return out;
}

/** blocker 脱敏：redactSensitiveText 抹具名 secret，再额外抹 URL query 里的 token/key（query 形 redactSensitiveText 不覆盖），截断 200。 */
export function scrubReworkBlocker(value) {
  return redactSensitiveText(String(value || ''))
    .replace(/([?&](?:access_?token|refresh_?token|api[_-]?key|token|key|secret|session|sig|signature|password|auth)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, 200);
}
