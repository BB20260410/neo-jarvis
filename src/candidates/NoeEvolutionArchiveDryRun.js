// @ts-check

import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_EVOLUTION_ARCHIVE_DRY_RUN_SCHEMA_VERSION = 1;
export const NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND = 'noe_evolution_archive_dry_run_record';
export const NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION = 'evolution-archive-dry-run-v1';

const MAX_REFS = 80;
const MAX_REF_CHARS = 500;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const UNSAFE_REF_CHARS_RE = /[\s"'`$;|&<>*?[\]{}()]/;
const ALLOWED_VERDICTS = new Set(['dry_run_passed', 'dry_run_failed', 'blocked']);
const REQUIRED_REF_FIELDS = Object.freeze([
  'patchArtifactRef',
  'diffRef',
  'promptRef',
  'evalInputRef',
  'commandOutputRef',
  'scoreRef',
  'rollbackRef',
]);
const REQUIRED_SCORE_FIELDS = Object.freeze([
  'overall',
  'capability',
  'regression',
  'safety',
  'cost',
  'rewardHackingRisk',
]);
const REQUIRED_VALIDATOR_CHECKS = Object.freeze([
  'candidatePatchGate',
  'archiveSchema',
  'secretScan',
  'sast',
  'sca',
  'rollbackDryRun',
  'rewardHacking',
]);
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_REF_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/loop|src\/webhook|package\.json|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel)/i;
const BODY_KEYS = new Set([
  'body',
  'command',
  'commandOutput',
  'content',
  'diff',
  'patch',
  'prompt',
  'raw',
  'rawDiff',
  'secret',
  'stderr',
  'stdout',
  'text',
  'value',
]);
const TOP_LEVEL_KEYS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'createdAt',
  'parentId',
  'childId',
  'generation',
  'candidateRef',
  'parentArchiveRef',
  'lineage',
  'refs',
  'hashes',
  'score',
  'cost',
  'result',
  'safety',
  'validator',
  'evidenceRefs',
]);
const SCHEMA_KEYS = new Map([
  ['record', TOP_LEVEL_KEYS],
  ['record.lineage', new Set(['parentId', 'childId', 'generation'])],
  ['record.refs', new Set(['patchArtifactRef', 'diffRef', 'promptRef', 'evalInputRef', 'commandOutputRef', 'scoreRef', 'rollbackRef', 'holdoutRef', 'benchmarkRef', 'reportRef'])],
  ['record.hashes', new Set(['diffSha256', 'promptSha256', 'evalInputSha256', 'commandOutputSha256'])],
  ['record.score', new Set(REQUIRED_SCORE_FIELDS)],
  ['record.cost', new Set(['estimatedUsd', 'tokensIn', 'tokensOut', 'paidApiUsed', 'quotaRisk'])],
  ['record.result', new Set(['verdict', 'failureReason', 'applied', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed'])],
  ['record.safety', new Set(['dryRunOnly', 'noPatchApply', 'noExecutorRegistration', 'noLive51835', 'noMemoryV2Write', 'noPrivateHoldoutRead', 'noSecretRead', 'noCommit', 'noPush', 'noPackageScriptChange', 'noEvaluatorChange', 'noSecurityOrPermissionChange'])],
  ['record.validator', new Set(['validatorVersion', 'reportRef', 'checks', 'warnings', 'blockers', 'secretValuesReturned'])],
  ['record.validator.checks', new Set(REQUIRED_VALIDATOR_CHECKS)],
  ['record.validator.checks.*', new Set(['ok', 'reportRef'])],
]);

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rawClean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '')).slice(0, max);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasText(value) {
  return clean(value).length > 0;
}

function idLooksSafe(value) {
  const text = rawClean(value, 200);
  return text === text.trim() && SAFE_ID_RE.test(text);
}

function reportSafeId(value) {
  const text = rawClean(value, 180);
  return SAFE_ID_RE.test(text) ? text : '';
}

function reportSafeVerdict(value) {
  const text = rawClean(value, 80);
  return ALLOWED_VERDICTS.has(text) ? text : '';
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function scoreValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1;
}

function shaLooksValid(value) {
  return /^[a-f0-9]{64}$/i.test(clean(value, 80));
}

function safeRef(value, max = MAX_REF_CHARS) {
  return rawClean(value, max).replaceAll('\\', '/');
}

function decodeRef(value) {
  const text = safeRef(value);
  try {
    return decodeURIComponent(text).replaceAll('\\', '/');
  } catch {
    return text;
  }
}

function refForbidden(ref) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  if (!text) return false;
  return Boolean(
    text.startsWith('/')
    || decoded.startsWith('/')
    || text.startsWith('../')
    || decoded.startsWith('../')
    || text.includes('/../')
    || decoded.includes('/../')
    || text.includes('\0')
    || decoded.includes('\0')
    || UNSAFE_REF_CHARS_RE.test(text)
    || UNSAFE_REF_CHARS_RE.test(decoded)
    || text.startsWith('~')
    || decoded.startsWith('~')
    || /^file:/i.test(text)
    || /^file:/i.test(decoded)
    || /^https?:/i.test(text)
    || /^https?:/i.test(decoded)
    || SENSITIVE_REF_RE.test(text)
    || SENSITIVE_REF_RE.test(decoded)
    || FORBIDDEN_REF_RE.test(text)
    || FORBIDDEN_REF_RE.test(decoded),
  );
}

