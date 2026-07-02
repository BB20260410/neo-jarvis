import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, weightedFusion } from '../../src/memory/NoeFusionRanker.js';

describe('reciprocalRankFusion', () => {
  it('两路都靠前的 id 融合后排第一', () => {
    const r = reciprocalRankFusion([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'b' }, { id: 'a' }, { id: 'd' }],
    ]);
    expect(r[0].id).toBe('a'); // a: rank1+rank2; b: rank2+rank1 → 接近，a 略高(1/61+1/62 vs 1/62+1/61 相等? 实为相等)
    // a 和 b 对称应相等，验证都在前两位
    expect(r.slice(0, 2).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('接受裸 id 数组', () => {
    const r = reciprocalRankFusion([['x', 'y'], ['y', 'x']]);
    expect(r.map((i) => i.id).sort()).toEqual(['x', 'y']);
  });

  it('空输入返回空', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion(null)).toEqual([]);
  });

  it('同一路内重复 id 只按最佳名次计一次(不重复累加扭曲融合)', () => {
    const withDup = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }, { id: 'a' }]]);
    const noDup = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]]);
    const a1 = withDup.find((x) => x.id === 'a').score;
    const a2 = noDup.find((x) => x.id === 'a').score;
    expect(a1).toBeCloseTo(a2);   // 修复前: a 出现两次被加 1/61+1/63，分数虚高
  });
});

describe('weightedFusion', () => {
  it('归一加权：向量权重更高时向量第一名胜出', () => {
    const v = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }];
    const f = [{ id: 'b', score: 10 }, { id: 'a', score: 2 }];
    const r = weightedFusion(v, f, { vectorWeight: 0.7, ftsWeight: 0.3 });
    expect(r[0].id).toBe('a'); // 向量权重大 + a 向量分高
  });

  it('只在一路出现的 id 也纳入', () => {
    const r = weightedFusion([{ id: 'a', score: 1 }], [{ id: 'b', score: 1 }]);
    expect(r.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('salience 二级权重温和提升重要记忆', () => {
    const v = [{ id: 'a', score: 1 }, { id: 'b', score: 1 }];
    const f = [{ id: 'a', score: 1 }, { id: 'b', score: 1 }];
    const r = weightedFusion(v, f, { salience: (id) => (id === 'b' ? 5 : 0) });
    expect(r[0].id).toBe('b'); // 同分时 salience 高的 b 胜出
  });

  it('空输入返回空', () => {
    expect(weightedFusion([], [])).toEqual([]);
  });

  it('负分(如 bm25)归一化稳健：归一到[0,1]不产生巨值', () => {
    const r = weightedFusion(
      [{ id: 'better', score: -1 }, { id: 'worse', score: -10 }],
      [],
      { vectorWeight: 1, ftsWeight: 0 },
    );
    expect(r[0].id).toBe('better');               // -1 > -10，约定下更相关
    expect(Number.isFinite(r[0].score)).toBe(true);
    expect(r[0].score).toBeGreaterThanOrEqual(0); // 修复前: 负分除以 1e-9 兜底 → -1e9 量级，远 < 0
    expect(r[0].score).toBeLessThanOrEqual(1.5);
  });
});
