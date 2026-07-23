// @ts-check
import { describe, expect, it } from 'vitest';
import {
  orderOpenGoalsAvoidingRejectLessons,
  createSelfEvolutionLessonRecall,
} from '../../src/room/NoeSelfEvolutionLessonRecall.js';
import {
  buildSelfEvolutionRejectLessonSummary,
  createSelfEvolutionRejectLessonRecorder,
} from '../../src/room/NoeSelfEvolutionRejectLesson.js';
import {
  buildSelfEvolutionHealthSnapshot,
  describeSelfEvolutionBlocker,
  readSelfEvolutionFlagSnapshot,
} from '../../src/room/NoeSelfEvolutionHealthSnapshot.js';
import { evaluateNoeSelfEvolutionLoop } from '../../src/room/NoeSelfEvolutionLoop.js';
import { createNoeSelfEvolutionTrigger } from '../../src/room/NoeSelfEvolutionTrigger.js';

describe('orderOpenGoalsAvoidingRejectLessons (true flywheel on open queue)', () => {
  it('demotes near-duplicate of reject lesson so [0] is not doomed forever', () => {
    const rejectedObj = '修复 src/runtime/NoeSourceDigest.js 的类型错误 TS2304';
    const lessonBody = buildSelfEvolutionRejectLessonSummary({
      objective: rejectedObj,
      reviews: [{ model: 'claude', decision: 'reject' }],
      errors: ['missing_tests'],
    });
    const lessons = [{ body: lessonBody, tags: ['self_evolution_reject'], createdAt: Date.now() }];
    const recall = createSelfEvolutionLessonRecall({
      recall: () => lessons,
      windowMs: 0,
      limit: 8,
    });
    const goals = [
      { id: 'g-doomed', title: rejectedObj, priority: 0.99, source: 'self_evolution' },
      { id: 'g-fresh', title: '优化 NoeSelfEvolutionHealthSnapshot 可观测性', priority: 0.5, source: 'self_evolution' },
    ];
    expect(goals[0].id).toBe('g-doomed');
    const { ordered, demoted } = orderOpenGoalsAvoidingRejectLessons(goals, recall, { demoteOnly: true });
    expect(demoted.length).toBeGreaterThanOrEqual(1);
    expect(ordered[0].id).toBe('g-fresh');
    expect(ordered.map((g) => g.id)).toContain('g-doomed');
  });

  it('hard-filter mode drops similar goals', () => {
    const rejectedObj = '修复 NoeBaiLongmaRuntimeMode 的 envelope 路径';
    const lessonBody = buildSelfEvolutionRejectLessonSummary({
      objective: rejectedObj,
      reviews: [{ model: 'm3', decision: 'reject' }],
      errors: ['bad_patch'],
    });
    const recall = createSelfEvolutionLessonRecall({
      recall: () => [{ body: lessonBody, tags: ['self_evolution_reject'], createdAt: Date.now() }],
      windowMs: 0,
    });
    const { ordered, blocked } = orderOpenGoalsAvoidingRejectLessons(
      [
        { id: 'a', title: rejectedObj },
        { id: 'b', title: '完全不同的目标：整理文档目录结构' },
      ],
      recall,
      { demoteOnly: false },
    );
    expect(ordered.some((g) => g.id === 'a')).toBe(false);
    expect(ordered.some((g) => g.id === 'b')).toBe(true);
    expect(blocked.length).toBe(1);
  });

  it('fail-open when recall missing', () => {
    const goals = [{ id: 'x', title: 'anything' }];
    const r = orderOpenGoalsAvoidingRejectLessons(goals, null);
    expect(r.ordered).toEqual(goals);
    expect(r.recallUnavailable).toBe(true);
  });
});

