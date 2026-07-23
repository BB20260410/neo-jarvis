// @ts-check
// 共享的「实施后复核」(post-review) 校验逻辑。
// 目的：让 NoeSelfEvolutionCycle（cycle 层）与 NoeSelfEvolutionGate（complete 动作）
// 用同一套规则判定 complete 是否可放行，杜绝 Gate 只凭 {ok:true, approvals>=1}
// 就放行、绕过动态 quorum / 真实非实施者 reviewer / rawOutputRef 的授权漏洞。
import { existsSync } from 'node:fs';
import {
  NOE_REQUIRED_CONSENSUS_MODELS,
  normalizeConsensusDecision,
  normalizeConsensusModelId,
  quorumThresholdForAvailableModels,
} from './NoeConsensusGate.js';
import { resolveNoeConsensusRef } from './NoeConsensusLedger.js';

const APPROVAL_DECISIONS = new Set(['approve', 'approve_with_changes']);
// request_changes 是 reviewer prompt 允许的裁决（见 NoeCompletionPostReview）：认作已知（不报 unknown_decision），
// 但**不**加入 APPROVAL_DECISIONS——它既不放行 complete，也由 Step3 返工分支接管，不会卡死占坑。
const KNOWN_REVIEW_DECISIONS = new Set(['approve', 'approve_with_changes', 'request_changes', 'reject', 'abstain', 'unavailable']);
// P0 判据②：硬证据缺口模式——reviewer 明列这类 gap 时，approve_with_changes 不算 clean approve（防"明说有问题仍盖章"）。
const HARD_GAP_RE = /tests?\s+array\s+is\s+empty|no\s+(actual\s+)?(diff|test\b)|no\s+test\s+added|empty\b[^.]*\bsummary|summary\b[^.]*\bempty|critical\s+risk[^.]*(no\s+audit|without\s+audit)|无(新增)?测试|无\s*diff|无审计/i;
function hasUnresolvedHardGap(review) {
  const gaps = [
    ...(Array.isArray(review?.evidence_gaps) ? review.evidence_gaps : []),
    ...(Array.isArray(review?.verification_required) ? review.verification_required : []),
    ...(Array.isArray(review?.blockers) ? review.blockers : []), // finding5（#17 评估发现）：reviewer schema 有 blockers 字段，硬 gap 可能写这里，须一并扫，否则 approve_with_changes+blockers:["Tests empty"] 绕过 gap 闸
  ];
  return gaps.some((g) => {
    const s = String(g);
    if (!HARD_GAP_RE.test(s)) return false;
    // 总验收多模型审 P1：resolved 标记排除否定形——"not resolved"/"unresolved"/"未解决" 仍算未解决硬 gap（不被 "resolved" 子串误判为已解决而漏）。
    if (/\bnot\s+resolved\b|\bunresolved\b|未解决/i.test(s)) return true;
    return !/\bresolved\b|已解决|已补/i.test(s);
  });
}

function cleanString(value) {
  return String(value || '').trim();
}

function refValue(input = {}, ...keys) {
  for (const key of keys) {
    const value = cleanString(input[key]);
    if (value) return value;
  }
  return '';
}

function addMissing(errors, condition, id) {
  if (!condition) errors.push(id);
}

function checkRef(errors, root, ref, id, requireFile) {
  const text = cleanString(ref);
  if (!text) {
    errors.push(`${id}_required`);
    return;
  }
  try {
    const full = resolveNoeConsensusRef(root, text);
    if (requireFile && !existsSync(full)) errors.push(`missing_${id}:${text}`);
  } catch (e) {
    errors.push(`${id}_invalid:${e.message}`);
  }
}

/** 必需的非实施者 reviewer = 全部共识模型去掉当前 active executor。 */
export function requiredReviewerModels(activeExecutor = 'codex') {
  const executor = normalizeConsensusModelId(activeExecutor || 'codex');
  return NOE_REQUIRED_CONSENSUS_MODELS.filter((model) => model !== executor);
}

/** 按模型归集 reviews，排除 active executor 自己的复核（不能既实施又给自己背书）。 */
export function collectPostReviews(postReview = {}, activeExecutor = 'codex') {
  const reviews = Array.isArray(postReview.reviews) ? postReview.reviews : [];
  const byModel = new Map();
  const duplicates = [];
  const executor = normalizeConsensusModelId(activeExecutor || 'codex');
  for (const review of reviews) {
    const model = normalizeConsensusModelId(review?.model);
    const decision = normalizeConsensusDecision(review?.decision);
    if (!model || model === executor) continue;
    if (byModel.has(model)) duplicates.push(model);
    byModel.set(model, { ...review, model, decision });
  }
  return { byModel, duplicates };
}

export function normalizePostReviews(postReview = {}, activeExecutor = 'codex') {
  return collectPostReviews(postReview, activeExecutor).byModel;
}

export function nonImplementerApprovals(postReview = {}, activeExecutor = 'codex') {
  return [...normalizePostReviews(postReview, activeExecutor).values()]
    .filter((review) => APPROVAL_DECISIONS.has(review.decision));
}

/**
 * 校验 post-review 与 cycle 层对齐：
 * - postReview.ok 必须为 true
 * - 排除 active executor 后必须覆盖全部必需 reviewer
 * - reviewer 不可重复
 * - 可用 reviewer 上动态 quorum（少于 2 个可用直接 insufficient）
 * - 每个 reviewer 必须带 rawOutputRef（requireFile 时文件须存在）
 * - 非实施者 reviewer 不得 canWrite
 *
 * @param {string[]} errors 累积错误的数组（原地 push）
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {object} [opts.postReview]
 * @param {boolean} [opts.requireFile]
 * @param {string} [opts.activeExecutor]
 * @param {string} [opts.prefix] 错误串前缀（cycle 层用 'cycle_post_review'，gate 层用 'post_review'）
 */
