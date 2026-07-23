// @ts-check
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectStageDurations,
  finiteOr,
  isMonotonicIncreasing,
  judgeLeak,
  linearSlope,
  percentile,
  seriesOf,
  stageDurationPercentiles,
  summarizeLeaks,
} from '../../scripts/noe-self-evolution-soak.mjs';
import { percentileNearestRank } from '../../src/loop/NoeSelfEvolutionSlo.js';

describe('noe-self-evolution-soak pure helpers', () => {
  describe('finiteOr', () => {
    it('returns the number when finite, fallback otherwise', () => {
      expect(finiteOr(5)).toBe(5);
      expect(finiteOr('7')).toBe(7);
      expect(finiteOr(undefined, null)).toBe(null);
      expect(finiteOr(NaN, -1)).toBe(-1);
      expect(finiteOr(Infinity, 0)).toBe(0);
    });
  });

  describe('linearSlope', () => {
    it('is positive for an increasing series', () => {
      const s = linearSlope([1, 2, 3, 4, 5]);
      expect(s).not.toBeNull();
      expect(s).toBeGreaterThan(0);
      expect(s).toBeCloseTo(1, 6);
    });

    it('is negative for a decreasing series', () => {
      const s = linearSlope([5, 4, 3, 2, 1]);
      expect(s).toBeLessThan(0);
      expect(s).toBeCloseTo(-1, 6);
    });

    it('is ~0 for a flat series', () => {
      expect(linearSlope([3, 3, 3, 3])).toBeCloseTo(0, 6);
    });

    it('returns null for empty or single-point series', () => {
      expect(linearSlope([])).toBeNull();
      expect(linearSlope([42])).toBeNull();
      expect(linearSlope([null, undefined])).toBeNull();
    });

    it('ignores null gaps but preserves index position', () => {
      // finite points at indices 0 and 2 with values 0 and 2 → slope 1
      const s = linearSlope([0, null, 2]);
      expect(s).toBeCloseTo(1, 6);
    });
  });

  describe('isMonotonicIncreasing', () => {
    it('true for strictly increasing', () => {
      expect(isMonotonicIncreasing([1, 2, 3])).toBe(true);
    });
    it('false for plateau / equal neighbors', () => {
      expect(isMonotonicIncreasing([1, 2, 2, 3])).toBe(false);
    });
    it('false for decreasing or mixed', () => {
      expect(isMonotonicIncreasing([3, 2, 1])).toBe(false);
      expect(isMonotonicIncreasing([1, 3, 2])).toBe(false);
    });
    it('false for empty / single point', () => {
      expect(isMonotonicIncreasing([])).toBe(false);
      expect(isMonotonicIncreasing([5])).toBe(false);
      expect(isMonotonicIncreasing([null])).toBe(false);
    });
  });

  describe('percentile', () => {
    it('computes P50/P95 on a known array using nearest-rank (no interpolation)', () => {
      const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      // nearest-rank P50 of 1..10: rank=ceil(0.5*10)=5 → sorted[4]=5 (a real sample, not 5.5)
      expect(percentile(a, 50)).toBe(5);
      // nearest-rank P95: rank=ceil(0.95*10)=10 → sorted[9]=10
      expect(percentile(a, 95)).toBe(10);
      expect(percentile(a, 0)).toBe(1);
      expect(percentile(a, 100)).toBe(10);
    });

    it('returns the only value for single-element arrays', () => {
      expect(percentile([42], 50)).toBe(42);
      expect(percentile([42], 95)).toBe(42);
    });

    it('returns null for empty arrays and drops non-finite values', () => {
      expect(percentile([], 50)).toBeNull();
      expect(percentile([NaN, undefined], 50)).toBeNull();
      // non-finite dropped: [10, 20] → nearest-rank P50 rank=ceil(0.5*2)=1 → sorted[0]=10
      expect(percentile([10, NaN, 20], 50)).toBe(10);
    });

    it('is order-independent (sorts internally)', () => {
      expect(percentile([10, 1, 5, 2, 8], 50)).toBe(percentile([1, 2, 5, 8, 10], 50));
    });

    it('agrees exactly with SLO percentileNearestRank (single algorithm, no drift)', () => {
      const data = [12, 3, 47, 8, 21, 5, 99, 2, 60, 33];
      for (const p of [0, 25, 50, 75, 90, 95, 99, 100]) {
        expect(percentile(data, p)).toBe(percentileNearestRank(data, p));
      }
    });
  });

  describe('stageDurationPercentiles', () => {
    it('reports count and percentiles for a known set', () => {
      const r = stageDurationPercentiles([100, 200, 300, 400, 500]);
      expect(r.count).toBe(5);
      expect(r.min).toBe(100);
      expect(r.max).toBe(500);
      expect(r.p50).toBeCloseTo(300, 6);
    });
    it('returns nulls for empty input (no fabrication)', () => {
      const r = stageDurationPercentiles([]);
      expect(r).toEqual({
        count: 0, p50: null, p95: null, p99: null, min: null, max: null, percentileMethod: 'nearest-rank',
      });
    });
    it('drops negative / non-finite durations', () => {
      const r = stageDurationPercentiles([-5, NaN, 100, 200]);
      expect(r.count).toBe(2);
      expect(r.min).toBe(100);
      expect(r.max).toBe(200);
    });
  });

  describe('judgeLeak', () => {
    it('flags a monotonically increasing series as a leak', () => {
      const v = judgeLeak([10, 20, 30, 40, 50]);
      expect(v.leak).toBe(true);
      expect(v.inconclusive).toBe(false);
      expect(v.monotonic).toBe(true);
      expect(v.slope).toBeGreaterThan(0);
      expect(v.first).toBe(10);
      expect(v.last).toBe(50);
      expect(v.delta).toBe(40);
    });

    it('does NOT flag a flat / stable series', () => {
      const v = judgeLeak([100, 100, 100, 100]);
      expect(v.leak).toBe(false);
      expect(v.inconclusive).toBe(false);
      expect(v.monotonic).toBe(false);
    });

    it('does NOT flag a noisy non-monotonic series even with positive drift', () => {
      const v = judgeLeak([10, 12, 9, 15, 11]);
      expect(v.leak).toBe(false);
    });

    it('respects slopeThreshold: gentle climb below threshold is not a leak', () => {
      // slope = 1 per round; threshold 5 → not a leak despite monotonic
      const v = judgeLeak([1, 2, 3, 4, 5], { slopeThreshold: 5 });
      expect(v.monotonic).toBe(true);
      expect(v.leak).toBe(false);
    });

    it('flags a steep climb above threshold', () => {
      const v = judgeLeak([0, 100, 200, 300], { slopeThreshold: 50 });
      expect(v.leak).toBe(true);
    });

    it('is inconclusive (not crashing) for empty / single-point series', () => {
      const empty = judgeLeak([]);
      expect(empty.inconclusive).toBe(true);
      expect(empty.leak).toBe(false);
      expect(empty.slope).toBeNull();
      expect(empty.samples).toBe(0);

      const single = judgeLeak([42]);
      expect(single.inconclusive).toBe(true);
      expect(single.leak).toBe(false);
      expect(single.first).toBe(42);
      expect(single.last).toBe(42);

      const allNull = judgeLeak([null, undefined, NaN]);
      expect(allNull.inconclusive).toBe(true);
      expect(allNull.leak).toBe(false);
    });

    it('does not flag a decreasing series', () => {
      const v = judgeLeak([50, 40, 30, 20, 10]);
      expect(v.leak).toBe(false);
      expect(v.slope).toBeLessThan(0);
    });
  });

  describe('seriesOf', () => {
    it('extracts a metric series and nulls out missing / non-finite', () => {
      const rounds = [
        { fd: { targetFdCount: 10 } },
        { fd: { targetFdCount: 12 } },
        { fd: {} },
        {},
      ];
      expect(seriesOf(rounds, (r) => r?.fd?.targetFdCount)).toEqual([10, 12, null, null]);
    });
    it('returns [] for non-array input', () => {
      // @ts-expect-error testing defensive path
      expect(seriesOf(null, (r) => r)).toEqual([]);
    });
  });

  describe('summarizeLeaks', () => {
    function round({ rss, fd, wal }) {
      return {
        process: { nodeProcessCount: 5, targetRssKb: rss },
        fd: { targetFdCount: fd },
        wal: { bytes: wal },
        tmp: { noeFileCount: 0 },
        model: { portConnections: null },
      };
    }

    it('detects an fd leak across rounds', () => {
      const rounds = [
        round({ rss: 100000, fd: 40, wal: 1000 }),
        round({ rss: 100000, fd: 50, wal: 1000 }),
        round({ rss: 100000, fd: 60, wal: 1000 }),
        round({ rss: 100000, fd: 70, wal: 1000 }),
      ];
      const s = summarizeLeaks(rounds);
      expect(s.metrics.targetFdCount.leak).toBe(true);
      expect(s.metrics.targetRssKb.leak).toBe(false); // flat
      expect(s.anyLeak).toBe(true);
      expect(s.suspected).toBeGreaterThanOrEqual(1);
    });

    it('reports no leak for a stable run', () => {
      const rounds = [
        round({ rss: 100000, fd: 40, wal: 1000 }),
        round({ rss: 100100, fd: 40, wal: 1000 }),
        round({ rss: 99900, fd: 40, wal: 1000 }),
        round({ rss: 100050, fd: 40, wal: 1000 }),
      ];
      const s = summarizeLeaks(rounds);
      expect(s.anyLeak).toBe(false);
      expect(s.suspected).toBe(0);
    });

    it('treats all-null metric series as inconclusive, not a leak', () => {
      const rounds = [
        { process: {}, fd: {}, wal: {}, tmp: {}, model: {} },
        { process: {}, fd: {}, wal: {}, tmp: {}, model: {} },
      ];
      const s = summarizeLeaks(rounds);
      expect(s.metrics.targetFdCount.inconclusive).toBe(true);
      expect(s.anyLeak).toBe(false);
    });

    it('honors custom slopeThresholds', () => {
      const rounds = [
        round({ rss: 100000, fd: 40, wal: 1000 }),
        round({ rss: 100000, fd: 41, wal: 1000 }),
        round({ rss: 100000, fd: 42, wal: 1000 }),
      ];
      // default fd threshold 0 → gentle +1/round flags; raise it to suppress
      const loose = summarizeLeaks(rounds, { slopeThresholds: { targetFdCount: 5 } });
      expect(loose.metrics.targetFdCount.leak).toBe(false);
    });

    it('catches a SLOW monotonic RSS leak (+1 KB/round) — no large RSS floor masking it', () => {
      // Regression: the old 4096 KB/round RSS floor let a tiny-but-real monotonic
      // climb read as "no leak". With the floor at 0, the monotonic gate flags it.
      const rounds = [
        round({ rss: 100000, fd: 40, wal: 1000 }),
        round({ rss: 100001, fd: 40, wal: 1000 }),
        round({ rss: 100002, fd: 40, wal: 1000 }),
        round({ rss: 100003, fd: 40, wal: 1000 }),
      ];
      const s = summarizeLeaks(rounds);
      expect(s.metrics.targetRssKb.slopeThreshold).toBe(0);
      expect(s.metrics.targetRssKb.monotonic).toBe(true);
      expect(s.metrics.targetRssKb.leak).toBe(true);
      expect(s.anyLeak).toBe(true);
    });

    it('still does NOT flag non-monotonic RSS jitter (GC churn) as a leak', () => {
      // GC noise dips after collection → non-monotonic → monotonic gate rejects it
      // even with the RSS floor at 0. Net delta is positive but it is not a leak.
      const rounds = [
        round({ rss: 100000, fd: 40, wal: 1000 }),
        round({ rss: 100200, fd: 40, wal: 1000 }),
        round({ rss: 100050, fd: 40, wal: 1000 }),
        round({ rss: 100300, fd: 40, wal: 1000 }),
      ];
      const s = summarizeLeaks(rounds);
      expect(s.metrics.targetRssKb.monotonic).toBe(false);
      expect(s.metrics.targetRssKb.leak).toBe(false);
    });
  });

  describe('collectStageDurations (no fabrication)', () => {
    const tmps = [];
    afterAll(() => { for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

    function makeRoot() {
      const root = mkdtempSync(join(tmpdir(), 'noe-soak-stagedur-'));
      tmps.push(root);
      mkdirSync(join(root, 'output', 'noe-self-evolution'), { recursive: true });
      return root;
    }
    function writeRunDir(root, stamp, plan) {
      const dir = join(root, 'output', 'noe-self-evolution', `${stamp}-deadbeef`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'patch-plan.json'), JSON.stringify(plan));
    }

    it('does NOT fabricate durations from cross-run-dir generatedAt gaps', () => {
      const root = makeRoot();
      // Three separate cycles, each plan carries only generatedAt (real production shape,
      // verified 2026-06-21). The OLD code diffed these stamps into bogus "stage durations".
      writeRunDir(root, '20260620T213054', { generatedAt: '2026-06-20T21:30:54.000Z' });
      writeRunDir(root, '20260620T213422', { generatedAt: '2026-06-20T21:34:22.000Z' });
      writeRunDir(root, '20260621T001059', { generatedAt: '2026-06-21T00:10:59.000Z' });
      const r = collectStageDurations({ root });
      expect(r.available).toBe(false);
      expect(r.durationsMs).toEqual([]);
      expect(r.percentiles.p50).toBeNull();
      expect(r.percentiles.p95).toBeNull();
      expect(r.note).toMatch(/不编造/);
      expect(r.source.runDirsScanned).toBe(3);
      expect(r.source.withDuration).toBe(0);
    });

    it('returns empty + note when the artifact dir is absent (no crash)', () => {
      const root = mkdtempSync(join(tmpdir(), 'noe-soak-empty-'));
      tmps.push(root);
      const r = collectStageDurations({ root });
      expect(r.available).toBe(false);
      expect(r.durationsMs).toEqual([]);
      expect(r.note).toMatch(/不编造/);
    });

    it('counts a real self-contained durationMs when a producer supplies it', () => {
      const root = makeRoot();
      writeRunDir(root, '20260621T010000', { generatedAt: '2026-06-21T01:00:00.000Z', durationMs: 1200 });
      writeRunDir(root, '20260621T010500', { generatedAt: '2026-06-21T01:05:00.000Z', durationMs: 800 });
      writeRunDir(root, '20260621T011000', { generatedAt: '2026-06-21T01:10:00.000Z' }); // no segment → ignored
      const r = collectStageDurations({ root });
      expect(r.available).toBe(true);
      expect(r.durationsMs.sort((a, b) => a - b)).toEqual([800, 1200]);
      expect(r.source.withDuration).toBe(2);
      expect(r.percentiles.count).toBe(2);
      expect(r.percentileMethod).toBe('nearest-rank');
    });

    it('derives duration from a same-artifact startedAt+endedAt pair', () => {
      const root = makeRoot();
      writeRunDir(root, '20260621T020000', {
        generatedAt: '2026-06-21T02:00:05.000Z',
        startedAt: '2026-06-21T02:00:00.000Z',
        endedAt: '2026-06-21T02:00:05.000Z',
      });
      const r = collectStageDurations({ root });
      expect(r.available).toBe(true);
      expect(r.durationsMs).toEqual([5000]);
    });
  });
});
