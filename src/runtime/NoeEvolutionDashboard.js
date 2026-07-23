// @ts-check
/**
 * Evolution dry-run dashboard DTO — read-only observability for product UI.
 * Honors REAL_APPLY default OFF under profile=safe without dual opt-in.
 */
import { buildSelfEvolutionHealthSnapshot } from '../room/NoeSelfEvolutionHealthSnapshot.js';

export const EVO_DASHBOARD_SCHEMA = 'neo.evolution.dashboard.v1';

/**
 * Build user-facing evolution dashboard model.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 * @param {object|null} [opts.loop]
 * @param {object|null} [opts.primaryCycle]
 * @param {Array<object>} [opts.openGoals]
 * @param {object|null} [opts.recentSignal]
 * @param {number} [opts.now]
 */
export function buildEvolutionDashboard(opts = {}) {
  const env = opts.env || process.env;
  const snap = buildSelfEvolutionHealthSnapshot({
    env,
    loop: opts.loop || null,
    primaryCycle: opts.primaryCycle || null,
    openGoals: opts.openGoals || [],
    now: opts.now,
  });

  const realApplyOn = snap.armed?.realApply === true;
  const profile = snap.profile || 'off';
  const rings = snap.rings || {};
  const flywheel = snap.flywheel || {};
  const honesty = snap.honesty || {};

  // Under safe without dual opt-in, never claim live rewrite is on.
  const liveRewriteClaim = realApplyOn === true;
  const dryRunHonest = !liveRewriteClaim;

  const stage = flywheel.primaryStage || opts.primaryCycle?.stage || 'idle';
  const blocker = flywheel.blocker || { reason: 'none', progressPossible: true };

  const recentSignal = opts.recentSignal && typeof opts.recentSignal === 'object'
    ? {
      id: String(opts.recentSignal.id || opts.recentSignal.signalId || '').slice(0, 80),
      kind: String(opts.recentSignal.kind || opts.recentSignal.type || '').slice(0, 80),
      summary: String(opts.recentSignal.summary || opts.recentSignal.title || '').slice(0, 240),
      at: opts.recentSignal.at || opts.recentSignal.createdAt || null,
    }
    : null;

  return {
    schema: EVO_DASHBOARD_SCHEMA,
    profile,
    boundary: {
      realApply: liveRewriteClaim,
      dryRunDefault: dryRunHonest,
      label: liveRewriteClaim
        ? '真改已开启（双开关 + 门控）'
        : 'dry-run · 默认不真改源码',
      honestyNote: honesty.note || 'REAL_APPLY default OFF under profile=safe.',
      allowRealApplyFlag: honesty.allowRealApplyFlag === true,
      rawRealApplyFlag: honesty.rawRealApplyFlag === true,
    },
    rings: {
      perception: rings.perception === true,
      memory: rings.memory === true,
      falsification: rings.falsification === true,
      boundary: rings.boundary !== false,
    },
    stage: {
      name: stage,
      nextAction: flywheel.nextAction || '',
      progressPossible: blocker.progressPossible !== false,
      blockerReason: blocker.reason || '',
    },
    cycleSummary: {
      openGoalCount: Number(flywheel.openGoalCount) || 0,
      primaryGoalId: flywheel.primaryGoalId || null,
      primaryStage: stage,
    },
    recentSignal,
    armed: {
      rings: snap.armed?.rings === true,
      realApply: liveRewriteClaim,
      heartbeat: snap.armed?.heartbeat === true,
      lessonFlywheel: snap.armed?.lessonFlywheel === true,
    },
    claimsLiveRewrite: liveRewriteClaim,
    readOnly: true,
  };
}

/**
 * Guard for tests: safe profile must not claim live rewrite without dual opt-in effective realApply.
 * @param {ReturnType<typeof buildEvolutionDashboard>} dash
 */
export function evolutionDashboardIsHonestAboutRealApply(dash) {
  if (!dash) return false;
  if (dash.claimsLiveRewrite === true && dash.boundary?.realApply !== true) return false;
  if (dash.boundary?.realApply === true && dash.claimsLiveRewrite !== true) return false;
  // If profile is safe and realApply false, label must not say 真改已开启 as default
  if (dash.profile === 'safe' && dash.boundary?.realApply !== true) {
    if (/真改已开启/.test(String(dash.boundary?.label || '')) && !dash.boundary?.realApply) {
      return false;
    }
    if (dash.claimsLiveRewrite) return false;
  }
  return dash.readOnly === true;
}
