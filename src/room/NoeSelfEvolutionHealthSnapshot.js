// @ts-check
/**
 * Machine-readable self-evolution health snapshot (no secrets).
 * Observable “is the flywheel armed / stuck / learning?” for audits and UI chips.
 */

import {
  summarizeSelfEvolutionRings,
  resolveSelfEvolutionProfileName,
  resolveSelfEvolutionRealApplyEnabled,
} from './NoeSelfEvolutionProfile.js';

export const SELF_EVOLUTION_HEALTH_SCHEMA = 'neo.self-evolution.health.v1';

/** Stages that cannot propose without autodrive / external work. */
export const NON_ACTIONABLE_STAGES = Object.freeze([
  'consensus_blocked',
  'implementation_blocked',
  'self_repair_blocked',
  'runtime_verification_required',
  'post_review_required',
  'retrospective_required',
  'post_review_rework_ready',
]);

/**
 * Explicit blocker description for a loop stage (pure).
 * @param {object} [loop] evaluateNoeSelfEvolutionLoop result
 * @param {{ hasConsensusAutodrive?: boolean, hasCompletionAutodrive?: boolean, reworkEnabled?: boolean }} [opts]
 */
export function describeSelfEvolutionBlocker(loop = {}, opts = {}) {
  const stage = String(loop?.stage || '');
  const nextAction = String(loop?.nextAction || '');
  const blocked = loop?.blocked === true;
  if (!stage) {
    return {
      progressPossible: false,
      reason: 'no_stage',
      nextAction: '',
      needsAutodrive: false,
    };
  }
  if (stage === 'complete' || stage === 'memory_writeback_ready' || stage === 'implementation_ready' || stage === 'self_repair_ready') {
    return {
      progressPossible: true,
      reason: blocked ? 'gate_blocked' : 'actionable',
      nextAction,
      needsAutodrive: false,
    };
  }
  if (stage === 'consensus_blocked') {
    return {
      progressPossible: opts.hasConsensusAutodrive === true,
      reason: opts.hasConsensusAutodrive ? 'awaiting_consensus_autodrive' : 'consensus_blocked_no_autodrive',
      nextAction: nextAction || 'refresh_four_model_consensus',
      needsAutodrive: true,
      autodriveKind: 'consensus',
    };
  }
  if (stage === 'post_review_required' || stage === 'retrospective_required') {
    return {
      progressPossible: opts.hasCompletionAutodrive === true,
      reason: opts.hasCompletionAutodrive ? 'awaiting_completion_autodrive' : `${stage}_no_autodrive`,
      nextAction: nextAction || 'run_post_review_or_retrospective',
      needsAutodrive: true,
      autodriveKind: 'completion',
    };
  }
  if (stage === 'post_review_rework_ready') {
    return {
      progressPossible: opts.reworkEnabled === true,
      reason: opts.reworkEnabled ? 'rework_ready' : 'rework_signal_but_disabled',
      nextAction: nextAction || 'rework_implementation_with_reviewer_blockers',
      needsAutodrive: false,
    };
  }
  if (stage === 'runtime_verification_required') {
    return {
      progressPossible: true,
      reason: 'needs_runtime_verification',
      nextAction: nextAction || 'run_targeted_runtime_verification',
      needsAutodrive: false,
    };
  }
  return {
    progressPossible: !blocked,
    reason: blocked ? 'blocked' : 'unknown_stage',
    nextAction,
    needsAutodrive: false,
  };
}

