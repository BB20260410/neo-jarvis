import { describe, expect, it } from 'vitest';
import {
  estimateVarianceFromVector,
  uncertaintyToVariance,
  fisherRaoRerank,
  makeFisherRaoReranker,
} from '../../src/memory/NoeFisherRaoReranker.js';
import { fisherRaoSimilarity } from '../../src/memory/NoeFisherRaoSimilarity.js';
import { cosineSim } from '../../src/embeddings/EmbeddingProvider.js';

const nz = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

describe('estimateVarianceFromVector', () => {
  it('常量/单元素/空 → 钳到 floor', () => {
    expect(estimateVarianceFromVector(null)).toBeCloseTo(1e-6, 12);
    expect(estimateVarianceFromVector([0.5])).toBeCloseTo(1e-6, 12);
    expect(estimateVarianceFromVector([3, 3, 3, 3])).toBeCloseTo(1e-6, 12); // 各维等值→样本方差0→floor
  });

  it('散布越大方差越大；scale 线性放大', () => {
    const tight = estimateVarianceFromVector([0.1, -0.1, 0.1, -0.1]);
    const wide = estimateVarianceFromVector([1, -1, 1, -1]);
    expect(wide).toBeGreaterThan(tight);
    expect(estimateVarianceFromVector([1, -1, 1, -1], { scale: 2 })).toBeCloseTo(wide * 2, 12);
  });

  it('等于总体样本方差(独立复算交叉验证)', () => {
    const v = [0.2, -0.4, 0.9, -0.7];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const ref = v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length;
    expect(estimateVarianceFromVector(v)).toBeCloseTo(ref, 12);
  });
});

describe('uncertaintyToVariance', () => {
  it('hit_count / salience 越高方差越小(越笃定)', () => {
    const cold = uncertaintyToVariance(1, { hitCount: 0, salience: 1 });
    const warm = uncertaintyToVariance(1, { hitCount: 50, salience: 5 });
    expect(warm).toBeLessThan(cold);
    expect(cold).toBeLessThanOrEqual(1); // factor 上限 1，不放大
  });

  it('factor 钳在 [min,1]，不会收得无限小', () => {
    const v = uncertaintyToVariance(1, { hitCount: 1e9, salience: 5, min: 0.25 });
    expect(v).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('非法基准方差回退到 floor 量级', () => {
    expect(uncertaintyToVariance(NaN, { hitCount: 0 })).toBeGreaterThan(0);
    expect(uncertaintyToVariance(-5, { hitCount: 0 })).toBeGreaterThan(0);
  });
});

describe('fisherRaoRerank', () => {
  it('空 hits / 无 queryVector → 原样返回(优雅退化)', () => {
    expect(fisherRaoRerank({ queryVector: [1, 0], hits: [] })).toEqual([]);
    const hits = [{ refId: 'a', vector: [1, 0] }];
    expect(fisherRaoRerank({ queryVector: null, hits })).toBe(hits);
  });

  it('核心：方差差异翻转 cosine 名次(证明 Fisher-Rao 真换了度量，非 cosine 恒等)', () => {
    const q = nz([1, 0, 0, 0]);
    const A = nz([0.96, 0.28, 0, 0]); // 与 q 余弦更近
    const B = nz([0.9, 0.436, 0, 0]); // 与 q 余弦略远
    // cosine 名次：A > B
    expect(cosineSim(A, q)).toBeGreaterThan(cosineSim(B, q));
    // 但 A 方差极小(过度自信)、B 方差大(宽容) → Fisher-Rao 名次翻转为 B > A
    const out = fisherRaoRerank({
      queryVector: q,
      queryVariance: 0.05,
      hits: [
        { refId: 'A', vector: A, variance: 0.001 },
        { refId: 'B', vector: B, variance: 0.5 },
      ],
    });
    expect(out.map((h) => h.refId)).toEqual(['B', 'A']);
    expect(out[0].fisherSim).toBeGreaterThan(out[1].fisherSim);
  });

  it('fisherSim 与 fisherRaoSimilarity 一致(无内部偷算)', () => {
    const q = nz([1, 0, 0]);
    const v = nz([0.7, 0.7, 0]);
    const [out] = fisherRaoRerank({ queryVector: q, queryVariance: 0.1, hits: [{ refId: 'x', vector: v, variance: 0.2 }] });
    expect(out.fisherSim).toBeCloseTo(fisherRaoSimilarity(q, 0.1, v, 0.2), 12);
  });

  it('缺 vector 的命中 sim=0 沉底且不抛错', () => {
    const q = nz([1, 0, 0]);
    const out = fisherRaoRerank({
      queryVector: q,
      hits: [
        { refId: 'novec' },
        { refId: 'hasvec', vector: nz([0.9, 0.1, 0]), variance: 0.1 },
      ],
    });
    expect(out.map((h) => h.refId)).toEqual(['hasvec', 'novec']);
    expect(out[out.length - 1].fisherSim).toBe(0);
  });

  it('缺 variance 时按各自向量估计(不崩，返回完整列表)', () => {
    const q = nz([1, 0, 0, 0]);
    const out = fisherRaoRerank({
      queryVector: q,
      hits: [
        { refId: 'a', vector: nz([0.9, 0.4, 0, 0]) },
        { refId: 'b', vector: nz([0.8, 0.6, 0, 0]) },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.every((h) => Number.isFinite(h.fisherSim))).toBe(true);
  });

  it('makeFisherRaoReranker 工厂等价直调', () => {
    const q = nz([1, 0, 0, 0]);
    const hits = [
      { refId: 'A', vector: nz([0.96, 0.28, 0, 0]), variance: 0.001 },
      { refId: 'B', vector: nz([0.9, 0.436, 0, 0]), variance: 0.5 },
    ];
    const rer = makeFisherRaoReranker({ scale: 1 });
    expect(rer(q, hits, 0.05).map((h) => h.refId)).toEqual(['B', 'A']);
  });
});
