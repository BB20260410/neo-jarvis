// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashBytes } from './artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside } from './policy.mjs';

const SAFE_RUN = fileURLToPath(new URL('../safe-run.mjs', import.meta.url));
const POLICY = fileURLToPath(new URL('./policy.mjs', import.meta.url));
const PROBE = fileURLToPath(new URL('../probe.mjs', import.meta.url));
const ACTIVITY_SCAN = fileURLToPath(new URL('../activity-scan.mjs', import.meta.url));
const MAX_EVIDENCE_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

const CANARY_CASES = new Map([
  ['allowed-runtime-write', 'allowed-write'],
  ['clone-source-write-denied', 'create-denied'],
  ['control-dir-rename-denied', 'control-dir-rename-denied'],
  ['main-rplus-denied', 'open-rplus-denied'],
  ['main-read-denied', 'read-denied'],
  ['symlink-escape-denied', 'symlink-rplus-denied'],
  ['symlink-read-denied', 'symlink-read-denied'],
  ['foreign-signal-denied', 'signal-zero-denied'],
  ['launchctl-exec-denied', 'launchctl-denied'],
  ['network-denied', 'network-denied'],
]);

/** @param {string[]} values */
function sortedUnique(values) {
  return [...new Set(values.map((item) => resolve(item)))].sort();
}

/** @param {unknown} value */
function asStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

/** @param {string} observedAt @param {string} referenceTime */
function isFresh(observedAt, referenceTime) {
  const observed = Date.parse(observedAt);
  const reference = Date.parse(referenceTime);
  if (!Number.isFinite(observed) || !Number.isFinite(reference)) return false;
  return observed <= reference + MAX_FUTURE_SKEW_MS && reference - observed <= MAX_EVIDENCE_AGE_MS;
}

/** @param {string} pathValue @param {string} runtimeRoot */
function readTypedJson(pathValue, runtimeRoot) {
  const absolute = resolve(pathValue);
  assertPathInside(runtimeRoot, absolute, 'required evidence');
  assertNoSymlinkSegments(runtimeRoot, absolute, 'required evidence');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not_regular_file');
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (typeof metadataDigest !== 'string' || hashBytes(canonicalJson(metadata)) !== metadataDigest) {
    throw new Error('metadata_digest_mismatch');
  }
  return { absolute, bytes, value, sha256: hashBytes(bytes), size: bytes.length };
}

/** @param {ReturnType<typeof readTypedJson>} file @param {string} taskRoot @param {string} runtimeRoot */
function validateSafeRunBase(file, taskRoot, runtimeRoot) {
  const value = file.value;
  const entrypoint = (value.commandFiles || []).find((item) => item.role === 'entrypoint');
  return value.schema === 'neo.code-integrity.safe-run.v2'
    && resolve(value.taskRoot || '') === taskRoot
    && resolve(value.runtimeRoot || '') === runtimeRoot
    && value.network === 'denied'
    && value.processSignals === 'denied'
    && value.runnerSha256 === hashBytes(readFileSync(SAFE_RUN))
    && value.policySha256 === hashBytes(readFileSync(POLICY))
    && Boolean(entrypoint);
}

/**
 * @param {ReturnType<typeof readTypedJson>} file
 * @param {string} repoRoot
 * @param {string} runtimeRoot
 * @param {string} referenceTime
 */
