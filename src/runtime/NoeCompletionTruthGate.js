// @ts-check
/**
 * Completion truth gate — failures must never display as completed.
 *
 * Pure decision function for task/agent-run/act terminal transitions.
 * Does not write stores; callers must refuse completed when gate denies.
 */
export const COMPLETION_TRUTH_GATE_VERSION = 1;

/**
 * @typedef {object} CompletionCandidate
 * @property {string} [requestedStatus]
 * @property {number|null|undefined} [exitCode]
 * @property {boolean|undefined} [verified]
 * @property {boolean|undefined} [hasValidArtifacts]
 * @property {boolean|undefined} [hasEvidence]
 * @property {boolean|undefined} [validatorsPass]
 * @property {boolean|undefined} [sourceDigestMatch]
 * @property {boolean|undefined} [approvalsSettled]
 * @property {boolean|undefined} [highRiskActsSettled]
 * @property {string|null|undefined} [error]
 * @property {boolean|undefined} [dryRun]
 */

const TERMINAL_FAIL = new Set(['failed', 'error', 'blocked', 'cancelled', 'partial', 'recovery_required']);
const TERMINAL_OK = new Set(['completed', 'succeeded', 'success']);

/**
 * Normalize status labels across AgentRun / Act / Task vocabularies.
 * @param {string} status
 */
export function normalizeTerminalStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'error') return 'failed';
  return s;
}

/**
 * Decide whether a completion transition is allowed.
 * @param {CompletionCandidate} candidate
 * @param {{ strict?: boolean }} [opts] strict=true requires full product completed rules
 */
export function evaluateCompletionTruth(candidate = {}, opts = {}) {
  const strict = opts.strict !== false;
  const requested = normalizeTerminalStatus(candidate.requestedStatus || '');
  const blockers = /** @type {string[]} */ ([]);

  if (!requested) {
    return {
      allowed: false,
      finalStatus: 'failed',
      blockers: ['missing_requested_status'],
      version: COMPLETION_TRUTH_GATE_VERSION,
    };
  }

  if (TERMINAL_FAIL.has(requested)) {
    return {
      allowed: true,
      finalStatus: requested,
      blockers: [],
      version: COMPLETION_TRUTH_GATE_VERSION,
      note: 'non_success_terminal_passthrough',
    };
  }

  if (!TERMINAL_OK.has(requested) && requested !== 'completed') {
    // non-terminal or unknown — allow intermediate states
    if (['running', 'queued', 'planned', 'awaiting_approval', 'verifying', 'executing', 'dry_run'].includes(requested)) {
      return {
        allowed: true,
        finalStatus: requested,
        blockers: [],
        version: COMPLETION_TRUTH_GATE_VERSION,
        note: 'non_terminal',
      };
    }
  }

  // Completing path
  if (candidate.dryRun === true) {
    blockers.push('dry_run_cannot_complete');
  }
  if (candidate.error) {
    blockers.push('error_field_present');
  }
  if (candidate.exitCode !== undefined && candidate.exitCode !== null && Number(candidate.exitCode) !== 0) {
    blockers.push('exit_code_nonzero');
  }
  if (candidate.verified === false) {
    blockers.push('verified_false');
  }
  if (candidate.hasValidArtifacts === false) {
    blockers.push('missing_artifacts');
  }
  if (candidate.hasEvidence === false) {
    blockers.push('missing_evidence');
  }
  if (candidate.validatorsPass === false) {
    blockers.push('validators_failed');
  }
  if (strict) {
    if (candidate.verified !== true) blockers.push('verified_not_true');
    if (candidate.hasValidArtifacts !== true) blockers.push('artifacts_not_true');
    if (candidate.hasEvidence !== true) blockers.push('evidence_not_true');
    if (candidate.validatorsPass !== true) blockers.push('validators_not_true');
    if (candidate.sourceDigestMatch === false) blockers.push('sourceDigest_mismatch');
    if (candidate.approvalsSettled === false) blockers.push('approvals_unsettled');
    if (candidate.highRiskActsSettled === false) blockers.push('high_risk_acts_unsettled');
    if (candidate.exitCode === undefined || candidate.exitCode === null) {
      // allow null only when explicitly verified tool-less completion? fail closed in strict
      blockers.push('exit_code_missing');
    }
  }

  if (blockers.length > 0) {
    return {
      allowed: false,
      finalStatus: blockers.includes('exit_code_nonzero') || blockers.includes('error_field_present')
        ? 'failed'
        : 'partial',
      blockers,
      version: COMPLETION_TRUTH_GATE_VERSION,
      displayStatus: 'partial', // UI must not show completed
    };
  }

  return {
    allowed: true,
    finalStatus: 'completed',
    blockers: [],
    version: COMPLETION_TRUTH_GATE_VERSION,
    displayStatus: 'completed',
  };
}

/**
 * Map gate result to UI-facing status (never lie completed).
 * @param {ReturnType<typeof evaluateCompletionTruth>} decision
 * @param {string} [fallback]
 */
export function displayStatusFromDecision(decision, fallback = 'partial') {
  if (!decision) return fallback;
  if (decision.allowed && decision.finalStatus === 'completed') return 'completed';
  if (decision.displayStatus) return decision.displayStatus;
  if (TERMINAL_FAIL.has(decision.finalStatus)) return decision.finalStatus;
  return fallback;
}

/**
 * Count false completions in a batch of already-recorded rows (audit).
 * A false completion is status completed/succeeded while gate would deny.
 * @param {CompletionCandidate[]} rows
 */
export function countFalseCompletions(rows = []) {
  let falseCompletionCount = 0;
  const samples = [];
  for (const row of rows) {
    const status = normalizeTerminalStatus(row.requestedStatus || row.status || '');
    if (status !== 'completed') continue;
    const decision = evaluateCompletionTruth({ ...row, requestedStatus: 'completed' }, { strict: true });
    if (!decision.allowed) {
      falseCompletionCount += 1;
      if (samples.length < 10) samples.push({ blockers: decision.blockers, exitCode: row.exitCode });
    }
  }
  return { falseCompletionCount, samples };
}
