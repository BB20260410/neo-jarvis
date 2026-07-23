// @ts-check
/**
 * Safe self-evolution profile: arms perception + memory + falsification rings
 * while keeping REAL_APPLY OFF (boundary).
 *
 * Activate with NOE_SELFEVO_PROFILE=safe (fills only undefined keys for arming flags).
 * REAL_APPLY is always forced to 0 under safe unless double opt-in:
 *   NOE_SELFEVO_ALLOW_REAL_APPLY=1  AND  NOE_SELF_EVOLUTION_REAL_APPLY=1
 */

/** Recommended flags for gated “true” flywheel under dry-run default. */
export const SELF_EVOLUTION_SAFE_PROFILE = Object.freeze({
  NOE_SELF_EVOLUTION: '1',
  NOE_SELF_EVOLUTION_EXECUTORS: '1',
  NOE_SELF_EVOLUTION_TYPECHECK: '1',
  NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE: '1',
  NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE: '1',
  NOE_SELFEVO_REJECT_LEARNING: '1',
  NOE_SELFEVO_LESSON_AWARE_AUTOSEED: '1',
  NOE_SELFEVO_FAILFAST: '1',
  NOE_SELFEVO_REWORK: '1',
  NOE_SELFEVO_TYPEERR_DETAIL: '1',
  NOE_SELFEVO_REPAIR_HINTS: '1',
  NOE_SELFEVO_SIGNAL_WEIGHTING: '1',
  NOE_SELFEVO_STRICT_AUTOSEED: '1',
  // Boundaries — never auto-enable real tree rewrite via profile alone
  NOE_SELF_EVOLUTION_REAL_APPLY: '0',
  // Heartbeat needed for continuous ticks when owner wants continuous loop
  NOE_HEARTBEAT: '1',
});

/**
 * Explicit double opt-in for real tree rewrite under profile=safe.
 * Alone, REAL_APPLY=1 is NOT enough when safe profile is active.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function isSelfEvolutionRealApplyAllowed(env = process.env) {
  return String(env.NOE_SELFEVO_ALLOW_REAL_APPLY || '') === '1'
    && String(env.NOE_SELF_EVOLUTION_REAL_APPLY || '') === '1';
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {'off'|'safe'|'custom'}
 */
export function resolveSelfEvolutionProfileName(env = process.env) {
  const raw = String(env.NOE_SELFEVO_PROFILE || env.NOE_SELF_EVOLUTION_PROFILE || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'safe' || raw === 'true' || raw === '1' || raw === 'flywheel') return 'safe';
  return 'custom';
}

/**
 * Whether trigger/executors may request realExecute.
 * - profile=safe → double opt-in only (ALLOW + REAL_APPLY)
 * - otherwise → REAL_APPLY=1 alone (legacy / custom profiles)
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function resolveSelfEvolutionRealApplyEnabled(env = process.env) {
  if (resolveSelfEvolutionProfileName(env) === 'safe') {
    return isSelfEvolutionRealApplyAllowed(env);
  }
  return String(env.NOE_SELF_EVOLUTION_REAL_APPLY || '') === '1';
}

/**
 * Capability flags for CycleStore.computeStage / evaluateLoop — keep in sync with
 * trigger autodrive / rework env so DB stage matches runtime.
 * maxReworkRounds must be >0 when rework is ON, else loop never yields post_review_rework_ready.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function resolveSelfEvolutionCycleStoreCapability(env = process.env) {
  const on = (k) => String(env[k] || '') === '1';
  const reworkEnabled = on('NOE_SELFEVO_REWORK');
  const rawMax = Number(env.NOE_SELFEVO_MAX_REWORK_ROUNDS);
  // Align with server trigger default: 2 when rework on; 0 when off.
  const maxReworkRounds = reworkEnabled
    ? (Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : 2)
    : 0;
  return {
    hasConsensusAutodrive: on('NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE'),
    hasCompletionAutodrive: on('NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE'),
    reworkEnabled,
    maxReworkRounds,
  };
}

/**
 * Apply safe profile into env.
 * - Arming flags: only fill undefined/empty keys.
 * - REAL_APPLY: force '0' unless NOE_SELFEVO_ALLOW_REAL_APPLY=1 (double opt-in).
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {{ apply?: boolean, profile?: string }} [opts]
 */
export function applySelfEvolutionProfile(env = process.env, opts = {}) {
  const name = opts.profile || resolveSelfEvolutionProfileName(env);
  if (name !== 'safe') {
    return { applied: false, profile: name, keys: [], realApplyForcedOff: false };
  }
  /** @type {string[]} */
  const keys = [];
  let realApplyForcedOff = false;
  let realApplyOwnerOverride = false;
  if (opts.apply === true) {
    for (const [k, v] of Object.entries(SELF_EVOLUTION_SAFE_PROFILE)) {
      if (k === 'NOE_SELF_EVOLUTION_REAL_APPLY') {
        // Boundary: safe profile forces dry-run unless explicit double opt-in.
        const allow = String(env.NOE_SELFEVO_ALLOW_REAL_APPLY || '') === '1';
        if (allow && String(env.NOE_SELF_EVOLUTION_REAL_APPLY || '') === '1') {
          realApplyOwnerOverride = true;
          // keep REAL_APPLY=1
        } else if (env[k] !== '0') {
          env[k] = '0';
          keys.push(k);
          realApplyForcedOff = true;
        } else {
          realApplyForcedOff = true;
        }
        continue;
      }
      if (env[k] === undefined || env[k] === '') {
        env[k] = v;
        keys.push(k);
      }
    }
  }
  return {
    applied: opts.apply === true && keys.length > 0,
    profile: 'safe',
    keys,
    realApplyForcedOff: realApplyForcedOff || !realApplyOwnerOverride,
    realApplyOwnerOverride,
    snapshot: { ...SELF_EVOLUTION_SAFE_PROFILE },
  };
}

/**
 * Machine summary for health/UI: whether perception/memory/falsify/boundary rings look armed.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function summarizeSelfEvolutionRings(env = process.env) {
  const on = (k) => String(env[k] || '') === '1';
  // boundary = real rewrite not effectively enabled (safe profile needs double opt-in).
  // Do NOT use raw REAL_APPLY alone — under safe without ALLOW, effective real-apply is off.
  return {
    perception: on('NOE_SELF_EVOLUTION') && (on('NOE_SELF_EVOLUTION_TYPECHECK') || on('NOE_SELF_EVOLUTION_EXECUTORS')),
    memory: on('NOE_SELFEVO_REJECT_LEARNING') && on('NOE_SELFEVO_LESSON_AWARE_AUTOSEED'),
    falsification: on('NOE_SELF_EVOLUTION_EXECUTORS') && on('NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE'),
    boundary: resolveSelfEvolutionRealApplyEnabled(env) !== true,
    continuousTick: on('NOE_SELF_EVOLUTION') && on('NOE_HEARTBEAT'),
  };
}
