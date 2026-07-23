import { describe, expect, it } from 'vitest';
import {
  buildStageEEvidencePack,
  buildStageEFinalRestartReport,
  scanStageERedaction,
} from '../../src/runtime/NoeFinal51835RestartEvidence.js';
import { validateNoeFinalStageEvidence } from '../../src/runtime/NoeFinalStageMatrix.js';

function fakePreflight() {
  return {
    ok: true,
    preflight: {
      decision: {
        safeToRestart: true,
        safeToStart: false,
        blockers: [],
        warnings: ['observe_only_port_51735_has_listener'],
        observeOnlyListenerCount: 1,
        policy: {
          secretValuesReturned: false,
          readsOwnerToken: false,
          touchesObserveOnlyPort: false,
          actionsPerformed: false,
        },
      },
      report: {
        panel: { owned: true, listeners: [{ pid: 100 }] },
        observeOnly: { listeners: [{ pid: 200 }] },
        policy: {
          secretValuesReturned: false,
          readsOwnerToken: false,
          touchesObserveOnlyPort: false,
          actionsPerformed: false,
        },
      },
    },
  };
}

function fakeDrill() {
  return {
    ok: true,
    applied: true,
    realRestartAttempted: true,
    host: '127.0.0.1',
    port: 51835,
    before: {
      port51835: { listeners: [{ pid: 100 }] },
      port51735: { listeners: [{ pid: 200 }] },
      lmStudio: { loadedModels: ['model-a'] },
    },
    restart: { startedPid: 101, nodeBin: '/fake/node22' },
    after: {
      port51835: { listeners: [{ pid: 101 }] },
      port51735: { listeners: [{ pid: 200 }] },
      lmStudio: { loadedModels: ['model-a'] },
    },
    checks: {
      pidChanged: true,
      oldPidAbsent: true,
      newPidCwdIsRoot: true,
      port51735Untouched: true,
      lmStudioLoadedModelsUnchanged: true,
      healthOk: true,
      readinessPassed: true,
      freedomLiveOk: true,
    },
    health: { ok: true, status: 200, json: { ok: true, health: { status: 'passed' } } },
    readiness: { ok: true, status: 200, json: { readiness: { status: 'passed' } } },
    freedomLive: { ok: true, status: 0, stdoutSha256: 'abc123' },
  };
}

function matrix() {
  return {
    schemaVersion: 1,
    roundId: 'auth',
    order: ['A', 'B', 'C', 'D', 'E'],
    stageEvidenceDir: 'output/noe-final-real-machine-stages/20260619',
    redactionRules: ['redact'],
    forbidden: ['raw secret read'],
    authorization: {
      B: { authorized: true, scope: 'b', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      C: { authorized: true, scope: 'c', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      D: { authorized: true, scope: 'd', redactionRequired: true, rollbackRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      E: { authorized: true, scope: 'e', redactionRequired: true, finalStage: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
    },
  };
}

describe('Noe final 51835 restart evidence', () => {
  it('builds redacted Stage E evidence accepted by the final stage matrix', () => {
    const report = buildStageEFinalRestartReport({
      observedAt: '2026-06-19T08:45:00Z',
      drill: fakeDrill(),
      drillReportRef: 'output/noe-final-real-machine-stages/20260619/stage-E-runtime-drill/run/report.json',
      preflight: fakePreflight(),
      preflightRef: 'output/noe-final-real-machine-stages/20260619/stage-E-preflight.json',
    });

    expect(report.ok).toBe(true);
    expect(report.finalRestartRecovery).toBe(true);
    expect(JSON.stringify(report)).not.toContain('/fake/node22');
    expect(scanStageERedaction(report)).toEqual([]);

    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      stageEvidence: { E: report },
    });
    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['E']);
  });

  it('marks report not ok when a required recovery check fails', () => {
    const drill = fakeDrill();
    drill.checks.port51735Untouched = false;
    const report = buildStageEFinalRestartReport({
      drill,
      drillReportRef: 'output/noe-final-real-machine-stages/20260619/stage-E-runtime-drill/run/report.json',
      preflight: fakePreflight(),
    });

    expect(report.ok).toBe(false);
    expect(report.ports.port51735Untouched).toBe(false);
  });

  it('creates a Stage E reviewer pack without raw process paths', () => {
    const report = buildStageEFinalRestartReport({
      drill: fakeDrill(),
      drillReportRef: 'output/noe-final-real-machine-stages/20260619/stage-E-runtime-drill/run/report.json',
      preflight: fakePreflight(),
    });
    const pack = buildStageEEvidencePack({
      report,
      redactionFindings: [],
      commandRefs: ['node scripts/noe-final-51835-restart-recovery.mjs'],
    });

    expect(pack).toContain('Stage E Final 51835 Restart Recovery Evidence Pack');
    expect(pack).toContain('finalRestartRecovery: true');
    expect(pack).not.toContain('/fake/node22');
  });
});
