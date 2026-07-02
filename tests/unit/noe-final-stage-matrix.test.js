import { describe, expect, it } from 'vitest';
import {
  validateNoeFinalStageRef,
  validateNoeFinalStageAuthorizationMatrix,
  validateNoeFinalStageEvidence,
} from '../../src/runtime/NoeFinalStageMatrix.js';

function matrix(overrides = {}) {
  return {
    schemaVersion: 1,
    roundId: '20260619-final-real-machine-authorization',
    order: ['A', 'B', 'C', 'D', 'E'],
    stageEvidenceDir: 'output/noe-final-real-machine-stages/20260619',
    redactionRules: ['no raw secret', 'no raw private_holdout'],
    forbidden: ['raw secret read', 'raw private_holdout read'],
    authorization: {
      B: {
        authorized: true,
        scope: 'minimum secret use through configured mechanism only',
        redactionRequired: true,
        rawSecretReadAllowed: false,
        rawPrivateHoldoutReadAllowed: false,
      },
      C: {
        authorized: true,
        scope: 'sealed private_holdout aggregate only',
        redactionRequired: true,
        rawSecretReadAllowed: false,
        rawPrivateHoldoutReadAllowed: false,
      },
      D: {
        authorized: true,
        scope: 'live 51835 scratch write with cleanup',
        redactionRequired: true,
        rollbackRequired: true,
        rawSecretReadAllowed: false,
        rawPrivateHoldoutReadAllowed: false,
      },
      E: {
        authorized: true,
        scope: 'final 51835 restart recovery drill',
        redactionRequired: true,
        finalStage: true,
        rawSecretReadAllowed: false,
        rawPrivateHoldoutReadAllowed: false,
      },
    },
    ...overrides,
  };
}

function evidence(stage, extra = {}) {
  return {
    stage,
    ok: true,
    redacted: true,
    observedAt: '2026-06-19T14:15:00+08:00',
    ...extra,
  };
}

function stageDEvidence(extra = {}) {
  return evidence('D', {
    mode: 'live_51835_scratch_write_cleanup',
    rollbackRef: 'output/noe-final-real-machine-stages/20260619/stage-D-rollback.json',
    qualityMode: {
      profile: 'exhaustive',
      modelReviewRequiredBeforeNextStage: true,
      subagentReviewRequiredBeforeNextStage: true,
    },
    scratch: {
      projectId: 'stage-d-scratch',
      scope: 'scratch',
      rawBodyStored: false,
      rawResponseStored: false,
    },
    policy: {
      scratchWriteOnly: true,
      cleanupRequired: true,
      live51835Touched: true,
    },
    cleanup: {
      attempted: true,
      ok: true,
      visibleAfterCleanup: false,
    },
    counts: {
      beforeVisible: 0,
      afterWriteVisible: 1,
      afterCleanupVisible: 0,
    },
    steps: [
      { name: 'before_query', ok: true, httpStatus: 200 },
      { name: 'scratch_write', ok: true, httpStatus: 201 },
      { name: 'after_write_query', ok: true, httpStatus: 200 },
      { name: 'cleanup_delete', ok: true, httpStatus: 200 },
      { name: 'after_cleanup_query', ok: true, httpStatus: 200 },
    ],
    ...extra,
  });
}

function stageEEvidence(extra = {}) {
  return evidence('E', {
    mode: 'final_51835_restart_recovery',
    finalRestartRecovery: true,
    drillReportRef: 'output/noe-final-real-machine-stages/20260619/stage-E-runtime-drill/report.json',
    qualityMode: {
      profile: 'exhaustive',
      modelReviewRequiredBeforeFinalCloseout: true,
      subagentReviewRequiredBeforeFinalCloseout: true,
    },
    preflight: {
      ok: true,
      safeToRestart: true,
      credentialValuesReturned: false,
      touchesObserveOnlyPort: false,
    },
    restart: {
      applied: true,
      realRestartAttempted: true,
      pidChanged: true,
      oldPidAbsent: true,
      newPidCwdIsRoot: true,
    },
    ports: {
      port51835: 51835,
      port51735Untouched: true,
    },
    health: { ok: true },
    readiness: { passed: true },
    lmStudio: { loadedModelsUnchanged: true },
    freedomLive: { ok: true },
    policy: {
      finalRestartOnly: true,
      no51735Touch: true,
      memoryV2Writes: false,
    },
    ...extra,
  });
}

