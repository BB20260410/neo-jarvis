// @ts-check
/**
 * Minimal structured error envelope for boundary surfaces (route/job/IPC).
 *
 * Not a full AppError migration. New/changed boundary code should prefer this
 * shape so multi-model changes share one machine-readable contract.
 *
 * Rules:
 * - Never put secrets in message/details.
 * - Prefer rethrow/propagation for internal layers; wrap only at boundaries.
 * - Preserve `cause` for diagnostics; strip for public clients via toPublicError.
 */

/** @typedef {'internal'|'validation'|'auth'|'not_found'|'conflict'|'external_blocked'|'timeout'|'cancelled'} NoeErrorKind */

/**
 * @typedef {Object} NoeErrorEnvelope
 * @property {1} schemaVersion
 * @property {'neo.error.envelope.v1'} kind
 * @property {string} code stable machine code (snake or dotted)
 * @property {NoeErrorKind} category
 * @property {string} message human-safe summary (no secrets)
 * @property {boolean} retryable
 * @property {string} [at] ISO timestamp
 * @property {Record<string, unknown>} [details] non-secret structured context
 * @property {unknown} [cause] original error (internal only)
 */

export const NOE_ERROR_ENVELOPE_SCHEMA = 'neo.error.envelope.v1';

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.message
 * @param {NoeErrorKind} [input.category]
 * @param {boolean} [input.retryable]
 * @param {Record<string, unknown>} [input.details]
 * @param {unknown} [input.cause]
 * @returns {NoeErrorEnvelope}
 */
export function createErrorEnvelope(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('createErrorEnvelope requires object input');
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!code) throw new TypeError('createErrorEnvelope requires non-empty code');
  if (!message) throw new TypeError('createErrorEnvelope requires non-empty message');

  /** @type {NoeErrorEnvelope} */
  const env = {
    schemaVersion: 1,
    kind: NOE_ERROR_ENVELOPE_SCHEMA,
    code,
    category: input.category || 'internal',
    message,
    retryable: Boolean(input.retryable),
    at: new Date().toISOString(),
  };
  if (input.details && typeof input.details === 'object' && !Array.isArray(input.details)) {
    env.details = { ...input.details };
  }
  if (input.cause !== undefined) env.cause = input.cause;
  return env;
}

/**
 * @param {unknown} value
 * @returns {value is NoeErrorEnvelope}
 */
export function isErrorEnvelope(value) {
  if (!value || typeof value !== 'object') return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    v.schemaVersion === 1 &&
    v.kind === NOE_ERROR_ENVELOPE_SCHEMA &&
    typeof v.code === 'string' &&
    typeof v.message === 'string' &&
    typeof v.category === 'string' &&
    typeof v.retryable === 'boolean'
  );
}

/**
 * Public/API-safe projection — drops cause and redacts obvious secret-like keys.
 * @param {NoeErrorEnvelope} envelope
 * @returns {Omit<NoeErrorEnvelope, 'cause'>}
 */
export function toPublicError(envelope) {
  if (!isErrorEnvelope(envelope)) {
    return createErrorEnvelope({
      code: 'invalid_error_envelope',
      message: 'Invalid error envelope',
      category: 'internal',
      retryable: false,
    });
  }
  /** @type {Record<string, unknown>|undefined} */
  let details;
  if (envelope.details) {
    details = {};
    for (const [k, v] of Object.entries(envelope.details)) {
      if (/secret|token|password|authorization|cookie|api[_-]?key/i.test(k)) continue;
      details[k] = v;
    }
  }
  /** @type {Omit<NoeErrorEnvelope, 'cause'>} */
  const publicEnv = {
    schemaVersion: 1,
    kind: NOE_ERROR_ENVELOPE_SCHEMA,
    code: envelope.code,
    category: envelope.category,
    message: envelope.message,
    retryable: envelope.retryable,
    at: envelope.at,
  };
  if (details && Object.keys(details).length > 0) publicEnv.details = details;
  return publicEnv;
}

/**
 * Normalize unknown thrown values at a boundary without inventing success.
 * @param {unknown} err
 * @param {{ code?: string, category?: NoeErrorKind, retryable?: boolean }} [opts]
 * @returns {NoeErrorEnvelope}
 */
export function fromThrown(err, opts = {}) {
  if (isErrorEnvelope(err)) return err;
  if (err instanceof Error) {
    return createErrorEnvelope({
      code: opts.code || 'unhandled_error',
      message: err.message || 'Unhandled error',
      category: opts.category || 'internal',
      retryable: Boolean(opts.retryable),
      cause: err,
      details: err.name ? { name: err.name } : undefined,
    });
  }
  return createErrorEnvelope({
    code: opts.code || 'unhandled_non_error',
    message: typeof err === 'string' && err ? err : 'Unhandled non-error throw',
    category: opts.category || 'internal',
    retryable: Boolean(opts.retryable),
    details: { typeofValue: typeof err },
  });
}
