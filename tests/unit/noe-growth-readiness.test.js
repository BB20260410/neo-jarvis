import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('noe-growth-readiness', () => {
  it('proves sleep, skill, and curriculum readiness in an isolated DB', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-growth-readiness-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-growth-readiness.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NOE_GROWTH_READINESS_OUT_DIR: outDir,
            NOE_GROWTH_READINESS_SKIP_SELF_EVOLUTION: '1',
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.scenario).toBe('p3_growth_readiness');
      expect(report.liveDbMutated).toBe(false);
      expect(report.sleepPipeline).toMatchObject({
        ok: true,
        duplicateMerged: true,
        identityProtected: true,
      });
      expect(report.skillLibrary).toMatchObject({
        ok: true,
        savedCount: 1,
      });
      expect(report.skillLibrary.savedSkill.enabled).toBe(false);
      expect(report.automaticCurriculum.taskCount).toBeGreaterThanOrEqual(3);
      expect(report.autonomyRegressionGate).toMatchObject({ ok: true, skipped: true });
      expect(existsSync(report.reportPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(report.reportPath, 'utf8'));
      expect(persisted.ok).toBe(true);
      expect(report.latestPath).toBeDefined();
      expect(existsSync(report.latestPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.latestPath, 'utf8'))).toEqual(persisted);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