export function validateNoePostReview(errors, opts = {}) {
  const root = opts.root || process.cwd();
  const postReview = opts.postReview || {};
  const requireFile = opts.requireFile === true;
  const activeExecutor = opts.activeExecutor || 'codex';
  const prefix = cleanString(opts.prefix) || 'post_review';

  addMissing(errors, postReview.ok === true, `${prefix}_required`);
  const reviewIndex = collectPostReviews(postReview, activeExecutor);
  const reviewsByModel = reviewIndex.byModel;
  for (const model of reviewIndex.duplicates) {
    errors.push(`${prefix}_duplicate_reviewer:${model}`);
  }
  // P0.2b：必需 reviewer 集可 override（self-evolution 用本地 clean-JSON reviewer 集；其余路径不传 → 回退
  //   requiredReviewerModels(cloud consensus)，零回归）。override 为非空数组才生效。
  const requiredReviewers = (Array.isArray(opts.requiredReviewers) && opts.requiredReviewers.length)
    ? [...new Set(opts.requiredReviewers.map(normalizeConsensusModelId).filter(Boolean))]
    : requiredReviewerModels(activeExecutor);
  for (const model of requiredReviewers) {
    if (!reviewsByModel.has(model)) errors.push(`${prefix}_missing_required_reviewer:${model}`);
  }
  const reviews = requiredReviewers.map((model) => reviewsByModel.get(model)).filter(Boolean);
  const available = reviews.filter((review) => review.decision !== 'unavailable');
  // P0 判据②（flag NOE_POSTREVIEW_GAP_BLOCK，默认 OFF）：reviewer 明列硬 gap 时不算 clean approve（无论 decision=approve 还是 approve_with_changes）
  //   ——堵"明列 evidence_gap/blockers(Tests array empty/no diff)仍被算通过盖章 complete"。总验收子代理审 P1：clean approve+硬 gap 同样矛盾，
  //   原只拦 approve_with_changes 致 decision=approve 变体绕过（REAL_APPLY 下真改代码盖章）；现对所有 approval decision 查 gap。OFF 逐字零回归。
  const gapBlock = opts.gapBlock ?? (process.env.NOE_POSTREVIEW_GAP_BLOCK === '1');
  const approvals = reviews.filter((review) => {
    if (!APPROVAL_DECISIONS.has(review.decision)) return false;
    if (gapBlock && hasUnresolvedHardGap(review)) return false; // :上一行已保证是 approval；硬 gap 则剔除（不限 approve_with_changes，子代理审 P1）
    return true;
  });
  const quorum = quorumThresholdForAvailableModels(available.length);
  if (!quorum.ok) errors.push(`${prefix}_${quorum.reason}`);
  if (approvals.length < quorum.threshold) {
    errors.push(`${prefix}_dynamic_quorum_required:${approvals.length}/${quorum.threshold}`);
  }
  for (const review of reviews) {
    const model = normalizeConsensusModelId(review.model);
    if (!KNOWN_REVIEW_DECISIONS.has(review.decision)) {
      errors.push(`${prefix}_unknown_decision:${model}:${review.decision || 'blank'}`);
    }
    // P1-1（两路审交叉）：request_changes = reviewer 显式要求返工，必须阻断 complete（ok=false）——否则 quorum 满足时会被其他
    //   reviewer 的 approve 盖过（3 reviewer threshold=2，approve,approve,request_changes 会算通过盖章）。normalize 后判，兼容
    //   Request_Changes/request-changes 变体（FINDING1 口径统一）。下游 completion autodrive 据此 ok=false 触发 Step3 返工。
    if (normalizeConsensusDecision(review.decision) === 'request_changes') {
      errors.push(`${prefix}_reviewer_requests_changes:${model}`);
    }
    // P3 复核复活（2026-07-02）：reject 一票即阻断。此前 reject 只减 approve 票——3 reviewer quorum 阈值 2 时
    //   local×2 橡皮章 approve + m3 reject 照样放行（实测 26 次 m3 reject 全被淹没、RejectLesson 饿死全库仅 1 条）。
    //   阻断后 completion ok=false + reviews 含 reject → trigger 的 isTerminalPostReviewReject 分支学习+释放坑位。
    if (normalizeConsensusDecision(review.decision) === 'reject') {
      errors.push(`${prefix}_reviewer_rejects:${model}`);
    }
    if (review.canWrite === true) errors.push(`${prefix}_non_implementer_must_not_write:${model}`);
    const rawRef = refValue(review, 'rawOutputRef', 'reportRef', 'evidenceRef');
    checkRef(errors, root, rawRef, `${prefix}_raw_output_ref:${model}`, requireFile);
  }
  // P3：必需集之外的 advisory reviewer（如 m3 不在本地必需集时）reject 同样阻断——建议权不该被"不在名单"静音。
  //   abstain/unavailable 照旧无效果（fail-open：advisory 挂了不拖累链路）。
  for (const [model, review] of reviewsByModel) {
    if (requiredReviewers.includes(model)) continue;
    if (normalizeConsensusDecision(review && review.decision) === 'reject') {
      errors.push(`${prefix}_advisory_reviewer_rejects:${model}`);
    }
  }
  return {
    ok: errors.length === 0,
    requiredReviewers,
    availableCount: available.length,
    approvalCount: approvals.length,
    quorum,
  };
}
