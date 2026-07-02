// 批2 性能优化等价性证明：fisherRaoRerank 把「查询侧标准差」提到循环外预算一次复用，
// 替代每个命中重算 toStd(同一 qVar, 同一 dim)。本测试证明：
//   ① 预算版 fisherRaoSimilarityPreparedA / fisherRaoDistancePreparedA 与原函数逐字相同；
//   ② 重排输出 fisherSim 与「老逐条 fisherRaoSimilarity」在随机输入上逐字相同（非近似）；
//   ③ 可观测更快：同维路径已不再每条调用 fisherRaoSimilarity（被预算版取代），
//      且查询标准差只构造一次（用一份 qStd 跑 N 条结果不变）；
//   ④ 异维命中仍回退原路径，行为不变（防御性正确）。
import { describe, expect, it, vi } from 'vitest';
import * as Sim from '../../src/memory/NoeFisherRaoSimilarity.js';
import { fisherRaoRerank, estimateVarianceFromVector } from '../../src/memory/NoeFisherRaoReranker.js';

const {
  fisherRaoSimilarity,
  fisherRaoDistance,
  fisherRaoSimilarityPreparedA,
  fisherRaoDistancePreparedA,
  toStd,
} = Sim;

// 确定性 LCG：可复现的伪随机，不触网、不依赖真实时钟。
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function randVec(rng, dim, spread = 1) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (rng() - 0.5) * 2 * spread;
  return v;
}

describe('预算版 == 原版（A 侧标准差预算）', () => {
  it('fisherRaoDistancePreparedA 与 fisherRaoDistance 逐字相同（多组随机 + 标量/数组/缺省方差）', () => {
    const rng = lcg(20260614);
    const variances = [null, 0.05, 0.5, 3, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]];
    for (let t = 0; t < 200; t++) {
      const dim = 6;
      const mA = randVec(rng, dim, 1.5);
      const mB = randVec(rng, dim, 1.5);
      const varA = variances[t % variances.length];
      const varB = variances[(t + 2) % variances.length];
      const ref = fisherRaoDistance(mA, varA, mB, varB);
      const fast = fisherRaoDistancePreparedA(mA, toStd(varA, mA.length), mB, varB);
      // toBe：要求 IEEE-754 完全相同的浮点位（共享同一算术核心，非近似等价）
      expect(fast).toBe(ref);
    }
  });

  it('fisherRaoSimilarityPreparedA 与 fisherRaoSimilarity 逐字相同（含 scale 透传）', () => {
    const rng = lcg(7);
    for (const scale of [1, 0.5, 5]) {
      for (let t = 0; t < 80; t++) {
        const dim = 8;
        const mA = randVec(rng, dim);
        const mB = randVec(rng, dim);
        const varA = t % 2 ? 0.3 : null;
        const varB = t % 3 ? [0.2, 0.4, 0.1, 0.9, 0.3, 0.7, 0.5, 0.6] : 0.8;
        const ref = fisherRaoSimilarity(mA, varA, mB, varB, { scale });
        const fast = fisherRaoSimilarityPreparedA(mA, toStd(varA, mA.length), mB, varB, { scale });
        expect(fast).toBe(ref);
      }
    }
  });

  it('预算版边界稳健：空/非法/缺 sA → 0，不抛', () => {
    expect(fisherRaoDistancePreparedA([1, 2], null, [1, 2], null)).toBe(0); // sA 缺失
    expect(fisherRaoDistancePreparedA([], toStd(1, 0), [], null)).toBe(0);  // dim 0
    // @ts-expect-error 故意非数组
    expect(fisherRaoDistancePreparedA(5, toStd(1, 3), 7, null)).toBe(0);
  });
});