function holdoutRefAllowed(ref) {
  const text = safeRef(ref);
  return !text || /^private_holdout:(not_accessed|structure_only)$/i.test(text);
}

function refMustStayUnderOutput(ref) {
  const text = safeRef(ref);
  return text === 'output' || text.startsWith('output/');
}

function schemaChildPath(parentPath, key) {
  if (parentPath === 'record.validator.checks') return 'record.validator.checks.*';
  return `${parentPath}.${key}`;
}

function safeErrorField(field, allowed = new Set()) {
  return allowed.has(field) ? field : '*';
}

function evaluateClosedSchema(value, errors = [], path = 'record') {
  if (Array.isArray(value)) {
    for (const item of value) evaluateClosedSchema(item, errors, `${path}[]`);
    return;
  }
  if (!isObject(value)) return;
  const allowed = SCHEMA_KEYS.get(path);
  for (const key of Object.keys(value)) {
    const childPath = schemaChildPath(path, key);
    if (BODY_KEYS.has(key) && value[key] !== undefined && value[key] !== null) {
      errors.push(`archive_body_field_forbidden:${key}`);
    }
    if (allowed && !allowed.has(key)) errors.push('archive_unknown_field');
    evaluateClosedSchema(value[key], errors, childPath);
  }
}

function collectRefs(record = {}) {
  const refs = [
    record.candidateRef,
    record.parentArchiveRef,
    ...Object.values(isObject(record.refs) ? record.refs : {}),
    ...Object.values(isObject(record.validator?.checks) ? record.validator.checks : {}).map((check) => check?.reportRef),
    record.validator?.reportRef,
    ...arr(record.evidenceRefs),
  ];
  return refs.map((ref) => safeRef(ref)).filter(Boolean).slice(0, MAX_REFS);
}

function add(errors, condition, id) {
  if (!condition) errors.push(id);
}

function evaluateLineage(record = {}, errors = []) {
  add(errors, hasText(record.parentId), 'archive_parent_id_required');
  add(errors, hasText(record.childId), 'archive_child_id_required');
  if (hasText(record.parentId) && !idLooksSafe(record.parentId)) errors.push('archive_parent_id_invalid');
  if (hasText(record.childId) && !idLooksSafe(record.childId)) errors.push('archive_child_id_invalid');
  if (!Number.isInteger(Number(record.generation)) || Number(record.generation) < 0) {
    errors.push('archive_generation_invalid');
  }
  const lineage = isObject(record.lineage) ? record.lineage : {};
  if (!isObject(record.lineage)) errors.push('archive_lineage_required');
  if (hasText(lineage.parentId) && !idLooksSafe(lineage.parentId)) errors.push('archive_lineage_parent_id_invalid');
  if (hasText(lineage.childId) && !idLooksSafe(lineage.childId)) errors.push('archive_lineage_child_id_invalid');
  if (hasText(record.parentId) && hasText(lineage.parentId) && clean(record.parentId, 160) !== clean(lineage.parentId, 160)) {
    errors.push('archive_lineage_parent_mismatch');
  }
  if (hasText(record.childId) && hasText(lineage.childId) && clean(record.childId, 160) !== clean(lineage.childId, 160)) {
    errors.push('archive_lineage_child_mismatch');
  }
  if (Number.isFinite(Number(record.generation)) && Number.isFinite(Number(lineage.generation)) && Number(record.generation) !== Number(lineage.generation)) {
    errors.push('archive_lineage_generation_mismatch');
  }
}

