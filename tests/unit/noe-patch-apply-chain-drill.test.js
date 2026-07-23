import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoePatchApplyChainDrillPatch,
  runNoePatchApplyChainDrill,
} from '../../src/runtime/mission/NoePatchApplyChainDrill.js';

describe('NoePatchApplyChainDrill', () => {
  it('builds an isolated output-only patch plan', () => {
    const patch = buildNoePatchApplyChainDrillPatch({ runId: 'unit-run' });

    expect(patch).toMatchObject({
      ok: true,
      claimedSucceeded: false,
      patchPlan: {
        kind: 'noe_patch_plan',
        operations: [{
          op: 'write_file',
          path: 'output/noe-patch-transactions/drills/unit-run/target/proof.txt',
        }],
      },
      secretValuesReturned: false,
    });
  });

  it('runs dry-run, unconfirmed block, confirmed apply, and rollback without leaving the target file', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-chain-drill-'));
    try {
      const report = runNoePatchApplyChainDrill({
        root,
        runId: 'unit-chain',
        now: new Date('2026-06-13T03:30:00.000Z'),
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'passed',
        runId: 'unit-chain',
        gates: {
          patchPlanWritten: true,
          dryRunReady: true,
          unconfirmedBlocked: true,
          confirmedApplyWroteTarget: true,
          rollbackDryRunReady: true,
          confirmedRollbackRemovedTarget: true,
          secretValuesReturned: false,
        },
        safety: {
          writesOnlyUnder: 'output/noe-patch-transactions/drills/unit-chain/',
          targetExistsAfterApply: true,
          targetExistsAfterRollback: false,
          noSourceFilesChangedByDrill: true,
        },
      });
      expect(existsSync(join(root, report.targetRef))).toBe(false);
      expect(existsSync(join(root, report.reportRef))).toBe(true);
      expect(existsSync(join(root, report.latestRef))).toBe(true);
      const finalText = readFileSync(join(root, report.reportRef), 'utf8');
      expect(finalText).not.toContain('patch apply chain drill proof');
      expect(finalText).not.toContain('unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
