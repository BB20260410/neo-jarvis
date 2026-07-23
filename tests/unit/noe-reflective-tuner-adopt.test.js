// @ts-check
import { describe, it, expect } from 'vitest';
import { createReflectiveTuner, recommendAdoption } from '../../src/cognition/NoeReflectiveTuner.js';

// P7 采纳门 + 反向 probe（必做）：
//  · recommendAdoption 只在【Pareto 前沿 + holdoutDelta 严格>门槛 + evaluatorOk】里挑候选 → 真改善才推荐。
//  · 反向 probe：故意喂「会让基准掉分」的坏参数候选 → 断言被 Pareto 拒/不推荐采纳（adopted 永不为 true、recommendedId null）。
//  · 采纳门 standing-grant：adoptEnabled 默认 OFF → adopted 恒 false（纯观察）；ON 才标 adopted:true，但仍绝不写 production。
// 全确定性：固定 now、注入 stub scoreFn（owner 权重越高分越高，方向可断言；不触网/不依赖时钟）。

const T0 = 1_780_000_000_000;
const BASE = { owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 };
// stub 标量评测尺子：分数 = owner 权重。→ 调高 owner = 改善（delta>0）；调低 owner = 变差（delta<0）。
const ownerScoreFn = (w) => w.owner;

describe('recommendAdoption — 纯函数采纳判定（反向 probe 拒绝点）', () => {
  it('好候选（前沿 + delta>0 + evaluatorOk）→ 被推荐', () => {
    const evaluated = [
      { candidateId: 'good', weights: { ...BASE, owner: 0.6 }, objectives: { holdoutDelta: 0.25, semanticMean: 0.6, minimalChange: 0.5 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.25 } },
    ];
    const front = evaluated; // 单候选即前沿
    const r = recommendAdoption(evaluated, front);
    expect(r.recommended?.candidateId).toBe('good');
    expect(r.reason).toBe('pareto_optimal_strict_improvement');
    expect(r.eligibleCount).toBe(1);
  });

  it('【反向 probe】坏候选（delta<0，让基准掉分）→ 即使在前沿也不被推荐', () => {
    const bad = { candidateId: 'bad', weights: { ...BASE, owner: 0.1 }, objectives: { holdoutDelta: -0.25, semanticMean: 0.1, minimalChange: 0.5 }, evaluation: { evaluatorOk: true, holdoutDelta: -0.25 } };
    const r = recommendAdoption([bad], [bad]); // 坏候选也放进“前沿”——证明拒绝来自 delta 门槛而非仅靠 Pareto
    expect(r.recommended).toBeNull();
    expect(r.eligibleCount).toBe(0);
    expect(r.reason).toBe('no_candidate_beats_baseline');
  });

  it('【反向 probe】delta=0（持平，没改善）→ 不被推荐（必须严格 > 门槛）', () => {
    const flat = { candidateId: 'flat', weights: BASE, objectives: { holdoutDelta: 0, semanticMean: 0.5, minimalChange: 0 }, evaluation: { evaluatorOk: true, holdoutDelta: 0 } };
    expect(recommendAdoption([flat], [flat]).recommended).toBeNull();
  });

  it('【反向 probe】坏候选被 Pareto 支配（不在前沿）→ 双重拒绝', () => {
    const good = { candidateId: 'good', objectives: { holdoutDelta: 0.3, semanticMean: 0.6, minimalChange: 0.1 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.3 } };
    const badDominated = { candidateId: 'bad', objectives: { holdoutDelta: -0.1, semanticMean: 0.1, minimalChange: 0.5 }, evaluation: { evaluatorOk: true, holdoutDelta: -0.1 } };
    // 前沿只含 good（bad 被全维支配）。即便误把 bad 传进 evaluated，也因不在 front + delta<0 被拒。
    const r = recommendAdoption([good, badDominated], [good]);
    expect(r.recommended?.candidateId).toBe('good');
    expect([...new Set([r.recommended?.candidateId])]).not.toContain('bad');
  });

  it('改善了但评测器没真跑通（evaluatorOk=false，fail-open 降级）→ 证据不足，不推荐', () => {
    const degraded = { candidateId: 'x', objectives: { holdoutDelta: 0.4, semanticMean: 0, minimalChange: 0.2 }, evaluation: { evaluatorOk: false, evalError: 'embed down', holdoutDelta: 0.4 } };
    const r = recommendAdoption([degraded], [degraded]);
    expect(r.recommended).toBeNull();
    expect(r.reason).toBe('improved_but_dominated_or_low_confidence');
  });

  it('多个合格 → 取 holdoutDelta 最大者；并列取漂移最小（确定性）', () => {
    const a = { candidateId: 'a', objectives: { holdoutDelta: 0.2, semanticMean: 0.5, minimalChange: 0.3 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.2 } };
    const b = { candidateId: 'b', objectives: { holdoutDelta: 0.5, semanticMean: 0.5, minimalChange: 0.4 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.5 } };
    expect(recommendAdoption([a, b], [a, b]).recommended?.candidateId).toBe('b'); // 0.5 > 0.2
    // 并列 delta：取 minimalChange 小的
    const c = { candidateId: 'c', objectives: { holdoutDelta: 0.5, semanticMean: 0.5, minimalChange: 0.1 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.5 } };
    expect(recommendAdoption([b, c], [b, c]).recommended?.candidateId).toBe('c'); // 同 0.5，c 漂移更小
  });

  // ── P0③ 修复：强制 delta>0（负 minDelta 不放水）+ 去 evaluation 旁路（与 Pareto 同口径）──────────
  it('【负 minDelta 不放水】minDelta=-0.3 + delta=-0.25（变差）→ 仍被拒（门槛下限恒为 0）', () => {
    // 旧 bug：delta>minDelta 即 -0.25 > -0.3 为真 → 坏候选被推荐。修复后门槛 max(0,-0.3)=0，-0.25 不>0 → 拒。
    const bad = { candidateId: 'bad', objectives: { holdoutDelta: -0.25, semanticMean: 0.1, minimalChange: 0.5 }, evaluation: { evaluatorOk: true, holdoutDelta: -0.25 } };
    const r = recommendAdoption([bad], [bad], { minDelta: -0.3 });
    expect(r.recommended).toBeNull();
    expect(r.eligibleCount).toBe(0);
    expect(r.reason).toBe('no_candidate_beats_baseline');
  });

  it('【负 minDelta 不放水】minDelta=-0.5 + delta=0（持平）→ 仍被拒（持平不是改善）', () => {
    const flat = { candidateId: 'flat', objectives: { holdoutDelta: 0, semanticMean: 0.5, minimalChange: 0 }, evaluation: { evaluatorOk: true, holdoutDelta: 0 } };
    expect(recommendAdoption([flat], [flat], { minDelta: -0.5 }).recommended).toBeNull();
  });

  it('【负 minDelta 不放水】minDelta=-0.5 + delta=0.1（真改善）→ 被推荐（负门槛只抬不降基准，真改善照采）', () => {
    const good = { candidateId: 'good', objectives: { holdoutDelta: 0.1, semanticMean: 0.5, minimalChange: 0.2 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.1 } };
    const r = recommendAdoption([good], [good], { minDelta: -0.5 });
    expect(r.recommended?.candidateId).toBe('good');
    expect(r.reason).toBe('pareto_optimal_strict_improvement');
  });

  it('【evaluation 旁路不绕过】objectives.holdoutDelta 缺失但 evaluation.holdoutDelta=0.4 → delta 读作 0、被拒（只认 objectives，与 Pareto 同口径）', () => {
    // 旧 bug：delta = objectives.holdoutDelta ?? evaluation.holdoutDelta → 走旁路读到 0.4 绕过判定。
    // 修复后只认 objectives.holdoutDelta（缺失即 0），不再被 evaluation 旁路救场。
    const sneaky = { candidateId: 'sneaky', objectives: { semanticMean: 0.5, minimalChange: 0.2 }, evaluation: { evaluatorOk: true, holdoutDelta: 0.4 } };
    const r = recommendAdoption([sneaky], [sneaky]);
    expect(r.recommended).toBeNull();
    expect(r.eligibleCount).toBe(0);
  });
});