describe('Noe final stage matrix', () => {
  it('accepts the B/C/D/E authorization matrix without raw secret permission', () => {
    const result = validateNoeFinalStageAuthorizationMatrix(matrix());

    expect(result.ok).toBe(true);
    expect(result.requiredStages).toEqual(['B', 'C', 'D', 'E']);
  });

  it('rejects raw secret or private holdout read permission', () => {
    const base = matrix();
    const result = validateNoeFinalStageAuthorizationMatrix(matrix({
      authorization: {
        ...base.authorization,
        B: {
          ...base.authorization.B,
          rawSecretReadAllowed: true,
        },
        C: {
          ...base.authorization.C,
          rawPrivateHoldoutReadAllowed: true,
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('raw_secret_read_must_remain_forbidden:B');
    expect(result.errors).toContain('raw_private_holdout_read_must_remain_forbidden:C');
  });

  it('requires restart recovery to be the final stage', () => {
    const result = validateNoeFinalStageAuthorizationMatrix(matrix({ order: ['A', 'B', 'C', 'E', 'D'] }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage_e_must_be_last');
    expect(result.errors).toContain('stage_d_must_precede_e');
  });

  it('rejects forbidden stage evidence refs before file reads', () => {
    const result = validateNoeFinalStageAuthorizationMatrix(matrix({
      stageEvidenceRefs: {
        B: '.env.local',
        C: 'evals/neo/private_holdout/cases.json',
        D: 'output/noe-final-real-machine-stages/20260619/stage-D.json',
        E: '../outside.json',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage_evidence_ref:B_ref_forbidden');
    expect(result.errors).toContain('stage_evidence_ref:C_ref_forbidden');
    expect(result.errors).toContain('stage_evidence_ref:E_ref_forbidden');
  });

  it('validates final-stage refs against sensitive paths and allowed prefixes', () => {
    expect(validateNoeFinalStageRef('output/noe-final-real-machine-stages/20260619/stage-B.json', {
      kind: 'stage_evidence_ref:B',
      allowedPrefixes: ['output/noe-final-real-machine-stages/20260619'],
    }).ok).toBe(true);
    expect(validateNoeFinalStageRef('evals/neo/private_holdout/cases.json', {
      kind: 'stage_evidence_ref:C',
      allowedPrefixes: ['output/noe-final-real-machine-stages/20260619'],
    }).errors).toEqual(expect.arrayContaining([
      'stage_evidence_ref:C_ref_forbidden',
      'stage_evidence_ref:C_ref_outside_allowed_prefix',
    ]));
  });

  it('requires complete redacted stage evidence when closing the final matrix', () => {
    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      requireComplete: true,
      stageEvidence: {
        B: evidence('B'),
        C: evidence('C'),
        D: stageDEvidence(),
        E: stageEEvidence(),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['B', 'C', 'D', 'E']);
  });

  it('rejects incomplete live scratch and restart evidence', () => {
    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      requireComplete: true,
      stageEvidence: {
        B: evidence('B'),
        C: evidence('C'),
        D: evidence('D'),
        E: evidence('E'),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage_d_rollback_ref_required');
    expect(result.errors).toContain('stage_d_scratch_scope_required');
    expect(result.errors).toContain('stage_e_restart_recovery_required');
    expect(result.errors).toContain('stage_e_drill_report_ref_required');
    expect(result.completed).toEqual(['B', 'C']);
  });

  it('rejects D evidence that claims ok without scratch cleanup proof', () => {
    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      stageEvidence: {
        D: stageDEvidence({
          cleanup: { attempted: true, ok: true, visibleAfterCleanup: true },
          counts: { beforeVisible: 0, afterWriteVisible: 1, afterCleanupVisible: 1 },
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage_d_cleanup_visibility_must_be_false');
    expect(result.errors).toContain('stage_d_after_cleanup_visible_must_be_zero');
    expect(result.completed).toEqual([]);
  });

  it('rejects E evidence that claims final restart without recovery checks', () => {
    const result = validateNoeFinalStageEvidence({
      matrix: matrix(),
      stageEvidence: {
        E: stageEEvidence({
          restart: { applied: true, realRestartAttempted: true, pidChanged: false, oldPidAbsent: true, newPidCwdIsRoot: true },
          ports: { port51835: 51835, port51735Untouched: false },
          health: { ok: false },
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stage_e_pid_changed_required');
    expect(result.errors).toContain('stage_e_51735_untouched_required');
    expect(result.errors).toContain('stage_e_health_ok_required');
    expect(result.completed).toEqual([]);
  });
});
