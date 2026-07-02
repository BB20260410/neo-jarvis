// @ts-check
// NoeReviewTier — P3.1 渐进审查梯度（self-evolution 信任校准）。
//
// 痛点：现状自改每次 complete 都硬要求 post_review（非实施者模型复核）。P3.1 做信任校准——Neo 自改
//   完成数越多越可信，审查梯度逐步放松：首 N 次全审 → 中段只审高危/auto-flagged → 后段抽样。
//
// 安全：高危（red/yellow tier）或 auto-flagged 始终 full（不随次数放松）；放松只发生在 green tier。
//   纯函数 + DI，零副作用。调用方门控 flag NOE_SELF_EVOLUTION_REVIEW_TIER（默认 OFF=逐次全审=现状）。
//   即便放松 post_review，consensus ledger / runtime / rollback 等硬约束仍由 Gate 独立保留（P3.1 不碰）。

export const REVIEW_TIERS = Object.freeze({ FULL: 'full', FLAGGED_ONLY: 'flagged_only', SAMPLE: 'sample' });

/**
 * 算当前自改候选的审查档 + 是否强制 post_review。
 * @param {object} input
 * @param {number} [input.completedCount] 已完成自改 cycle 数（越多越可信）
 * @param {string} [input.riskTier] P3.2 风险档 green/yellow/red（高危不放松）
 * @param {boolean} [input.autoFlagged] 是否被自动标记（异常/可疑 → 强制全审）
 * @param {number} [input.sampleIndex] 抽样序号（后段确定性抽样用；缺省用 completedCount）
 * @param {object} [opts]
 * @param {number} [opts.fullThreshold] 首 N 次全审，默认 5
 * @param {number} [opts.flaggedThreshold] 中段上限，默认 25
 * @param {number} [opts.sampleEvery] 后段每 N 次抽 1 次审，默认 5
 * @returns {{ tier:string, requirePostReview:boolean, reason:string }}
 */
export function resolveReviewTier(input = {}, { fullThreshold = 5, flaggedThreshold = 25, sampleEvery = 5 } = {}) {
  const count = Number.isFinite(Number(input.completedCount)) ? Math.max(0, Number(input.completedCount)) : 0;
  const riskTier = String(input.riskTier || '');

  // 白名单 fail-closed（Claude 审加固）：仅明确 green 才进 count-based 放松；非 green（yellow/red/unknown/空/
  //   未知值）一律 full。安全默认 = "非明确 green 即不放松"，不把 fail-closed 责任外包给调用方归一化。
  if (riskTier !== 'green') {
    return { tier: REVIEW_TIERS.FULL, requirePostReview: true, reason: `非 green 档(${riskTier || 'unknown'})始终全审` };
  }
  if (input.autoFlagged === true) {
    return { tier: REVIEW_TIERS.FULL, requirePostReview: true, reason: 'auto-flagged 强制全审' };
  }
  // 首 N 次：全审（建立信任基线）
  if (count < fullThreshold) {
    return { tier: REVIEW_TIERS.FULL, requirePostReview: true, reason: `首 ${fullThreshold} 次全审(${count}/${fullThreshold})` };
  }
  // 中段：只审高危/auto-flagged（此处既非高危也非 flagged）→ 可省 post_review
  if (count < flaggedThreshold) {
    return { tier: REVIEW_TIERS.FLAGGED_ONLY, requirePostReview: false, reason: `中段只审高危/flagged(${count})` };
  }
  // 后段：确定性抽样（sampleIndex % sampleEvery === 0 时审，其余跳过）
  const idx = Number.isFinite(Number(input.sampleIndex)) ? Math.max(0, Number(input.sampleIndex)) : count;
  const every = Math.max(1, sampleEvery);
  const sampled = idx % every === 0;
  return {
    tier: REVIEW_TIERS.SAMPLE,
    requirePostReview: sampled,
    reason: sampled ? `后段抽样命中(idx ${idx} % ${every}=0)` : `后段抽样跳过(idx ${idx})`,
  };
}

/** 从 env 解析 flag + 阈值（非法/未设回退默认）。 */
export function resolveReviewTierConfig(env = process.env) {
  const enabled = env.NOE_SELF_EVOLUTION_REVIEW_TIER === '1';
  const full = Number.parseInt(env.NOE_REVIEW_TIER_FULL_N ?? '', 10);
  const flagged = Number.parseInt(env.NOE_REVIEW_TIER_FLAGGED_N ?? '', 10);
  const sample = Number.parseInt(env.NOE_REVIEW_TIER_SAMPLE_EVERY ?? '', 10);
  const fullThreshold = Number.isFinite(full) && full > 0 ? full : 5;
  let flaggedThreshold = Number.isFinite(flagged) && flagged > 0 ? flagged : 25;
  if (flaggedThreshold <= fullThreshold) flaggedThreshold = fullThreshold + 1; // 防误配中段区间为空（Claude 审）
  return {
    enabled,
    fullThreshold,
    flaggedThreshold,
    sampleEvery: Number.isFinite(sample) && sample > 0 ? sample : 5,
  };
}