describe('createReflectiveTuner 采纳门 standing-grant（默认 OFF）', () => {
  // 让本地脑只提一个“调高 owner”的好候选 → scoreFn 下 delta>0、可被推荐。
  const goodMutate = async () => [{ owner: 0.6, urgency: 0.2, novelty: 0.1, affect: 0.1 }];
  // 让本地脑只提一个“调低 owner”的坏候选 → scoreFn 下 delta<0。
  const badMutate = async () => [{ owner: 0.1, urgency: 0.2, novelty: 0.1, affect: 0.1 }];

  it('adoptEnabled 默认 OFF → adopted:false，但 recommendation 仍照算（纯观察“若采纳会选谁”）', async () => {
    const tuner = createReflectiveTuner({ baselineWeights: BASE, scoreFn: ownerScoreFn, reflectMutate: goodMutate, now: () => T0 });
    expect(tuner.adoptEnabled).toBe(false);
    const out = await tuner.runShadowCycle({ traces: [] });
    expect(out.adoption).toBe('observe_only');
    expect(out.adopted).toBe(false);                       // OFF → 永不发出采纳建议
    expect(out.recommendation.recommendedId).not.toBeNull(); // 但仍观察出最佳候选
    expect(out.recommendation.holdoutDelta).toBeGreaterThan(0);
  });

  it('adoptEnabled ON + 好候选 → adopted:true + recommendation 落地候选（但绝不写 production）', async () => {
    const archive = [];
    const tuner = createReflectiveTuner({ baselineWeights: BASE, scoreFn: ownerScoreFn, reflectMutate: goodMutate, adoptEnabled: true, appendArchive: (d, o) => archive.push(o), now: () => T0 });
    expect(tuner.adoptEnabled).toBe(true);
    const out = await tuner.runShadowCycle({ traces: [] });
    expect(out.adoption).toBe('recommend_only');
    expect(out.adopted).toBe(true);
    expect(out.recommendation.recommendedId).not.toBeNull();
    expect(out.recommendation.weights.owner).toBeCloseTo(0.6, 6);
    // 即便 adopted:true，归档记录与返回值都绝不含 production 写回钩子（结构上不可能落地）。
    const serialized = JSON.stringify(out) + JSON.stringify(archive[0]);
    for (const forbidden of ['patchApply', 'patch_apply', 'writeProduction', 'setEnv', 'applyWeights', 'liveWorkspace', 'autoAdopt']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(archive[0].note).toContain('owner 需人工'); // 明确告诉 owner 仍需手动抄进 .env
  });

  it('【反向 probe·端到端】adoptEnabled ON 但只有坏候选（让基准掉分）→ adopted:false、recommendedId null（Pareto/门槛拒采纳）', async () => {
    const tuner = createReflectiveTuner({ baselineWeights: BASE, scoreFn: ownerScoreFn, reflectMutate: badMutate, adoptEnabled: true, now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: [] });
    expect(out.adopted).toBe(false);                       // 坏参数：即使采纳门 ON 也不采纳
    expect(out.recommendation.recommendedId).toBeNull();
    expect(out.adoption).toBe('recommend_only');           // 门是开的（证明拒绝来自候选质量，不是门关着）
    // 坏候选的 holdoutDelta 确实为负（证明它真让基准掉分，是有效的反向 probe 而非空测）
    const badCand = out.candidates.find((c) => c.weights.owner < 0.2);
    expect(badCand.objectives.holdoutDelta).toBeLessThan(0);
    // 关键语义：单个坏候选在“候选集内部”仍是 Pareto 最优（无他者支配它）——所以拒绝采纳【不是靠 Pareto，而是靠
    // delta>门槛 这道独立闸】（候选 vs 基线，holdoutDelta<0 即比基线差 → 永不推荐）。这正是反向 probe 要钉的：
    // 哪怕候选侥幸进了前沿，只要它让基准掉分就绝不被采纳。
    expect(badCand.paretoOptimal).toBe(true);
  });

  it('adoptMinDelta 抬高门槛 → 小改善也被拒（防过度敏感采纳）', async () => {
    // 好候选 delta = 0.6-0.35 = 0.25；门槛设 0.3 → 该候选不够格。
    const tuner = createReflectiveTuner({ baselineWeights: BASE, scoreFn: ownerScoreFn, reflectMutate: goodMutate, adoptEnabled: true, adoptMinDelta: 0.3, now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: [] });
    expect(out.adopted).toBe(false);
    expect(out.recommendation.recommendedId).toBeNull();
  });
});