describe('lesson write → recall → second proposal blocked', () => {
  it('recorder + recall blocks near-duplicate objective', () => {
    const writes = [];
    const record = createSelfEvolutionRejectLessonRecorder({
      memoryWrite: (e) => {
        writes.push(e);
        return { id: 'mem1' };
      },
      now: () => 1_700_000_000_000,
      projectId: 'noe',
    });
    const objective = '修复 src/loop/NoeSelfEvolutionActGuard.js 校验漏洞';
    const out = record({
      objective,
      cycleId: 'c1',
      reviews: [{ model: 'claude', decision: 'reject' }],
      errors: ['gate_failed'],
    });
    expect(out.ok).toBe(true);
    expect(writes[0].sourceType).toBe('self_evolution_reject_lesson');
    expect(writes[0].tags).toContain('self_evolution_reject');

    const recall = createSelfEvolutionLessonRecall({
      recall: () => [{
        body: writes[0].text,
        tags: writes[0].tags,
        sourceType: writes[0].sourceType,
        createdAt: 1_700_000_000_000,
      }],
      windowMs: 0,
    });
    const first = recall(objective);
    expect(first.similar).toBe(true);
    const second = recall('完全不同：为 home shell 增加空状态文案');
    expect(second.similar).toBe(false);
  });
});

describe('describeSelfEvolutionBlocker + loop progressBlocker', () => {
  it('consensus_blocked without autodrive is explicit non-progress', () => {
    const b = describeSelfEvolutionBlocker(
      { stage: 'consensus_blocked', nextAction: 'refresh_four_model_consensus', blocked: true },
      { hasConsensusAutodrive: false },
    );
    expect(b.progressPossible).toBe(false);
    expect(b.reason).toBe('consensus_blocked_no_autodrive');
    expect(b.needsAutodrive).toBe(true);
  });

  it('loop attaches progressBlocker on consensus_blocked', () => {
    const state = evaluateNoeSelfEvolutionLoop({
      implementation: {},
      hasConsensusAutodrive: false,
    });
    expect(state.stage).toBe('consensus_blocked');
    expect(state.progressBlocker?.reason).toBe('consensus_blocked_no_autodrive');
    expect(state.progressBlocker?.progressPossible).toBe(false);
  });

  it('with completion autodrive flag on input, post_review_required reports progressPossible', () => {
    const b = describeSelfEvolutionBlocker(
      { stage: 'post_review_required', blocked: true },
      { hasCompletionAutodrive: true },
    );
    expect(b.progressPossible).toBe(true);
    expect(b.reason).toBe('awaiting_completion_autodrive');
  });
});

describe('buildSelfEvolutionHealthSnapshot', () => {
  it('reports armed rings and flywheel stage without secrets', () => {
    const snap = buildSelfEvolutionHealthSnapshot({
      env: {
        NOE_SELF_EVOLUTION: '1',
        NOE_SELF_EVOLUTION_EXECUTORS: '1',
        NOE_SELF_EVOLUTION_REAL_APPLY: '0',
        NOE_SELFEVO_REJECT_LEARNING: '1',
        NOE_SELFEVO_LESSON_AWARE_AUTOSEED: '1',
        NOE_HEARTBEAT: '1',
      },
      openGoals: [{ id: 'g1' }],
      loop: { stage: 'consensus_blocked', nextAction: 'refresh', blocked: true },
      lastFailureClass: 'post_review_reject',
      now: 42,
    });
    expect(snap.kind).toBe('neo.self-evolution.health.v1');
    expect(snap.armed.rings).toBe(true);
    expect(snap.armed.realApply).toBe(false);
    expect(snap.armed.lessonFlywheel).toBe(true);
    expect(snap.flywheel.primaryStage).toBe('consensus_blocked');
    expect(snap.flywheel.progressPossible).toBe(false);
    expect(snap.honesty.realApplyDefaultOff).toBe(true);
    expect(JSON.stringify(snap)).not.toMatch(/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{16,}/);
  });

  it('readSelfEvolutionFlagSnapshot defaults off', () => {
    const f = readSelfEvolutionFlagSnapshot({});
    expect(f.NOE_SELF_EVOLUTION).toBe(false);
    expect(f.NOE_SELF_EVOLUTION_REAL_APPLY).toBe(false);
  });
});

