import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_BIPHASIC,
  dualPhaseRetention,
  tierForAge,
  lambdaForTier,
  activationFactor,
  reinforce,
  ageSinceLastRecall,
  makeActivationScorer,
} from '../../src/memory/NoeMemoryDynamics.js';

describe('dualPhaseRetention 双相衰减', () => {
  it('t=0 时严格归一为 1', () => {
    expect(dualPhaseRetention(0)).toBe(1);
  });

  it('单调不增：越老留存越低', () => {
    const a = dualPhaseRetention(1 * DAY_MS);
    const b = dualPhaseRetention(10 * DAY_MS);
    const c = dualPhaseRetention(100 * DAY_MS);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('始终落在 [0,1]（含极大年龄）', () => {
    for (const days of [0, 1, 7, 30, 365, 100000]) {
      const r = dualPhaseRetention(days * DAY_MS);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it('精确匹配公式 (e^(-λ₁t)+θ·e^(-λ₂t))/(1+θ)，t 以天计', () => {
    const days = 5;
    const { lambdaFast, lambdaSlow, theta } = DEFAULT_BIPHASIC;
    const expected =
      (Math.exp(-lambdaFast * days) + theta * Math.exp(-lambdaSlow * days)) / (1 + theta);
    expect(dualPhaseRetention(days * DAY_MS)).toBeCloseTo(expected, 12);
  });

  it('慢相 θ 越大、长期留存底座越高（巩固更强）', () => {
    const far = 200 * DAY_MS;
    const lowTheta = dualPhaseRetention(far, { theta: 0.1 });
    const highTheta = dualPhaseRetention(far, { theta: 0.9 });
    expect(highTheta).toBeGreaterThan(lowTheta);
  });

  it('快相 λ₁ 越大、近期掉得越快', () => {
    const at2d = 2 * DAY_MS;
    const slow = dualPhaseRetention(at2d, { lambdaFast: 0.005 });
    const fast = dualPhaseRetention(at2d, { lambdaFast: 0.05 });
    expect(fast).toBeLessThan(slow);
  });

  it('边界：负年龄按 0 处理 → 1', () => {
    expect(dualPhaseRetention(-1000)).toBe(1);
  });

  it('边界：非数字年龄回落为 0 → 1', () => {
    // @ts-expect-error 故意传非法值测健壮性
    expect(dualPhaseRetention('not-a-number')).toBe(1);
    // @ts-expect-error
    expect(dualPhaseRetention(undefined)).toBe(1);
  });
});

describe('tierForAge / lambdaForTier 分档', () => {
  it('按年龄分 hot/warm/cold', () => {
    expect(tierForAge(0)).toBe('hot');
    expect(tierForAge(6 * DAY_MS)).toBe('hot');
    expect(tierForAge(7 * DAY_MS)).toBe('warm'); // 边界含右开：7天=warm
    expect(tierForAge(29 * DAY_MS)).toBe('warm');
    expect(tierForAge(30 * DAY_MS)).toBe('cold');
    expect(tierForAge(365 * DAY_MS)).toBe('cold');
  });

  it('可注入自定义边界', () => {
    const b = { hotMaxMs: 1 * DAY_MS, warmMaxMs: 2 * DAY_MS };
    expect(tierForAge(0, b)).toBe('hot');
    expect(tierForAge(1 * DAY_MS, b)).toBe('warm');
    expect(tierForAge(2 * DAY_MS, b)).toBe('cold');
  });

  it('lambdaForTier 返回各档 λ；未知档回落 warm', () => {
    expect(lambdaForTier('hot')).toBeCloseTo(0.005, 12);
    expect(lambdaForTier('warm')).toBeCloseTo(0.02, 12);
    expect(lambdaForTier('cold')).toBeCloseTo(0.05, 12);
    // @ts-expect-error 非法档位
    expect(lambdaForTier('bogus')).toBeCloseTo(lambdaForTier('warm'), 12);
  });

  it('lambdaForTier 可注入覆盖表', () => {
    expect(lambdaForTier('hot', { hot: 0.123 })).toBeCloseTo(0.123, 12);
  });
});

describe('activationFactor 时间激活因子', () => {
  it('年龄=0 → 因子=1（新记忆满激活）', () => {
    expect(activationFactor(0)).toBe(1);
  });

  it('落在 [0,1] 且随年龄单调不增', () => {
    const seq = [0, 1, 7, 30, 365].map((d) => activationFactor(d * DAY_MS));
    for (const f of seq) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i]).toBeLessThanOrEqual(seq[i - 1]);
    }
  });

  it('显式 tier 覆盖自动判档：同年龄下 cold 档 λ 更大→因子更低', () => {
    const age = 3 * DAY_MS; // 自动判档本会是 hot
    const asHot = activationFactor(age, { tier: 'hot' });
    const asCold = activationFactor(age, { tier: 'cold' });
    expect(asCold).toBeLessThan(asHot);
  });

  it('不给 tier 时按年龄自动选档（等价显式传该档）', () => {
    const age = 3 * DAY_MS; // → hot
    expect(activationFactor(age)).toBeCloseTo(activationFactor(age, { tier: 'hot' }), 12);
  });

  it('确定性：同输入多次调用结果一致', () => {
    const a = activationFactor(42 * DAY_MS);
    const b = activationFactor(42 * DAY_MS);
    expect(a).toBe(b);
  });
});

describe('reinforce 检索即强化 sal←sal+η(1-sal)', () => {
  it('一次强化把 0.5 推向 1：0.5+0.3*0.5=0.65', () => {
    expect(reinforce(0.5)).toBeCloseTo(0.65, 12);
  });

  it('边际递减且收敛于 1（多次强化逼近但不超过 1）', () => {
    let s = 0.2;
    let prevGain = Infinity;
    for (let i = 0; i < 20; i += 1) {
      const next = reinforce(s);
      const gain = next - s;
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(prevGain + 1e-12); // 增益不增大
      prevGain = gain;
      s = next;
    }
    expect(s).toBeGreaterThan(0.99);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('times 参数一次算多步 = 逐步调用', () => {
    const step = reinforce(reinforce(reinforce(0.3)));
    const batch = reinforce(0.3, { times: 3 });
    expect(batch).toBeCloseTo(step, 12);
  });

  it('η=0 不变；η=1 直接到 1', () => {
    expect(reinforce(0.4, { eta: 0 })).toBeCloseTo(0.4, 12);
    expect(reinforce(0.4, { eta: 1 })).toBe(1);
  });

  it('输入越界被 clamp 到 [0,1]', () => {
    expect(reinforce(-5)).toBe(0 + 0.3 * (1 - 0)); // -5→0, 再强化=0.3
    expect(reinforce(0)).toBeCloseTo(0.3, 12);
    expect(reinforce(2)).toBe(1); // 2→1, 强化仍=1
  });

  it('times=0 返回原值（clamp 后）', () => {
    expect(reinforce(0.42, { times: 0 })).toBeCloseTo(0.42, 12);
  });
});

describe('ageSinceLastRecall 距上次想起（让召回像回忆）', () => {
  const now = () => 1_000 * DAY_MS; // 固定注入时刻

  it('优先用 lastHitAt 算年龄', () => {
    const item = {
      lastHitAt: 998 * DAY_MS,
      updatedAt: 500 * DAY_MS,
      createdAt: 1 * DAY_MS,
    };
    expect(ageSinceLastRecall(item, { now })).toBe(2 * DAY_MS);
  });

  it('缺 lastHitAt 回落 updatedAt', () => {
    const item = { updatedAt: 990 * DAY_MS, createdAt: 1 * DAY_MS };
    expect(ageSinceLastRecall(item, { now })).toBe(10 * DAY_MS);
  });

  it('只有 createdAt 时用 createdAt', () => {
    const item = { createdAt: 900 * DAY_MS };
    expect(ageSinceLastRecall(item, { now })).toBe(100 * DAY_MS);
  });

  it('无任何时间字段 → Infinity（视为极老）', () => {
    expect(ageSinceLastRecall({}, { now })).toBe(Infinity);
  });

  it('接受可解析的 ISO 字符串时间', () => {
    const ms = Date.parse('2020-01-01T00:00:00Z');
    const item = { lastHitAt: '2020-01-01T00:00:00Z' };
    const fixedNow = () => ms + 3 * DAY_MS;
    expect(ageSinceLastRecall(item, { now: fixedNow })).toBe(3 * DAY_MS);
  });

  it('未来时间（now 之前的负差）被 clamp 到 0', () => {
    const item = { lastHitAt: 1_005 * DAY_MS }; // 在 now 之后
    expect(ageSinceLastRecall(item, { now })).toBe(0);
  });
});

describe('makeActivationScorer 工厂（env 门控默认 OFF）', () => {
  it('默认 OFF（env 无开关）→ 恒等打分器，任何记忆都返回 1', () => {
    const scorer = makeActivationScorer({ env: {} });
    expect(scorer({ lastHitAt: 0 })).toBe(1);
    expect(scorer({})).toBe(1);
  });

  it('NOE_MEMORY_DYNAMIC_DECAY=1 才启用', () => {
    const off = makeActivationScorer({ env: { NOE_MEMORY_DYNAMIC_DECAY: '0' } });
    expect(off({ lastHitAt: 0 })).toBe(1);
    const on = makeActivationScorer({
      env: { NOE_MEMORY_DYNAMIC_DECAY: '1' },
      now: () => 1_000 * DAY_MS,
    });
    // 老记忆（lastHitAt 很久前）启用后因子 < 1
    expect(on({ lastHitAt: 0 })).toBeLessThan(1);
  });

  it('显式 enabled 覆盖 env（测试注入用）', () => {
    const forcedOn = makeActivationScorer({
      enabled: true,
      env: {},
      now: () => 1_000 * DAY_MS,
    });
    expect(forcedOn({ lastHitAt: 0 })).toBeLessThan(1);
    const forcedOff = makeActivationScorer({ enabled: false, env: { NOE_MEMORY_DYNAMIC_DECAY: '1' } });
    expect(forcedOff({ lastHitAt: 0 })).toBe(1);
  });

  it('启用时：刚被召回的记忆因子 ≈ 1，远高于久未召回的', () => {
    const now = () => 1_000 * DAY_MS;
    const scorer = makeActivationScorer({ enabled: true, now });
    const justRecalled = scorer({ lastHitAt: 1_000 * DAY_MS }); // age=0
    const stale = scorer({ lastHitAt: 900 * DAY_MS }); // age=100d
    expect(justRecalled).toBeCloseTo(1, 12);
    expect(stale).toBeLessThan(justRecalled);
  });

  it('启用时：作乘子能改变两条记忆的排序（时间维度真生效）', () => {
    const now = () => 1_000 * DAY_MS;
    const scorer = makeActivationScorer({ enabled: true, now });
    // A 基础分略高但很旧；B 基础分略低但刚被想起 → 叠时间后 B 反超
    const A = { id: 'A', baseScore: 0.62, lastHitAt: 700 * DAY_MS };
    const B = { id: 'B', baseScore: 0.58, lastHitAt: 1_000 * DAY_MS };
    const score = (m) => m.baseScore * scorer(m);
    expect(score(B)).toBeGreaterThan(score(A));
  });

  it('floor 下限：无时间字段返回 floor，不被压到 0（仍可召回）', () => {
    const scorer = makeActivationScorer({ enabled: true, floor: 0.1, now: () => 1_000 * DAY_MS });
    expect(scorer({})).toBe(0.1);
    // 极老记忆也不低于 floor
    expect(scorer({ lastHitAt: 0 })).toBeGreaterThanOrEqual(0.1);
  });

  it('启用时默认 floor=0：极老记忆因子趋近 0', () => {
    const scorer = makeActivationScorer({ enabled: true, now: () => 1e9 * DAY_MS });
    expect(scorer({ lastHitAt: 0 })).toBeGreaterThanOrEqual(0);
    expect(scorer({ lastHitAt: 0 })).toBeLessThan(0.01);
  });
});
