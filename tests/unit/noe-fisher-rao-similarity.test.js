import { describe, expect, it } from 'vitest';
import {
  distanceToSimilarity,
  fisherRaoDistance,
  fisherRaoSimilarity,
  makeFisherRaoSimilarity,
  stableArccosh,
} from '../../src/memory/NoeFisherRaoSimilarity.js';

// 参考实现：直接用标准 log 公式独立复算一份闭式解，与被测模块交叉验证（不依赖其内部数值技巧）。
function refAcosh(x) {
  return x <= 1 ? 0 : Math.log(x + Math.sqrt(x * x - 1));
}
function refFRDistance(mA, vA, mB, vB) {
  const dim = Math.min(mA.length, mB.length);
  let sq = 0;
  for (let i = 0; i < dim; i++) {
    const s1 = Math.sqrt(Math.max(1e-12, vA?.[i] ?? 1));
    const s2 = Math.sqrt(Math.max(1e-12, vB?.[i] ?? 1));
    const dm = mA[i] - mB[i];
    const ds = s1 - s2;
    const delta = (dm * dm + 2 * ds * ds) / (4 * s1 * s2);
    const di = Math.SQRT2 * refAcosh(1 + delta);
    sq += di * di;
  }
  return Math.sqrt(sq);
}

describe('stableArccosh', () => {
  it('x<=1 钳为 0（含数值噪声略小于 1）', () => {
    expect(stableArccosh(1)).toBe(0);
    expect(stableArccosh(0.5)).toBe(0);
    expect(stableArccosh(1 - 1e-15)).toBe(0);
  });

  it('大 x 与标准公式一致', () => {
    for (const x of [2, 5, 10, 100]) {
      expect(stableArccosh(x)).toBeCloseTo(Math.log(x + Math.sqrt(x * x - 1)), 12);
    }
  });

  it('x→1⁺ 的 Taylor 分支仍逼近真值（数值稳定）', () => {
    const x = 1 + 1e-9;
    // 真值参照高精度展开 √(2t)
    expect(stableArccosh(x)).toBeCloseTo(Math.sqrt(2e-9), 9);
    expect(Number.isFinite(stableArccosh(x))).toBe(true);
  });

  it('非法输入返回 0', () => {
    expect(stableArccosh(NaN)).toBe(0);
    expect(stableArccosh(Infinity === Infinity ? -1 : 0)).toBe(0);
  });
});

describe('fisherRaoDistance — 核心性质', () => {
  it('同分布距离为 0', () => {
    expect(fisherRaoDistance([1, 2, 3], [1, 1, 1], [1, 2, 3], [1, 1, 1])).toBeCloseTo(0, 12);
    expect(fisherRaoDistance([0.5, -0.5], null, [0.5, -0.5], null)).toBeCloseTo(0, 12);
  });

  it('恒非负', () => {
    expect(fisherRaoDistance([1, 0], [2, 0.5], [-1, 3], [0.1, 4])).toBeGreaterThanOrEqual(0);
  });

  it('对称 d(A,B)=d(B,A)', () => {
    const d1 = fisherRaoDistance([1, 2], [0.5, 2], [3, -1], [1, 0.3]);
    const d2 = fisherRaoDistance([3, -1], [1, 0.3], [1, 2], [0.5, 2]);
    expect(d1).toBeCloseTo(d2, 12);
  });

  it('与独立参考实现逐字一致（交叉验证闭式解）', () => {
    const mA = [0.2, -1.4, 3.1];
    const vA = [0.5, 2.0, 0.1];
    const mB = [1.0, -0.5, 2.0];
    const vB = [1.5, 0.3, 0.9];
    expect(fisherRaoDistance(mA, vA, mB, vB)).toBeCloseTo(refFRDistance(mA, vA, mB, vB), 12);
  });

  it('均值分离越大、距离越大（对均值单调）', () => {
    const near = fisherRaoDistance([0, 0], [1, 1], [0.5, 0], [1, 1]);
    const far = fisherRaoDistance([0, 0], [1, 1], [2.0, 0], [1, 1]);
    expect(near).toBeLessThan(far);
  });

  it('不确定度更大（方差更大）时，同样均值差产生更小距离（更宽容）', () => {
    const tight = fisherRaoDistance([0], [0.01], [1], [0.01]); // 都很确定
    const loose = fisherRaoDistance([0], [100], [1], [100]);   // 都很不确定
    expect(loose).toBeLessThan(tight);
  });

  it('方差差异本身贡献距离（均值相同也可 > 0）', () => {
    const d = fisherRaoDistance([0, 0], [1, 1], [0, 0], [4, 0.25]);
    expect(d).toBeGreaterThan(0);
  });
});

