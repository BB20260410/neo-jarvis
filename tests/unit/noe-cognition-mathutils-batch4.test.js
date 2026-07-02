// @ts-check
// 批4 去重验证：src/cognition/_mathUtils.js 新增的 clamp01 / round3 与抽取前各模块内联实现逐字等价，
//   且各去重模块仍可正常 import（无残留本地定义 / 无循环依赖）。行为零变化是本批的核心契约。
import { describe, it, expect } from 'vitest';
import { clamp01, round3 } from '../../src/cognition/_mathUtils.js';

// 抽取前的内联黄金参照（5 处 clamp01 / 2 处 round3 的字节级一致定义）。
const inlineClamp01 = (x) => Math.max(0, Math.min(1, x));
const inlineRound3 = (x) => Math.round(x * 1000) / 1000;

describe('_mathUtils.clamp01 — 与抽取前 5 处内联实现逐字等价', () => {
  it('区间内原样返回', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.999)).toBe(0.999);
    expect(clamp01(0.001)).toBe(0.001);
  });

  it('越界夹取到 [0,1]', () => {
    expect(clamp01(-0.3)).toBe(0);
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(99)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('保留 Math.min/Math.max 对 NaN 的透传语义（非法输入不抛错，返回 NaN）', () => {
    expect(Number.isNaN(clamp01(NaN))).toBe(true);
    expect(() => clamp01(NaN)).not.toThrow();
  });

  it('-0/+0 边界与内联参照按 Object.is 完全一致', () => {
    expect(Object.is(clamp01(-0), inlineClamp01(-0))).toBe(true);
    expect(Object.is(clamp01(0), inlineClamp01(0))).toBe(true);
  });

  it('大量随机/特殊输入上与内联参照结果完全一致', () => {
    const xs = [
      -Infinity, Infinity, NaN, 0, -0, 1, -1, 0.001, 0.999, 0.5, 0.55, 0.7, 0.6,
      0.05, 0.95, 0.01, 0.99, -1000, 1000, 2, 14, 30, 0.25, 0.4, 0.35,
    ];
    for (const x of xs) {
      const got = clamp01(x);
      const ref = inlineClamp01(x);
      if (Number.isNaN(ref)) {
        expect(Number.isNaN(got)).toBe(true);
      } else {
        expect(Object.is(got, ref)).toBe(true);
      }
    }
  });
});

describe('_mathUtils.round3 — 与抽取前 2 处内联实现逐字等价', () => {
  it('四舍五入到 3 位小数', () => {
    expect(round3(0.123456)).toBe(0.123);
    expect(round3(0.1235)).toBe(0.124);
    expect(round3(1)).toBe(1);
    expect(round3(0)).toBe(0);
    expect(round3(0.9999)).toBe(1);
  });

  it('负数与大数', () => {
    expect(round3(-0.123456)).toBe(-0.123);
    expect(round3(1234.56789)).toBe(1234.568);
  });

  it('NaN 透传为 NaN，不抛错', () => {
    expect(Number.isNaN(round3(NaN))).toBe(true);
    expect(() => round3(NaN)).not.toThrow();
  });

  it('大量输入上与内联参照结果完全一致（含 -0）', () => {
    const xs = [
      -Infinity, Infinity, NaN, 0, -0, 1, -1, 0.0005, 0.0004, 0.123456, 0.1235,
      0.9999, -0.123456, 1234.56789, 0.5, 0.333333, 0.666666,
    ];
    for (const x of xs) {
      const got = round3(x);
      const ref = inlineRound3(x);
      if (Number.isNaN(ref)) {
        expect(Number.isNaN(got)).toBe(true);
      } else {
        expect(Object.is(got, ref)).toBe(true);
      }
    }
  });
});

describe('去重后各模块仍可正常 import（无残留本地定义 / 无循环依赖）', () => {
  it('clamp01 的 5 个消费模块 + round3 的 2 个消费模块均可 import', async () => {
    const mods = await Promise.all([
      import('../../src/cognition/NoeReflectiveTuner.js'),
      import('../../src/cognition/NoeGoalSystem.js'),
      import('../../src/cognition/NoeWorkspace.js'),
      import('../../src/cognition/NoeMindVitals.js'),
      import('../../src/vision/NoeVisionSituation.js'),
      import('../../src/loop/NoeDriveSystem.js'),
    ]);
    for (const m of mods) expect(m).toBeTruthy();
  });
});
