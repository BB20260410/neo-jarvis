// @ts-check
import { describe, expect, it } from 'vitest';
import {
  precisionAt,
  recallAt,
  scoreOneRun,
  passAtKForCase,
  wilsonInterval,
  aggregateBench,
  caseSchemaError,
  WILSON_Z,
} from '../../src/memory/NoeMemoryBenchScoring.js';

describe('NoeMemoryBenchScoring · precision/recall', () => {
  it('precision: empty selection with empty expectation = 1 (correctly selected nothing)', () => {
    expect(precisionAt([], [])).toBe(1);
  });
  it('precision: empty selection with non-empty expectation = 0', () => {
    expect(precisionAt([], ['a'])).toBe(0);
  });
  it('precision: half right', () => {
    expect(precisionAt(['a', 'x'], ['a', 'b'])).toBe(0.5);
  });
  it('recall: no expectation (negative sample) = 1', () => {
    expect(recallAt(['x'], [])).toBe(1);
  });
  it('recall: partial', () => {
    expect(recallAt(['a'], ['a', 'b'])).toBe(0.5);
  });
});

describe('NoeMemoryBenchScoring · scoreOneRun (execution-based)', () => {
  const exp = { id: 'c', expectedIds: ['a', 'b'], disallowedIds: ['bad'] };

  it('passes when all expected recalled, none disallowed', () => {
    const r = scoreOneRun({ selectedIds: ['a', 'b'], ok: true }, exp);
    expect(r.passed).toBe(true);
    expect(r.recall).toBe(1);
  });

  it('fails when a disallowed id is present (adversarial distractor)', () => {
    const r = scoreOneRun({ selectedIds: ['a', 'b', 'bad'], ok: true }, exp);
    expect(r.passed).toBe(false);
    expect(r.blockedIds).toEqual(['bad']);
  });

  it('fails when recall below minRecall (default 1 = need all)', () => {
    const r = scoreOneRun({ selectedIds: ['a'], ok: true }, exp);
    expect(r.passed).toBe(false);
    expect(r.recall).toBe(0.5);
  });

  it('honors partial minRecall', () => {
    const r = scoreOneRun({ selectedIds: ['a'], ok: true }, { ...exp, minRecall: 0.5 });
    expect(r.passed).toBe(true);
  });

  it('reverse probe: run that errored (ok=false) never passes', () => {
    const r = scoreOneRun({ selectedIds: ['a', 'b'], ok: false }, exp);
    expect(r.passed).toBe(false);
  });

  it('expectEmpty: passes only when nothing selected', () => {
    const empty = { id: 'neg', expectedIds: [], expectEmpty: true };
    expect(scoreOneRun({ selectedIds: [], ok: true }, empty).passed).toBe(true);
    expect(scoreOneRun({ selectedIds: ['x'], ok: true }, empty).passed).toBe(false);
  });

  it('matchScope=hit judges against hitIds not selectedIds', () => {
    const r = scoreOneRun({ selectedIds: [], hitIds: ['a', 'b'], ok: true }, { ...exp, matchScope: 'hit' });
    expect(r.passed).toBe(true);
  });
});

describe('NoeMemoryBenchScoring · passAtKForCase (pass^k)', () => {
  const exp = { id: 'c', questionType: 'single_hop', expectedIds: ['a'] };

  it('pass^k true only when ALL k runs pass', () => {
    const runs = [{ selectedIds: ['a'] }, { selectedIds: ['a'] }, { selectedIds: ['a'] }];
    const r = passAtKForCase(runs, exp);
    expect(r.k).toBe(3);
    expect(r.passedRuns).toBe(3);
    expect(r.passAtK).toBe(true);
  });

  it('reverse probe: one failing run among k → pass^k = false but pass@1 = true (flaky)', () => {
    const runs = [{ selectedIds: ['a'] }, { selectedIds: ['wrong'] }, { selectedIds: ['a'] }];
    const r = passAtKForCase(runs, exp);
    expect(r.passAtK).toBe(false);
    expect(r.passAt1).toBe(true);
  });

  it('reverse probe: all k runs fail → pass^k = 0/false', () => {
    const runs = [{ selectedIds: ['x'] }, { selectedIds: ['y'] }, { selectedIds: [] }];
    const r = passAtKForCase(runs, exp);
    expect(r.passedRuns).toBe(0);
    expect(r.passAtK).toBe(false);
    expect(r.passAt1).toBe(false);
  });

  it('k=0 (no runs) → cannot pass (never vacuously true)', () => {
    const r = passAtKForCase([], exp);
    expect(r.k).toBe(0);
    expect(r.passAtK).toBe(false);
  });
});

