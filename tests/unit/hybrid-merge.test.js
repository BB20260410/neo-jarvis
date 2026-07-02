import { describe, it, expect } from 'vitest';
import { rrf, mergeHybrid } from '../../src/knowledge/learned/hybrid-merge.js';

describe('rrf', () => {
  it('returns empty array when input is empty', () => {
    expect(rrf([])).toEqual([]);
  });

  it('returns empty array when input is not an array', () => {
    expect(rrf(null)).toEqual([]);
    expect(rrf(undefined)).toEqual([]);
    expect(rrf('not-an-array')).toEqual([]);
  });

  it('skips non-array entries inside the list of lists', () => {
    const result = rrf([null, [{ id: 'a', score: 0.9 }], undefined]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('returns entries sorted by rrfScore descending', () => {
    const list = [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }, { id: 'c', score: 0.7 }],
    ];
    const result = rrf(list, 60);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('computes the correct RRF contribution per rank with default k=60', () => {
    const list = [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
    ];
    const result = rrf(list);
    // rank 1 -> 1/61, rank 2 -> 1/62
    expect(result[0].rrfScore).toBeCloseTo(1 / 61, 10);
    expect(result[1].rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it('accumulates score for docs appearing in multiple lists', () => {
    const lists = [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
      [{ id: 'a', score: 0.7 }, { id: 'c', score: 0.6 }],
    ];
    const result = rrf(lists, 60);
    const a = result.find((r) => r.id === 'a');
    expect(a.rrfScore).toBeCloseTo(2 / 61, 10);
    expect(a.sources).toHaveLength(2);
  });

  it('records sources with listIdx, rank, and originalScore', () => {
    const lists = [
      [{ id: 'a', score: 0.9 }],
      [{ id: 'a', score: 0.5 }],
    ];
    const result = rrf(lists, 60);
    expect(result[0].sources).toEqual([
      { listIdx: 0, rank: 1, originalScore: 0.9 },
      { listIdx: 1, rank: 1, originalScore: 0.5 },
    ]);
  });

  it('respects a custom k parameter', () => {
    const lists = [
      [{ id: 'a', score: 0.9 }],
      [{ id: 'b', score: 0.9 }],
    ];
    const result = rrf(lists, 0);
    // k=0, rank=1 => 1/1 each, tied scores
    expect(result[0].rrfScore).toBe(1);
    expect(result[1].rrfScore).toBe(1);
  });

  it('returns objects with id, rrfScore, and sources fields', () => {
    const result = rrf([[{ id: 'a', score: 0.9 }]]);
    expect(result[0]).toHaveProperty('id', 'a');
    expect(result[0]).toHaveProperty('rrfScore');
    expect(result[0]).toHaveProperty('sources');
    expect(Array.isArray(result[0].sources)).toBe(true);
  });
});

describe('mergeHybrid', () => {
  it('merges bm25 and vector results', () => {
    const bm25 = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }];
    const vector = [{ id: 'a', score: 0.8 }, { id: 'c', score: 0.6 }];
    const result = mergeHybrid(bm25, vector);
    expect(result).toHaveLength(3);
    // 'a' appears in both lists, so it should be on top
    expect(result[0].id).toBe('a');
  });

  it('limits the result by the topN option', () => {
    const bm25 = Array.from({ length: 20 }, (_, i) => ({
      id: `bm25-${i}`,
      score: 0.9 - i * 0.01,
    }));
    const vector = Array.from({ length: 20 }, (_, i) => ({
      id: `vec-${i}`,
      score: 0.9 - i * 0.01,
    }));
    const result = mergeHybrid(bm25, vector, { topN: 5 });
    expect(result).toHaveLength(5);
  });

  it('defaults topN to 10', () => {
    const bm25 = Array.from({ length: 15 }, (_, i) => ({
      id: `bm25-${i}`,
      score: 0.9 - i * 0.01,
    }));
    const vector = Array.from({ length: 15 }, (_, i) => ({
      id: `vec-${i}`,
      score: 0.9 - i * 0.01,
    }));
    const result = mergeHybrid(bm25, vector);
    expect(result).toHaveLength(10);
  });

  it('forwards the k option to rrf', () => {
    const bm25 = [{ id: 'a', score: 0.9 }];
    const vector = [{ id: 'b', score: 0.9 }];
    const result = mergeHybrid(bm25, vector, { k: 0 });
    expect(result[0].rrfScore).toBe(1);
    expect(result[1].rrfScore).toBe(1);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(mergeHybrid([], [])).toEqual([]);
  });

  it('every entry exposes rrfScore and sources', () => {
    const bm25 = [{ id: 'a', score: 0.9 }];
    const vector = [{ id: 'b', score: 0.8 }];
    const result = mergeHybrid(bm25, vector);
    for (const entry of result) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('rrfScore');
      expect(entry).toHaveProperty('sources');
      expect(Array.isArray(entry.sources)).toBe(true);
    }
  });
});
