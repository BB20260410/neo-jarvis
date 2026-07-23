import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeTraceV2Records,
  runEvidenceFlywheelV2Closeout,
} from '../../scripts/noe-evidence-flywheel-v2-closeout.mjs';
import {
  NOE_RUNTIME_TRACE_STAGES,
  validateNoeRuntimeTraceRecord,
} from '../../src/runtime/NoeRuntimeTrace.js';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('noe-evidence-flywheel-v2-closeout', () => {
  it('builds one valid sanitized runtime trace record per required stage', () => {
    const records = buildRuntimeTraceV2Records({ nowMs: 1782000000000 });

    expect(records.map((record) => record.stage)).toEqual(NOE_RUNTIME_TRACE_STAGES);
    for (const record of records) {
      expect(validateNoeRuntimeTraceRecord(record)).toEqual({ ok: true, errors: [] });
      expect(record.policy).toMatchObject({
        runtimeTouched: false,
        runtimeSemanticChange: false,
        memoryV2Writes: false,
        liveRestart: false,
        privateHoldoutRead: false,
        secretValuesReturned: false,
      });
    }
  });

  it('writes D/E/F v2 closeout artifacts without applying a patch or touching live runtime claims', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-flywheel-v2-closeout-'));
    try {
      const result = await runEvidenceFlywheelV2Closeout({
        root,
        nowMs: 1782000000000,
        stage: 'all',
      });

      expect(result.ok).toBe(true);
      expect(result.policy).toMatchObject({
        live51735Touched: false,
        live51835Touched: false,
        rawSecretRead: false,
        rawPrivateHoldoutRead: false,
        memoryV2Write: false,
        skillHotLoad: false,
        patchApplied: false,
        runtimeRestart: false,
      });

      const traceReport = readJson(join(root, 'output/noe-runtime-trace/v2/coverage-report.json'));
      expect(traceReport.ok).toBe(true);
      expect(traceReport.stageD.missingStages).toEqual([]);
      expect(traceReport.coverage.recordsScanned).toBe(5);
      expect(traceReport.coverage.byStage).toMatchObject({
        observe: 1,
        can_execute: 1,
        act: 1,
        verify: 1,
        learn: 1,
      });
      expect(existsSync(join(root, 'output/noe-runtime-trace/v2/coverage-report.md'))).toBe(true);

      const unified = readJson(join(root, 'output/noe-candidate-gate-v2/unified-gate-summary.json'));
      expect(unified.ok).toBe(true);
      expect(unified.policy).toMatchObject({
        candidateOnly: true,
        noMemoryCoreWrite: true,
        noSkillStoreWrite: true,
        noSkillHotLoad: true,
        noPatchApply: true,
        noLive51735Or51835: true,
        rawSecretRead: false,
        rawPrivateHoldoutRead: false,
      });
      expect(readJson(join(root, 'output/noe-candidate-gate-v2/memory-candidate-report.json')).ok).toBe(true);
      expect(readJson(join(root, 'output/noe-candidate-gate-v2/skill-candidate-report.json')).ok).toBe(true);
      expect(readJson(join(root, 'output/noe-candidate-gate-v2/patch-candidate-report.json')).ok).toBe(true);
      for (const reportName of ['memory-candidate-report.json', 'skill-candidate-report.json', 'patch-candidate-report.json']) {
        const report = readJson(join(root, 'output/noe-candidate-gate-v2', reportName));
        expect(report.v2Requirements).toEqual(expect.objectContaining({
          sourceEpisode: expect.any(String),
          evidenceRef: expect.any(Array),
          evalResult: expect.objectContaining({ ok: true }),
          rollbackPlan: expect.any(Object),
          sealedHoldoutAggregate: expect.objectContaining({ rawPrivateHoldoutRead: false }),
          redactionStatus: expect.objectContaining({
            rawSecretRead: false,
            rawPrivateHoldoutRead: false,
          }),
          ownerImpact: expect.objectContaining({ liveOwnerStateChanged: false }),
        }));
      }

      const safety = readJson(join(root, 'output/noe-self-evolution-dry-run-v2/safety-report.json'));
      expect(safety.ok).toBe(true);
      expect(safety.policy).toMatchObject({
        dryRunOnly: true,
        patchExecutorCalled: false,
        patchApplied: false,
        targetFileCreated: false,
        commit: false,
        push: false,
        live51735Touched: false,
        live51835Touched: false,
        runtimeRestart: false,
        memoryV2Write: false,
        rawSecretRead: false,
        rawPrivateHoldoutRead: false,
      });
      expect(existsSync(join(root, 'output/noe-self-evolution-dry-run-v2/patch-artifact.json'))).toBe(true);
      expect(existsSync(join(root, 'output/noe-self-evolution-dry-run-v2/safety-report.md'))).toBe(true);
      expect(existsSync(join(root, 'output/noe-self-evolution-dry-run-v2/rollback-dry-run.md'))).toBe(true);
      expect(existsSync(join(root, 'src/report/noe-evidence-flywheel-v2-dry-run-summary.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