describe('NoeMemoryBenchScoring · wilsonInterval', () => {
  it('n=0 → all zeros, no NaN', () => {
    expect(wilsonInterval(0, 0)).toMatchObject({ point: 0, lower: 0, upper: 0, n: 0, method: 'wilson' });
  });

  it('all pass (n=n) → upper bound = 1, lower < 1', () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.point).toBe(1);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(1);
  });

  it('zero pass (x=0) → lower bound = 0, upper > 0 (does not collapse to point)', () => {
    const ci = wilsonInterval(0, 10);
    expect(ci.point).toBe(0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
  });

  it('half: interval brackets 0.5 and stays inside [0,1]', () => {
    const ci = wilsonInterval(18, 36);
    expect(ci.point).toBe(0.5);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(0.5);
    expect(ci.upper).toBeGreaterThan(0.5);
    expect(ci.upper).toBeLessThan(1);
  });

  it('matches a known Wilson value (x=20,n=36,z=1.96) within tolerance', () => {
    // Reference: phat=0.5556, Wilson 95% ≈ [0.3958, 0.7046]
    const ci = wilsonInterval(20, 36, 1.96);
    expect(ci.point).toBeCloseTo(0.5556, 3);
    expect(ci.lower).toBeCloseTo(0.3958, 2);
    expect(ci.upper).toBeCloseTo(0.7046, 2);
  });

  it('clamps successes to [0,total]', () => {
    expect(wilsonInterval(50, 10).point).toBe(1);
    expect(wilsonInterval(-5, 10).point).toBe(0);
  });
});

describe('NoeMemoryBenchScoring · aggregateBench', () => {
  it('aggregates pass^k, pass@1, flaky and per-type intervals', () => {
    const cases = [
      { passAtK: true, passAt1: true, questionType: 'single_hop', k: 5 },
      { passAtK: false, passAt1: true, questionType: 'single_hop', k: 5 }, // flaky
      { passAtK: true, passAt1: true, questionType: 'temporal', k: 5 },
      { passAtK: false, passAt1: false, questionType: 'adversarial', k: 5 },
    ];
    const agg = aggregateBench(cases, { k: 5 });
    expect(agg.summary).toMatchObject({ cases: 4, passedAtK: 2, passedAt1: 3, flaky: 1 });
    expect(agg.passAtK.method).toBe('wilson');
    expect(agg.byQuestionType.single_hop).toMatchObject({ total: 2, passed: 1 });
    expect(agg.byQuestionType.adversarial).toMatchObject({ total: 1, passed: 0 });
    expect(agg.confidence.level).toBe('95%');
  });

  it('empty case set does not crash (reverse probe: empty bench)', () => {
    const agg = aggregateBench([], { k: 5 });
    expect(agg.summary).toMatchObject({ cases: 0, passedAtK: 0 });
    expect(agg.passAtK.point).toBe(0);
  });

  it('P2 ⑤: k=0 cases are excluded from the denominator (not counted as failures)', () => {
    const cases = [
      { passAtK: true, passAt1: true, questionType: 'single_hop', k: 5 },
      { passAtK: false, passAt1: false, questionType: 'single_hop', k: 0 }, // never ran → must not dilute
    ];
    const agg = aggregateBench(cases, { k: 5 });
    expect(agg.summary).toMatchObject({ cases: 1, passedAtK: 1, skippedNoRun: 1 });
    expect(agg.passAtK.point).toBe(1); // 1/1, not 1/2
  });

  it('P2 ⑤: questionType is lowercased + trimmed before bucketing', () => {
    const cases = [
      { passAtK: true, passAt1: true, questionType: 'Single_Hop', k: 5 },
      { passAtK: true, passAt1: true, questionType: ' single_hop ', k: 5 },
    ];
    const agg = aggregateBench(cases, { k: 5 });
    expect(Object.keys(agg.byQuestionType)).toEqual(['single_hop']);
    expect(agg.byQuestionType.single_hop).toMatchObject({ total: 2, passed: 2 });
  });

  it('surfaces schemaErrors count from case results', () => {
    const cases = [
      { passAtK: false, passAt1: false, questionType: 'single_hop', schemaError: 'empty_expected_without_expectEmpty', k: 5 },
      { passAtK: true, passAt1: true, questionType: 'single_hop', k: 5 },
    ];
    const agg = aggregateBench(cases, { k: 5 });
    expect(agg.summary.schemaErrors).toBe(1);
  });
});

