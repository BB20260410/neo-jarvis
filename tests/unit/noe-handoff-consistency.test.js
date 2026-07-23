import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_MAX_LINES,
  READ_ORDER_STABLE_MARKERS,
  claudeHasReadOrderBoundary,
} from '../../scripts/noe-handoff-consistency.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realClaude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

describe('noe-handoff-consistency: read-order predicate is date-resilient but not watered down', () => {
  it('keeps HANDOFF_MAX_LINES default at 500 (extraction is behavior-preserving)', () => {
    expect(HANDOFF_MAX_LINES).toBe(500);
  });

  it('exposes a frozen list of stable semantic markers, never pinned dates', () => {
    expect(Object.isFrozen(READ_ORDER_STABLE_MARKERS)).toBe(true);
    expect([...READ_ORDER_STABLE_MARKERS]).toEqual([
      'docs/HANDOFF',
      '优先',
      '只作为背景',
      'NOE_100_ACCEPTANCE_MATRIX.md',
    ]);
    // The whole point of the fix: no marker may be a hardcoded YYYY-MM-DD date.
    for (const marker of READ_ORDER_STABLE_MARKERS) {
      expect(/20\d\d-\d\d-\d\d/.test(marker)).toBe(false);
    }
  });

  it('passes on the current real CLAUDE.md (regression guard: today behavior unchanged)', () => {
    expect(claudeHasReadOrderBoundary(realClaude)).toBe(true);
  });

  it('still passes after the read-order dates evolve (fixes the brittle false-failure)', () => {
    // Same boundary semantics, but every date advanced past the old pinned strings.
    const futureDoc = [
      '- **接手读序**：最新 `docs/HANDOFF_*.md`（当前 2026-07-01）优先 >',
      ' `2026-06-25 handoff` > 旧 2026-06-05 至 2026-06-24 文档只作为背景；',
      '验收基线看 `NOE_100_ACCEPTANCE_MATRIX.md`。',
    ].join('');
    expect(futureDoc.includes('2026-06-12 handoff')).toBe(false); // old check would have failed here
    expect(claudeHasReadOrderBoundary(futureDoc)).toBe(true);
  });

  it('still genuinely checks that a read order exists (does not water down)', () => {
    // Missing the deprioritized "背景" tier -> not a real read order.
    expect(
      claudeHasReadOrderBoundary('最新 docs/HANDOFF 优先；验收看 NOE_100_ACCEPTANCE_MATRIX.md。'),
    ).toBe(false);
    // Missing the "优先" priority tier.
    expect(
      claudeHasReadOrderBoundary('docs/HANDOFF 旧文档只作为背景；NOE_100_ACCEPTANCE_MATRIX.md。'),
    ).toBe(false);
    // Missing the acceptance-baseline anchor.
    expect(claudeHasReadOrderBoundary('最新 docs/HANDOFF 优先 > 旧文档只作为背景。')).toBe(false);
    // Missing the handoff pointer entirely.
    expect(
      claudeHasReadOrderBoundary('优先读这个 > 那个只作为背景；NOE_100_ACCEPTANCE_MATRIX.md。'),
    ).toBe(false);
  });

  it('is robust to non-string input instead of throwing', () => {
    expect(claudeHasReadOrderBoundary(null)).toBe(false);
    expect(claudeHasReadOrderBoundary(undefined)).toBe(false);
    expect(claudeHasReadOrderBoundary(123)).toBe(false);
    expect(claudeHasReadOrderBoundary({})).toBe(false);
  });
});
