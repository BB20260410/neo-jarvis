import { describe, it, expect } from 'vitest';
import { detectConsensus } from '../../src/room/learned/consensus-detector.js';

describe('detectConsensus', () => {
  it('returns no consensus for empty array', () => {
    expect(detectConsensus([])).toEqual({ consensus: false, score: 0, evidence: [] });
  });

  it('returns no consensus for non-array input', () => {
    expect(detectConsensus(null)).toEqual({ consensus: false, score: 0, evidence: [] });
    expect(detectConsensus(undefined)).toEqual({ consensus: false, score: 0, evidence: [] });
    expect(detectConsensus('not an array')).toEqual({ consensus: false, score: 0, evidence: [] });
  });

  it('detects consensus when recent turns contain multiple agreement markers (defaults)', () => {
    const turns = [
      { speaker: 'Alice', content: '我同意这个方案。' },
      { speaker: 'Bob', content: 'I agree, this works.' },
      { speaker: 'Carol', content: '达成共识。' },
    ];
    const result = detectConsensus(turns);
    expect(result.consensus).toBe(true);
    expect(result.score).toBeCloseTo(1);
    expect(result.evidence).toHaveLength(3);
  });

  it('does not reach consensus if any disagreement is present in window', () => {
    const turns = [
      { speaker: 'Alice', content: '我同意。' },
      { speaker: 'Bob', content: 'I agree.' },
      { speaker: 'Carol', content: '我不同意，这有问题。' },
    ];
    const result = detectConsensus(turns);
    expect(result.consensus).toBe(false);
    expect(result.score).toBeLessThan(1);
  });

  it('treats a turn as disagreement when both consensus and disagreement keywords match', () => {
    const turns = [
      { speaker: 'Alice', content: '我同意，但我不同意最终结论。' },
      { speaker: 'Bob', content: 'I agree.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 1 });
    expect(result.consensus).toBe(false);
    expect(result.evidence.some(e => e.includes('分歧'))).toBe(true);
  });

  it('respects window option to limit inspected recent turns', () => {
    const turns = [
      { speaker: 'Alice', content: '我同意。' },
      { speaker: 'Bob', content: 'I disagree with this.' },
      { speaker: 'Carol', content: 'I agree.' },
      { speaker: 'Dave', content: 'I agree.' },
    ];
    // window=2 → only Carol+Dave inspected; older disagreement ignored
    const result = detectConsensus(turns, { window: 2, minAgreed: 2 });
    expect(result.consensus).toBe(true);
  });

  it('respects minAgreed threshold', () => {
    const turns = [
      { speaker: 'Alice', content: '我同意。' },
      { speaker: 'Bob', content: 'Some neutral comment.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 2 });
    expect(result.consensus).toBe(false);
  });

  it('achieves consensus when minAgreed is 1', () => {
    const turns = [{ speaker: 'Alice', content: 'I agree.' }];
    const result = detectConsensus(turns, { window: 1, minAgreed: 1 });
    expect(result.consensus).toBe(true);
    expect(result.score).toBe(1);
  });

  it('computes score as (agreed - disagreed) divided by window length', () => {
    const turns = [
      { speaker: 'A', content: '我同意。' },
      { speaker: 'B', content: 'I disagree.' },
      { speaker: 'C', content: 'I agree.' },
    ];
    const result = detectConsensus(turns, { window: 3, minAgreed: 2 });
    // agreed=2, disagreed=1, recent.length=3 → score = 1/3
    expect(result.score).toBeCloseTo(1 / 3);
    expect(result.consensus).toBe(false);
  });

  it('uses "?" placeholder when speaker is missing in evidence', () => {
    const turns = [
      { content: 'I agree.' },
      { content: 'I agree.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 2 });
    expect(result.evidence[0]).toContain('[?]');
    expect(result.evidence[1]).toContain('[?]');
    expect(result.consensus).toBe(true);
  });

  it('handles missing turn content gracefully', () => {
    const turns = [
      { speaker: 'A' }, // no content
      { speaker: 'B', content: 'I agree.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 1 });
    expect(result.consensus).toBe(true);
    expect(result.evidence).toHaveLength(1);
  });

  it('matches keywords case-insensitively', () => {
    const turns = [
      { speaker: 'A', content: 'I AGREE.' },
      { speaker: 'B', content: 'WE AGREE.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 2 });
    expect(result.consensus).toBe(true);
  });

  it('returns zero score and empty evidence when no keywords match', () => {
    const turns = [
      { speaker: 'A', content: '我们继续讨论一下。' },
      { speaker: 'B', content: 'Let me think about this.' },
    ];
    const result = detectConsensus(turns);
    expect(result.consensus).toBe(false);
    expect(result.score).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  it('records the matched keyword in evidence strings', () => {
    const turns = [
      { speaker: 'A', content: '我同意这个方案。' },
      { speaker: 'B', content: 'I agree with that.' },
    ];
    const result = detectConsensus(turns, { window: 2, minAgreed: 2 });
    expect(result.evidence[0]).toContain('我同意');
    expect(result.evidence[1]).toContain('i agree');
  });

  it('handles window larger than turns length without crashing', () => {
    const turns = [
      { speaker: 'A', content: 'I agree.' },
      { speaker: 'B', content: 'I agree.' },
    ];
    const result = detectConsensus(turns, { window: 10, minAgreed: 2 });
    expect(result.consensus).toBe(true);
    expect(result.score).toBe(1);
  });

  it('emits negative score when disagreement dominates recent window', () => {
    const turns = [
      { speaker: 'A', content: 'I disagree.' },
      { speaker: 'B', content: 'I disagree.' },
      { speaker: 'C', content: '我同意。' },
    ];
    const result = detectConsensus(turns, { window: 3, minAgreed: 2 });
    expect(result.score).toBeLessThan(0);
    expect(result.consensus).toBe(false);
  });
});
