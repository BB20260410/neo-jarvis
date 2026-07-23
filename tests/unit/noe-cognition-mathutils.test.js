// @ts-check
// 验证 src/cognition/_mathUtils.js 抽取出的 clamp 与原各模块内联实现逐字等价（去重不改行为）。
import { describe, it, expect } from 'vitest';
import { clamp, rate } from '../../src/cognition/_mathUtils.js';

// 原内联实现（抽取前 7 个 cognition 模块各自的字节级一致定义）——作为黄金参照。
const inlineClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// rate 抽取前 SelfTalkAuditStore / SelfTalkLandingPolicy 各自的字节级一致定义——黄金参照。
const inlineRate = (n, d) => d ? Number((n / d).toFixed(3)) : 0;

describe('_mathUtils.clamp — 与抽取前内联实现逐字等价', () => {
  it('区间内原样返回', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-0.3, -1, 1)).toBe(-0.3);
    expect(clamp(3, 1, 10)).toBe(3);
  });

  it('低于下界夹到 lo / 高于上界夹到 hi', () => {
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(99, 0, 1)).toBe(1);
    expect(clamp(0, 1, 720)).toBe(1);
    expect(clamp(99999, 1, 30)).toBe(30);
  });

  it('边界值原样', () => {
    expect(clamp(0, 0, 1)).toBe(0);
    expect(clamp(1, 0, 1)).toBe(1);
    expect(clamp(0.05, 0.05, 0.95)).toBe(0.05);
    expect(clamp(0.95, 0.05, 0.95)).toBe(0.95);
  });

  it('与内联参照在大量随机/特殊输入上结果完全一致', () => {
    const xs = [
      -Infinity, Infinity, NaN, 0, -0, 1, -1, 0.001, 0.999, 720, 168, 30, 14, 2,
      -1000, 1000, 0.5, 0.55, 0.7, 0.6, 0.05, 0.95, 0.01, 0.99,
    ];
    const bounds = [
      [0, 1], [-1, 1], [0.01, 0.99], [0.05, 0.95], [1, 720], [1, 168], [1, 30], [1, 14], [0.001, 1],
    ];
    for (const x of xs) {
      for (const [lo, hi] of bounds) {
        const got = clamp(x, lo, hi);
        const ref = inlineClamp(x, lo, hi);
        // NaN 经 Math.min/Math.max 透传为 NaN：两边都应是 NaN（用 Object.is 精确比对，含 -0/+0）。
        if (Number.isNaN(ref)) {
          expect(Number.isNaN(got)).toBe(true);
        } else {
          expect(Object.is(got, ref)).toBe(true);
        }
      }
    }
  });

  it('保留 Math.min/Math.max 对 NaN 的透传语义（非法输入不抛错）', () => {
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true);
    expect(() => clamp(NaN, 0, 1)).not.toThrow();
  });
});

describe('_mathUtils.rate — 与抽取前 SelfTalk 内联实现逐字等价', () => {
  it('正常比率保留 3 位小数', () => {
    expect(rate(1, 2)).toBe(0.5);
    expect(rate(1, 3)).toBe(0.333);
    expect(rate(2, 3)).toBe(0.667);
    expect(rate(7, 7)).toBe(1);
  });

  it('分母为假值(0/NaN/undefined/null)返回 0（不抛错、不产生 NaN/Infinity）', () => {
    expect(rate(5, 0)).toBe(0);
    expect(rate(5, NaN)).toBe(0);
    expect(rate(5, undefined)).toBe(0);
    expect(rate(5, null)).toBe(0);
    expect(rate(0, 0)).toBe(0);
    expect(() => rate(1, 0)).not.toThrow();
  });

  it('与内联参照在多种输入上结果完全一致', () => {
    const cases = [[0, 10], [3, 4], [1, 3], [2, 3], [5, 0], [10, 10], [1, 7], [6, 7], [0, 0], [100, 3], [1, 8], [9, 4]];
    for (const [n, d] of cases) {
      expect(rate(n, d)).toBe(inlineRate(n, d));
    }
  });
});

describe('抽取后各 cognition 模块仍按原签名消费 clamp（导入连通性冒烟）', () => {
  it('7 个改动模块均可正常 import（无残留本地定义/无循环依赖）', async () => {
    const mods = await Promise.all([
      import('../../src/cognition/NoeAffectEngine.js'),
      import('../../src/cognition/NoeExpectationLedger.js'),
      import('../../src/cognition/NoeVerifiableReward.js'),
      import('../../src/cognition/NoeEntropyTemperature.js'),
      import('../../src/cognition/NoeExpectationHarvester.js'),
      import('../../src/cognition/NoeCuriosityDecompose.js'),
      import('../../src/cognition/NoeOwnerBehaviorPredictor.js'),
    ]);
    for (const m of mods) expect(m).toBeTruthy();
  });
});