function validateCanary(file, repoRoot, runtimeRoot, referenceTime) {
  const summary = file.value;
  const names = Array.isArray(summary.results) ? summary.results.map((item) => item.name) : [];
  if (summary.schema !== 'neo.code-integrity.canary.v2'
    || resolve(summary.taskRoot || '') !== repoRoot
    || resolve(summary.runtimeRoot || '') !== runtimeRoot
    || resolve(summary.mainRoot || '') === repoRoot
    || summary.total !== CANARY_CASES.size
    || summary.passed !== CANARY_CASES.size
    || summary.failed !== 0
    || summary.readyForStaticChecks !== true
    || summary.readyForRuntimeChecks !== false
    || canonicalJson([...names].sort()) !== canonicalJson([...CANARY_CASES.keys()].sort())
    || !isFresh(summary.createdAt, referenceTime)) {
    throw new Error('canary_summary_invalid');
  }
  for (const result of summary.results) {
    const expectedAction = CANARY_CASES.get(result.name);
    if (!expectedAction || result.passed !== true || result.exitCode !== 0 || result.signal !== null || result.receiptValid !== true) {
      throw new Error(`canary_case_invalid:${result.name || 'unknown'}`);
    }
    const receipt = readTypedJson(result.receipt, runtimeRoot);
    const safe = receipt.value;
    const entrypoint = (safe.commandFiles || []).find((item) => item.role === 'entrypoint');
    if (receipt.sha256 !== result.receiptSha256
      || !validateSafeRunBase(receipt, repoRoot, runtimeRoot)
      || safe.exitCode !== 0
      || safe.childExitCode !== 0
      || safe.signal !== null
      || safe.spawnError !== null
      || resolve(safe.cwd || '') !== repoRoot
      || canonicalJson(sortedUnique(safe.allowedWriteRoots || [])) !== canonicalJson([runtimeRoot])
      || !asStringArray(safe.protectedReadRoots).map((item) => resolve(item)).includes(resolve(summary.mainRoot))
      || resolve(entrypoint?.path || '') !== PROBE
      || entrypoint?.sha256 !== hashBytes(readFileSync(PROBE))
      || resolve(safe.args?.[0] || '') !== PROBE
      || safe.args?.[1] !== expectedAction) {
      throw new Error(`canary_receipt_invalid:${result.name}`);
    }
  }
  return {
    valid: true,
    path: file.absolute,
    sha256: file.sha256,
    passed: summary.passed,
    total: summary.total,
    readyForStaticChecks: true,
    readyForRuntimeChecks: false,
    createdAt: summary.createdAt,
    mainRoot: resolve(summary.mainRoot),
  };
}

/**
 * @param {ReturnType<typeof readTypedJson>} file
 * @param {Array<ReturnType<typeof readTypedJson>>} safeReceipts
 * @param {string} repoRoot
 * @param {string} runtimeRoot
 * @param {string[]} changedPaths
 * @param {string} referenceTime
 */
function validateActivity(file, safeReceipts, repoRoot, runtimeRoot, changedPaths, referenceTime) {
  const report = file.value;
  const dirtyPaths = asStringArray(report.dirtyPaths);
  const blocked = asStringArray(report.blockedAllowedPaths);
  const semantic = asStringArray(report.semanticConflictPaths);
  const expectedClear = blocked.length === 0 && semantic.length === 0;
  if (report.schema !== 'neo.code-integrity.activity-scan.v2'
    || !/^[a-f0-9]{40}$/.test(report.head || '')
    || !/^[a-f0-9]{64}$/.test(report.dirtyDigest || '')
    || report.dirtyCount !== dirtyPaths.length
    || new Set(dirtyPaths).size !== dirtyPaths.length
    || canonicalJson(asStringArray(report.allowedFiles)) !== canonicalJson([...new Set(changedPaths)].sort())
    || report.clearForSlice !== expectedClear
    || resolve(report.sourceRoot || '') === repoRoot
    || !isFresh(report.observedAt, referenceTime)) {
    throw new Error('activity_summary_invalid');
  }
  const expectedExit = report.clearForSlice ? 0 : 3;
  const expectedArgs = [
    ACTIVITY_SCAN,
    '--source-root', resolve(report.sourceRoot),
    '--output', file.absolute,
  ];
  for (const pathValue of report.allowedFiles) expectedArgs.push('--allowed-file', pathValue);
  for (const item of report.responsibilityTerms || []) expectedArgs.push('--responsibility-term', `${item.id}=${item.term}`);
  const companion = safeReceipts.find((candidate) => {
    const safe = candidate.value;
    const bound = (safe.boundOutputs || []).find((item) => resolve(item.path || '') === file.absolute);
    const entrypoint = (safe.commandFiles || []).find((item) => item.role === 'entrypoint');
    return validateSafeRunBase(candidate, repoRoot, runtimeRoot)
      && bound?.valid === true
      && bound.sha256 === file.sha256
      && safe.exitCode === expectedExit
      && safe.childExitCode === expectedExit
      && safe.signal === null
      && safe.spawnError === null
      && resolve(safe.cwd || '') === repoRoot
      && canonicalJson(sortedUnique(safe.allowedWriteRoots || [])) === canonicalJson([runtimeRoot])
      && canonicalJson(sortedUnique(safe.allowedReadRoots || [])) === canonicalJson(sortedUnique([repoRoot, runtimeRoot, report.sourceRoot]))
      && resolve(entrypoint?.path || '') === ACTIVITY_SCAN
      && entrypoint?.sha256 === hashBytes(readFileSync(ACTIVITY_SCAN))
      && canonicalJson(safe.args) === canonicalJson(expectedArgs);
  });
  if (!companion) throw new Error('activity_safe_run_companion_missing_or_invalid');
  return {
    valid: true,
    path: file.absolute,
    sha256: file.sha256,
    safeRunReceipt: { path: companion.absolute, sha256: companion.sha256 },
    observedAt: report.observedAt,
    sourceRoot: resolve(report.sourceRoot),
    head: report.head,
    dirtyCount: report.dirtyCount,
    dirtyDigest: report.dirtyDigest,
    exactConflictCount: blocked.length,
    semanticConflictCount: semantic.length,
    clearForSlice: report.clearForSlice,
    producerExitCode: expectedExit,
    producerExitMeaning: report.clearForSlice ? 'clear' : 'valid_negative_decision',
  };
}

