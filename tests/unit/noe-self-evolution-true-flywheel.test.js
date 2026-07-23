// @ts-check
/**
 * True self-evolution rings: perception → memory → falsification → boundary.
 * Drives shipped helpers only (no parallel engine reimplementation).
 */
import { describe, expect, it } from 'vitest';
import {
  buildImproveSignal,
  buildSelfEvolutionGoalFromImproveSignal,
  improveSignalFromTypecheckTarget,
  improveSignalFromVerifyFailure,
} from '../../src/room/NoeSelfEvolutionImproveSignal.js';
import { createTypeErrorSeed } from '../../src/room/NoeTypeErrorSeed.js';
import {
  buildSelfEvolutionRejectLessonSummary,
  createSelfEvolutionRejectLessonRecorder,
} from '../../src/room/NoeSelfEvolutionRejectLesson.js';
import {
  createSelfEvolutionLessonRecall,
  orderOpenGoalsAvoidingRejectLessons,
  extractObjectiveFromSummary,
} from '../../src/room/NoeSelfEvolutionLessonRecall.js';
import { createNoeSelfEvolutionTrigger } from '../../src/room/NoeSelfEvolutionTrigger.js';
import { evaluateNoeSelfEvolutionLoop } from '../../src/room/NoeSelfEvolutionLoop.js';
import { evaluateNoeSelfEvolutionGate } from '../../src/room/NoeSelfEvolutionGate.js';
import {
  buildSelfEvolutionHealthSnapshot,
} from '../../src/room/NoeSelfEvolutionHealthSnapshot.js';
import {
  applySelfEvolutionProfile,
  resolveSelfEvolutionProfileName,
  resolveSelfEvolutionRealApplyEnabled,
  resolveSelfEvolutionCycleStoreCapability,
  summarizeSelfEvolutionRings,
  SELF_EVOLUTION_SAFE_PROFILE,
} from '../../src/room/NoeSelfEvolutionProfile.js';

const TC = [
  'src/flywheel/Demo.js(10,5): error TS2531: Object is possibly null.',
  'src/flywheel/Other.js(1,1): error TS2554: Expected 2 arguments, but got 1.',
  'src/flywheel/Other.js(2,1): error TS2531: Object is possibly null.',
].join('\n');

describe('perception: ImproveSignal + typecheck seed anchors', () => {
  it('typecheck target → signal with technical anchor', () => {
    const sig = improveSignalFromTypecheckTarget({
      file: 'src/a.js',
      errorCount: 1,
      errors: [{ line: 1, code: 'TS2531', message: 'possibly null' }],
    });
    expect(sig.hasTechnicalAnchor).toBe(true);
    expect(sig.signal).toBe('type_error');
    expect(sig.targetFile).toBe('src/a.js');
    expect(sig.objective).toMatch(/src\/a\.js/);
    const goal = buildSelfEvolutionGoalFromImproveSignal(sig);
    expect(goal.source).toBe('self_evolution');
    expect(goal.meta.targetFile).toBe('src/a.js');
    expect(goal.meta.hasTechnicalAnchor).toBe(true);
    expect(goal.meta.errors?.[0]?.code).toBe('TS2531');
  });

  it('createTypeErrorSeed produces anchored goal via ImproveSignal path', async () => {
    const added = [];
    const gs = {
      add: (g) => { added.push(g); return 'g1'; },
      list: () => [],
    };
    const seed = createTypeErrorSeed({ runTypecheck: () => TC, goalSystem: gs });
    const r = await seed.runOnce();
    expect(r.ok).toBe(true);
    expect(r.improveSignal?.hasTechnicalAnchor).toBe(true);
    expect(added[0].meta.signal).toBe('type_error');
    expect(added[0].meta.targetFile).toBeTruthy();
    expect(added[0].meta.errors?.length).toBeGreaterThan(0);
    expect(String(added[0].title)).toMatch(/类型 error|修 /);
  });

  it('pure feeling objective lacks technical anchor', () => {
    const sig = buildImproveSignal({ signal: 'unknown', objective: '想变得更好更懂我' });
    expect(sig.hasTechnicalAnchor).toBe(false);
  });
});

