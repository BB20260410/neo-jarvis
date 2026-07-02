// @ts-check

import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_PLAN_VALIDATOR_DRY_RUN_SCHEMA_VERSION = 1;
export const NOE_PLAN_VALIDATOR_DRY_RUN_KIND = 'noe_plan_validator_dry_run_record';
export const NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION = 'plan-validator-dry-run-v1';

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const UNSAFE_REF_CHARS_RE = /[\s"'`$;|&<>*?[\]{}()]/;
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_REF_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.git\/|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel|pull-request-publish|github-publish|gh-cli|graphmemory-write|causal-runtime-gate)/i;
const BODY_KEYS = new Set(['approvalRef', 'body', 'command', 'commandOutput', 'content', 'description', 'diff', 'patch', 'plan', 'prompt', 'raw', 'rawDiff', 'secret', 'stderr', 'stdout', 'text', 'title', 'token', 'url', 'value']);
const PLAN_KINDS = new Set(['candidate_patch', 'archive', 'scorecard', 'pr_repair', 'memory_candidate', 'skill_candidate', 'social_plan', 'maintenance', 'boundary_report']);
const RESULT_VERDICTS = new Set(['plan_review_ready', 'plan_review_blocked']);
const REQUIRED_CHECKS = Object.freeze(['planSchema', 'sourceReports', 'refSafety', 'policy', 'secretScan', 'noExecution', 'rollbackRef']);
const TOP_KEYS = new Set(['kind', 'schemaVersion', 'id', 'createdAt', 'planKind', 'planRef', 'planSha256', 'sourceReportRefs', 'rollbackRef', 'riskReportRef', 'intendedStage', 'refs', 'policy', 'result', 'validator', 'evidenceRefs']);
const SCHEMA_KEYS = new Map([
  ['record', TOP_KEYS],
  ['record.refs', new Set(['candidatePatchReportRef', 'archiveReportRef', 'scorecardReportRef', 'prRepairReportRef', 'runtimeTraceReportRef', 'evalReportRef', 'boundaryReportRef'])],
  ['record.policy', new Set(['dryRunOnly', 'metadataOnly', 'noPlanExecution', 'noPatchApply', 'noGit', 'noGh', 'noExternalPublish', 'noEvaluatorRun', 'noModelApiCall', 'noLive51835', 'noMemoryV2Write', 'noSecretRead', 'noPrivateHoldoutRead', 'noPackageScriptChange', 'noEvaluatorChange', 'noSecurityOrPermissionChange', 'noGraphMemoryWrite', 'noCausalRuntimeGate'])],
  ['record.result', new Set(['verdict', 'readyAfterGate', 'executed', 'applied', 'committed', 'pushed', 'published', 'runtimeTouched', 'memoryWritten'])],
  ['record.validator', new Set(['validatorVersion', 'reportRef', 'checks', 'warnings', 'blockers', 'secretValuesReturned'])],
  ['record.validator.checks', new Set(REQUIRED_CHECKS)],
  ['record.validator.checks.*', new Set(['ok', 'reportRef'])],
]);

function rawClean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '')).slice(0, max);
}

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
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

function safeRef(value, max = 500) {
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

function shaLooksValid(value) {
  return /^[a-f0-9]{64}$/i.test(clean(value, 80));
}

function underOutput(ref) {
  const text = safeRef(ref);
  return text === 'output' || text.startsWith('output/');
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
    || FORBIDDEN_REF_RE.test(decoded)
  );
}

function schemaPath(path, key) {
  if (path === 'record.validator.checks') return 'record.validator.checks.*';
  return `${path}.${key}`;
}

function closedSchema(value, errors = [], path = 'record') {
  if (Array.isArray(value)) {
    for (const item of value) closedSchema(item, errors, `${path}[]`);
    return;
  }
  if (!isObject(value)) return;
  const allowed = SCHEMA_KEYS.get(path);
  for (const key of Object.keys(value)) {
    const childPath = schemaPath(path, key);
    if (BODY_KEYS.has(key) && value[key] !== undefined && value[key] !== null) errors.push(`plan_validator_body_field_forbidden:${key}`);
    if (allowed && !allowed.has(key)) errors.push('plan_validator_unknown_field');
    closedSchema(value[key], errors, childPath);
  }
}

function addRefError(errors, ref, code, { required = false, prefix = '' } = {}) {
  if (!hasText(ref)) {
    if (required) errors.push(`${code}_required`);
    return;
  }
  if (refForbidden(ref)) errors.push(`${code}_forbidden`);
  if (!underOutput(ref)) errors.push(`${code}_output_scope_required`);
  if (prefix && !safeRef(ref).startsWith(prefix)) errors.push(`${code}_scope_required`);
}

