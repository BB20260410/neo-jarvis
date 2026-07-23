// @ts-check
/**
 * Fail-closed acceptance matrix gate runner.
 * Spec presence, unit tests alone, model self-report, health endpoints, or UI copy
 * NEVER flip an absolute gate to pass without bound evidence digests.
 *
 * Contract (Codex audit 2026-07-22):
 * - validEvidenceCount=0 → pending
 * - evidenceCount=0 → pending
 * - sourceDigest mismatch → stale/pending
 * - missing artifact / hash / unknown exit → pending/fail
 * - matrix gate status only written by applyGateResultsToMatrix (never hand-edit PASS)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import { sha256Hex, buildEvidenceKey } from './NoeSourceDigest.js';

export const GATE_RUNNER_SCHEMA_VERSION = 2;

const FORBIDDEN_SOLE_PROOF = new Set([
  'spec',
  'unit_test',
  'model_claim',
  'health_endpoint',
  'ui_copy',
  'loose_asr_match',
  'tts_stt_only',
]);

/**
 * @param {string} filePath
 * @returns {string|null}
 */
export function fileSha256IfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return sha256Hex(readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Resolve evidence path against optional roots (plan root, evidence root, cwd).
 * @param {string} path
 * @param {{ evidenceRoot?: string, planRoot?: string, cwd?: string }} [opts]
 * @returns {string|null} absolute path if file exists
 */
export function resolveEvidencePath(path, opts = {}) {
  const raw = String(path || '').trim();
  if (!raw) return null;
  const candidates = [];
  if (isAbsolute(raw)) candidates.push(raw);
  const cwd = opts.cwd || process.cwd();
  candidates.push(pathResolve(cwd, raw));
  if (opts.evidenceRoot) {
    candidates.push(join(opts.evidenceRoot, raw.replace(/^evidence\//, '')));
    candidates.push(join(opts.evidenceRoot, raw));
  }
  if (opts.planRoot) {
    candidates.push(join(opts.planRoot, raw));
    candidates.push(join(opts.planRoot, 'evidence', raw.replace(/^evidence\//, '')));
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return pathResolve(c);
  }
  return null;
}

/**
 * @param {unknown} matrix
 * @returns {{ ok: boolean, error?: string, matrix?: any }}
 */
export function loadAcceptanceMatrixObject(matrix) {
  if (!matrix || typeof matrix !== 'object') return { ok: false, error: 'matrix_missing' };
  const m = /** @type {any} */ (matrix);
  if (!Array.isArray(m.absoluteGates)) return { ok: false, error: 'absoluteGates_missing' };
  return { ok: true, matrix: m };
}

/**
 * @param {string} path
 */
export function readAcceptanceMatrixFile(path) {
  if (!existsSync(path)) return { ok: false, error: 'file_missing', path };
  try {
    const raw = readFileSync(path, 'utf8');
    const matrix = JSON.parse(raw);
    const loaded = loadAcceptanceMatrixObject(matrix);
    if (!loaded.ok) return { ...loaded, path };
    return { ok: true, path, matrix: loaded.matrix, rawSha256: sha256Hex(raw) };
  } catch (e) {
    return { ok: false, error: String(/** @type {Error} */ (e).message || e), path };
  }
}

/**
 * Validate a single evidence artifact record (fail-closed).
 * @param {object} ev
 * @param {object} ctx
 */
export function validateEvidenceRecord(ev, ctx = {}) {
  if (!ev || typeof ev !== 'object') return { valid: false, reason: 'evidence_not_object' };
  if (ev.stale === true) return { valid: false, reason: 'marked_stale' };

  const requiredDigest = ctx.sourceDigest || null;
  const requirePath = ctx.requirePath !== false;
  const requireDigest = ctx.requireSourceDigest !== false && !!requiredDigest;
  const requireHash = ctx.requireArtifactHash === true;

  const pathRaw = ev.path || ev.artifactPath || null;
  if (requirePath && !pathRaw) {
    return { valid: false, reason: 'evidence_path_required' };
  }

  let resolved = null;
  if (pathRaw) {
    resolved = resolveEvidencePath(String(pathRaw), {
      evidenceRoot: ctx.evidenceRoot,
      planRoot: ctx.planRoot,
      cwd: ctx.cwd,
    });
    if (!resolved) {
      return { valid: false, reason: 'artifact_missing', path: pathRaw };
    }
  }

  if (requireDigest) {
    if (!ev.sourceDigest) {
      return { valid: false, reason: 'evidence_missing_sourceDigest' };
    }
    if (ev.sourceDigest !== requiredDigest) {
      return {
        valid: false,
        reason: 'sourceDigest_mismatch',
        expected: requiredDigest,
        actual: ev.sourceDigest,
      };
    }
  } else if (requiredDigest && ev.sourceDigest && ev.sourceDigest !== requiredDigest) {
    return {
      valid: false,
      reason: 'sourceDigest_mismatch',
      expected: requiredDigest,
      actual: ev.sourceDigest,
    };
  }

  if (resolved && (ev.artifactSha256 || requireHash)) {
    const actual = fileSha256IfExists(resolved);
    if (!actual) return { valid: false, reason: 'artifact_unreadable', path: resolved };
    if (ev.artifactSha256) {
      const want = String(ev.artifactSha256).replace(/^sha256:/, '');
      if (actual !== want) {
        return { valid: false, reason: 'artifact_hash_mismatch', path: resolved };
      }
    } else if (requireHash) {
      return { valid: false, reason: 'artifact_hash_required', path: resolved };
    }
  }

  if (ev.soleProofType && FORBIDDEN_SOLE_PROOF.has(String(ev.soleProofType))) {
    return { valid: false, reason: 'sole_proof_type_forbidden', soleProofType: ev.soleProofType };
  }

  // Unknown/nonzero process exit recorded on evidence
  if (ev.exitCode !== undefined && ev.exitCode !== null && Number(ev.exitCode) !== 0) {
    return { valid: false, reason: 'evidence_exit_nonzero', exitCode: ev.exitCode };
  }
  if (ev.unknownExit === true || ev.exitCode === 'unknown') {
    return { valid: false, reason: 'evidence_unknown_exit' };
  }

  return { valid: true, reason: null, resolvedPath: resolved };
}

/**
 * Evaluate operator against observed metric value.
 * @param {string} operator
 * @param {unknown} observed
 * @param {unknown} target
 */
export function evalOperator(operator, observed, target) {
  if (observed === null || observed === undefined || Number.isNaN(observed)) {
    return { pass: false, reason: 'observed_missing' };
  }
  const op = String(operator || 'eq');
  if (op === 'eq') return { pass: observed === target, reason: observed === target ? null : 'neq' };
  if (op === 'gte') return { pass: Number(observed) >= Number(target), reason: null };
  if (op === 'lte') return { pass: Number(observed) <= Number(target), reason: null };
  if (op === 'gt') return { pass: Number(observed) > Number(target), reason: null };
  if (op === 'lt') return { pass: Number(observed) < Number(target), reason: null };
  return { pass: false, reason: 'unknown_operator' };
}

/**
 * Evaluate one absolute gate fail-closed.
 * @param {object} gate
 * @param {object} opts
 */
export function evaluateAbsoluteGate(gate, opts = {}) {
  const metrics = opts.metrics || {};
  const sourceDigest = opts.sourceDigest || null;
  const runtimeConfigDigest = opts.runtimeConfigDigest || null;
  const evidence = Array.isArray(gate.evidence) ? gate.evidence : [];
  const observed = Object.prototype.hasOwnProperty.call(metrics, gate.metric)
    ? metrics[gate.metric]
    : gate.observed;

  const evidenceChecks = evidence.map((ev) =>
    validateEvidenceRecord(ev, {
      sourceDigest,
      evidenceRoot: opts.evidenceRoot,
      planRoot: opts.planRoot,
      cwd: opts.cwd,
      requirePath: true,
      requireSourceDigest: !!sourceDigest,
      requireArtifactHash: opts.requireArtifactHash === true,
    }),
  );
  const validEvidence = evidenceChecks.filter((c) => c.valid);
  const metricEval = evalOperator(gate.operator, observed, gate.target);

  let status = 'pending';
  /** @type {string[]} */
  const blockers = [];

  if (evidence.length === 0) {
    status = 'pending';
    blockers.push('evidence_count_zero');
  }

  if (observed === null || observed === undefined) {
    status = 'pending';
    blockers.push('metric_not_observed');
  } else if (!metricEval.pass) {
    // Metric miss is fail only if we also have valid evidence context; else pending
    if (validEvidence.length > 0) {
      status = 'fail';
      blockers.push(metricEval.reason || 'metric_miss');
    } else {
      status = 'pending';
      blockers.push(metricEval.reason || 'metric_miss');
      blockers.push('no_valid_bound_evidence');
    }
  } else if (validEvidence.length === 0) {
    status = 'pending';
    blockers.push('no_valid_bound_evidence');
    if (evidence.length > 0) {
      const reasons = evidenceChecks.map((c) => c.reason).filter(Boolean);
      for (const r of reasons) {
        if (!blockers.includes(String(r))) blockers.push(String(r));
      }
    }
  } else {
    // Only pass when metric OK AND ≥1 valid bound evidence
    status = 'pass';
  }

  // Wall-clock soak cannot pass early
  if (status === 'pass' && opts.requireWallClockHours && gate.id === 'G-SOAK-01') {
    const hours = Number(opts.soakWallClockHours || 0);
    if (hours < Number(opts.requireWallClockHours)) {
      status = 'pending';
      blockers.push('soak_wall_clock_insufficient');
    }
  }

  // Hard rule: never pass with zero valid evidence (belt + suspenders)
  if (status === 'pass' && validEvidence.length === 0) {
    status = 'pending';
    blockers.push('no_valid_bound_evidence');
  }
  if (status === 'pass' && evidence.length === 0) {
    status = 'pending';
    blockers.push('evidence_count_zero');
  }

  const evidenceKey = buildEvidenceKey({
    gateId: gate.id,
    gateVersion: gate.gateVersion || '1',
    sourceDigest,
    runtimeConfigDigest,
    platform: opts.platform || process.platform,
    arch: opts.arch || process.arch,
    commandDigest: opts.commandDigest || null,
    artifactHashes: Object.fromEntries(
      evidence
        .filter((ev) => ev.artifactSha256 || ev.path)
        .map((ev, i) => {
          const resolved = resolveEvidencePath(String(ev.path || ''), {
            evidenceRoot: opts.evidenceRoot,
            planRoot: opts.planRoot,
            cwd: opts.cwd,
          });
          return [
            ev.id || `e${i}`,
            ev.artifactSha256 || (resolved ? fileSha256IfExists(resolved) : null) || 'missing',
          ];
        }),
    ),
  });

  return {
    id: gate.id,
    name: gate.name,
    metric: gate.metric,
    operator: gate.operator,
    target: gate.target,
    observed: observed === undefined ? null : observed,
    status,
    blockers: [...new Set(blockers)],
    evidenceCount: evidence.length,
    validEvidenceCount: validEvidence.length,
    evidenceChecks: evidenceChecks.map((c) => ({
      valid: c.valid,
      reason: c.reason,
      resolvedPath: c.resolvedPath || null,
    })),
    evidenceKey,
    sourceDigest,
    runtimeConfigDigest,
  };
}

/**
 * Run all absolute gates + stage dependency checks.
 * @param {object} matrix
 * @param {object} [opts]
 */
export function runAcceptanceGates(matrix, opts = {}) {
  const loaded = loadAcceptanceMatrixObject(matrix);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
      absolute: [],
      stages: [],
      summary: { pass: 0, fail: 0, pending: 0, blocked_external: 0 },
      overallStatus: 'error',
      readyForCodexValidation: false,
    };
  }
  const m = loaded.matrix;
  const absolute = (m.absoluteGates || []).map((g) => evaluateAbsoluteGate(g, opts));
  const summary = summarizeGateStatuses(absolute);

  const stages = (m.stages || []).map((s) => {
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    const depStages = (m.stages || []).filter((x) => deps.includes(x.id));
    const depsMet = depStages.every((d) => d.status === 'completed' || d.status === 'pass');
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      dependsOn: deps,
      depsMet,
      evidenceCount: Array.isArray(s.evidence) ? s.evidence.length : 0,
    };
  });

  const allAbsolutePass = absolute.length > 0 && absolute.every((g) => g.status === 'pass');
  const candidateStatus = m.candidate?.overallStatus || 'planned';

  let readyForCodexValidation = false;
  if (allAbsolutePass && opts.allowReadyForCodexValidation === true) {
    readyForCodexValidation = true;
  }

  let overallStatus = candidateStatus;
  if (candidateStatus === 'accepted') {
    overallStatus = 'invalid_executor_claimed_accepted';
  } else if (readyForCodexValidation) {
    overallStatus = 'ready_for_codex_validation';
  } else if (summary.fail > 0 || summary.pending > 0) {
    overallStatus = m.candidate?.startedAt ? 'in_progress' : 'planned';
  }

  // Never allow overall ready if any gate has pass with zero valid evidence
  const illegalPass = absolute.some((g) => g.status === 'pass' && g.validEvidenceCount === 0);
  if (illegalPass) {
    readyForCodexValidation = false;
    overallStatus = 'in_progress';
  }

  return {
    ok: true,
    schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    planId: m.planId,
    sourceDigest: opts.sourceDigest || m.candidate?.sourceDigest || null,
    runtimeConfigDigest: opts.runtimeConfigDigest || m.candidate?.runtimeConfigDigest || null,
    absolute,
    stages,
    summary,
    allAbsolutePass: allAbsolutePass && !illegalPass,
    overallStatus,
    readyForCodexValidation,
    executorMaximumStatus: m.authority?.executorMaximumStatus || 'ready_for_codex_validation',
    rule: 'fail_closed_no_static_presence_pass',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {Array<{status:string}>} absolute
 */
export function summarizeGateStatuses(absolute = []) {
  const summary = { pass: 0, fail: 0, pending: 0, blocked_external: 0 };
  for (const g of absolute) {
    if (g.status === 'pass') summary.pass += 1;
    else if (g.status === 'fail') summary.fail += 1;
    else if (g.status === 'blocked_external') summary.blocked_external += 1;
    else summary.pending += 1;
  }
  return summary;
}

/**
 * Apply gate runner results onto matrix absoluteGates statuses.
 * Only automatic path to set PASS. Clears illegal hand-written PASS.
 * @param {object} matrix
 * @param {ReturnType<typeof runAcceptanceGates>} gateReport
 * @param {{ sourceDigest?: string, runtimeConfigDigest?: string }} [meta]
 */
export function applyGateResultsToMatrix(matrix, gateReport, meta = {}) {
  const m = JSON.parse(JSON.stringify(matrix));
  const byId = new Map((gateReport.absolute || []).map((g) => [g.id, g]));
  for (const g of m.absoluteGates || []) {
    const r = byId.get(g.id);
    if (!r) {
      // Unknown gate → demote any hand PASS
      if (g.status === 'pass') g.status = 'pending';
      continue;
    }
    g.status = r.status;
    // keep evidence array; attach evaluation meta for audit
    g.lastEvaluation = {
      at: gateReport.generatedAt,
      validEvidenceCount: r.validEvidenceCount,
      evidenceCount: r.evidenceCount,
      blockers: r.blockers,
      observed: r.observed,
      sourceDigest: r.sourceDigest,
    };
  }
  if (m.candidate) {
    if (meta.sourceDigest) m.candidate.sourceDigest = meta.sourceDigest;
    if (meta.runtimeConfigDigest) m.candidate.runtimeConfigDigest = meta.runtimeConfigDigest;
    if (gateReport.overallStatus && gateReport.overallStatus !== 'invalid_executor_claimed_accepted') {
      // Never promote to ready unless runner says so
      if (gateReport.readyForCodexValidation) {
        m.candidate.overallStatus = 'ready_for_codex_validation';
        m.candidate.readyForCodexValidationAt = gateReport.generatedAt;
      } else if (m.candidate.overallStatus === 'ready_for_codex_validation') {
        m.candidate.overallStatus = 'in_progress';
        m.candidate.readyForCodexValidationAt = null;
      } else if (m.candidate.overallStatus === 'accepted') {
        // executor must not hold accepted
        m.candidate.overallStatus = 'in_progress';
      } else {
        m.candidate.overallStatus = 'in_progress';
      }
    }
  }
  return m;
}

/**
 * Mark evidence records stale when digest mismatches candidate.
 * @param {object} matrix
 * @param {string} currentDigest
 */
export function markStaleEvidenceByDigest(matrix, currentDigest) {
  const m = JSON.parse(JSON.stringify(matrix));
  const digest = String(currentDigest || '');
  let staleCount = 0;
  for (const g of m.absoluteGates || []) {
    if (!Array.isArray(g.evidence)) continue;
    for (const ev of g.evidence) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.sourceDigest && digest && ev.sourceDigest !== digest) {
        ev.stale = true;
        ev.staleReason = 'sourceDigest_mismatch';
        staleCount += 1;
      }
    }
    // demote hand PASS when any evidence stale or empty
    if (g.status === 'pass') {
      const validish = (g.evidence || []).some((ev) => ev && !ev.stale);
      if (!validish) g.status = 'pending';
    }
  }
  for (const s of m.stages || []) {
    if (!Array.isArray(s.evidence)) continue;
    for (const ev of s.evidence) {
      if (ev?.sourceDigest && digest && ev.sourceDigest !== digest) {
        ev.stale = true;
        ev.staleReason = 'sourceDigest_mismatch';
        staleCount += 1;
      }
    }
  }
  return { matrix: m, staleCount };
}

/**
 * Write matrix JSON to disk (pretty, stable).
 * @param {string} path
 * @param {object} matrix
 */
export function writeAcceptanceMatrixFile(path, matrix) {
  writeFileSync(path, `${JSON.stringify(matrix, null, 2)}\n`);
  return { path, sha256: sha256Hex(readFileSync(path)) };
}

/**
 * Compute VTCR from task receipt rows.
 * @param {Array<{status:string, cancelledByUser?:boolean, verified?:boolean, hasValidArtifacts?:boolean}>} tasks
 */
export function computeVtcr(tasks = []) {
  const accepted = tasks.filter((t) => t && t.status !== 'cancelled' && !t.cancelledByUser);
  const denom = accepted.length;
  if (denom === 0) {
    return { VTCR: null, verifiedCompleted: 0, accepted: 0, reason: 'no_accepted_tasks' };
  }
  const verifiedCompleted = accepted.filter(
    (t) => t.status === 'completed' && t.verified === true && t.hasValidArtifacts === true,
  ).length;
  return {
    VTCR: verifiedCompleted / denom,
    verifiedCompleted,
    accepted: denom,
    reason: null,
  };
}

/**
 * Count false completions.
 * @param {Array<{status:string, verified?:boolean, hasValidArtifacts?:boolean, exitCode?:number|null, hasEvidence?:boolean, receiptId?:string}>} tasks
 */
export function computeTruthMetrics(tasks = []) {
  const completed = tasks.filter((t) => t && t.status === 'completed');
  let falseCompletionCount = 0;
  let completedWithoutEvidence = 0;
  let completedWithExitNonZero = 0;
  let completedWithMissingArtifact = 0;
  let withReceipt = 0;
  for (const t of completed) {
    const bad =
      t.verified !== true ||
      t.hasValidArtifacts !== true ||
      (t.exitCode !== undefined && t.exitCode !== null && t.exitCode !== 0) ||
      t.hasEvidence === false;
    if (bad) falseCompletionCount += 1;
    if (t.hasEvidence === false) completedWithoutEvidence += 1;
    if (t.exitCode !== undefined && t.exitCode !== null && t.exitCode !== 0) completedWithExitNonZero += 1;
    if (t.hasValidArtifacts !== true) completedWithMissingArtifact += 1;
    if (t.hasEvidence !== false && t.receiptId) withReceipt += 1;
  }
  const completedReceiptCoverage = completed.length === 0 ? 1.0 : withReceipt / completed.length;
  return {
    falseCompletionCount,
    completedWithoutEvidence,
    completedWithExitNonZero,
    completedWithMissingArtifact,
    completedReceiptCoverage,
    completedCount: completed.length,
  };
}