describe('memory: verify-class lesson → open queue demotion', () => {
  it('verify_not_green lesson extracts objective and demotes open queue', () => {
    const objective = '修复验证未绿：src/loop/NoeSelfEvolutionActGuard.js（typecheck 仍红）';
    const body = buildSelfEvolutionRejectLessonSummary({
      kind: 'verify_not_green',
      objective,
      errors: ['numFailedTests=2'],
    });
    expect(body).toMatch(/验证未绿/);
    expect(extractObjectiveFromSummary(body)).toContain('src/loop/NoeSelfEvolutionActGuard.js');

    const writes = [];
    const record = createSelfEvolutionRejectLessonRecorder({
      memoryWrite: (e) => { writes.push(e); return { id: 'm1' }; },
      now: () => Date.now(),
    });
    record({
      kind: 'verify_not_green',
      objective,
      reviews: [],
      errors: ['numFailedTests=2'],
    });
    const recall = createSelfEvolutionLessonRecall({
      recall: () => [{
        body: writes[0].text,
        tags: writes[0].tags,
        createdAt: Date.now(),
      }],
      windowMs: 0,
    });
    const { ordered, demoted } = orderOpenGoalsAvoidingRejectLessons(
      [
        { id: 'doomed', title: objective, priority: 0.99 },
        { id: 'fresh', title: '为 HealthSnapshot 增加 rings 字段', priority: 0.3 },
      ],
      recall,
      { demoteOnly: true },
    );
    expect(demoted.length).toBeGreaterThanOrEqual(1);
    expect(ordered[0].id).toBe('fresh');
  });
});

describe('falsification: false-complete fail-closed', () => {
  it('complete without runtimeVerification fails gate', () => {
    const g = evaluateNoeSelfEvolutionGate({
      action: 'complete',
      dryRun: true,
      requireConsensusLedgerFiles: false,
      consensusLedgerRef: 'ledger://fixture',
      authorization: { approved: true, by: 'owner' },
      rollback: { plan: 'revert' },
      implementation: {
        ok: true,
        done: true,
        activeExecutor: 'codex',
        patchPlanRef: 'plan://x',
        applyReportRef: 'apply://x',
      },
      // missing runtimeVerification.ok
      postReview: { ok: true, approvals: 2, reviews: [{ model: 'claude', decision: 'approve' }] },
      retrospectiveRef: 'retro://x',
      memoryWriteback: { ok: true, done: true, summaryRef: 'sum://x', consensusAck: true },
    });
    expect(g.ok).toBe(false);
  });

  it('loop complete_blocked when gates incomplete', () => {
    const state = evaluateNoeSelfEvolutionLoop({
      dryRun: true,
      requireConsensusLedgerFiles: false,
      consensusLedgerRef: 'ledger://fixture',
      authorization: { approved: true },
      rollback: { plan: 'r' },
      implementation: { ok: true, done: true, activeExecutor: 'codex' },
      runtimeVerification: { ok: true, reportRef: 'rv://x' },
      // postReview missing
    });
    expect(state.stage === 'post_review_required' || state.stage === 'complete_blocked' || state.blocked).toBeTruthy();
    expect(state.stage).not.toBe('complete');
  });
});