describe('NoeMemoryBenchScoring · P0 ① over-recall guard (maxSelected)', () => {
  it('reverse probe: return-all (recall=1 but floods selected) is REJECTED by maxSelected', () => {
    const exp = { id: 'c', expectedIds: ['a'], maxSelected: 3 };
    // 返回期望 a + 一大堆无关非 disallowed id → recall=1, 但 selectedCount 远超上限
    const flooded = ['a', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const r = scoreOneRun({ selectedIds: flooded, ok: true }, exp);
    expect(r.recall).toBe(1); // 召回确实全中
    expect(r.overRecall).toBe(true);
    expect(r.passed).toBe(false); // 但因 over-recall 被拦，不给免费高分
  });

  it('returning expected + a couple noise (within budget) still passes', () => {
    const exp = { id: 'c', expectedIds: ['a'], maxSelected: 3, minPrecision: 0.25 };
    const r = scoreOneRun({ selectedIds: ['a', 'n1', 'n2'], ok: true }, exp);
    expect(r.overRecall).toBe(false);
    expect(r.passed).toBe(true);
  });

  it('default maxSelected (no explicit) = expectedCount + 3; floods beyond it fail', () => {
    const exp = { id: 'c', expectedIds: ['a', 'b'] }; // default max = 5
    const ok = scoreOneRun({ selectedIds: ['a', 'b', 'n1', 'n2', 'n3'], ok: true }, exp);
    expect(ok.maxSelected).toBe(5);
    expect(ok.overRecall).toBe(false);
    const bad = scoreOneRun({ selectedIds: ['a', 'b', 'n1', 'n2', 'n3', 'n4'], ok: true }, exp);
    expect(bad.overRecall).toBe(true);
    expect(bad.passed).toBe(false);
  });

  it('minPrecision floor: expected present but mostly junk fails on precision', () => {
    const exp = { id: 'c', expectedIds: ['a'], maxSelected: 10, minPrecision: 0.5 };
    const r = scoreOneRun({ selectedIds: ['a', 'n1', 'n2', 'n3'], ok: true }, exp); // P=0.25 < 0.5
    expect(r.overRecall).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('expectEmpty case has maxSelected=0; any selection is over-recall', () => {
    const exp = { id: 'neg', expectedIds: [], expectEmpty: true };
    const r = scoreOneRun({ selectedIds: ['x'], ok: true }, exp);
    expect(r.maxSelected).toBe(0);
    expect(r.passed).toBe(false);
  });
});

describe('NoeMemoryBenchScoring · P0 ① schema error (empty expected without expectEmpty)', () => {
  it('caseSchemaError flags empty expectedIds when expectEmpty not set', () => {
    expect(caseSchemaError({ id: 'c', expectedIds: [] })).toBe('empty_expected_without_expectEmpty');
    expect(caseSchemaError({ id: 'c', expectedIds: [], expectEmpty: true })).toBeNull();
    expect(caseSchemaError({ id: 'c', expectedIds: ['a'] })).toBeNull();
  });

  it('a schema-broken case can never pass (would otherwise be a vacuous free pass)', () => {
    const broken = { id: 'c', questionType: 'single_hop', expectedIds: [] }; // empty + not expectEmpty
    // 即便 run 返回空（recall 对空期望=1、precision=1），schemaError 也强制 fail
    const r = passAtKForCase([{ selectedIds: [], ok: true }], broken);
    expect(r.schemaError).toBe('empty_expected_without_expectEmpty');
    expect(r.passAtK).toBe(false);
    expect(r.passAt1).toBe(false);
  });
});

describe('NoeMemoryBenchScoring · P2 ⑤ wilsonInterval edge cases', () => {
  it('negative z is treated as |z| (abs), not garbage', () => {
    const neg = wilsonInterval(20, 36, -1.959964);
    const pos = wilsonInterval(20, 36, 1.959964);
    expect(neg.z).toBeCloseTo(1.959964, 5);
    expect(neg.lower).toBe(pos.lower);
    expect(neg.upper).toBe(pos.upper);
  });

  it('non-finite z falls back to 95%, never NaN', () => {
    const ci = wilsonInterval(20, 36, NaN);
    expect(ci.z).toBeCloseTo(WILSON_Z['95%'], 5);
    expect(Number.isNaN(ci.lower)).toBe(false);
    expect(Number.isNaN(ci.upper)).toBe(false);
  });

  it('exact z constant: 95% uses 1.959964 (not the 1.96 approximation)', () => {
    expect(WILSON_Z['95%']).toBeCloseTo(1.959964, 6);
    // aggregateBench default labels as 95% and uses the exact z
    const agg = aggregateBench([{ passAtK: true, passAt1: true, questionType: 't', k: 5 }]);
    expect(agg.confidence.level).toBe('95%');
    expect(agg.confidence.z).toBeCloseTo(1.959964, 5);
  });

  it('unknown z gets an honest custom label, not a fake 95%', () => {
    const agg = aggregateBench([{ passAtK: true, passAt1: true, questionType: 't', k: 5 }], { z: 1.23 });
    expect(agg.confidence.level).toMatch(/^custom\(z=1\.23/);
  });
});