describe('fisherRaoDistance — 退化≈cosine 行为', () => {
  // 在单位向量 + 等方差下，L2² = 2(1-cos)，FR 距离对 L2² 单调，故排序应与 cosine 完全一致。
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }
  const unit = (t) => [Math.cos(t), Math.sin(t)];

  it('缺省方差(null)与等方差标量结果一致', () => {
    const a = [1, 2, 3], b = [0, 1, -1];
    const dNull = fisherRaoDistance(a, null, b, null);
    const dScalar = fisherRaoDistance(a, 1, b, 1);
    expect(dNull).toBeCloseTo(dScalar, 12);
  });

  it('单位向量+等方差：FR 排序与 cosine 排序一致', () => {
    const q = unit(0);
    const cands = [unit(0.05), unit(0.4), unit(1.2), unit(2.5)];
    const byCos = [...cands].sort((x, y) => cosine(q, y) - cosine(q, x)).map((v) => v.join(','));
    const byFR = [...cands].sort(
      (x, y) => fisherRaoDistance(q, null, x, null) - fisherRaoDistance(q, null, y, null),
    ).map((v) => v.join(','));
    expect(byFR).toEqual(byCos); // cos 越大(越相似) ↔ FR 距离越小，名次完全对应
  });

  it('cosine 更相似的候选 → FR 距离更小', () => {
    const q = unit(0);
    const near = unit(0.1); // cos≈0.995
    const far = unit(1.0);  // cos≈0.540
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
    expect(fisherRaoDistance(q, null, near, null)).toBeLessThan(fisherRaoDistance(q, null, far, null));
  });
});

describe('fisherRaoDistance — 边界与稳健性', () => {
  it('维度为 0 / 空数组 → 0', () => {
    expect(fisherRaoDistance([], null, [], null)).toBe(0);
    expect(fisherRaoDistance([], 1, [1, 2], 1)).toBe(0);
  });

  it('非法/缺失入参 → 0（不抛）', () => {
    // @ts-expect-error 故意传 null 验证容错
    expect(fisherRaoDistance(null, null, [1], null)).toBe(0);
    // @ts-expect-error 故意传 undefined
    expect(fisherRaoDistance([1], null, undefined, null)).toBe(0);
    // @ts-expect-error 故意传非数组
    expect(fisherRaoDistance(5, null, 7, null)).toBe(0);
  });

  it('维度不等时按较短维计算，不抛', () => {
    const d = fisherRaoDistance([1, 2, 3, 4], null, [1, 2], null);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(0, 12); // 前两维相等 → 0
  });

  it('方差为 0 被稳健化（不产生 NaN/Inf）', () => {
    const d = fisherRaoDistance([0, 0], [0, 0], [1, 1], [0, 0]);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });

  it('方差含负数/NaN 时回退为 1，不产生 NaN', () => {
    const d = fisherRaoDistance([0, 0], [-1, NaN], [1, 1], [1, 1]);
    expect(Number.isFinite(d)).toBe(true);
  });

  it('均值含非数字按 0 处理，不抛', () => {
    // @ts-expect-error 故意混入非数字
    const d = fisherRaoDistance([1, 'x'], null, [1, 0], null);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(0, 12);
  });
});

