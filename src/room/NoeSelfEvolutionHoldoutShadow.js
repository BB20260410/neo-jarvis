// @ts-check
// NoeSelfEvolutionHoldoutShadow — complete 盖章点的 holdout 观测哨兵（shadow 模式，绝不拦）。
// 定位（多子代理审实证·别当真闸用）：Neo 已有 holdout 差分评测（NoeEvolutionHoldoutRunner：进化前后跑同组
//   testCase 比 delta）但从没接进飞轮 complete 判定。本模块在盖章点按 holdout delta 记"这次进化按外部 holdout
//   该不该算成功"，只 advance 记账、绝不拦截（flag NOE_SELFEVO_HOLDOUT_SHADOW 默认 OFF）。
// ⚠️ 这是观测哨兵不是根治：飞轮现状根本不产 holdout 证据（17 个生产 cycle 全 unverified 实测），所以它恒记
//   unverified/no_holdout_evidence。价值=把"飞轮 0% complete 经外部验证"从推测变可监控指标 + 为真根治预埋接入点；
//   局限=观测不拦、不阻止假进化。真根治需上游三环：立项带外部任务集 ref + 状态机加 holdout 评测阶段 + complete
//   gate 消费 candidate.holdout（复用已有 NoeEvolutionCandidateGate.validateHoldout 真闸，它硬拦 delta<minDelta）。
// 安全：候选自报 holdout.minDelta 用 Math.max 夹紧（只能更严不能放宽）；权威 minDelta 传 0/负回落 0.001（纯函数审 HIGH）。

export const NOE_SELF_EVOLUTION_HOLDOUT_SHADOW_SCHEMA_VERSION = 1;

// round9：消浮点噪声（0.51-0.5 在 JS 是 0.00999…，直接比会误判边界）。
const round9 = (x) => Math.round(x * 1e9) / 1e9;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// 多路径提取 holdout 证据（兼容不同写入位置：candidate.holdout / 顶层 holdout / implementation.holdout）。
function extractHoldout(cycle) {
  const c = safeObject(cycle);
  return safeObject(c.candidate).holdout ?? c.holdout ?? safeObject(c.implementation).holdout ?? null;
}

export function evaluateSelfEvolutionHoldoutShadow(cycle = {}, opts = {}) {
  const { minDelta = 0.001 } = opts || {}; // 纯函数审 LOW：opts 显式传 null 也安全（解构 null 会抛）
  const rawMinDelta = num(minDelta);
  // 安全（纯函数审 HIGH）：权威下限必须为正——传 0/负（运维失误/env NOE_SELFEVO_HOLDOUT_MIN_DELTA 配错）回落安全
  //   默认 0.001，否则 no-op(delta=0)/倒退(delta<0) 会被洗成 pass，"防 reward hacking 的闸自己留后门"。
  const authoritativeMinDelta = (rawMinDelta !== null && rawMinDelta > 0) ? rawMinDelta : 0.001;
  const base = {
    schemaVersion: NOE_SELF_EVOLUTION_HOLDOUT_SHADOW_SCHEMA_VERSION,
    minDelta: authoritativeMinDelta,
    delta: null,
    baselineScore: null,
    candidateScore: null,
  };

  const holdout = extractHoldout(cycle);
  if (!holdout || typeof holdout !== 'object') {
    return { ...base, verdict: 'unverified', reason: 'no_holdout_evidence', shadowWouldBlock: true };
  }

  const ho = safeObject(holdout);
  const baselineScore = num(ho.baselineScore);
  const candidateScore = num(ho.candidateScore);
  if (baselineScore === null || candidateScore === null) {
    return { ...base, verdict: 'unverified', reason: 'holdout_scores_missing', shadowWouldBlock: true };
  }

  // 安全：候选自报 minDelta 只能更严（Math.max），不能放宽权威下限 → 防候选自设 minDelta=0 把 no-op 洗成 pass。
  const selfReported = num(ho.minDelta);
  const effectiveMinDelta = selfReported === null
    ? authoritativeMinDelta
    : Math.max(selfReported, authoritativeMinDelta);

  const delta = round9(candidateScore - baselineScore);
  const filled = { ...base, minDelta: effectiveMinDelta, delta, baselineScore, candidateScore };
  if (delta >= effectiveMinDelta) {
    return { ...filled, verdict: 'pass', shadowWouldBlock: false };
  }
  return { ...filled, verdict: 'regression_or_noop', reason: 'holdout_improvement_below_min', shadowWouldBlock: true };
}
