import { describe, it, expect } from 'vitest';
import {
  computeEntropyTemperature,
  clusterEntropy,
  createEntropyTemperature,
} from '../../src/cognition/NoeEntropyTemperature.js';

// 确定性测试：不依赖网络/时钟/RNG/真模型。向量手工构造。

// 单位基向量（4 维），余弦正交，用于构造「分散」念头
const E = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

describe('NoeEntropyTemperature — 熵驱动温度（借鉴 giansha entropy_drive）', () => {
  describe('computeEntropyTemperature 核心：低熵升温 / 高熵回落', () => {
    it('念头全部相同（想腻了 ⇒ 熵≈0）⇒ 温度升到接近 base+α', () => {
      const same = [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]];
      const r = computeEntropyTemperature(same, { baseTemperature: 0.7, alpha: 0.4, beta: 4, maxTemperature: 1.5 });
      expect(r.clusters).toBe(1);
      expect(r.entropy).toBe(0);
      expect(r.boosted).toBe(true);
      // H=0 ⇒ boost=α ⇒ T=0.7+0.4=1.1
      expect(r.temperature).toBeCloseTo(1.1, 6);
    });

    it('念头两两正交（发散够了 ⇒ 熵≈1）⇒ 温度回落到接近 base', () => {
      const r = computeEntropyTemperature(E, { baseTemperature: 0.7, alpha: 0.4, beta: 4, k: 5 });
      expect(r.clusters).toBe(4);
      expect(r.entropy).toBeGreaterThan(0.95);
      // H≈1 ⇒ boost=α·exp(-4)≈0.0073 ⇒ T≈0.707
      expect(r.temperature).toBeLessThan(0.72);
      expect(r.temperature).toBeGreaterThan(0.7);
    });

    it('单调性：扎堆念头的温度严格高于分散念头的温度', () => {
      const same = [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
      const tSame = computeEntropyTemperature(same, { baseTemperature: 0.7 }).temperature;
      const tDiverse = computeEntropyTemperature(E, { baseTemperature: 0.7 }).temperature;
      expect(tSame).toBeGreaterThan(tDiverse);
    });

    it('部分扎堆（2 紧簇 + 2 散）⇒ 温度介于全同与全散之间', () => {
      const same = [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]];
      const mixed = [[1, 0, 0, 0], [0.98, 0.02, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
      const tSame = computeEntropyTemperature(same, { baseTemperature: 0.7 }).temperature;
      const tMixed = computeEntropyTemperature(mixed, { baseTemperature: 0.7 }).temperature;
      const tDiverse = computeEntropyTemperature(E, { baseTemperature: 0.7 }).temperature;
      expect(tMixed).toBeGreaterThanOrEqual(tDiverse);
      expect(tMixed).toBeLessThanOrEqual(tSame);
    });

    it('相同输入 ⇒ 相同输出（确定性，连跑 5 次不抖）', () => {
      const v = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 1, 0, 0]];
      const first = computeEntropyTemperature(v, { baseTemperature: 0.66 }).temperature;
      for (let i = 0; i < 5; i++) {
        expect(computeEntropyTemperature(v, { baseTemperature: 0.66 }).temperature).toBe(first);
      }
    });
  });

  describe('参数调节', () => {
    it('alpha 越大，扎堆时升温幅度越大', () => {
      const same = [[1, 0], [1, 0], [1, 0]];
      const lo = computeEntropyTemperature(same, { baseTemperature: 0.5, alpha: 0.2 }).temperature;
      const hi = computeEntropyTemperature(same, { baseTemperature: 0.5, alpha: 0.6 }).temperature;
      expect(hi).toBeGreaterThan(lo);
      expect(lo).toBeCloseTo(0.7, 6); // 0.5 + 0.2
      expect(hi).toBeCloseTo(1.1, 6); // 0.5 + 0.6
    });

    it('maxTemperature 夹取生效：升温不越上限', () => {
      const same = [[1, 0], [1, 0], [1, 0]];
      const r = computeEntropyTemperature(same, { baseTemperature: 0.9, alpha: 0.5, maxTemperature: 1.0 });
      expect(r.temperature).toBe(1.0); // 0.9+0.5=1.4 被夹到 1.0
    });

    it('baseTemperature 本身也被夹到 [min,max]', () => {
      const r = computeEntropyTemperature([], { baseTemperature: 5, maxTemperature: 1.2 });
      expect(r.temperature).toBe(1.2);
    });
  });

  describe('边界 / fail-open', () => {
    it('空数组 ⇒ 返回 base，不升温', () => {
      const r = computeEntropyTemperature([], { baseTemperature: 0.7 });
      expect(r.temperature).toBe(0.7);
      expect(r.entropy).toBe(null);
      expect(r.clusters).toBe(0);
      expect(r.boosted).toBe(false);
    });

    it('单个念头（信号不足）⇒ 返回 base，不升温', () => {
      const r = computeEntropyTemperature([[1, 2, 3]], { baseTemperature: 0.7 });
      expect(r.temperature).toBe(0.7);
      expect(r.entropy).toBe(null);
    });

    it('夹杂非法向量（null/空/含 NaN）被剔除，剩余照常算', () => {
      // @ts-ignore 故意传脏数据测健壮性
      const v = [null, [], [Number.NaN, 1], [1, 0, 0], [1, 0, 0], 'x', [1, 0, 0]];
      const r = computeEntropyTemperature(v, { baseTemperature: 0.7, alpha: 0.4 });
      // 三个有效且相同 ⇒ 1 簇 ⇒ 熵 0 ⇒ 升温
      expect(r.clusters).toBe(1);
      expect(r.temperature).toBeCloseTo(1.1, 6);
    });

    it('全是非法向量 ⇒ 退化为 base（fail-open）', () => {
      // @ts-ignore
      const r = computeEntropyTemperature([null, 'x', [], [Number.NaN]], { baseTemperature: 0.55 });
      expect(r.temperature).toBe(0.55);
      expect(r.entropy).toBe(null);
    });

    it('非数组输入 ⇒ fail-open 返回 base', () => {
      // @ts-ignore
      expect(computeEntropyTemperature(undefined, { baseTemperature: 0.7 }).temperature).toBe(0.7);
      // @ts-ignore
      expect(computeEntropyTemperature(42, { baseTemperature: 0.7 }).temperature).toBe(0.7);
    });

    it('零向量不抛错（归一化范数兜底）', () => {
      const r = computeEntropyTemperature([[0, 0, 0], [0, 0, 0]], { baseTemperature: 0.7 });
      expect(Number.isFinite(r.temperature)).toBe(true);
    });

    it('tau=0 不产生 NaN（除零兜底）', () => {
      const r = computeEntropyTemperature(E, { baseTemperature: 0.7, tau: 0 });
      expect(Number.isFinite(r.temperature)).toBe(true);
    });
  });

  describe('clusterEntropy 直测', () => {
    it('相同念头 ⇒ 1 簇 / 熵 0', () => {
      const s = clusterEntropy([[1, 0], [1, 0], [1, 0]]);
      expect(s).toEqual({ entropy: 0, clusters: 1 });
    });

    it('正交念头 ⇒ 多簇 / 熵接近 1', () => {
      const s = clusterEntropy(E, { k: 5 });
      expect(s.clusters).toBe(4);
      expect(s.entropy).toBeGreaterThan(0.95);
      expect(s.entropy).toBeLessThanOrEqual(1);
    });

    it('< 2 个有效向量 ⇒ null', () => {
      expect(clusterEntropy([])).toBe(null);
      expect(clusterEntropy([[1, 2]])).toBe(null);
    });

    it('熵恒在 [0,1]', () => {
      const s = clusterEntropy([[1, 0, 0], [0.5, 0.8, 0], [0, 0, 1], [0.7, 0, 0.7]], { k: 4 });
      expect(s.entropy).toBeGreaterThanOrEqual(0);
      expect(s.entropy).toBeLessThanOrEqual(1);
    });

    it('k 上限约束簇数（簇数不超过 k）', () => {
      const s = clusterEntropy(E, { k: 2, spawnSim: 0.6 });
      expect(s.clusters).toBeLessThanOrEqual(2);
    });
  });

  describe('createEntropyTemperature — env 门控（默认 OFF）', () => {
    const same = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];

    it('env 缺省 ⇒ OFF ⇒ 恒返回 base（零行为变化）', () => {
      const eng = createEntropyTemperature({ env: {} });
      expect(eng.enabled).toBe(false);
      const r = eng.temperature(same, { baseTemperature: 0.7, alpha: 0.4 });
      expect(r.enabled).toBe(false);
      expect(r.temperature).toBe(0.7); // OFF：不升温
      expect(r.entropy).toBe(null);
    });

    it('NOE_ENTROPY_TEMPERATURE=true ⇒ ON ⇒ 扎堆升温', () => {
      const eng = createEntropyTemperature({ env: { NOE_ENTROPY_TEMPERATURE: 'true' } });
      expect(eng.enabled).toBe(true);
      const r = eng.temperature(same, { baseTemperature: 0.7, alpha: 0.4 });
      expect(r.enabled).toBe(true);
      expect(r.temperature).toBeCloseTo(1.1, 6);
      expect(r.boosted).toBe(true);
    });

    it('NOE_ENTROPY_TEMPERATURE=1 也视为 ON', () => {
      const eng = createEntropyTemperature({ env: { NOE_ENTROPY_TEMPERATURE: '1' } });
      expect(eng.enabled).toBe(true);
    });

    it('显式 enabled 参数优先于 env（便于测试不碰 process.env）', () => {
      const onByFlag = createEntropyTemperature({ env: {}, enabled: true });
      expect(onByFlag.enabled).toBe(true);
      const offByFlag = createEntropyTemperature({ env: { NOE_ENTROPY_TEMPERATURE: 'true' }, enabled: false });
      expect(offByFlag.enabled).toBe(false);
      expect(offByFlag.temperature(same, { baseTemperature: 0.7 }).temperature).toBe(0.7);
    });

    it('config 默认参数 + 单次 overrides 合并', () => {
      const eng = createEntropyTemperature({ enabled: true, config: { baseTemperature: 0.5, alpha: 0.4 } });
      const a = eng.temperature(same);
      expect(a.temperature).toBeCloseTo(0.9, 6); // 0.5 + 0.4
      const b = eng.temperature(same, { alpha: 0.6 }); // override alpha
      expect(b.temperature).toBeCloseTo(1.1, 6); // 0.5 + 0.6
    });

    it('ON 但念头不足 ⇒ fail-open 回 base', () => {
      const eng = createEntropyTemperature({ enabled: true });
      expect(eng.temperature([], { baseTemperature: 0.6 }).temperature).toBe(0.6);
      expect(eng.temperature([[1, 2]], { baseTemperature: 0.6 }).temperature).toBe(0.6);
    });
  });
});