/**
 * Read env flag snapshot (does not print secrets).
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function readSelfEvolutionFlagSnapshot(env = process.env) {
  const on = (k) => String(env[k] || '') === '1';
  return {
    NOE_SELF_EVOLUTION: on('NOE_SELF_EVOLUTION'),
    NOE_SELF_EVOLUTION_REAL_APPLY: on('NOE_SELF_EVOLUTION_REAL_APPLY'),
    NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE: on('NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE'),
    NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE: on('NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE'),
    NOE_SELF_EVOLUTION_EXECUTORS: on('NOE_SELF_EVOLUTION_EXECUTORS'),
    NOE_SELFEVO_REJECT_LEARNING: on('NOE_SELFEVO_REJECT_LEARNING'),
    NOE_SELFEVO_LESSON_AWARE_AUTOSEED: on('NOE_SELFEVO_LESSON_AWARE_AUTOSEED'),
    NOE_SELFEVO_REWORK: on('NOE_SELFEVO_REWORK'),
    NOE_SELFEVO_FAILFAST: on('NOE_SELFEVO_FAILFAST'),
    NOE_SELFEVO_SIGNAL_WEIGHTING: on('NOE_SELFEVO_SIGNAL_WEIGHTING'),
    NOE_HEARTBEAT: on('NOE_HEARTBEAT'),
  };
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 * @param {Array<object>} [opts.openGoals]
 * @param {object|null} [opts.primaryCycle] open cycle for primary goal
 * @param {object|null} [opts.loop] evaluateNoeSelfEvolutionLoop result for primary
 * @param {string|null} [opts.lastFailureClass]
 * @param {object|null} [opts.lastLessonVerdict] classifyAgainstRejectLessons result
 * @param {number} [opts.now]
 */
export function buildSelfEvolutionHealthSnapshot(opts = {}) {
  const env = opts.env || process.env;
  const flags = readSelfEvolutionFlagSnapshot(env);
  const openGoals = Array.isArray(opts.openGoals) ? opts.openGoals : [];
  const loop = opts.loop || null;
  const blocker = describeSelfEvolutionBlocker(loop || {}, {
    hasConsensusAutodrive: flags.NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE,
    hasCompletionAutodrive: flags.NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE,
    reworkEnabled: flags.NOE_SELFEVO_REWORK,
  });
  const ringsArmed = flags.NOE_SELF_EVOLUTION && flags.NOE_SELF_EVOLUTION_EXECUTORS;
  const learningArmed = flags.NOE_SELFEVO_REJECT_LEARNING && flags.NOE_SELFEVO_LESSON_AWARE_AUTOSEED;
  // realApply armed = effective enablement (safe profile needs double opt-in), not raw REAL_APPLY flag alone.
  const realApplyEffective = resolveSelfEvolutionRealApplyEnabled(env);
  return {
    schemaVersion: 1,
    kind: SELF_EVOLUTION_HEALTH_SCHEMA,
    generatedAt: Number(opts.now) || Date.now(),
    armed: {
      trigger: flags.NOE_SELF_EVOLUTION === true,
      executors: flags.NOE_SELF_EVOLUTION_EXECUTORS === true,
      heartbeat: flags.NOE_HEARTBEAT === true,
      rings: ringsArmed === true,
      realApply: realApplyEffective === true,
      lessonFlywheel: learningArmed === true,
      consensusAutodrive: flags.NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE === true,
      completionAutodrive: flags.NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE === true,
      rework: flags.NOE_SELFEVO_REWORK === true,
      failFast: flags.NOE_SELFEVO_FAILFAST === true,
    },
    flags,
    flywheel: {
      openGoalCount: openGoals.length,
      primaryGoalId: openGoals[0]?.id || null,
      primaryStage: loop?.stage || opts.primaryCycle?.stage || null,
      nextAction: loop?.nextAction || null,
      progressPossible: blocker.progressPossible,
      blocker,
    },
    learning: {
      lastFailureClass: opts.lastFailureClass || null,
      lastLessonSimilar: opts.lastLessonVerdict?.similar === true,
      lastLessonScore: Number(opts.lastLessonVerdict?.score) || 0,
      lastLessonReason: opts.lastLessonVerdict?.reason || null,
    },
    honesty: {
      realApplyDefaultOff: realApplyEffective !== true,
      note: 'Default-OFF dry-run under profile=safe; real-apply needs NOE_SELFEVO_ALLOW_REAL_APPLY=1 + NOE_SELF_EVOLUTION_REAL_APPLY=1 + gates/grants.',
      allowRealApplyFlag: String(env.NOE_SELFEVO_ALLOW_REAL_APPLY || '') === '1',
      rawRealApplyFlag: flags.NOE_SELF_EVOLUTION_REAL_APPLY === true,
    },
    rings: summarizeSelfEvolutionRings(env),
    profile: resolveSelfEvolutionProfileName(env),
  };
}
