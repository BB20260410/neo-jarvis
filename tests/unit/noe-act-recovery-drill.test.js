import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('noe-act-recovery-drill', () => {
  it('proves failed-act retry and approval-wait resume semantics in an isolated DB', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'noe-act-recovery-drill-'));
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-act-recovery-drill.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NOE_ACT_RECOVERY_DRILL_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.scenario).toBe('act_failure_and_approval_wait_recovery');
      expect(report.liveDbMutated).toBe(false);
      expect(report.failedAct).toMatchObject({
        firstStatus: 'failed',
        recoveredStatus: 'completed',
        executorAttempts: 2,
        actionEvidenceValid: true,
        executedEventCount: 1,
        checkpointWorkflowReady: true,
      });
      expect(report.approvalWait).toMatchObject({
        firstStatus: 'awaiting_approval',
        resumedStatusBeforeApproval: 'awaiting_approval',
        sameApprovalAfterRestart: true,
        approvalCountAfterRestart: 1,
        executorCallsBeforeApproval: 0,
        approvedStatus: 'approved',
        finalStatus: 'completed',
        finalExecutorCalls: 1,
        actionEvidenceValid: true,
        executedEventCount: 1,
        checkpointWorkflowReady: true,
      });
      expect(report.events.executedCount).toBe(2);
      expect(existsSync(report.reportPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.reportPath, 'utf8')).ok).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