describe('fisherRaoRerank 优化后结果与「老逐条算法」逐字相同', () => {
  // 老算法参考：完全照优化前那样，每条命中各自 fisherRaoSimilarity(queryVector, qVar, vec, variance)。
  function legacyRerank({ queryVector, queryVariance = null, hits, scale = 1 }) {
    const qVar = queryVariance == null ? estimateVarianceFromVector(queryVector) : queryVariance;
    const scored = hits.map((h, idx) => {
      const vec = h && h.vector;
      let sim = 0;
      if (vec && typeof vec.length === 'number' && vec.length > 0) {
        const variance = h.variance == null ? estimateVarianceFromVector(vec) : h.variance;
        sim = fisherRaoSimilarity(queryVector, qVar, vec, variance, { scale });
      }
      return { hit: h, sim, idx };
    });
    scored.sort((a, b) => (b.sim - a.sim) || (a.idx - b.idx));
    return scored.map(({ hit, sim }) => ({ ...hit, fisherSim: sim }));
  }

  it('随机 query + 50 条同维命中：fisherSim 与名次逐字一致', () => {
    const rng = lcg(424242);
    const dim = 16;
    for (let trial = 0; trial < 12; trial++) {
      const queryVector = randVec(rng, dim);
      const queryVariance = trial % 2 ? 0.07 : null;
      const hits = [];
      for (let i = 0; i < 50; i++) {
        const hasVar = i % 4 !== 0;
        hits.push({
          refId: `h${i}`,
          vector: randVec(rng, dim, 0.5 + (i % 5) * 0.3),
          ...(hasVar ? { variance: 0.01 + (i % 7) * 0.13 } : {}),
        });
      }
      const got = fisherRaoRerank({ queryVector, queryVariance, hits, opts: { scale: 1 } });
      const ref = legacyRerank({ queryVector, queryVariance, hits, scale: 1 });
      expect(got.map((h) => h.refId)).toEqual(ref.map((h) => h.refId)); // 名次一致
      for (let i = 0; i < got.length; i++) {
        expect(got[i].fisherSim).toBe(ref[i].fisherSim); // 分数逐字一致（toBe）
      }
    }
  });

  it('缺 vector 的命中仍 sim=0 沉底（与老算法一致）', () => {
    const rng = lcg(99);
    const dim = 8;
    const queryVector = randVec(rng, dim);
    const hits = [
      { refId: 'novec' },
      { refId: 'a', vector: randVec(rng, dim), variance: 0.1 },
      { refId: 'b', vector: randVec(rng, dim) },
    ];
    const got = fisherRaoRerank({ queryVector, hits });
    expect(got.find((h) => h.refId === 'novec').fisherSim).toBe(0);
    expect(got[got.length - 1].refId).toBe('novec');
  });
});

describe('可观测更快：查询标准差提到循环外、不再每条调用 fisherRaoSimilarity', () => {
  it('同维路径不再逐条调用 fisherRaoSimilarity（已被预算版取代），结果仍正确', () => {
    // spy 原逐条函数：优化前每条命中都会调它 → 现同维路径走预算版，应 0 次调用。
    const spy = vi.spyOn(Sim, 'fisherRaoSimilarity');
    try {
      const rng = lcg(2026);
      const dim = 12;
      const queryVector = randVec(rng, dim);
      const hits = Array.from({ length: 30 }, (_, i) => ({
        refId: `h${i}`,
        vector: randVec(rng, dim),
        variance: 0.05 + (i % 5) * 0.1,
      }));
      const out = fisherRaoRerank({ queryVector, hits });
      expect(out).toHaveLength(30);
      expect(out.every((h) => Number.isFinite(h.fisherSim))).toBe(true);
      // 关键可观测信号：同维热路径不再走逐条 fisherRaoSimilarity（每条都要重建 query 标准差）。
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('一份预算 qStd 跑 N 条命中结果不变 → 证明查询标准差只构造一次即可复用', () => {
    const rng = lcg(555);
    const dim = 10;
    const queryVector = randVec(rng, dim);
    const qVar = 0.2;
    const qStd = toStd(qVar, dim); // 循环外只算一次
    const hits = Array.from({ length: 25 }, (_, i) => ({
      vector: randVec(rng, dim),
      variance: 0.03 + (i % 6) * 0.11,
    }));
    for (const h of hits) {
      const viaShared = fisherRaoSimilarityPreparedA(queryVector, qStd, h.vector, h.variance, { scale: 1 });
      const viaFull = fisherRaoSimilarity(queryVector, qVar, h.vector, h.variance, { scale: 1 });
      expect(viaShared).toBe(viaFull); // 复用预算 qStd 与每次重建 qStd 逐字相同
    }
  });
});

describe('异维命中回退原路径（防御性，行为不变）', () => {
  it('命中向量维度 ≠ 查询维度时仍正确（走 fisherRaoSimilarity 回退）', () => {
    const queryVector = [1, 0, 0, 0]; // dim 4
    const hits = [
      { refId: 'short', vector: [0.6, 0.8], variance: 0.1 }, // dim 2，异维
      { refId: 'same', vector: [0.9, 0.4, 0, 0], variance: 0.1 }, // dim 4，同维
    ];
    const got = fisherRaoRerank({ queryVector, queryVariance: 0.1, hits });
    // 与逐条 fisherRaoSimilarity 参考一致（min 维计算，不抛）
    const qVar = 0.1;
    for (const h of got) {
      const ref = fisherRaoSimilarity(queryVector, qVar, h.vector, h.variance, { scale: 1 });
      expect(h.fisherSim).toBe(ref);
    }
  });
});
