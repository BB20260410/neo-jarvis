import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeThoughtMemoryEvalReport } from '../../scripts/noe-thought-memory-eval.mjs';

describe('noe-thought-memory-eval report writer', () => {
  it('writes timestamped and latest thought-memory eval reports without secret-like text', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-thought-memory-'));
    try {
      const summary = {
        ok: true,
        passed: true,
        generatedAt: '2026-06-12T05:40:00.000Z',
        score: 100,
        thoughtGrounding: {
          sampleCount: 50,
          avgScore: 0.7,
          passCount: 50,
          passRate: 1,
          rewriteCount: 8,
          refKeyCount: 50,
          blockers: [],
          lowRecent: [],
        },
        memoryEval: {
          counts: { total: 3, skillDistill: 1, factExtract: 1, insights: 1 },
          liveQueries: [],
          conflictFixtures: [],
          blockers: [],
        },
        blockers: [],
        source: {
          dbPath: '/tmp/panel.db',
          policy: 'read-only; no .env; no owner token; no model calls',
        },
      };
      const paths = writeThoughtMemoryEvalReport(summary, {
        outDir,
        now: Date.parse('2026-06-12T05:40:00Z'),
      });

      expect(paths.reportPath).toMatch(/thought-memory-eval-1781242800000\.json$/);
      expect(paths.latestPath).toMatch(/latest\.json$/);
      const timestamped = JSON.parse(readFileSync(join(outDir, 'thought-memory-eval-1781242800000.json'), 'utf8'));
      const latest = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8'));
      expect(latest).toEqual(timestamped);
      expect(latest.thoughtGrounding.passRate).toBe(1);
      expect(JSON.stringify(latest)).not.toMatch(/sk-|token=|cookie=/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
