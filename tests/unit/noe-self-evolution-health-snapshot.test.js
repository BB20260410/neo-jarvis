import { describe, it, expect } from 'vitest';
import {
  describeSelfEvolutionBlocker,
  readSelfEvolutionFlagSnapshot,
  buildSelfEvolutionHealthSnapshot,
  SELF_EVOLUTION_HEALTH_SCHEMA,
  NON_ACTIONABLE_STAGES,
} from '../../src/room/NoeSelfEvolutionHealthSnapshot.js';

describe('describeSelfEvolutionBlocker', () => {
  it('returns no_stage when loop is empty', () => {
    const result = describeSelfEvolutionBlocker({});
    expect(result).toEqual({
      progressPossible: false,
      reason: 'no_stage',
      nextAction: '',
      needsAutodrive: false,
    });
  });

  it('returns actionable for complete stage', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'complete', nextAction: 'done' });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('actionable');
    expect(result.nextAction).toBe('done');
  });

  it('returns consensus_blocked_no_autodrive when no autodrive', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'consensus_blocked' }, {});
    expect(result.progressPossible).toBe(false);
    expect(result.reason).toBe('consensus_blocked_no_autodrive');
    expect(result.needsAutodrive).toBe(true);
  });

  it('returns awaiting_consensus_autodrive when autodrive enabled', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'consensus_blocked' }, { hasConsensusAutodrive: true });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('awaiting_consensus_autodrive');
  });

  it('returns post_review_required_no_autodrive when no completion autodrive', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'post_review_required' }, {});
    expect(result.progressPossible).toBe(false);
    expect(result.reason).toBe('post_review_required_no_autodrive');
  });

  it('returns awaiting_completion_autodrive when completion autodrive enabled', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'retrospective_required' }, { hasCompletionAutodrive: true });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('awaiting_completion_autodrive');
  });

  it('returns rework_signal_but_disabled when rework disabled', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'post_review_rework_ready' }, {});
    expect(result.progressPossible).toBe(false);
    expect(result.reason).toBe('rework_signal_but_disabled');
  });

  it('returns rework_ready when rework enabled', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'post_review_rework_ready' }, { reworkEnabled: true });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('rework_ready');
  });

  it('returns needs_runtime_verification for runtime_verification_required', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'runtime_verification_required' });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('needs_runtime_verification');
  });

  it('returns blocked for unknown blocked stage', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'unknown', blocked: true });
    expect(result.progressPossible).toBe(false);
    expect(result.reason).toBe('blocked');
  });

  it('returns unknown_stage for unknown non-blocked stage', () => {
    const result = describeSelfEvolutionBlocker({ stage: 'unknown', blocked: false });
    expect(result.progressPossible).toBe(true);
    expect(result.reason).toBe('unknown_stage');
  });
});

describe('readSelfEvolutionFlagSnapshot', () => {
  it('returns all false when env is empty', () => {
    const result = readSelfEvolutionFlagSnapshot({});
    expect(result.NOE_SELF_EVOLUTION).toBe(false);
    expect(result.NOE_SELF_EVOLUTION_EXECUTORS).toBe(false);
    expect(result.NOE_HEARTBEAT).toBe(false);
  });

  it('returns true when env value is "1"', () => {
    const result = readSelfEvolutionFlagSnapshot({ NOE_SELF_EVOLUTION: '1' });
    expect(result.NOE_SELF_EVOLUTION).toBe(true);
  });

  it('returns false when env value is "0"', () => {
    const result = readSelfEvolutionFlagSnapshot({ NOE_SELF_EVOLUTION: '0' });
    expect(result.NOE_SELF_EVOLUTION).toBe(false);
  });

  it('returns false when env value is undefined', () => {
    const result = readSelfEvolutionFlagSnapshot({ NOE_SELF_EVOLUTION: undefined });
    expect(result.NOE_SELF_EVOLUTION).toBe(false);
  });
});

describe('buildSelfEvolutionHealthSnapshot', () => {
  it('returns snapshot with correct schema version and kind', () => {
    const result = buildSelfEvolutionHealthSnapshot({ now: 1234567890 });
    expect(result.schemaVersion).toBe(1);
    expect(result.kind).toBe(SELF_EVOLUTION_HEALTH_SCHEMA);
    expect(result.generatedAt).toBe(1234567890);
  });

  it('returns armed flags based on env', () => {
    const result = buildSelfEvolutionHealthSnapshot({
      env: {
        NOE_SELF_EVOLUTION: '1',
        NOE_SELF_EVOLUTION_EXECUTORS: '1',
        NOE_HEARTBEAT: '1',
      },
    });
    expect(result.armed.trigger).toBe(true);
    expect(result.armed.executors).toBe(true);
    expect(result.armed.heartbeat).toBe(true);
    expect(result.armed.rings).toBe(true);
  });

  it('returns flywheel with open goal count', () => {
    const result = buildSelfEvolutionHealthSnapshot({
      openGoals: [{ id: 'goal-1' }, { id: 'goal-2' }],
    });
    expect(result.flywheel.openGoalCount).toBe(2);
    expect(result.flywheel.primaryGoalId).toBe('goal-1');
  });

  it('returns learning section with nulls when no lesson verdict', () => {
    const result = buildSelfEvolutionHealthSnapshot({});
    expect(result.learning.lastFailureClass).toBe(null);
    expect(result.learning.lastLessonSimilar).toBe(false);
    expect(result.learning.lastLessonScore).toBe(0);
    expect(result.learning.lastLessonReason).toBe(null);
  });

  it('returns learning section with lesson verdict data', () => {
    const result = buildSelfEvolutionHealthSnapshot({
      lastFailureClass: 'timeout',
      lastLessonVerdict: { similar: true, score: 0.85, reason: 'similar_error' },
    });
    expect(result.learning.lastFailureClass).toBe('timeout');
    expect(result.learning.lastLessonSimilar).toBe(true);
    expect(result.learning.lastLessonScore).toBe(0.85);
    expect(result.learning.lastLessonReason).toBe('similar_error');
  });
});

describe('constants', () => {
  it('SELF_EVOLUTION_HEALTH_SCHEMA is correct', () => {
    expect(SELF_EVOLUTION_HEALTH_SCHEMA).toBe('neo.self-evolution.health.v1');
  });

  it('NON_ACTIONABLE_STAGES contains expected stages', () => {
    expect(NON_ACTIONABLE_STAGES).toContain('consensus_blocked');
    expect(NON_ACTIONABLE_STAGES).toContain('implementation_blocked');
    expect(NON_ACTIONABLE_STAGES).toContain('self_repair_blocked');
    expect(NON_ACTIONABLE_STAGES).toContain('runtime_verification_required');
    expect(NON_ACTIONABLE_STAGES).toContain('post_review_required');
    expect(NON_ACTIONABLE_STAGES).toContain('retrospective_required');
    expect(NON_ACTIONABLE_STAGES).toContain('post_review_rework_ready');
  });
});
