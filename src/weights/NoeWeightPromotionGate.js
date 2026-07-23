// @ts-check
// NoeWeightPromotionGate（P5-2 人格一致性回归 + 2 轮审计 Shadow Mode）——权重更新不漂走人格、不污染生产。
//
// 两道闸：
//   ① Shadow Mode（审计必修）：候选 LoRA 先在隔离仿真跑，连续 N 次（minConsecutiveWins）人格一致性 ≥ 基线
//      才允许热更生产；任一次掉点超阈值即判 revert。禁在线直接微调污染生产。
//   ② 自动 revert：已上线候选若一致性掉点超 maxDropThreshold（相对基线）→ 判 revert（配合版本库回滚）。
// 纯决策逻辑（给定评分→裁决），确定性可单测。一致性评分器 personaConsistencyScore 用 token 重叠，离线可跑
//   （真模型答案的生成需 model，属 kickstart；本模块吃「已有的评分/答案对」做裁决）。
//
// @deprecated 2026-06-22（P7 换路线）：与 NoeLoraVersionRegistry 同——LoRA 权重提升路线经 owner
//   2026-06-21 复盘判死（persona 改挂 system prompt，weights 进化改 GEPA + memory-RAG）。本模块
//   server.js 引用=0（已 unwired）。**代码保留不删**：Shadow-Mode 一致性闸/自动 revert 裁决逻辑在
//   未来用干净数据重启权重训练时仍有价值，删了要重写。新增权重进化逻辑请走 GEPA/RAG，勿再接线此模块。

function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[\s，。、；：！？,.;:!?()（）"'`/\\[\]{}|]+/).map((t) => t.trim()).filter((t) => t.length >= 1);
}

// 两文本 token Dice 相似度（人格一致性的轻量代理：答案与基准/期望的措辞-语义重叠）。
function tokenDice(a, b) {
  const ta = tokenize(a); const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const bag = new Map();
  for (const t of ta) bag.set(t, (bag.get(t) || 0) + 1);
  let common = 0;
  for (const t of tb) { const c = bag.get(t) || 0; if (c > 0) { common += 1; bag.set(t, c - 1); } }
  return (2 * common) / (ta.length + tb.length);
}

/**
 * 人格一致性评分：给定 [{expected, actual}] 答案对，返回平均一致性 0-1。
 * @deprecated LoRA 路线已判死（见文件头 2026-06-22 注），仅留作未来干净数据重启时复用；勿新接线。
 * @param {Array<{expected:string, actual:string}>} pairs
 */
export function personaConsistencyScore(pairs = []) {
  const list = (Array.isArray(pairs) ? pairs : []).filter((p) => p && (p.expected !== undefined) && (p.actual !== undefined));
  if (list.length === 0) return { ok: false, score: 0, count: 0 };
  const sims = list.map((p) => tokenDice(p.expected, p.actual));
  const score = sims.reduce((a, b) => a + b, 0) / sims.length;
  return { ok: true, score: Number(score.toFixed(4)), count: list.length, perItem: sims.map((s) => Number(s.toFixed(4))) };
}

/**
 * 权重提升裁决（Shadow Mode + 自动 revert）。
 * @deprecated LoRA 路线已判死（见文件头 2026-06-22 注），仅留作未来干净数据重启时复用；勿新接线。
 * @param {{ shadowRuns?: Array<{baseline:number, candidate:number}>, minConsecutiveWins?: number, maxDropThreshold?: number, winMargin?: number }} input
 * @returns {{decision:'promote'|'hold'|'revert', reason:string, consecutiveWins:number, worstDrop:number}}
 */
export function decideWeightPromotion({ shadowRuns = [], minConsecutiveWins = 3, maxDropThreshold = 0.05, winMargin = 0 } = {}) {
  const minWins = Math.max(1, Math.trunc(Number(minConsecutiveWins) || 1)); // 防误传 0/负数→「无胜也 promote」（审核观察）
  const runs = (Array.isArray(shadowRuns) ? shadowRuns : []).filter((r) => r && Number.isFinite(Number(r.baseline)) && Number.isFinite(Number(r.candidate)));
  if (runs.length === 0) return { decision: 'hold', reason: 'no_shadow_runs', consecutiveWins: 0, worstDrop: 0 };

  // 最差掉点（基线 - 候选 的最大值）。任一次掉点超阈值 → revert（人格漂移/退化，禁热更）。
  let worstDrop = -Infinity;
  for (const r of runs) worstDrop = Math.max(worstDrop, Number(r.baseline) - Number(r.candidate));
  worstDrop = Number(worstDrop.toFixed(4));
  if (worstDrop > maxDropThreshold) {
    return { decision: 'revert', reason: 'consistency_regression_exceeds_threshold', consecutiveWins: 0, worstDrop };
  }

  // 从最近往前数连续「候选 ≥ 基线 + winMargin」的次数。
  let consecutiveWins = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (Number(runs[i].candidate) >= Number(runs[i].baseline) + winMargin) consecutiveWins += 1;
    else break;
  }
  if (consecutiveWins >= minWins) {
    return { decision: 'promote', reason: 'beat_baseline_n_consecutive', consecutiveWins, worstDrop };
  }
  return { decision: 'hold', reason: 'insufficient_consecutive_wins', consecutiveWins, worstDrop };
}
