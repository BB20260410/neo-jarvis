import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('noe-model-unload-recovery-drill', () => {
  it('recovers from a controlled model_unloaded provider error without load/unload commands', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-model-unload-drill-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-model-unload-recovery-drill.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NOE_MODEL_UNLOAD_DRILL_FAKE_LOADED_MODELS: JSON.stringify(['qwen/qwen3.6-35b-a3b']),
            NOE_MODEL_UNLOAD_DRILL_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.scenario).toBe('controlled_model_unloaded_error_recovery');
      expect(report.realProviderCalls).toBe(false);
      expect(report.fakeProviderCalls).toBe(true);
      expect(report.lmStudioLoadUnloadCommandsIssued).toBe(false);
      expect(report.lmStudioLoadUnloadChanged).toBe(false);
      expect(report.modelUnloadedDetected).toBe(true);
      expect(report.modelUnloadedIssue).toBe('model_unloaded');
      expect(report.backupParticipantUsed).toBe(true);
      expect(report.quorum.ok).toBe(true);
      expect(report.quorum.availableCount).toBeGreaterThanOrEqual(2);
      expect(report.ledgerSafe.ok).toBe(true);
      expect(existsSync(report.ledgerPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).ok).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