describe('distanceToSimilarity', () => {
  it('距离 0 → 相似度 1', () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  it('单调递减且落在 [0,1]', () => {
    const s1 = distanceToSimilarity(0.5);
    const s2 = distanceToSimilarity(2);
    const s3 = distanceToSimilarity(10);
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
    for (const s of [s1, s2, s3]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('scale 越大相似度衰减越慢', () => {
    expect(distanceToSimilarity(2, { scale: 5 })).toBeGreaterThan(distanceToSimilarity(2, { scale: 1 }));
  });

  it('非法距离/scale 稳健回退', () => {
    expect(distanceToSimilarity(NaN)).toBe(1);
    expect(distanceToSimilarity(-3)).toBe(1);
    expect(distanceToSimilarity(2, { scale: 0 })).toBeCloseTo(distanceToSimilarity(2, { scale: 1 }), 12);
    expect(distanceToSimilarity(2, { scale: -1 })).toBeCloseTo(distanceToSimilarity(2, { scale: 1 }), 12);
  });
});

describe('fisherRaoSimilarity — 组合入口', () => {
  it('同分布 → 1，越远 → 越小', () => {
    expect(fisherRaoSimilarity([1, 2], null, [1, 2], null)).toBe(1);
    const near = fisherRaoSimilarity([0, 0], 1, [0.2, 0], 1);
    const far = fisherRaoSimilarity([0, 0], 1, [3, 0], 1);
    expect(near).toBeGreaterThan(far);
  });

  it('结果恒在 [0,1]', () => {
    const s = fisherRaoSimilarity([5, -5, 5], [0.01, 0.01, 0.01], [-5, 5, -5], [10, 10, 10]);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('确定性：同输入多次调用结果完全相同', () => {
    const args = [[0.3, 1.1], [0.5, 2], [0.9, 0.2], [1, 0.3]];
    // @ts-ignore 解构传参
    const a = fisherRaoSimilarity(...args);
    // @ts-ignore
    const b = fisherRaoSimilarity(...args);
    expect(a).toBe(b);
  });
});

describe('makeFisherRaoSimilarity — 注入式工厂（给 NoeFusionRanker 当替代度量）', () => {
  it('默认 accessor 接受 {mean,variance} 对象', () => {
    const sim = makeFisherRaoSimilarity();
    const a = { mean: [0, 0], variance: [1, 1] };
    const b = { mean: [0.3, 0], variance: [1, 1] };
    const s = sim(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeCloseTo(fisherRaoSimilarity(a.mean, a.variance, b.mean, b.variance), 12);
  });

  it('默认 accessor 接受裸数组（无方差 → 退化接近 cosine 行为）', () => {
    const sim = makeFisherRaoSimilarity();
    const s = sim([1, 0], [Math.cos(0.2), Math.sin(0.2)]);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('自定义 accessor 可从条目结构里取 mean/variance', () => {
    const sim = makeFisherRaoSimilarity({
      accessor: (x) => ({ mean: x.emb, variance: x.var }),
    });
    const a = { id: 'a', emb: [0, 0], var: [1, 1] };
    const b = { id: 'b', emb: [0, 0], var: [1, 1] };
    expect(sim(a, b)).toBe(1); // 同分布
  });

  it('scale 透传影响衰减', () => {
    const a = { mean: [0, 0], variance: 1 };
    const b = { mean: [2, 0], variance: 1 };
    const tight = makeFisherRaoSimilarity({ scale: 1 })(a, b);
    const loose = makeFisherRaoSimilarity({ scale: 5 })(a, b);
    expect(loose).toBeGreaterThan(tight);
  });

  it('可直接当 weightedFusion 风格的排序键：按相似度降序排候选', () => {
    const q = { mean: [1, 0], variance: 1 };
    const sim = makeFisherRaoSimilarity();
    const cands = [
      { id: 'far', mean: [Math.cos(1.2), Math.sin(1.2)], variance: 1 },
      { id: 'near', mean: [Math.cos(0.1), Math.sin(0.1)], variance: 1 },
      { id: 'mid', mean: [Math.cos(0.6), Math.sin(0.6)], variance: 1 },
    ];
    const ranked = cands
      .map((c) => ({ id: c.id, score: sim(q, c) }))
      .sort((x, y) => y.score - x.score)
      .map((x) => x.id);
    expect(ranked).toEqual(['near', 'mid', 'far']);
  });
});