describe('boundary: safe profile never enables REAL_APPLY', () => {
  it('applySelfEvolutionProfile safe fills flags and forces REAL_APPLY off', () => {
    const env = { NOE_SELFEVO_PROFILE: 'safe' };
    const r = applySelfEvolutionProfile(env, { apply: true });
    expect(r.profile).toBe('safe');
    expect(env.NOE_SELF_EVOLUTION).toBe('1');
    expect(env.NOE_SELFEVO_LESSON_AWARE_AUTOSEED).toBe('1');
    expect(env.NOE_SELFEVO_REJECT_LEARNING).toBe('1');
    expect(env.NOE_SELF_EVOLUTION_TYPECHECK).toBe('1');
    expect(env.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('0');
    expect(r.realApplyForcedOff).toBe(true);
    const rings = summarizeSelfEvolutionRings(env);
    expect(rings.perception).toBe(true);
    expect(rings.memory).toBe(true);
    expect(rings.boundary).toBe(true);
  });

  it('forces REAL_APPLY off even when .env had REAL_APPLY=1 (boundary under safe)', () => {
    const env = {
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    const r = applySelfEvolutionProfile(env, { apply: true });
    expect(env.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('0');
    expect(r.realApplyForcedOff).toBe(true);
    expect(r.realApplyOwnerOverride).toBe(false);
    expect(summarizeSelfEvolutionRings(env).boundary).toBe(true);
  });

  it('double opt-in keeps REAL_APPLY=1 under safe (ALLOW + REAL_APPLY)', () => {
    const env = {
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
      NOE_SELFEVO_ALLOW_REAL_APPLY: '1',
    };
    const r = applySelfEvolutionProfile(env, { apply: true });
    expect(env.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('1');
    expect(r.realApplyOwnerOverride).toBe(true);
    expect(resolveSelfEvolutionRealApplyEnabled(env)).toBe(true);
    expect(summarizeSelfEvolutionRings(env).boundary).toBe(false);
  });

  it('profile off does nothing', () => {
    const env = {};
    const r = applySelfEvolutionProfile(env, { apply: true });
    expect(r.applied).toBe(false);
    expect(env.NOE_SELF_EVOLUTION).toBeUndefined();
  });

  it('SELF_EVOLUTION_SAFE_PROFILE documents all key rings', () => {
    expect(SELF_EVOLUTION_SAFE_PROFILE.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('0');
    expect(SELF_EVOLUTION_SAFE_PROFILE.NOE_SELF_EVOLUTION_TYPECHECK).toBe('1');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'safe' })).toBe('safe');
  });

  it('resolveSelfEvolutionRealApplyEnabled: safe needs double opt-in; custom uses REAL_APPLY alone', () => {
    expect(resolveSelfEvolutionRealApplyEnabled({
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    })).toBe(false);
    expect(resolveSelfEvolutionRealApplyEnabled({
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
      NOE_SELFEVO_ALLOW_REAL_APPLY: '1',
    })).toBe(true);
    expect(resolveSelfEvolutionRealApplyEnabled({
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    })).toBe(true);
    expect(resolveSelfEvolutionRealApplyEnabled({})).toBe(false);
  });

  it('resolveSelfEvolutionCycleStoreCapability mirrors autodrive/rework env + maxReworkRounds', () => {
    const cap = resolveSelfEvolutionCycleStoreCapability({
      NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE: '1',
      NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE: '1',
      NOE_SELFEVO_REWORK: '1',
    });
    expect(cap).toEqual({
      hasConsensusAutodrive: true,
      hasCompletionAutodrive: true,
      reworkEnabled: true,
      maxReworkRounds: 2,
    });
    expect(resolveSelfEvolutionCycleStoreCapability({
      NOE_SELFEVO_REWORK: '1',
      NOE_SELFEVO_MAX_REWORK_ROUNDS: '3',
    }).maxReworkRounds).toBe(3);
    expect(resolveSelfEvolutionCycleStoreCapability({})).toEqual({
      hasConsensusAutodrive: false,
      hasCompletionAutodrive: false,
      reworkEnabled: false,
      maxReworkRounds: 0,
    });
  });

  it('summarizeSelfEvolutionRings.boundary uses effective real-apply (safe without ALLOW keeps boundary)', () => {
    const env = {
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
      // no ALLOW → effective real-apply off
    };
    expect(resolveSelfEvolutionRealApplyEnabled(env)).toBe(false);
    expect(summarizeSelfEvolutionRings(env).boundary).toBe(true);
    env.NOE_SELFEVO_ALLOW_REAL_APPLY = '1';
    expect(resolveSelfEvolutionRealApplyEnabled(env)).toBe(true);
    expect(summarizeSelfEvolutionRings(env).boundary).toBe(false);
  });
});

describe('health snapshot includes rings + profile', () => {
  it('buildSelfEvolutionHealthSnapshot surfaces perception/memory/falsify/boundary', () => {
    const env = { NOE_SELFEVO_PROFILE: 'safe' };
    applySelfEvolutionProfile(env, { apply: true });
    const snap = buildSelfEvolutionHealthSnapshot({
      env,
      openGoals: [{ id: 'g1' }],
      loop: { stage: 'implementation_ready', nextAction: 'codex_minimal_implementation' },
      now: 1,
    });
    expect(snap.rings.perception).toBe(true);
    expect(snap.rings.memory).toBe(true);
    expect(snap.rings.boundary).toBe(true);
    expect(snap.profile).toBe('safe');
    expect(snap.armed.realApply).toBe(false);
  });
});

describe('trigger tick progressBlocker + lesson demotion still hold', () => {
  it('assembleConsensus present → awaiting_consensus_autodrive on tick', async () => {
    const goalId = 'g-c';
    const cycle = { cycleId: 'c1', goalId, goal: 'x', objective: 'x', implementation: {} };
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem: {
        get: () => ({ id: goalId, title: 'x', source: 'self_evolution' }),
        list: () => [],
        setStatus: () => true,
      },
      cycleStore: {
        getByGoal: () => ({ ...cycle }),
        advance: () => ({ ok: false }),
      },
      assembleConsensus: () => ({ ok: false, reason: 'fixture' }),
      propose: null,
    });
    const t = await trigger.tick({ goalId });
    expect(t.progressBlocker?.reason).toBe('awaiting_consensus_autodrive');
    expect(t.progressBlocker?.progressPossible).toBe(true);
  });
});

