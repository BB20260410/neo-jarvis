// @ts-check
// NoeReflectiveTunerAdopt — GEPA 闭环的「采纳判定」纯逻辑（从 NoeReflectiveTuner 抽出，保主文件 <500 行）。
//
// 职责单一：给定【已评测候选 + Pareto 前沿】，回答「是否建议采纳一个候选、采哪个、为什么」。
// 【关键安全语义】本模块只「建议」——不写任何权重、不碰 fs、不接 workspace、不调 patch-apply。采纳门 OFF/ON
//   都只产出一个建议对象；真正落地（把 weights 抄进 .env NOE_WS_SALIENCE_*）永远是 owner 的人工动作。
// 反向 probe 的拒绝点就在这里：holdout 变差/持平（delta ≤ max(0,minDelta)，即 delta 不严格>0 或不过门槛）
// 或被 Pareto 支配的坏候选，永不被推荐。负 minDelta 不放水（门槛下限恒为 0）；delta 只认 objectives.holdoutDelta。

/** @param {*} value @param {*} [fallback] @returns {number} */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number(fallback) || 0;
}

/** @typedef {{recommended: object|null, reason: string, eligibleCount: number}} AdoptDecision */

/**
 * 采纳判定（纯函数，确定性）。判据（全部满足才推荐，否则 recommended=null）：
 *   ① 候选必须在 Pareto 前沿上（未被任何其他候选全维支配）；
 *   ② holdoutDelta 必须 > 0 且 > minDelta（实际门槛 = max(0, minDelta)）——【反向 probe 拒绝点】：
 *      变差/持平永不推荐；且负 minDelta 不放水（holdout 没真改善基准就绝不采纳，负门槛只能抬高不能降低基准）；
 *   ③ evaluation.evaluatorOk===true（语义评测器真跑通；fail-open 降级的候选证据不足，不推荐）。
 * 【口径统一】delta 只认 objectives.holdoutDelta（与 selectPareto/paretoFront 读 objectives 同口径）——
 *   去掉旧 evaluation.holdoutDelta 旁路：旁路会让一个 objectives 缺失但 evaluation 含分的候选绕过 Pareto 同口径判定。
 *   真实链路里 objectives.holdoutDelta 恒被构造（NoeReflectiveTuner evaluateCandidate），无旁路需求。
 * 多个合格 → holdoutDelta 最大者；并列取 drift(minimalChange) 最小者（最小改动防漂移）；再并列取 id 字典序（确定性）。
 * @param {Array} evaluated 已评测候选（每项含 candidateId/weights/objectives{holdoutDelta,minimalChange}/evaluation{evaluatorOk}）
 * @param {Array} front     selectPareto 产出的前沿（每项含 candidateId）
 * @param {{minDelta?:number}} [opts]
 * @returns {AdoptDecision}
 */
export function recommendAdoption(evaluated, front, { minDelta = 0 } = {}) {
  const list = Array.isArray(evaluated) ? evaluated : [];
  const frontIds = new Set((Array.isArray(front) ? front : []).map((c) => c?.candidateId));
  // 实际门槛永不低于 0：负 minDelta 不放水（变差/持平绝不采纳，负门槛只能抬高真改善要求，不能降低基准）。
  const md = Math.max(0, num(minDelta, 0));
  const deltaOf = (c) => num(c?.objectives?.holdoutDelta, 0); // 只认 objectives.holdoutDelta（与 Pareto 同口径，无 evaluation 旁路）
  // 只在前沿 + 严格改善（delta>0 且 >门槛）+ 评测器真跑通的候选里挑（缺一不可）。
  const eligible = list.filter((c) => {
    if (!frontIds.has(c?.candidateId)) return false;
    const delta = deltaOf(c);
    const evaluatorOk = c?.evaluation?.evaluatorOk === true;
    return evaluatorOk && delta > 0 && delta > md;
  });
  if (!eligible.length) {
    const anyImproved = list.some((c) => { const d = deltaOf(c); return d > 0 && d > md; });
    return { recommended: null, eligibleCount: 0, reason: anyImproved ? 'improved_but_dominated_or_low_confidence' : 'no_candidate_beats_baseline' };
  }
  eligible.sort((a, b) => {
    const da = num(a?.objectives?.holdoutDelta, 0);
    const db = num(b?.objectives?.holdoutDelta, 0);
    if (db !== da) return db - da;
    const ma = num(a?.objectives?.minimalChange ?? a?.drift, 0);
    const mb = num(b?.objectives?.minimalChange ?? b?.drift, 0);
    if (ma !== mb) return ma - mb;
    return String(a?.candidateId).localeCompare(String(b?.candidateId));
  });
  return { recommended: eligible[0], eligibleCount: eligible.length, reason: 'pareto_optimal_strict_improvement' };
}