function evaluateRefs(record = {}, errors = []) {
  const refs = isObject(record.refs) ? record.refs : {};
  if (!isObject(record.refs)) errors.push('archive_refs_required');
  add(errors, hasText(record.candidateRef), 'archive_candidate_ref_required');
  if (hasText(record.candidateRef) && !safeRef(record.candidateRef).startsWith('output/noe-candidate-patches/')) {
    errors.push('archive_candidate_ref_scope_required');
  }
  if (hasText(record.parentArchiveRef) && !refMustStayUnderOutput(record.parentArchiveRef)) {
    errors.push('archive_parent_archive_ref_output_scope_required');
  }
  if (record.evidenceRefs !== undefined && !Array.isArray(record.evidenceRefs)) {
    errors.push('archive_evidence_refs_must_be_array');
  }
  for (const field of REQUIRED_REF_FIELDS) {
    if (!hasText(refs[field])) errors.push(`archive_ref_required:${field}`);
  }
  if (hasText(refs.patchArtifactRef) && !safeRef(refs.patchArtifactRef).startsWith('output/noe-candidate-patches/')) {
    errors.push('archive_patch_artifact_ref_scope_required');
  }
  for (const [field, ref] of Object.entries(refs)) {
    if (!hasText(ref)) continue;
    if (field === 'holdoutRef') {
      if (!holdoutRefAllowed(ref)) errors.push('archive_holdout_ref_forbidden');
      continue;
    }
    const safeField = safeErrorField(field, SCHEMA_KEYS.get('record.refs'));
    if (refForbidden(ref)) errors.push(`archive_ref_forbidden:${safeField}`);
    if (!refMustStayUnderOutput(ref)) errors.push(`archive_ref_output_scope_required:${safeField}`);
  }
  for (const ref of [record.candidateRef, record.parentArchiveRef, ...arr(record.evidenceRefs)]) {
    if (!hasText(ref)) continue;
    if (refForbidden(ref)) errors.push('archive_ref_forbidden');
    if (!refMustStayUnderOutput(ref)) errors.push('archive_ref_output_scope_required');
  }
}

function evaluateHashes(record = {}, errors = []) {
  const hashes = isObject(record.hashes) ? record.hashes : {};
  if (!isObject(record.hashes)) errors.push('archive_hashes_required');
  for (const field of ['diffSha256', 'promptSha256', 'evalInputSha256', 'commandOutputSha256']) {
    if (!shaLooksValid(hashes[field])) errors.push(`archive_hash_required:${field}`);
  }
}

function evaluateScore(record = {}, errors = []) {
  const score = isObject(record.score) ? record.score : {};
  if (!isObject(record.score)) errors.push('archive_score_required');
  for (const field of REQUIRED_SCORE_FIELDS) {
    if (!scoreValue(score[field])) errors.push(`archive_score_invalid:${field}`);
  }
}

function evaluateCost(record = {}, errors = []) {
  const cost = isObject(record.cost) ? record.cost : {};
  if (!isObject(record.cost)) errors.push('archive_cost_required');
  for (const field of ['estimatedUsd', 'tokensIn', 'tokensOut']) {
    if (!finiteNonNegative(cost[field])) errors.push(`archive_cost_invalid:${field}`);
  }
  if (cost.paidApiUsed !== false) errors.push('archive_cost_paid_api_forbidden');
  if (!hasText(cost.quotaRisk)) errors.push('archive_cost_quota_risk_required');
}