/**
 * Validate evidence semantics separately from integration readiness. A valid
 * negative activity decision is acceptable static evidence and an explicit
 * integration blocker, never a reason to call the candidate production-ready.
 * @param {{ artifactPaths: string[], repoRoot: string, runtimeRoot: string, changedPaths: string[], referenceTime: string }} input
 */
export function validateRequiredArtifacts(input) {
  const repoRoot = resolve(input.repoRoot);
  const runtimeRoot = resolve(input.runtimeRoot);
  /** @type {Array<ReturnType<typeof readTypedJson>>} */
  const files = [];
  /** @type {Array<Record<string, unknown>>} */
  const artifacts = [];
  for (const pathValue of input.artifactPaths) {
    try {
      const file = readTypedJson(pathValue, runtimeRoot);
      files.push(file);
      artifacts.push({ path: file.absolute, exists: true, valid: true, reason: 'typed_json', schema: file.value.schema, sha256: file.sha256, size: file.size });
    } catch (error) {
      artifacts.push({ path: resolve(pathValue), exists: false, valid: false, reason: error instanceof Error ? error.message : String(error), schema: null, sha256: null, size: null });
    }
  }
  const safeReceipts = files.filter((item) => item.value.schema === 'neo.code-integrity.safe-run.v2');
  const canaryFiles = files.filter((item) => item.value.schema === 'neo.code-integrity.canary.v2');
  const activityFiles = files.filter((item) => item.value.schema === 'neo.code-integrity.activity-scan.v2');
  const knownSchemas = new Set([
    'neo.code-integrity.safe-run.v2',
    'neo.code-integrity.canary.v2',
    'neo.code-integrity.activity-scan.v2',
    'neo.code-integrity.gate-integration.v2',
  ]);
  for (const artifact of artifacts) {
    if (artifact.valid && !knownSchemas.has(String(artifact.schema || ''))) {
      artifact.valid = false;
      artifact.reason = 'unsupported_evidence_schema';
    }
  }
  const codeIntegrityScope = input.changedPaths.some((item) => item.startsWith('scripts/code-integrity/'));
  /** @type {string[]} */
  const staticBlockers = [];
  /** @type {Record<string, unknown>|null} */
  let canary = null;
  /** @type {Record<string, unknown>|null} */
  let activity = null;
  if (codeIntegrityScope) {
    if (canaryFiles.length !== 1) staticBlockers.push(`typed_canary_count:${canaryFiles.length}`);
    else {
      try { canary = validateCanary(canaryFiles[0], repoRoot, runtimeRoot, input.referenceTime); }
      catch (error) { staticBlockers.push(`typed_canary_invalid:${error instanceof Error ? error.message : String(error)}`); }
    }
    if (activityFiles.length !== 1) staticBlockers.push(`typed_activity_count:${activityFiles.length}`);
    else {
      try { activity = validateActivity(activityFiles[0], safeReceipts, repoRoot, runtimeRoot, input.changedPaths, input.referenceTime); }
      catch (error) { staticBlockers.push(`typed_activity_invalid:${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  for (const artifact of artifacts.filter((item) => item.valid === false)) staticBlockers.push(`required_evidence_invalid:${artifact.path}:${artifact.reason}`);
  const integrationBlockers = codeIntegrityScope ? [
    ...(activity && activity.clearForSlice === true ? [] : ['activity_not_clear']),
    'bauth_unbound',
    'canonical_source_digest_unbound',
    'unique_integrator_unbound',
    'production_replay_unverified',
  ] : [];
  return {
    schema: 'neo.code-integrity.required-evidence.v1',
    artifacts,
    evidence: { canary, activity },
    staticBlockers: [...new Set(staticBlockers)],
    integration: {
      ready: codeIntegrityScope ? false : null,
      blockers: [...new Set(integrationBlockers)],
      assurance: codeIntegrityScope ? 'isolated_static_candidate_only' : 'not_evaluated',
    },
  };
}
