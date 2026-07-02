import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('noe-runtime-restart-recovery-drill', () => {
  it('supports fake mode without touching live ports', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-runtime-restart-drill-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-runtime-restart-recovery-drill.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NOE_RUNTIME_RESTART_DRILL_FAKE: '1',
            NOE_RUNTIME_RESTART_DRILL_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.mode).toBe('fake');
      expect(report.applied).toBe(false);
      expect(report.realRestartAttempted).toBe(false);
      expect(report.checks).toMatchObject({
        pidChanged: true,
        oldPidAbsent: true,
        newPidCwdIsRoot: true,
        port51735Untouched: true,
        lmStudioLoadedModelsUnchanged: true,
        healthOk: true,
        readinessPassed: true,
        freedomLiveOk: true,
      });
      expect(existsSync(report.reportPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).source.policy).toContain('fake unit-test mode');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