function collectRefs(record = {}) {
  const refs = isObject(record.refs) ? record.refs : {};
  return [
    record.planRef,
    record.rollbackRef,
    record.riskReportRef,
    ...arr(record.sourceReportRefs),
    ...Object.values(refs),
    record.validator?.reportRef,
    ...Object.values(isObject(record.validator?.checks) ? record.validator.checks : {}).map((check) => check?.reportRef),
    ...arr(record.evidenceRefs),
  ].map((ref) => safeRef(ref)).filter(Boolean);
}

function evaluatePolicy(record = {}, errors = []) {
  const policy = isObject(record.policy) ? record.policy : {};
  if (!isObject(record.policy)) errors.push('plan_validator_policy_required');
  for (const key of ['dryRunOnly', 'metadataOnly', 'noPlanExecution', 'noPatchApply', 'noGit', 'noGh', 'noExternalPublish', 'noEvaluatorRun', 'noModelApiCall', 'noLive51835', 'noMemoryV2Write', 'noSecretRead', 'noPrivateHoldoutRead', 'noPackageScriptChange', 'noEvaluatorChange', 'noSecurityOrPermissionChange', 'noGraphMemoryWrite', 'noCausalRuntimeGate']) {
    if (policy[key] !== true) errors.push(`plan_validator_policy_required:${key}`);
  }
}

function evaluateResult(record = {}, errors = []) {
  const result = isObject(record.result) ? record.result : {};
  if (!isObject(record.result)) {
    errors.push('plan_validator_result_required');
    return;
  }
  if (!RESULT_VERDICTS.has(rawClean(result.verdict, 80))) errors.push('plan_validator_result_verdict_invalid');
  if (typeof result.readyAfterGate !== 'boolean') errors.push('plan_validator_ready_after_gate_boolean_required');
  for (const field of ['executed', 'applied', 'committed', 'pushed', 'published', 'runtimeTouched', 'memoryWritten']) {
    if (result[field] !== false) errors.push(`plan_validator_result_flag_false_required:${field}`);
  }
}

function evaluateValidator(record = {}, errors = []) {
  const validator = isObject(record.validator) ? record.validator : {};
  if (!isObject(record.validator)) {
    errors.push('plan_validator_validator_required');
    return;
  }
  if (validator.validatorVersion !== NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION) errors.push('plan_validator_validator_version_mismatch');
  addRefError(errors, validator.reportRef, 'plan_validator_validator_report_ref', { required: true, prefix: 'output/noe-plan-validator-dry-run/' });
  if (!Array.isArray(validator.warnings)) errors.push('plan_validator_validator_warnings_required');
  if (!Array.isArray(validator.blockers)) errors.push('plan_validator_validator_blockers_required');
  if (validator.secretValuesReturned !== false) errors.push('plan_validator_secret_values_returned_forbidden');
  if (!isObject(validator.checks)) {
    errors.push('plan_validator_checks_required');
    return;
  }
  for (const name of REQUIRED_CHECKS) {
    const check = validator.checks[name];
    if (!isObject(check)) {
      errors.push(`plan_validator_check_required:${name}`);
      continue;
    }
    if (check.ok !== true) errors.push(`plan_validator_check_failed:${name}`);
    addRefError(errors, check.reportRef, `plan_validator_check_ref:${name}`, { required: true });
  }
}

function checksAllOk(record = {}) {
  const checks = isObject(record.validator?.checks) ? record.validator.checks : {};
  return REQUIRED_CHECKS.every((name) => checks[name]?.ok === true);
}

