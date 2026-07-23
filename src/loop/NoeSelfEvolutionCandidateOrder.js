// @ts-check
/**
 * Pure candidate-order policy for self-evolution implementer adapters.
 * Fixes repair escalate hole: routeAdapterId may be lmstudio-code under LOCAL_FIRST,
 * so putting it first made "cloud-first" still run local and never cascade on bad patches.
 */

const DEFAULT_LOCAL_IDS = Object.freeze([
  'lmstudio',
  'lmstudio-code',
  'ollama',
  'ollama-9b',
]);

const DEFAULT_CLOUD_FALLBACKS = Object.freeze([
  'minimax',
  'minimax-highspeed',
  'codex',
  'claude',
  'gemini',
]);

/**
 * @param {string|null|undefined} id
 * @param {string} localCodeAdapterId
 * @param {string[]} [extraLocalIds]
 */
export function isLocalCodeAdapterId(id, localCodeAdapterId = 'lmstudio', extraLocalIds = DEFAULT_LOCAL_IDS) {
  const s = String(id || '').trim();
  if (!s) return true;
  if (s === localCodeAdapterId) return true;
  if (extraLocalIds.includes(s)) return true;
  if (s.startsWith('lmstudio')) return true;
  if (s.startsWith('ollama')) return true;
  return false;
}

/**
 * Resolve ordered adapter ids for implementer.
 * @param {object} [opts]
 * @param {string|null} [opts.routeAdapterId]
 * @param {string} [opts.localCodeAdapterId]
 * @param {boolean} [opts.localFirst]
 * @param {boolean} [opts.cloudFirst] repair escalate / second+ repair beat
 * @param {string[]} [opts.cloudFallbackIds]
 * @param {boolean} [opts.hasPriorRepairEvidence] second+ repair: force cloud even harder
 * @returns {string[]}
 */
export function resolveSelfEvolutionImplementerCandidates({
  routeAdapterId = null,
  localCodeAdapterId = 'lmstudio',
  localFirst = false,
  cloudFirst = false,
  cloudFallbackIds = DEFAULT_CLOUD_FALLBACKS,
  hasPriorRepairEvidence = false,
} = {}) {
  const localId = localCodeAdapterId || 'lmstudio';
  const routeId = routeAdapterId ? String(routeAdapterId).trim() : null;
  const forceCloud = cloudFirst || hasPriorRepairEvidence;

  if (forceCloud) {
    const cloud = [];
    if (routeId && !isLocalCodeAdapterId(routeId, localId)) cloud.push(routeId);
    for (const c of cloudFallbackIds) {
      if (c && !isLocalCodeAdapterId(c, localId)) cloud.push(c);
    }
    // If route was local-only, still ensure at least one cloud id
    if (!cloud.length) cloud.push('minimax');
    return [...new Set([...cloud, localId, 'lmstudio'].filter(Boolean))];
  }

  if (localFirst) {
    return [...new Set([localId, routeId, 'lmstudio'].filter(Boolean))];
  }

  return [...new Set([routeId, localId].filter(Boolean))];
}

/**
 * Detect prior failure evidence in repair objective (A2 repairHints baked into text).
 * @param {string} objective
 */
export function objectiveHasPriorRepairEvidence(objective = '') {
  const t = String(objective || '');
  if (!t) return false;
  return /repairHints|失败证据|verify_failed|未减少|self_repair_failed|typeError|TS\d{4,5}|作弊|anchor/i.test(t);
}
