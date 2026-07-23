import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runNoeMemoryCandidateChainDrill } from '../../src/memory/NoeMemoryCandidateChainDrill.js';

describe('NoeMemoryCandidateChainDrill', () => {
  it('proves proposal -> review -> dry-run apply with owner-gated real writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-memory-chain-drill-'));
    try {
      const report = runNoeMemoryCandidateChainDrill({
        root,
        now: new Date('2026-06-13T02:00:00.000Z'),
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'passed',
        blockers: [],
        safety: {
          writesProductionMemoryCore: false,
          writesFixtureMemoryCore: true,
          writesCode: false,
          requiresOwnerApprovalBeforeMemoryCore: true,
          unconfirmedApplyWrites: 0,
          rollbackApplied: true,
        },
      });
      expect(report.stages.materializePendingQueue).toMatchObject({
        ok: true,
        status: 'materialized',
        writesMemoryCore: false,
        changesCode: false,
      });
      expect(report.stages.reviewToPendingCandidate).toMatchObject({
        ok: true,
        status: 'ready_for_owner_review',
        accepted: 1,
        written: 1,
        writesMemoryCore: false,
        requiresOwnerApprovalForMemoryWrite: true,
      });
      expect(report.stages.dryRunMemoryApply).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        ready: 1,
        applied: 0,
        directWrites: [],
      });
      expect(report.stages.unconfirmedRealApplyBlocked).toMatchObject({
        ok: true,
        status: 'blocked',
        errors: ['owner_confirmation_required'],
        fakeMemoryWrites: 0,
      });
      expect(report.stages.confirmedFixtureApplyRollback).toMatchObject({
        ok: true,
        status: 'applied',
        applied: 1,
        rollbackApplied: true,
        hiddenAfterRollback: true,
        visibleAfterRollback: false,
      });
      expect(report.stages.confirmedFixtureApplyRollback.rollbackReportRef).toContain('rollback-reports/confirmed-fixture');
      expect(report.stages.dryRunMemoryApply.reportRef).not.toBe(report.stages.unconfirmedRealApplyBlocked.reportRef);
      expect(report.stages.unconfirmedRealApplyBlocked.reportRef).not.toBe(report.stages.confirmedFixtureApplyRollback.reportRef);
      expect(existsSync(join(root, report.reportRef))).toBe(true);
      expect(existsSync(join(root, report.latestRef))).toBe(true);
      const serialized = readFileSync(join(root, report.latestRef), 'utf8');
      expect(serialized).not.toContain('MemoryCore writes completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
