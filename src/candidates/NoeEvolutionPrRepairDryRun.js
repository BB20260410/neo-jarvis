// @ts-check

import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_EVOLUTION_PR_REPAIR_DRY_RUN_SCHEMA_VERSION = 1;
export const NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND = 'noe_evolution_pr_repair_dry_run_record';
export const NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION = 'evolution-pr-repair-dry-run-v1';

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const SAFE_BRANCH_RE = /^codex\/noe-[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const UNSAFE_REF_CHARS_RE = /[\s"'`$;|&<>*?[\]{}()]/;
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_REF_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.git\/|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel|pull-request-publish|github-publish|gh-cli)/i;
const BODY_KEYS = new Set([
  'body',
  'command',
  'commandOutput',
  'content',
  'description',
  'diff',
  'patch',
  'prompt',
  'raw',
  'rawDiff',
  'secret',
  'stderr',
  'stdout',
  'text',
  'title',
  'token',
  'url',
  'value',
]);
const REQUIRED_CHECKS = Object.freeze([
  'candidatePatchGate',
  'archiveDryRun',
  'scorecardDryRun',
  'draftPrSchema',
  'validationReport',
  'secretScan',
  'sast',
  'sca',
  'rollbackDryRun',
  'publishDryRun',
]);
const RESULT_VERDICTS = new Set(['dry_run_ready', 'dry_run_blocked']);
const TOP_KEYS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'createdAt',
  'parentId',
  'childId',
  'generation',
  'candidateRef',
  'archiveReportRef',
  'scorecardReportRef',
  'holdoutRef',
  'branch',
  'artifacts',
  'cost',
  'result',
  'policy',
  'validator',
  'evidenceRefs',
]);
const SCHEMA_KEYS = new Map([
  ['record', TOP_KEYS],
  ['record.branch', new Set(['proposedName', 'baseRef', 'branchCreated', 'existingBranchChecked'])],
  ['record.artifacts', new Set(['patchArtifactRef', 'patchArtifactSha256', 'draftPrDescriptionRef', 'draftPrDescriptionSha256', 'validationReportRef', 'validationReportSha256', 'rollbackRef', 'rollbackSha256', 'riskReportRef', 'riskReportSha256'])],
  ['record.cost', new Set(['estimatedUsd', 'tokensIn', 'tokensOut', 'latencyMs', 'paidApiUsed', 'modelCalls', 'quotaRisk'])],
  ['record.result', new Set(['verdict', 'readyForHumanReview', 'branchCreated', 'patchApplied', 'prOpened', 'externalPublished', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed'])],
  ['record.policy', new Set(['dryRunOnly', 'metadataOnly', 'noGitBranchCreate', 'noGitCommit', 'noGitPush', 'noExternalPublish', 'noPatchApply', 'noLive51835', 'noMemoryV2Write', 'noPrivateHoldoutRead', 'noSecretRead', 'noPackageScriptChange', 'noEvaluatorChange', 'noSecurityOrPermissionChange'])],
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

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0;
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

function holdoutRefAllowed(ref) {
  const text = safeRef(ref);
  return text === 'private_holdout:not_accessed';
}

function branchNameSafe(value) {
  const text = rawClean(value, 180);
  return text === text.trim()
    && SAFE_BRANCH_RE.test(text)
    && !text.includes('..')
    && !text.includes('//')
    && !text.includes('@{')
    && !text.endsWith('/')
    && !text.endsWith('.')
    && !text.endsWith('.lock');
}

function reportSafeBranch(value) {
  const text = rawClean(value, 180);
  return branchNameSafe(text) ? text : '';
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
    if (BODY_KEYS.has(key) && value[key] !== undefined && value[key] !== null) errors.push(`pr_repair_body_field_forbidden:${key}`);
    if (allowed && !allowed.has(key)) errors.push('pr_repair_unknown_field');
    closedSchema(value[key], errors, childPath);
  }
}

function addRefError(errors, ref, code, { outputOnly = true, prefix = '' } = {}) {
  if (!hasText(ref)) return;
  if (refForbidden(ref)) errors.push(`${code}_forbidden`);
  if (outputOnly && !underOutput(ref)) errors.push(`${code}_output_scope_required`);
  if (prefix && !safeRef(ref).startsWith(prefix)) errors.push(`${code}_scope_required`);
}

function evaluateLineage(record = {}, errors = []) {
  if (!hasText(record.parentId)) errors.push('pr_repair_parent_id_required');
  else if (!idLooksSafe(record.parentId)) errors.push('pr_repair_parent_id_invalid');
  if (!hasText(record.childId)) errors.push('pr_repair_child_id_required');
  else if (!idLooksSafe(record.childId)) errors.push('pr_repair_child_id_invalid');
  if (!nonNegativeInt(record.generation)) errors.push('pr_repair_generation_invalid');
}

function evaluateBranch(record = {}, errors = []) {
  const branch = isObject(record.branch) ? record.branch : {};
  if (!isObject(record.branch)) {
    errors.push('pr_repair_branch_required');
    return;
  }
  if (!branchNameSafe(branch.proposedName)) errors.push('pr_repair_branch_name_invalid');
  if (!hasText(branch.baseRef)) errors.push('pr_repair_base_ref_required');
  else if (!idLooksSafe(branch.baseRef)) errors.push('pr_repair_base_ref_invalid');
  if (branch.branchCreated !== false) errors.push('pr_repair_branch_created_forbidden');
  if (branch.existingBranchChecked !== false) errors.push('pr_repair_existing_branch_check_forbidden');
}

function evaluateArtifacts(record = {}, errors = []) {
  const artifacts = isObject(record.artifacts) ? record.artifacts : {};
  if (!isObject(record.artifacts)) {
    errors.push('pr_repair_artifacts_required');
    return;
  }
  addRefError(errors, artifacts.patchArtifactRef, 'pr_repair_patch_artifact_ref', { prefix: 'output/noe-candidate-patches/' });
  addRefError(errors, artifacts.draftPrDescriptionRef, 'pr_repair_draft_pr_ref', { prefix: 'output/noe-pr-repair-dry-run/' });
  addRefError(errors, artifacts.validationReportRef, 'pr_repair_validation_report_ref', { prefix: 'output/noe-pr-repair-dry-run/' });
  addRefError(errors, artifacts.rollbackRef, 'pr_repair_rollback_ref', { prefix: 'output/noe-pr-repair-dry-run/' });
  addRefError(errors, artifacts.riskReportRef, 'pr_repair_risk_report_ref', { prefix: 'output/noe-pr-repair-dry-run/' });
  for (const [field, value] of Object.entries({
    patchArtifactSha256: artifacts.patchArtifactSha256,
    draftPrDescriptionSha256: artifacts.draftPrDescriptionSha256,
    validationReportSha256: artifacts.validationReportSha256,
    rollbackSha256: artifacts.rollbackSha256,
    riskReportSha256: artifacts.riskReportSha256,
  })) {
    if (!shaLooksValid(value)) errors.push(`pr_repair_sha_invalid:${field}`);
  }
}

function evaluateRefConsistency(record = {}, errors = []) {
  const artifacts = isObject(record.artifacts) ? record.artifacts : {};
  const checks = isObject(record.validator?.checks) ? record.validator.checks : {};
  if (hasText(record.candidateRef) && hasText(artifacts.patchArtifactRef) && safeRef(record.candidateRef) !== safeRef(artifacts.patchArtifactRef)) {
    errors.push('pr_repair_patch_artifact_ref_mismatch');
  }
  if (hasText(record.candidateRef) && hasText(checks.candidatePatchGate?.reportRef) && safeRef(record.candidateRef) !== safeRef(checks.candidatePatchGate.reportRef)) {
    errors.push('pr_repair_candidate_check_ref_mismatch');
  }
  if (hasText(record.archiveReportRef) && hasText(checks.archiveDryRun?.reportRef) && safeRef(record.archiveReportRef) !== safeRef(checks.archiveDryRun.reportRef)) {
    errors.push('pr_repair_archive_check_ref_mismatch');
  }
  if (hasText(record.scorecardReportRef) && hasText(checks.scorecardDryRun?.reportRef) && safeRef(record.scorecardReportRef) !== safeRef(checks.scorecardDryRun.reportRef)) {
    errors.push('pr_repair_scorecard_check_ref_mismatch');
  }
}

function evaluateCost(record = {}, errors = []) {
  const cost = isObject(record.cost) ? record.cost : {};
  if (!isObject(record.cost)) errors.push('pr_repair_cost_required');
  for (const field of ['estimatedUsd', 'tokensIn', 'tokensOut', 'latencyMs']) {
    if (!nonNegative(cost[field])) errors.push(`pr_repair_cost_invalid:${field}`);
  }
  if (cost.paidApiUsed !== false) errors.push('pr_repair_paid_api_forbidden');
  if (cost.modelCalls !== false) errors.push('pr_repair_model_calls_forbidden');
  if (!hasText(cost.quotaRisk)) errors.push('pr_repair_quota_risk_required');
}

function evaluatePolicy(record = {}, errors = []) {
  const policy = isObject(record.policy) ? record.policy : {};
  if (!isObject(record.policy)) errors.push('pr_repair_policy_required');
  for (const key of ['dryRunOnly', 'metadataOnly', 'noGitBranchCreate', 'noGitCommit', 'noGitPush', 'noExternalPublish', 'noPatchApply', 'noLive51835', 'noMemoryV2Write', 'noPrivateHoldoutRead', 'noSecretRead', 'noPackageScriptChange', 'noEvaluatorChange', 'noSecurityOrPermissionChange']) {
    if (policy[key] !== true) errors.push(`pr_repair_policy_required:${key}`);
  }
}

function evaluateValidator(record = {}, errors = []) {
  const validator = isObject(record.validator) ? record.validator : {};
  if (!isObject(record.validator)) {
    errors.push('pr_repair_validator_required');
    return;
  }
  if (validator.validatorVersion !== NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION) errors.push('pr_repair_validator_version_mismatch');
  addRefError(errors, validator.reportRef, 'pr_repair_validator_report_ref', { prefix: 'output/noe-pr-repair-dry-run/' });
  if (!Array.isArray(validator.warnings)) errors.push('pr_repair_validator_warnings_required');
  if (!Array.isArray(validator.blockers)) errors.push('pr_repair_validator_blockers_required');
  if (validator.secretValuesReturned !== false) errors.push('pr_repair_validator_secret_values_returned_forbidden');
  if (!isObject(validator.checks)) {
    errors.push('pr_repair_validator_checks_required');
    return;
  }
  for (const name of REQUIRED_CHECKS) {
    const check = validator.checks[name];
    if (!isObject(check)) {
      errors.push(`pr_repair_validator_check_required:${name}`);
      continue;
    }
    if (check.ok !== true) errors.push(`pr_repair_validator_check_failed:${name}`);
    addRefError(errors, check.reportRef, `pr_repair_validator_check_ref:${name}`);
  }
}

function evaluateResult(record = {}, errors = []) {
  const result = isObject(record.result) ? record.result : {};
  if (!isObject(record.result)) {
    errors.push('pr_repair_result_required');
    return;
  }
  if (!RESULT_VERDICTS.has(rawClean(result.verdict, 80))) errors.push('pr_repair_result_verdict_invalid');
  for (const field of ['branchCreated', 'patchApplied', 'prOpened', 'externalPublished', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed']) {
    if (result[field] !== false) errors.push(`pr_repair_result_flag_false_required:${field}`);
  }
  if (typeof result.readyForHumanReview !== 'boolean') errors.push('pr_repair_ready_for_human_review_boolean_required');
}

function collectRefs(record = {}) {
  const artifacts = isObject(record.artifacts) ? record.artifacts : {};
  return [
    record.candidateRef,
    record.archiveReportRef,
    record.scorecardReportRef,
    artifacts.patchArtifactRef,
    artifacts.draftPrDescriptionRef,
    artifacts.validationReportRef,
    artifacts.rollbackRef,
    artifacts.riskReportRef,
    record.validator?.reportRef,
    ...Object.values(isObject(record.validator?.checks) ? record.validator.checks : {}).map((check) => check?.reportRef),
    ...arr(record.evidenceRefs),
  ].map((ref) => safeRef(ref)).filter(Boolean);
}

function checksAllOk(record = {}) {
  const checks = isObject(record.validator?.checks) ? record.validator.checks : {};
  return REQUIRED_CHECKS.every((name) => checks[name]?.ok === true);
}

export function evaluateNoeEvolutionPrRepairDryRunRecord(record = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(record)) return { ok: false, schemaVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_SCHEMA_VERSION, errors: ['pr_repair_record_must_be_object'], warnings, gates: {} };
  closedSchema(record, errors);
  const serialized = JSON.stringify(record);
  if (redactSensitiveText(serialized) !== serialized) errors.push('pr_repair_contains_secret_like_value');
  const kind = rawClean(record.kind, 120);
  if (kind !== NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND) errors.push('pr_repair_kind_unsupported');
  if (record.schemaVersion !== NOE_EVOLUTION_PR_REPAIR_DRY_RUN_SCHEMA_VERSION) errors.push('pr_repair_schema_version_unsupported');
  if (!hasText(record.id)) errors.push('pr_repair_id_required');
  else if (!idLooksSafe(record.id)) errors.push('pr_repair_id_invalid');
  if (!hasText(record.createdAt)) errors.push('pr_repair_created_at_required');
  evaluateLineage(record, errors);
  addRefError(errors, record.candidateRef, 'pr_repair_candidate_ref', { prefix: 'output/noe-candidate-patches/' });
  addRefError(errors, record.archiveReportRef, 'pr_repair_archive_report_ref', { prefix: 'output/noe-evolution-archive-dry-run/' });
  addRefError(errors, record.scorecardReportRef, 'pr_repair_scorecard_report_ref', { prefix: 'output/noe-evolution-scorecard-dry-run/' });
  if (!holdoutRefAllowed(record.holdoutRef)) errors.push('pr_repair_holdout_ref_must_be_not_accessed');
  evaluateBranch(record, errors);
  evaluateArtifacts(record, errors);
  evaluateCost(record, errors);
  evaluateResult(record, errors);
  evaluatePolicy(record, errors);
  evaluateValidator(record, errors);
  evaluateRefConsistency(record, errors);
  if (record.evidenceRefs !== undefined && !Array.isArray(record.evidenceRefs)) errors.push('pr_repair_evidence_refs_must_be_array');
  for (const ref of arr(record.evidenceRefs)) addRefError(errors, ref, 'pr_repair_evidence_ref');
  const refs = collectRefs(record);
  if (refs.some((ref) => !refForbidden(ref) && !underOutput(ref))) errors.push('pr_repair_ref_output_scope_required');
  if (refs.some((ref) => refForbidden(ref))) errors.push('pr_repair_ref_forbidden');
  const blockers = arr(record.validator?.blockers);
  const shouldBeReady = checksAllOk(record)
    && blockers.length === 0
    && record.policy?.dryRunOnly === true
    && record.policy?.metadataOnly === true
    && record.branch?.branchCreated === false
    && record.result?.readyForHumanReview === true;
  if (record.result?.verdict === 'dry_run_ready' && !shouldBeReady) errors.push('pr_repair_ready_verdict_mismatch');
  if (record.result?.verdict === 'dry_run_blocked' && shouldBeReady) errors.push('pr_repair_blocked_verdict_mismatch');
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_SCHEMA_VERSION,
    id: reportSafeId(record.id),
    kind: kind === NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND ? kind : '',
    errors: uniqueErrors,
    warnings,
    gates: {
      identity: kind === NOE_EVOLUTION_PR_REPAIR_DRY_RUN_KIND && idLooksSafe(record.id),
      branchSafe: branchNameSafe(record.branch?.proposedName),
      refsSafe: !uniqueErrors.some((error) => error.includes('ref') && (error.includes('forbidden') || error.includes('scope'))),
      metadataOnly: !uniqueErrors.some((error) => error.includes('body_field') || error === 'pr_repair_contains_secret_like_value'),
      dryRunOnly: record.policy?.dryRunOnly === true && record.policy?.metadataOnly === true,
      noGitOrPublish: record.policy?.noGitBranchCreate === true && record.policy?.noGitCommit === true && record.policy?.noGitPush === true && record.policy?.noExternalPublish === true,
      validator: !uniqueErrors.some((error) => error.startsWith('pr_repair_validator_')),
    },
    summary: {
      branch: reportSafeBranch(record.branch?.proposedName),
      baseRef: idLooksSafe(record.branch?.baseRef) ? rawClean(record.branch?.baseRef, 180) : '',
      readyForHumanReview: record.result?.readyForHumanReview === true,
      verdict: RESULT_VERDICTS.has(rawClean(record.result?.verdict, 80)) ? rawClean(record.result?.verdict, 80) : '',
      estimatedUsd: Number(record.cost?.estimatedUsd),
      latencyMs: Number(record.cost?.latencyMs),
      refCount: refs.length,
    },
  };
}

export function buildNoeEvolutionPrRepairDryRunReport(records = [], {
  generatedAt = new Date().toISOString(),
  inputRef = 'smoke',
} = {}) {
  const results = arr(records).map((record) => evaluateNoeEvolutionPrRepairDryRunRecord(record));
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    schemaVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_SCHEMA_VERSION,
    validatorVersion: NOE_EVOLUTION_PR_REPAIR_DRY_RUN_VALIDATOR_VERSION,
    generatedAt,
    inputRef: refForbidden(inputRef) ? 'unsafe_ref' : safeRef(inputRef),
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      doesNotCreateBranch: true,
      doesNotRunGitCommit: true,
      doesNotPush: true,
      doesNotOpenPr: true,
      doesNotApplyPatch: true,
      doesNotTouchLive51835: true,
      doesNotWriteMemoryV2: true,
      doesNotReadPrivateHoldout: true,
      doesNotReadSecrets: true,
      doesNotChangePackageScripts: true,
      doesNotChangeEvaluator: true,
      doesNotChangeSecurityOrPermission: true,
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