function evaluateResult(record = {}, errors = []) {
  const result = isObject(record.result) ? record.result : {};
  if (!isObject(record.result)) errors.push('archive_result_required');
  const verdict = rawClean(result.verdict, 80);
  if (!ALLOWED_VERDICTS.has(verdict)) errors.push('archive_verdict_invalid');
  if (verdict !== 'dry_run_passed' && !hasText(result.failureReason)) errors.push('archive_failure_reason_required');
  for (const field of ['applied', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed']) {
    if (result[field] !== false) errors.push(`archive_result_flag_false_required:${field}`);
    if (result[field] === true || record[field] === true) errors.push(`archive_result_claim_forbidden:${field}`);
  }
}

function evaluateSafety(record = {}, errors = []) {
  const safety = isObject(record.safety) ? record.safety : {};
  if (!isObject(record.safety)) errors.push('archive_safety_required');
  const mustBeTrue = [
    'dryRunOnly',
    'noPatchApply',
    'noExecutorRegistration',
    'noLive51835',
    'noMemoryV2Write',
    'noPrivateHoldoutRead',
    'noSecretRead',
    'noCommit',
    'noPush',
    'noPackageScriptChange',
    'noEvaluatorChange',
    'noSecurityOrPermissionChange',
  ];
  for (const key of mustBeTrue) {
    if (safety[key] !== true) errors.push(`archive_safety_required:${key}`);
  }
}

function evaluateValidator(record = {}, errors = []) {
  const validator = isObject(record.validator) ? record.validator : {};
  if (!isObject(record.validator)) {
    errors.push('archive_validator_required');
    return;
  }
  if (validator.validatorVersion !== NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION) {
    errors.push('archive_validator_version_mismatch');
  }
  if (!hasText(validator.reportRef)) errors.push('archive_validator_report_ref_required');
  else if (refForbidden(validator.reportRef) || !refMustStayUnderOutput(validator.reportRef)) {
    errors.push('archive_validator_report_ref_forbidden');
  }
  if (!Array.isArray(validator.warnings)) errors.push('archive_validator_warnings_required');
  if (!Array.isArray(validator.blockers)) errors.push('archive_validator_blockers_required');
  if (validator.secretValuesReturned !== false) errors.push('archive_validator_secret_values_returned_forbidden');
  if (!isObject(validator.checks)) {
    errors.push('archive_validator_checks_required');
    return;
  }
  for (const checkName of REQUIRED_VALIDATOR_CHECKS) {
    const check = validator.checks[checkName];
    if (!isObject(check)) {
      errors.push(`archive_validator_check_required:${checkName}`);
      continue;
    }
    if (check.ok !== true) errors.push(`archive_validator_check_failed:${checkName}`);
    if (!hasText(check.reportRef)) errors.push(`archive_validator_check_report_ref_required:${checkName}`);
    else if (refForbidden(check.reportRef) || !refMustStayUnderOutput(check.reportRef)) {
      errors.push(`archive_validator_check_report_ref_forbidden:${checkName}`);
    }
  }
}

export function evaluateNoeEvolutionArchiveDryRunRecord(record = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(record)) {
    return { ok: false, schemaVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_SCHEMA_VERSION, errors: ['archive_record_must_be_object'], warnings, gates: {} };
  }

  evaluateClosedSchema(record, errors);
  const text = JSON.stringify(record);
  if (redactSensitiveText(text) !== text) errors.push('archive_contains_secret_like_value');
  const kind = rawClean(record.kind, 120);
  add(errors, kind === NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND, 'archive_kind_unsupported');
  add(errors, record.schemaVersion === NOE_EVOLUTION_ARCHIVE_DRY_RUN_SCHEMA_VERSION, 'archive_schema_version_unsupported');
  add(errors, hasText(record.id), 'archive_id_required');
  if (hasText(record.id) && !idLooksSafe(record.id)) errors.push('archive_id_invalid');
  add(errors, hasText(record.createdAt), 'archive_created_at_required');
  evaluateLineage(record, errors);
  evaluateRefs(record, errors);
  evaluateHashes(record, errors);
  evaluateScore(record, errors);
  evaluateCost(record, errors);
  evaluateResult(record, errors);
  evaluateSafety(record, errors);
  evaluateValidator(record, errors);
  const refs = collectRefs(record);
  if (refs.some((ref) => !holdoutRefAllowed(ref) && refForbidden(ref))) errors.push('archive_ref_forbidden');

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_SCHEMA_VERSION,
    id: reportSafeId(record.id),
    kind: kind === NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND ? kind : '',
    errors: uniqueErrors,
    warnings,
    gates: {
      identity: kind === NOE_EVOLUTION_ARCHIVE_DRY_RUN_KIND && hasText(record.id),
      lineage: uniqueErrors.every((error) => !error.startsWith('archive_lineage_')) && hasText(record.parentId) && hasText(record.childId),
      metadataOnly: !uniqueErrors.some((error) => error.includes('body_field') || error === 'archive_contains_secret_like_value'),
      refsSafe: !uniqueErrors.some((error) => error.includes('ref_forbidden') || error.includes('output_scope')),
      dryRunOnly: record.safety?.dryRunOnly === true && record.result?.applied !== true,
      scoring: !uniqueErrors.some((error) => error.startsWith('archive_score_') || error.startsWith('archive_cost_')),
      validator: !uniqueErrors.some((error) => error.startsWith('archive_validator_')),
    },
    summary: {
      parentId: reportSafeId(record.parentId),
      childId: reportSafeId(record.childId),
      generation: Number(record.generation),
      verdict: reportSafeVerdict(record.result?.verdict),
      refCount: refs.length,
      score: {
        overall: Number(record.score?.overall),
        safety: Number(record.score?.safety),
        rewardHackingRisk: Number(record.score?.rewardHackingRisk),
      },
    },
  };
}

export function buildNoeEvolutionArchiveDryRunReport(records = [], {
  generatedAt = new Date().toISOString(),
  inputRef = 'unknown',
} = {}) {
  const results = arr(records).map((record) => evaluateNoeEvolutionArchiveDryRunRecord(record));
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    schemaVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_SCHEMA_VERSION,
    validatorVersion: NOE_EVOLUTION_ARCHIVE_DRY_RUN_VALIDATOR_VERSION,
    generatedAt,
    inputRef: refForbidden(inputRef) ? 'unsafe_ref' : safeRef(inputRef),
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      doesNotWriteLiveArchive: true,
      doesNotApplyPatch: true,
      doesNotReadPrivateHoldout: true,
      doesNotReadSecrets: true,
      bodyFieldsForbidden: [...BODY_KEYS],
      requiredRefs: REQUIRED_REF_FIELDS,
      requiredScores: REQUIRED_SCORE_FIELDS,
      requiredChecks: REQUIRED_VALIDATOR_CHECKS,
    },
    counts: {
      records: results.length,
      passed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
    },
    results,
  };
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}