export function evaluateNoePlanValidatorDryRunRecord(record = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(record)) return { ok: false, schemaVersion: NOE_PLAN_VALIDATOR_DRY_RUN_SCHEMA_VERSION, errors: ['plan_validator_record_must_be_object'], warnings, gates: {} };
  closedSchema(record, errors);
  const serialized = JSON.stringify(record);
  if (redactSensitiveText(serialized) !== serialized) errors.push('plan_validator_contains_secret_like_value');
  const kind = rawClean(record.kind, 120);
  if (kind !== NOE_PLAN_VALIDATOR_DRY_RUN_KIND) errors.push('plan_validator_kind_unsupported');
  if (record.schemaVersion !== NOE_PLAN_VALIDATOR_DRY_RUN_SCHEMA_VERSION) errors.push('plan_validator_schema_version_unsupported');
  if (!hasText(record.id)) errors.push('plan_validator_id_required');
  else if (!idLooksSafe(record.id)) errors.push('plan_validator_id_invalid');
  if (!hasText(record.createdAt)) errors.push('plan_validator_created_at_required');
  if (!PLAN_KINDS.has(clean(record.planKind, 80))) errors.push('plan_validator_plan_kind_invalid');
  if (record.intendedStage !== 'dry_run_schema_report') errors.push('plan_validator_intended_stage_invalid');
  addRefError(errors, record.planRef, 'plan_validator_plan_ref', { required: true });
  if (!shaLooksValid(record.planSha256)) errors.push('plan_validator_plan_sha_invalid');
  addRefError(errors, record.rollbackRef, 'plan_validator_rollback_ref', { required: true, prefix: 'output/noe-plan-validator-dry-run/' });
  addRefError(errors, record.riskReportRef, 'plan_validator_risk_report_ref', { required: true, prefix: 'output/noe-plan-validator-dry-run/' });
  if (!Array.isArray(record.sourceReportRefs) || record.sourceReportRefs.length === 0) errors.push('plan_validator_source_report_refs_required');
  for (const ref of arr(record.sourceReportRefs)) addRefError(errors, ref, 'plan_validator_source_report_ref');
  const refs = isObject(record.refs) ? record.refs : {};
  if (!isObject(record.refs)) errors.push('plan_validator_refs_required');
  for (const [name, ref] of Object.entries(refs)) addRefError(errors, ref, `plan_validator_ref:${name}`);
  if (record.evidenceRefs !== undefined && !Array.isArray(record.evidenceRefs)) errors.push('plan_validator_evidence_refs_must_be_array');
  for (const ref of arr(record.evidenceRefs)) addRefError(errors, ref, 'plan_validator_evidence_ref');
  evaluatePolicy(record, errors);
  evaluateResult(record, errors);
  evaluateValidator(record, errors);
  const refsAll = collectRefs(record);
  if (refsAll.some((ref) => refForbidden(ref))) errors.push('plan_validator_ref_forbidden');
  if (refsAll.some((ref) => !underOutput(ref))) errors.push('plan_validator_ref_output_scope_required');
  const shouldBeReady = checksAllOk(record)
    && arr(record.validator?.blockers).length === 0
    && record.policy?.dryRunOnly === true
    && record.policy?.metadataOnly === true
    && record.result?.readyAfterGate === true;
  if (record.result?.verdict === 'plan_review_ready' && !shouldBeReady) errors.push('plan_validator_ready_verdict_mismatch');
  if (record.result?.verdict === 'plan_review_blocked' && shouldBeReady) errors.push('plan_validator_blocked_verdict_mismatch');
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: NOE_PLAN_VALIDATOR_DRY_RUN_SCHEMA_VERSION,
    id: reportSafeId(record.id),
    kind: kind === NOE_PLAN_VALIDATOR_DRY_RUN_KIND ? kind : '',
    errors: uniqueErrors,
    warnings,
    gates: {
      identity: kind === NOE_PLAN_VALIDATOR_DRY_RUN_KIND && idLooksSafe(record.id),
      refsSafe: !uniqueErrors.some((error) => error.includes('ref') && (error.includes('forbidden') || error.includes('scope'))),
      metadataOnly: !uniqueErrors.some((error) => error.includes('body_field') || error === 'plan_validator_contains_secret_like_value'),
      dryRunOnly: record.policy?.dryRunOnly === true && record.policy?.metadataOnly === true,
      noExecution: record.policy?.noPlanExecution === true && record.policy?.noPatchApply === true && record.policy?.noGit === true && record.policy?.noGh === true,
      validator: !uniqueErrors.some((error) => error.startsWith('plan_validator_validator_') || error.startsWith('plan_validator_check_')),
    },
    summary: {
      planKind: PLAN_KINDS.has(clean(record.planKind, 80)) ? clean(record.planKind, 80) : '',
      verdict: RESULT_VERDICTS.has(rawClean(record.result?.verdict, 80)) ? rawClean(record.result?.verdict, 80) : '',
      readyAfterGate: record.result?.readyAfterGate === true,
      sourceReportCount: arr(record.sourceReportRefs).length,
      refCount: refsAll.length,
    },
  };
}

export function buildNoePlanValidatorDryRunReport(records = [], {
  generatedAt = new Date().toISOString(),
  inputRef = 'smoke',
} = {}) {
  const results = arr(records).map((record) => evaluateNoePlanValidatorDryRunRecord(record));
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    schemaVersion: NOE_PLAN_VALIDATOR_DRY_RUN_SCHEMA_VERSION,
    validatorVersion: NOE_PLAN_VALIDATOR_DRY_RUN_VALIDATOR_VERSION,
    generatedAt,
    inputRef: refForbidden(inputRef) ? 'unsafe_ref' : safeRef(inputRef),
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      doesNotExecutePlan: true,
      doesNotApplyPatch: true,
      doesNotRunGitOrGh: true,
      doesNotPublishExternally: true,
      doesNotRunEvaluator: true,
      doesNotCallModelsOrApis: true,
      doesNotTouchLive51835: true,
      doesNotWriteMemoryV2: true,
      doesNotReadPrivateHoldout: true,
      doesNotReadSecrets: true,
      doesNotChangePackageScripts: true,
      doesNotChangeEvaluator: true,
      doesNotChangeSecurityOrPermission: true,
      doesNotWriteGraphMemory: true,
      doesNotInstallCausalRuntimeGate: true,
      bodyFieldsForbidden: [...BODY_KEYS],
      requiredChecks: REQUIRED_CHECKS,
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
