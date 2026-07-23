import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  latestJsonReport,
  runNoeMemoryRoadmapVerification,
} from '../../src/memory/NoeMemoryRoadmapVerifier.js';

describe('runNoeMemoryRoadmapVerification', () => {
  it('passes isolated lifecycle canary and recall benchmark', async () => {
    const report = await runNoeMemoryRoadmapVerification({ includeRealDb: false });
    expect(report.ok).toBe(true);
    expect(report.requiredChecks.map((c) => c.id)).toEqual([
      'isolated_lifecycle_canary',
      'recall_benchmark',
      'real_db_status_readable',
      'real_db_no_unreviewed_orphans',
      'real_db_quarantine_clear',
    ]);
    expect(report.canary.ok).toBe(true);
    expect(report.recallBenchmark.ok).toBe(true);
  });

  it('selects the latest report matching the requested evidence mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-memory-roadmap-report-test-'));
    try {
      writeFileSync(join(dir, 'noe-memory-relevance-benchmark-100.json'), JSON.stringify({
        mode: 'real_db_read_only',
        ok: false,
        summary: { cases: 2, semanticQualityOk: false },
      }));
      writeFileSync(join(dir, 'noe-memory-relevance-benchmark-200.json'), JSON.stringify({
        mode: 'isolated_fixture',
        ok: true,
        summary: { cases: 1, semanticQualityOk: true },
      }));

      const report = latestJsonReport(dir, 'noe-memory-relevance-benchmark-', {
        predicate: (item) => item?.mode === 'real_db_read_only',
      });

      expect(report?.path.endsWith('noe-memory-relevance-benchmark-100.json')).toBe(true);
      expect(report?.report.mode).toBe('real_db_read_only');
      expect(report?.report.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
