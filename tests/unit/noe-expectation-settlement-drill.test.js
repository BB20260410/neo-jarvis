import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('noe-expectation-settlement-drill', () => {
  it('settles at least 20 controlled expectations in an isolated DB', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-expectation-drill-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-expectation-settlement-drill.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NOE_EXPECTATION_DRILL_OUT_DIR: outDir },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.liveDbMutated).toBe(false);
      expect(report.sampleCount).toBeGreaterThanOrEqual(20);
      expect(report.resolvedCount).toBe(report.sampleCount);
      expect(report.unresolvedCount).toBe(0);
      expect(report.brier.n).toBe(report.sampleCount);
      expect(Number.isFinite(report.brier.brier)).toBe(true);
      expect(existsSync(report.dbPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).ok).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
