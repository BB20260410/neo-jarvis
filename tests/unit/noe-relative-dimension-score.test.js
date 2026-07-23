// @ts-check
import { describe, expect, it } from 'vitest';
import {
  computeRelativeLabel,
  labelMatchesScores,
  recomputeDimensionRelative,
  PROXY_FORBIDDEN_DIMS,
  summarizeRelativeDimensions,
} from '../../src/runtime/NoeRelativeDimensionScore.js';

const REAL_EQUIVALENT_INPUTS = {
  measurementEquivalent: true,
  neoInputComplete: true,
  bailongmaInputComplete: true,
};

describe('NoeRelativeDimensionScore', () => {
  it('computes neo_leads only when neo > bl by lead epsilon', () => {
    const r = computeRelativeLabel(1, 0.5, REAL_EQUIVALENT_INPUTS);
    expect(r.relative).toBe('neo_leads');
    expect(r.lead).toBeCloseTo(0.5);
    expect(r.leadPp).toBeCloseTo(50);
  });

  it('computes neo_not_below when neo equals bl below ceiling', () => {
    const r = computeRelativeLabel(0.8, 0.8, REAL_EQUIVALENT_INPUTS);
    expect(r.relative).toBe('neo_not_below');
  });

  it('computes ceiling_tie when both at 1.0', () => {
    const r = computeRelativeLabel(1, 1, REAL_EQUIVALENT_INPUTS);
    expect(r.relative).toBe('ceiling_tie');
  });

  it('computes neo_below when neo < bl', () => {
    const r = computeRelativeLabel(0.5, 0.9, REAL_EQUIVALENT_INPUTS);
    expect(r.relative).toBe('neo_below');
    expect(r.relativeReason).toBe('neo_score_below_bailongma');
  });

  it('never labels neo_not_below when neoScore < blScore', () => {
    const r = computeRelativeLabel(0.2, 0.9, REAL_EQUIVALENT_INPUTS);
    expect(r.relative).not.toBe('neo_not_below');
    expect(r.relative).toBe('neo_below');
    const check = labelMatchesScores('neo_not_below', 0.2, 0.9, REAL_EQUIVALENT_INPUTS);
    expect(check.ok).toBe(false);
    expect(check.expected).toBe('neo_below');
  });

  it('marks missing scores non_comparable', () => {
    expect(computeRelativeLabel(1, null, REAL_EQUIVALENT_INPUTS).relative).toBe('non_comparable');
    expect(computeRelativeLabel(null, 1, REAL_EQUIVALENT_INPUTS).relative).toBe('non_comparable');
  });

  it('rejects inequivalent proxy measurements for D06/D09/D10/D11', () => {
    expect(PROXY_FORBIDDEN_DIMS).toEqual(['D06', 'D09', 'D10', 'D11']);
    for (const id of PROXY_FORBIDDEN_DIMS) {
      const row = recomputeDimensionRelative({
        id,
        neoScore: 1,
        bailongmaScore: 1,
        isProxy: true,
        measurementEquivalent: false,
      });
      expect(row.relative).toBe('non_comparable');
      expect(String(row.relativeReason)).toMatch(/proxy|equivalent|comparable/i);
    }
  });

  it('D08 is pending_owner_waived without claiming soak pass', () => {
    const row = recomputeDimensionRelative({
      id: 'D08',
      neoScore: null,
      bailongmaScore: null,
      pendingOwnerWaived: true,
    });
    expect(row.relative).toBe('pending_owner_waived');
  });

  it('recomputes labels from numbers even if a wrong hand label was provided', () => {
    const row = recomputeDimensionRelative({
      id: 'D03',
      neoScore: 0.4,
      bailongmaScore: 0.9,
      relative: 'neo_leads', // wrong hand label
      measurementEquivalent: true,
      isProxy: false,
      neoInputComplete: true,
      bailongmaInputComplete: true,
    });
    expect(row.relative).toBe('neo_below');
  });

  it('fails closed unless equivalence and complete real inputs are explicit', () => {
    expect(computeRelativeLabel(1, 0.5).relative).toBe('non_comparable');
    expect(
      computeRelativeLabel(1, 0.5, {
        measurementEquivalent: true,
        neoInputComplete: true,
        bailongmaInputComplete: false,
      }).relative,
    ).toBe('non_comparable');
    expect(
      computeRelativeLabel(1, 0.5, {
        ...REAL_EQUIVALENT_INPUTS,
        isProxy: true,
      }).relative,
    ).toBe('non_comparable');
  });

  it('keeps D07 and D12 non-comparable until both real inputs are complete', () => {
    for (const id of ['D07', 'D12']) {
      const incomplete = recomputeDimensionRelative({
        id,
        neoScore: 1,
        bailongmaScore: 0.5,
        measurementEquivalent: true,
        neoInputComplete: true,
        bailongmaInputComplete: false,
      });
      expect(incomplete.relative).toBe('non_comparable');

      const realPair = recomputeDimensionRelative({
        id,
        neoScore: 1,
        bailongmaScore: 0.5,
        ...REAL_EQUIVALENT_INPUTS,
      });
      expect(realPair.relative).toBe('neo_leads');
    }
  });

  it('separates stated, comparable, pass, non-comparable and pending counts', () => {
    const summary = summarizeRelativeDimensions([
      { id: 'D01', relative: 'neo_leads' },
      { id: 'D02', relative: 'non_comparable' },
      { id: 'D03', relative: 'neo_below' },
      { id: 'D08', relative: 'pending_owner_waived' },
      { id: 'D12', relative: 'pending' },
    ]);
    expect(summary).toMatchObject({
      total: 5,
      stated: 4,
      comparable: 2,
      relativePass: 1,
      nonComparable: 1,
      pending: 1,
      pendingOwnerWaived: 1,
      neoBelow: 1,
      relativePassBar: '1/5',
      statedBar: '4/5',
      complete: false,
    });
  });
});
