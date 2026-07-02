import { afterEach, describe, expect, it } from 'vitest';
import {
  curiosityScore,
  beliefEntropy,
  createCuriosityDecompose,
} from '../../src/cognition/NoeCuriosityDecompose.js';

// 确定性测试：不触网/不碰时钟/不用 RNG/不调真模型。分布与标量均手工构造。
// 借鉴 pymdp EFE 二分解理念，验证 epistemic/pragmatic 拆分与信念熵。

describe('NoeCuriosityDecompose — 好奇二分解（借鉴 pymdp 期望自由能 EFE）', () => {
  describe('curiosityScore 核心：双因子加权 + label', () => {
    it('默认半饱和点对齐 2bit 好奇阈值：epistemic=2bit → 分量 0.5', () => {
      const r = curiosityScore({ epistemicValue: 2, pragmaticValue: 0 });
      // saturate(2, scale=2) = 2/(2+2) = 0.5
      expect(r.epistemic).toBeCloseTo(0.5, 9);
      // pragmatic=0 → 0；均权 → score = 0.5*0.5 + 0.5*0 = 0.25
      expect(r.pragmatic).toBe(0);
      expect(r.score).toBeCloseTo(0.25, 9);
    });

    it('epistemic 强主导（高惊奇、不贴偏好）→ label=epistemic', () => {
      const r = curiosityScore({ epistemicValue: 100, pragmaticValue: 0, surfaceThreshold: 0.4 });
      expect(r.epistemic).toBeGreaterThan(0.9); // saturate(100,2)≈0.98
      expect(r.pragmatic).toBe(0);
      // score ≈ 0.5*0.98 ≈ 0.49 > 0.4 阈值
      expect(r.score).toBeGreaterThan(0.4);
      expect(r.label).toBe('epistemic');
    });

    it('pragmatic 强主导（很贴 owner 偏好、信息增益小）→ label=pragmatic', () => {
      const r = curiosityScore({ epistemicValue: 0, pragmaticValue: 5, surfaceThreshold: 0.4 });
      expect(r.pragmatic).toBeGreaterThan(0.8); // saturate(5,1)≈0.83
      expect(r.epistemic).toBe(0);
      expect(r.label).toBe('pragmatic');
    });

    it('两因子接近（死区内）→ label=balanced', () => {
      // 取 epistemicValue=2(→0.5)、pragmaticValue=1(→0.5)，gap=0 落死区
      const r = curiosityScore({ epistemicValue: 2, pragmaticValue: 1, surfaceThreshold: 0.4 });
      expect(r.epistemic).toBeCloseTo(0.5, 9);
      expect(r.pragmatic).toBeCloseTo(0.5, 9);
      expect(r.score).toBeCloseTo(0.5, 9);
      expect(r.label).toBe('balanced');
    });

    it('分数不过阈值 → label=idle（别立目标）', () => {
      const r = curiosityScore({ epistemicValue: 0.2, pragmaticValue: 0.1, surfaceThreshold: 0.5 });
      expect(r.score).toBeLessThan(0.5);
      expect(r.label).toBe('idle');
    });

    it('权重可调：epistemic 权重拉满则只看 epistemic 分量', () => {
      const r = curiosityScore({
        epistemicValue: 2, // → 0.5
        pragmaticValue: 5, // → 0.83
        weights: { epistemic: 1, pragmatic: 0 },
      });
      expect(r.score).toBeCloseTo(0.5, 9); // 完全等于 epistemic 分量
    });

    it('权重自动归一化：{2,2} 与 {0.5,0.5} 等价', () => {
      const a = curiosityScore({ epistemicValue: 3, pragmaticValue: 0.5, weights: { epistemic: 2, pragmatic: 2 } });
      const b = curiosityScore({ epistemicValue: 3, pragmaticValue: 0.5, weights: { epistemic: 0.5, pragmatic: 0.5 } });
      expect(a.score).toBeCloseTo(b.score, 12);
    });

    it('单调性：epistemicValue 增大 → epistemic 分量与 score 单调不减', () => {
      const lo = curiosityScore({ epistemicValue: 1, pragmaticValue: 0 });
      const hi = curiosityScore({ epistemicValue: 5, pragmaticValue: 0 });
      expect(hi.epistemic).toBeGreaterThan(lo.epistemic);
      expect(hi.score).toBeGreaterThan(lo.score);
    });
  });

  describe('curiosityScore 边界 / fail-open：脏输入不崩、不返回 NaN', () => {
    it('空参数 → 全 0，label=idle', () => {
      const r = curiosityScore();
      expect(r.score).toBe(0);
      expect(r.epistemic).toBe(0);
      expect(r.pragmatic).toBe(0);
      expect(r.label).toBe('idle');
    });

    it('NaN / Infinity / 字符串输入 → 退化为 0，不抛、不 NaN', () => {
      const r = curiosityScore({ epistemicValue: NaN, pragmaticValue: Infinity });
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBe(0);
      const r2 = curiosityScore({ epistemicValue: 'abc', pragmaticValue: null });
      expect(r2.score).toBe(0);
    });

    it('负的 epistemicValue 按 0 处理（surprise 语义非负）', () => {
      const r = curiosityScore({ epistemicValue: -10, pragmaticValue: 0 });
      expect(r.epistemic).toBe(0);
      expect(r.score).toBe(0);
    });

    it('全零 / 负权重 → 退化为均权，不返回 NaN', () => {
      const zero = curiosityScore({ epistemicValue: 2, pragmaticValue: 1, weights: { epistemic: 0, pragmatic: 0 } });
      expect(zero.score).toBeCloseTo(0.5, 9); // 均权 → (0.5+0.5)/2
      const neg = curiosityScore({ epistemicValue: 2, pragmaticValue: 1, weights: { epistemic: -1, pragmatic: -1 } });
      expect(Number.isFinite(neg.score)).toBe(true);
      expect(neg.score).toBeCloseTo(0.5, 9);
    });

    it('score 始终夹在 [0,1]', () => {
      const r = curiosityScore({ epistemicValue: 1e9, pragmaticValue: 1e9 });
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.score).toBeGreaterThanOrEqual(0);
    });

    it('surfaceThreshold 越界被夹取，不破坏 label 判定', () => {
      const r = curiosityScore({ epistemicValue: 100, pragmaticValue: 100, surfaceThreshold: -5 });
      // 阈值夹到 0 → 必过阈；高分两因子均满 → balanced
      expect(r.label).not.toBe('idle');
    });
  });

  describe('beliefEntropy：信念熵（Neo 现状无此能力，真增量）', () => {
    it('均匀分布 → 归一熵 = 1（最不确定，最有 epistemic 价值）', () => {
      const r = beliefEntropy([0.25, 0.25, 0.25, 0.25]);
      expect(r.entropy).toBeCloseTo(2, 9); // log2(4)=2
      expect(r.normalized).toBeCloseTo(1, 9);
      expect(r.support).toBe(4);
    });

    it('确定分布（单点）→ 熵 = 0（无好奇价值）', () => {
      const r = beliefEntropy([1, 0, 0, 0]);
      expect(r.entropy).toBe(0); // 理论 0，且修掉 -0/浮点抖动
      expect(Object.is(r.entropy, -0)).toBe(false);
      expect(r.normalized).toBe(0);
      expect(r.support).toBe(1); // 仅 1 个 >0 项
    });

    it('未归一化的权重也能算（自动归一化）', () => {
      const a = beliefEntropy([2, 2, 2, 2]);
      const b = beliefEntropy([0.25, 0.25, 0.25, 0.25]);
      expect(a.entropy).toBeCloseTo(b.entropy, 12);
      expect(a.normalized).toBeCloseTo(b.normalized, 12);
    });

    it('归一熵对支撑数稳定：2 选项满熵 与 8 选项满熵 都 = 1（可横向比较）', () => {
      const two = beliefEntropy([0.5, 0.5]);
      const eight = beliefEntropy(new Array(8).fill(1));
      expect(two.normalized).toBeCloseTo(1, 9);
      expect(eight.normalized).toBeCloseTo(1, 9);
      // 但原始熵不同（信息量不同）
      expect(eight.entropy).toBeGreaterThan(two.entropy);
    });

    it('偏斜分布：归一熵介于 0 与 1 之间', () => {
      const r = beliefEntropy([0.9, 0.1]);
      expect(r.normalized).toBeGreaterThan(0);
      expect(r.normalized).toBeLessThan(1);
    });

    it('负项 / 零项被过滤，不影响有效支撑', () => {
      const r = beliefEntropy([0.5, 0.5, 0, -1]);
      expect(r.support).toBe(2);
      expect(r.normalized).toBeCloseTo(1, 9);
    });

    it('空 / 非数组 / 全零 / 全非法 → entropy=0（fail-open）', () => {
      expect(beliefEntropy([]).entropy).toBe(0);
      // @ts-expect-error 故意传非数组测鲁棒性
      expect(beliefEntropy(null).entropy).toBe(0);
      expect(beliefEntropy([0, 0, 0]).entropy).toBe(0);
      expect(beliefEntropy([NaN, Infinity, 'x']).entropy).toBe(0);
      expect(beliefEntropy([NaN, Infinity]).support).toBe(0);
    });

    it('信念熵可作为 epistemicValue 喂回 curiosityScore（端到端串联）', () => {
      const uncertain = beliefEntropy([0.25, 0.25, 0.25, 0.25]); // entropy=2bit
      const certain = beliefEntropy([1, 0, 0, 0]); // entropy=0
      const curiousAboutUncertain = curiosityScore({ epistemicValue: uncertain.entropy, pragmaticValue: 0, surfaceThreshold: 0.4 });
      const curiousAboutCertain = curiosityScore({ epistemicValue: certain.entropy, pragmaticValue: 0, surfaceThreshold: 0.4 });
      // 越不确定的信念，越值得好奇
      expect(curiousAboutUncertain.score).toBeGreaterThan(curiousAboutCertain.score);
      expect(curiousAboutCertain.label).toBe('idle');
    });
  });

  describe('createCuriosityDecompose 工厂：env 门控（默认 OFF）', () => {
    const ORIG = process.env.NOE_EFE_CURIOSITY;
    afterEach(() => {
      if (ORIG === undefined) delete process.env.NOE_EFE_CURIOSITY;
      else process.env.NOE_EFE_CURIOSITY = ORIG;
    });

    it('默认（env 未设）enabled=false', () => {
      delete process.env.NOE_EFE_CURIOSITY;
      expect(createCuriosityDecompose().enabled).toBe(false);
    });

    it('NOE_EFE_CURIOSITY=1 → enabled=true', () => {
      process.env.NOE_EFE_CURIOSITY = '1';
      expect(createCuriosityDecompose().enabled).toBe(true);
    });

    it('NOE_EFE_CURIOSITY 其他值（如 0/true）→ enabled=false（只认 "1"）', () => {
      process.env.NOE_EFE_CURIOSITY = '0';
      expect(createCuriosityDecompose().enabled).toBe(false);
      process.env.NOE_EFE_CURIOSITY = 'true';
      expect(createCuriosityDecompose().enabled).toBe(false);
    });

    it('显式 enabled 覆盖 env', () => {
      delete process.env.NOE_EFE_CURIOSITY;
      expect(createCuriosityDecompose({ enabled: true }).enabled).toBe(true);
      process.env.NOE_EFE_CURIOSITY = '1';
      expect(createCuriosityDecompose({ enabled: false }).enabled).toBe(false);
    });

    it('工厂绑定默认权重/阈值，score()/entropy() 可用且逐次可覆写', () => {
      const cur = createCuriosityDecompose({ weights: { epistemic: 1, pragmatic: 0 }, surfaceThreshold: 0.4 });
      const r = cur.score({ epistemicValue: 2, pragmaticValue: 5 });
      expect(r.score).toBeCloseTo(0.5, 9); // 绑定的 epistemic-only 权重生效
      // 逐次覆写权重
      const r2 = cur.score({ epistemicValue: 2, pragmaticValue: 5, weights: { epistemic: 0, pragmatic: 1 } });
      expect(r2.score).toBeGreaterThan(0.5);
      // entropy 直通
      expect(cur.entropy([0.5, 0.5]).normalized).toBeCloseTo(1, 9);
    });

    it('工厂不依赖时钟/网络/RNG：同输入恒同输出（确定性）', () => {
      const cur = createCuriosityDecompose({ enabled: true });
      const a = cur.score({ epistemicValue: 3, pragmaticValue: 0.7 });
      const b = cur.score({ epistemicValue: 3, pragmaticValue: 0.7 });
      expect(a).toEqual(b);
    });
  });
});