describe('trigger openSelfEvolutionGoals demotes doomed first pick', () => {
  it('with lessonAwareAutoseed, open queue prefers non-similar goal', () => {
    const rejectedObj = '修复 src/runtime/NoeSourceDigest.js 的 digest 回归';
    const lessonBody = buildSelfEvolutionRejectLessonSummary({
      objective: rejectedObj,
      reviews: [{ model: 'claude', decision: 'reject' }],
      errors: ['tests_failed'],
    });
    const goals = [
      { id: 'doomed', title: rejectedObj, priority: 0.95, source: 'self_evolution', status: 'open' },
      { id: 'good', title: '为自进化健康快照增加 status 字段', priority: 0.4, source: 'self_evolution', status: 'open' },
    ];
    const trigger = createNoeSelfEvolutionTrigger({
      lessonAwareAutoseed: true,
      recallRejectLessons: createSelfEvolutionLessonRecall({
        recall: () => [{ body: lessonBody, tags: ['self_evolution_reject'], createdAt: Date.now() }],
        windowMs: 0,
      }),
      goalSystem: {
        list: ({ status }) => goals.filter((g) => g.status === status || status === 'open'),
      },
    });
    const open = trigger.openSelfEvolutionGoals();
    expect(open[0].id).toBe('good');
  });
});

describe('trigger evalLoop wires autodrive capability into progressBlocker', () => {
  it('with assembleConsensus injected, tick on consensus_blocked reports awaiting_consensus_autodrive', async () => {
    const goalId = 'g-consensus-blocked';
    const cycle = {
      cycleId: 'cyc-1',
      goalId,
      goal: '推进共识',
      objective: '推进共识',
      // no consensus ledger → loop stage consensus_blocked
      implementation: {},
      authorization: {},
      rollback: {},
    };
    let stored = { ...cycle };
    const cycleStore = {
      getByGoal: (id) => (id === goalId ? { ...stored } : null),
      advance: (cycleId, patch) => {
        stored = { ...stored, ...patch, cycleId };
        return { ok: true, cycle: { ...stored } };
      },
    };
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem: {
        get: (id) => (id === goalId ? { id: goalId, title: '推进共识', source: 'self_evolution' } : null),
        list: () => [],
        setStatus: () => true,
      },
      cycleStore,
      // inject autodrive — must flip progressBlocker even before advance succeeds
      assembleConsensus: () => ({
        ok: false,
        reason: 'fixture_no_ledger',
      }),
      assembleCompletion: null,
      propose: null,
    });
    const tickResult = await trigger.tick({ goalId });
    expect(tickResult.stage).toBe('consensus_blocked');
    expect(tickResult.proposed).toBe(false);
    // Production wiring: assembleConsensus present → not false "no_autodrive"
    expect(tickResult.progressBlocker?.reason).toBe('awaiting_consensus_autodrive');
    expect(tickResult.progressBlocker?.progressPossible).toBe(true);
    expect(tickResult.progressBlocker?.needsAutodrive).toBe(true);
  });

  it('without assembleConsensus, tick reports consensus_blocked_no_autodrive', async () => {
    const goalId = 'g-no-drive';
    const cycle = {
      cycleId: 'cyc-2',
      goalId,
      goal: '卡死项',
      objective: '卡死项',
      implementation: {},
    };
    const trigger = createNoeSelfEvolutionTrigger({
      goalSystem: {
        get: (id) => (id === goalId ? { id: goalId, title: '卡死项', source: 'self_evolution' } : null),
        list: () => [],
      },
      cycleStore: {
        getByGoal: (id) => (id === goalId ? { ...cycle } : null),
        advance: () => ({ ok: false }),
      },
      assembleConsensus: null,
      propose: null,
    });
    const tickResult = await trigger.tick({ goalId });
    expect(tickResult.stage).toBe('consensus_blocked');
    expect(tickResult.progressBlocker?.reason).toBe('consensus_blocked_no_autodrive');
    expect(tickResult.progressBlocker?.progressPossible).toBe(false);
  });
});

describe('CycleStore.evaluateLoop capability alignment', () => {
  it('store.evaluateLoop with hasConsensusAutodrive reports awaiting_consensus_autodrive', async () => {
    const { NoeSelfEvolutionCycleStore } = await import('../../src/room/NoeSelfEvolutionCycleStore.js');
    const store = new NoeSelfEvolutionCycleStore({
      projectId: 'test-proj',
      hasConsensusAutodrive: true,
      hasCompletionAutodrive: false,
    });
    const loop = store.evaluateLoop({ implementation: {}, goal: 'x' });
    expect(loop.stage).toBe('consensus_blocked');
    expect(loop.progressBlocker?.reason).toBe('awaiting_consensus_autodrive');
    expect(loop.progressBlocker?.progressPossible).toBe(true);
  });
});