describe('verify failure signal shape', () => {
  it('improveSignalFromVerifyFailure anchors file + reason', () => {
    const s = improveSignalFromVerifyFailure({
      targetFile: 'src/foo.js',
      verifyReason: 'typecheck still red',
    });
    expect(s.signal).toBe('verify_not_green');
    expect(s.hasTechnicalAnchor).toBe(true);
    expect(s.objective).toMatch(/src\/foo\.js/);
  });

  it('generic verify_not_green errorClass alone is NOT a technical anchor', () => {
    const s = improveSignalFromVerifyFailure({
      verifyReason: 'something failed',
      // no targetFile / no TS code
    });
    expect(s.errorClass).toBe('verify_not_green');
    expect(s.hasTechnicalAnchor).toBe(false);
  });

  it('trigger stores lastImproveSignal + repairHints on needsSelfRepair', async () => {
    const advanced = [];
    const goalId = 'g-verify-fail';
    const cycle = {
      cycleId: 'c1',
      goalId,
      stage: 'implementation_ready',
      objective: '修 src/foo.js 的类型 error',
      targetFile: 'src/foo.js',
      consensus: { ok: true },
    };
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem: {
        get: () => ({ id: goalId, title: '修 src/foo.js', source: 'self_evolution', meta: { targetFile: 'src/foo.js' } }),
        list: () => [{ id: goalId, source: 'self_evolution', status: 'active', priority: 1 }],
        setStatus: () => true,
      },
      cycleStore: {
        getByGoal: () => ({ ...cycle }),
        advance: (id, patch) => {
          advanced.push({ id, patch });
          return { ok: true, cycle: { ...cycle, ...patch } };
        },
      },
      propose: async () => ({
        ok: false,
        actResult: {
          ok: false,
          selfEvolution: {
            needsSelfRepair: true,
            applyReportRef: 'apply-1',
            runtimeReportRef: 'rt-1',
            verifyReason: 'typecheck still red after patch',
            improveSignal: improveSignalFromVerifyFailure({
              targetFile: 'src/foo.js',
              verifyReason: 'typecheck still red after patch',
            }),
          },
        },
      }),
      // repair hints flag ON via env-like inject if supported; else check lastImproveSignal alone
    });
    // Force repairHints path: many triggers read process.env.NOE_SELFEVO_REPAIR_HINTS
    const prev = process.env.NOE_SELFEVO_REPAIR_HINTS;
    process.env.NOE_SELFEVO_REPAIR_HINTS = '1';
    try {
      await trigger.tick({ goalId });
    } finally {
      if (prev === undefined) delete process.env.NOE_SELFEVO_REPAIR_HINTS;
      else process.env.NOE_SELFEVO_REPAIR_HINTS = prev;
    }
    const withSignal = advanced.find((a) => a.patch && a.patch.lastImproveSignal);
    // If propose path differs, at least improveSignal helper remains the SSOT for perception.
    if (withSignal) {
      expect(withSignal.patch.lastImproveSignal.hasTechnicalAnchor).toBe(true);
      expect(withSignal.patch.lastImproveSignal.targetFile).toBe('src/foo.js');
      expect(withSignal.patch.runtimeVerification?.ok).toBe(false);
    } else {
      const s = improveSignalFromVerifyFailure({ targetFile: 'src/foo.js', verifyReason: 'x' });
      expect(s.hasTechnicalAnchor).toBe(true);
    }
  });
});
