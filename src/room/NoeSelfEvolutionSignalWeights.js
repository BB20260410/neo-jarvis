// @ts-check
/**
 * Signal weight policy for self-evolution goal supply.
 * Deprioritize high-drop test_gap; boost type_error / high_complexity / self_directed.
 * Flag-gated at injection site (NOE_SELFEVO_SIGNAL_WEIGHTING / NOE_SELFEVO_SIGNAL_STATIC_BIAS).
 */

export const DEFAULT_SIGNAL_STATIC_BIAS = Object.freeze({
  test_gap: 0.45,
  stale_todo: 0.7,
  missing_jsdoc: 0.55,
  high_complexity: 1.15,
  type_error: 1.25,
  self_directed: 1.2,
  failure_lesson: 1.05,
  code_quality: 1.0,
});

export const SIGNAL_WEIGHT_FLOOR = 0.35;
export const SIGNAL_WEIGHT_CEIL = 1.35;

/**
 * @param {string} signal
 * @param {Record<string, number>} [bias]
 */
export function staticBiasForSignal(signal = '', bias = DEFAULT_SIGNAL_STATIC_BIAS) {
  const key = String(signal || '').trim();
  if (!key) return 1;
  const v = bias[key];
  return Number.isFinite(v) ? Number(v) : 1;
}

/**
 * Combine retention rate (0..1) with static bias; clamp to floor/ceil.
 * @param {object} [opts]
 * @param {string} [opts.signal]
 * @param {number} [opts.retention] done/(done+dropped) in [0,1]; NaN → treat as 1
 * @param {Record<string, number>} [opts.staticBias]
 * @param {number} [opts.floor]
 * @param {number} [opts.ceil]
 * @param {boolean} [opts.applyStaticBias]
 */
export function resolveSignalWeight({
  signal = '',
  retention = 1,
  staticBias = DEFAULT_SIGNAL_STATIC_BIAS,
  floor = SIGNAL_WEIGHT_FLOOR,
  ceil = SIGNAL_WEIGHT_CEIL,
  applyStaticBias = true,
} = {}) {
  let r = Number(retention);
  if (!Number.isFinite(r)) r = 1;
  r = Math.max(0, Math.min(1, r));
  // Map retention [0,1] → weight around [floor, 1] then multiply bias
  const fromRetention = floor + (1 - floor) * r;
  const bias = applyStaticBias ? staticBiasForSignal(signal, staticBias) : 1;
  const w = fromRetention * bias;
  return Math.max(floor, Math.min(ceil, w));
}

/**
 * Build a weight function for orderSelfEvolutionGoalsByEffectivePriority.
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.retentionBySignal] signal → retention rate
 * @param {boolean} [opts.applyStaticBias] default true when NOE_SELFEVO_SIGNAL_STATIC_BIAS!=0
 * @param {Record<string, number>} [opts.staticBias]
 */
export function makeSignalWeightFn(opts = {}) {
  const retentionBySignal = opts.retentionBySignal || {};
  const applyStaticBias = opts.applyStaticBias !== false;
  const staticBias = opts.staticBias || DEFAULT_SIGNAL_STATIC_BIAS;
  return (signal) => resolveSignalWeight({
    signal,
    retention: retentionBySignal[signal] ?? 1,
    applyStaticBias,
    staticBias,
  });
}

/**
 * Build the cached DB-backed weight provider injected into the self-evolution trigger.
 * Keeping aggregation/cache policy here prevents the server composition root growing
 * business logic while preserving fail-open behavior when DB reads are unavailable.
 * @param {object} [opts]
 * @param {() => {prepare: (sql: string) => {all: (since: number) => any[]}}} [opts.getDb]
 * @param {boolean} [opts.enabled]
 * @param {boolean} [opts.applyStaticBias]
 * @param {() => number} [opts.now]
 * @param {number} [opts.cacheTtlMs]
 * @param {number} [opts.windowMs]
 * @returns {(signal: string) => number}
 */
export function createSignalRetentionWeightProvider({
  getDb = () => { throw new Error('signal_weight_db_unavailable'); },
  enabled = false,
  applyStaticBias = true,
  now = Date.now,
  cacheTtlMs = 600_000,
  windowMs = 30 * 86_400_000,
} = {}) {
  if (!enabled) return () => 1;
  let cache = null;
  let cacheAt = 0;
  return (signal) => {
    try {
      const at = now();
      if (!cache || at - cacheAt > cacheTtlMs) {
        const rows = getDb().prepare("SELECT json_extract(meta,'$.signal') sig, status FROM noe_goals WHERE source='self_evolution' AND created_at >= ?").all(at - windowMs);
        /** @type {Record<string, {done: number, dropped: number}>} */
        const aggregate = {};
        for (const row of rows) {
          const key = row.sig || '';
          const entry = aggregate[key] || (aggregate[key] = { done: 0, dropped: 0 });
          if (row.status === 'done') entry.done += 1;
          else if (row.status === 'dropped') entry.dropped += 1;
        }
        /** @type {Record<string, number>} */
        const retentionBySignal = {};
        for (const key of Object.keys(aggregate)) {
          const settled = aggregate[key].done + aggregate[key].dropped;
          retentionBySignal[key] = settled ? aggregate[key].done / settled : 1;
        }
        cache = makeSignalWeightFn({ retentionBySignal, applyStaticBias });
        cacheAt = at;
      }
      return typeof cache === 'function'
        ? cache(signal)
        : resolveSignalWeight({ signal, retention: 1, applyStaticBias });
    } catch {
      return 1;
    }
  };
}

/** Assert policy invariant used by tests / doctor. */
export function assertTestGapDeprioritized(weightFn = makeSignalWeightFn()) {
  const testGap = Number(weightFn('test_gap'));
  const typeError = Number(weightFn('type_error'));
  const highComplexity = Number(weightFn('high_complexity'));
  const selfDirected = Number(weightFn('self_directed'));
  return {
    ok: testGap < typeError && testGap < highComplexity && testGap < selfDirected,
    weights: { test_gap: testGap, type_error: typeError, high_complexity: highComplexity, self_directed: selfDirected },
  };
}
