// @ts-check
// NoeSelfEvolutionHoldoutShadow 纯函数单测——把已有 holdout 差分评测接进自我进化飞轮 complete 判定（shadow 观测，不拦）。
// 根治假进化：complete 盖"成功"章前，按 holdout（进化前后跑同组 testCase 的 delta）判"这次进化该不该算成功"，
// 记账但先不拦（NOE_SELFEVO_HOLDOUT_SHADOW 默认 OFF）。飞轮现状不产 holdout 证据 → 记 unverified/no_holdout_evidence，
// 这就是假进化的量化铁证（每个 complete 都无外部验证 = "造 ValueError 当成就"也能盖章的根因）。
import { describe, expect, it } from 'vitest';
import { evaluateSelfEvolutionHoldoutShadow } from '../../src/room/NoeSelfEvolutionHoldoutShadow.js';

describe('evaluateSelfEvolutionHoldoutShadow', () => {
  it('holdout delta >= minDelta → pass，shadow 不拦', () => {
    const cycle = { candidate: { holdout: { baselineScore: 0.5, candidateScore: 0.8 } } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('pass');
    expect(r.shadowWouldBlock).toBe(false);
    expect(r.delta).toBeCloseTo(0.3, 6);
  });

  it('delta < minDelta（no-op，进化前后无差）→ regression_or_noop，shadow 标"该拦"', () => {
    const cycle = { candidate: { holdout: { baselineScore: 0.5, candidateScore: 0.5 } } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('regression_or_noop');
    expect(r.shadowWouldBlock).toBe(true);
    expect(r.delta).toBe(0);
  });

  it('delta 为负（进化后反而变差）→ regression_or_noop', () => {
    const cycle = { candidate: { holdout: { baselineScore: 0.8, candidateScore: 0.5 } } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('regression_or_noop');
    expect(r.shadowWouldBlock).toBe(true);
    expect(r.delta).toBeCloseTo(-0.3, 6);
  });

  it('飞轮现状：cycle 无 holdout 证据 → unverified/no_holdout_evidence（假进化铁证）', () => {
    const r = evaluateSelfEvolutionHoldoutShadow({ cycleId: 'c1', stage: 'complete' }, { minDelta: 0.001 });
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toBe('no_holdout_evidence');
    expect(r.shadowWouldBlock).toBe(true);
    expect(r.delta).toBeNull();
  });

  it('有 holdout 对象但 scores 缺 → unverified/holdout_scores_missing（防把残缺证据当通过）', () => {
    const cycle = { candidate: { holdout: { reportRef: 'x' } } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toBe('holdout_scores_missing');
    expect(r.shadowWouldBlock).toBe(true);
  });

  it('多路径取证据：cycle.holdout 顶层也能取到（兼容不同写入位置）', () => {
    const cycle = { holdout: { baselineScore: 0.4, candidateScore: 0.9 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('pass');
    expect(r.delta).toBeCloseTo(0.5, 6);
  });

  it('多路径取证据：cycle.implementation.holdout 也能取到', () => {
    const cycle = { implementation: { holdout: { baselineScore: 0.2, candidateScore: 0.6 } } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('pass');
  });

  it('边界：delta === minDelta → pass（用 >= 不是 >）', () => {
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.51 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.01 });
    expect(r.verdict).toBe('pass');
  });

  it('安全：候选自报 minDelta 不能放宽权威下限（Math.max 夹紧，防 reward hacking）', () => {
    // 候选自设 minDelta=0（想让 delta=0 也算 pass），权威 minDelta=0.001 → 夹紧到 0.001 → delta=0 不达标
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.5, minDelta: 0 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.verdict).toBe('regression_or_noop');
    expect(r.minDelta).toBe(0.001);
  });

  it('安全：候选自报 minDelta 更严时采纳更严的（只能更严）', () => {
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.52, minDelta: 0.05 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.minDelta).toBe(0.05);
    expect(r.verdict).toBe('regression_or_noop'); // delta 0.02 < 0.05
  });

  it('反向 probe：null / 空 / 非对象 cycle → 安全 unverified 不抛', () => {
    expect(evaluateSelfEvolutionHoldoutShadow(null).verdict).toBe('unverified');
    expect(evaluateSelfEvolutionHoldoutShadow({}).verdict).toBe('unverified');
    expect(evaluateSelfEvolutionHoldoutShadow(42).verdict).toBe('unverified');
    expect(evaluateSelfEvolutionHoldoutShadow(undefined).reason).toBe('no_holdout_evidence');
  });

  it('默认 minDelta（不传 opts）→ 0.001，不抛', () => {
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.5 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle);
    expect(r.minDelta).toBe(0.001);
    expect(r.verdict).toBe('regression_or_noop');
  });

  it('schemaVersion + 证据分数回填（可审计）', () => {
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.8 } };
    const r = evaluateSelfEvolutionHoldoutShadow(cycle, { minDelta: 0.001 });
    expect(r.schemaVersion).toBe(1);
    expect(r.baselineScore).toBe(0.5);
    expect(r.candidateScore).toBe(0.8);
  });

  // 纯函数审 HIGH：权威 minDelta（env NOE_SELFEVO_HOLDOUT_MIN_DELTA）本身无下限保护——传 0/负（运维失误）
  //   会把 no-op/倒退洗成 pass，"防 reward hacking 的闸自己留后门"。权威下限必须为正，否则回落安全默认 0.001。
  it('纯函数审 HIGH：权威 minDelta 传 0 → no-op 不洗白（回落正下限 0.001）', () => {
    const noop = { holdout: { baselineScore: 0.5, candidateScore: 0.5 } };
    const r = evaluateSelfEvolutionHoldoutShadow(noop, { minDelta: 0 });
    expect(r.verdict).toBe('regression_or_noop');
    expect(r.minDelta).toBe(0.001);
  });

  it('纯函数审 HIGH：权威 minDelta 传负数 → 倒退不洗白（回落正下限）', () => {
    const regress = { holdout: { baselineScore: 0.8, candidateScore: 0.5 } };
    const r = evaluateSelfEvolutionHoldoutShadow(regress, { minDelta: -1 });
    expect(r.verdict).toBe('regression_or_noop');
    expect(r.minDelta).toBe(0.001);
  });

  it('纯函数审 LOW：opts 显式传 null（非省略）→ 安全不抛（回落默认）', () => {
    const cycle = { holdout: { baselineScore: 0.5, candidateScore: 0.8 } };
    expect(() => evaluateSelfEvolutionHoldoutShadow(cycle, null)).not.toThrow();
    expect(evaluateSelfEvolutionHoldoutShadow(cycle, null).verdict).toBe('pass');
  });
});
