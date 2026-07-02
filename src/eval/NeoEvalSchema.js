// @ts-check

import { posix as pathPosix } from 'node:path';

export const NEO_EVAL_SCHEMA_VERSION = 1;

const LAYERS = new Set(['dev', 'regression', 'private_holdout']);
const SOURCE_KINDS = new Set(['real_replay', 'memory_retrieval_log', 'synthetic_guard', 'incident_regression']);
const ROUTE_TYPES = new Set(['chat', 'mission', 'reflection', 'maintenance']);
const CANDIDATE_KINDS = new Set(['baseline', 'patch', 'prompt', 'memory_candidate', 'skill_candidate']);
const REQUIRED_REDACTION_FLAGS = [
  'secretValuesReturned',
  'memoryBodyIncluded',
  'ownerTokenIncluded',
];
const REQUIRED_POLICY_FALSE = [
  'privateHoldoutAccessibleToCandidate',
  'secretValuesReturned',
  'memoryV2Writes',
  'liveRestart',
];
const REQUIRED_SCORE_INVARIANTS = [
  'noSecretOutput',
  'noPrivateHoldoutLeak',
  'noEvaluatorMutation',
  'rollbackPlanPresent',
];
const REQUIRED_RAW_POLICY_FALSE = [
  'runtimeTouched',
  'privateHoldoutAccessibleToCandidate',
  'secretValuesReturned',
  'memoryV2Writes',
  'liveRestart',
];

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function pushMissing(errors, condition, id) {
  if (!condition) errors.push(id);
}

function enumCheck(errors, value, allowed, id) {
  if (!allowed.has(clean(value))) errors.push(`${id}:${clean(value) || 'blank'}`);
}

function numberInRange(errors, value, id, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) errors.push(`${id}:${value}`);
  return n;
}

function stringList(errors, value, id, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${id}_must_be_array`);
    return [];
  }
  const out = value.map((item) => clean(item, 1000)).filter(Boolean);
  if (out.length < min) errors.push(`${id}_min:${out.length}/${min}`);
  return out;
}

function normalizedEvalRef(value) {
  return pathPosix.normalize(String(value ?? '').replaceAll('\\', '/')).replace(/^\/+/, '');
}

function stringHasPrivateHoldoutPath(value) {
  const text = String(value ?? '');
  const normalized = normalizedEvalRef(text);
  return /evals\/neo\/private_holdout(?:\/|$)/.test(text)
    || normalized === 'evals/neo/private_holdout'
    || normalized.startsWith('evals/neo/private_holdout/');
}

export function hasPrivateHoldoutLeak(value, seen = new Set()) {
  if (typeof value === 'string') return stringHasPrivateHoldoutPath(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasPrivateHoldoutLeak(item, seen));
  return Object.values(value).some((item) => hasPrivateHoldoutLeak(item, seen));
}

function validateRedaction(errors, redaction = {}) {
  if (!isObject(redaction)) {
    errors.push('source_redaction_required');
    return;
  }
  for (const flag of REQUIRED_REDACTION_FLAGS) {
    if (redaction[flag] !== false) errors.push(`redaction_${flag}_must_be_false`);
  }
}

function validateScoring(errors, scoring = {}) {
  if (!isObject(scoring)) {
    errors.push('scoring_required');
    return;
  }
  const fields = ['capabilityWeight', 'regressionWeight', 'safetyWeight', 'costLatencyWeight'];
  const values = fields.map((field) => numberInRange(errors, scoring[field], `scoring_${field}`));
  if (values.every(Number.isFinite)) {
    const sum = values.reduce((acc, item) => acc + item, 0);
    if (Math.abs(sum - 1) > 0.001) errors.push(`scoring_weights_sum_not_one:${Math.round(sum * 1000) / 1000}`);
  }
}

export function validateNeoEvalCase(input = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(input)) return { ok: false, errors: ['case_must_be_object'], warnings };
  pushMissing(errors, input.schemaVersion === NEO_EVAL_SCHEMA_VERSION, 'schema_version_must_be_1');
  pushMissing(errors, clean(input.id).length > 0, 'case_id_required');
  enumCheck(errors, input.layer, LAYERS, 'case_layer_unknown');

  const source = isObject(input.source) ? input.source : {};
  if (!isObject(input.source)) errors.push('source_required');
  enumCheck(errors, source.kind, SOURCE_KINDS, 'source_kind_unknown');
  const evidenceRefs = stringList(errors, source.evidenceRefs, 'source_evidenceRefs', { min: 1 });
  validateRedaction(errors, source.redaction);

  const evalInput = isObject(input.input) ? input.input : {};
  if (!isObject(input.input)) errors.push('input_required');
  enumCheck(errors, evalInput.routeType, ROUTE_TYPES, 'input_routeType_unknown');
  pushMissing(errors, clean(evalInput.task).length > 0, 'input_task_required');
  stringList(errors, evalInput.contextRefs ?? [], 'input_contextRefs');
  stringList(errors, evalInput.allowedTools ?? [], 'input_allowedTools');
  stringList(errors, evalInput.forbiddenTools ?? [], 'input_forbiddenTools');

  const expectations = isObject(input.expectations) ? input.expectations : {};
  if (!isObject(input.expectations)) errors.push('expectations_required');
  stringList(errors, expectations.requiredEvidenceKinds, 'expectations_requiredEvidenceKinds', { min: 1 });
  stringList(errors, expectations.safetyInvariants, 'expectations_safetyInvariants', { min: 1 });
  const hasExpectation = [
    ...list(expectations.mustSelectMemoryIds),
    ...list(expectations.mustNotSelectMemoryIds),
    ...list(expectations.expectedIncludes),
    ...list(expectations.forbiddenIncludes),
  ].some((item) => clean(item));
  if (!hasExpectation) warnings.push('case_has_no_behavior_expectation');

  validateScoring(errors, input.scoring);
  if (hasPrivateHoldoutLeak(input) && input.layer !== 'private_holdout') {
    errors.push('private_holdout_path_leak');
  }
  return { ok: errors.length === 0, errors, warnings, evidenceRefs };
}

export function validateNeoEvalRun(input = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(input)) return { ok: false, errors: ['run_must_be_object'], warnings };
  pushMissing(errors, input.schemaVersion === NEO_EVAL_SCHEMA_VERSION, 'schema_version_must_be_1');
  pushMissing(errors, clean(input.id).length > 0, 'run_id_required');

  const caseSet = isObject(input.caseSet) ? input.caseSet : {};
  if (!isObject(input.caseSet)) errors.push('caseSet_required');
  enumCheck(errors, caseSet.layer, LAYERS, 'caseSet_layer_unknown');
  const caseRefs = stringList(errors, caseSet.caseRefs, 'caseSet_caseRefs', { min: 1 });
  if (Number(caseSet.caseCount) !== caseRefs.length) errors.push(`caseSet_caseCount_mismatch:${caseSet.caseCount}/${caseRefs.length}`);
  if (caseRefs.some((ref) => ref.includes('evals/neo/private_holdout/'))) {
    errors.push('run_caseRefs_must_not_expose_private_holdout_paths');
  }

  const candidate = isObject(input.candidate) ? input.candidate : {};
  if (!isObject(input.candidate)) errors.push('candidate_required');
  enumCheck(errors, candidate.kind, CANDIDATE_KINDS, 'candidate_kind_unknown');
  pushMissing(errors, clean(candidate.candidateRef).length > 0, 'candidate_candidateRef_required');

  const environment = isObject(input.environment) ? input.environment : {};
  if (!isObject(input.environment)) errors.push('environment_required');
  for (const field of ['repo', 'branch', 'head']) {
    pushMissing(errors, clean(environment[field]).length > 0, `environment_${field}_required`);
  }
  if (environment.runtimeTouched !== false) errors.push('environment_runtimeTouched_must_be_false_for_schema_stage');

  const policy = isObject(input.policy) ? input.policy : {};
  if (!isObject(input.policy)) errors.push('policy_required');
  for (const field of REQUIRED_POLICY_FALSE) {
    if (policy[field] !== false) errors.push(`policy_${field}_must_be_false`);
  }
  if (policy.readOnly !== true) errors.push('policy_readOnly_must_be_true');

  const outputs = isObject(input.outputs) ? input.outputs : {};
  if (!isObject(input.outputs)) errors.push('outputs_required');
  for (const field of ['rawRef', 'scoreRef']) {
    pushMissing(errors, clean(outputs[field]).length > 0, `outputs_${field}_required`);
  }
  stringList(errors, outputs.traceRefs ?? [], 'outputs_traceRefs');
  if (hasPrivateHoldoutLeak(input)) errors.push('private_holdout_path_leak');
  return { ok: errors.length === 0, errors, warnings, caseRefs };
}

export function validateNeoEvalScore(input = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(input)) return { ok: false, errors: ['score_must_be_object'], warnings };
  pushMissing(errors, input.schemaVersion === NEO_EVAL_SCHEMA_VERSION, 'schema_version_must_be_1');
  pushMissing(errors, clean(input.runId).length > 0, 'score_runId_required');
  pushMissing(errors, typeof input.ok === 'boolean', 'score_ok_boolean_required');

  const summary = isObject(input.summary) ? input.summary : {};
  if (!isObject(input.summary)) errors.push('summary_required');
  for (const field of ['caseCount', 'passed', 'failed', 'blocked']) {
    const n = Number(summary[field]);
    if (!Number.isInteger(n) || n < 0) errors.push(`summary_${field}_nonnegative_int_required`);
  }
  if (Number.isInteger(Number(summary.caseCount))) {
    const counted = Number(summary.passed || 0) + Number(summary.failed || 0) + Number(summary.blocked || 0);
    if (counted !== Number(summary.caseCount)) errors.push(`summary_caseCount_mismatch:${counted}/${summary.caseCount}`);
  }

  const scores = isObject(input.scores) ? input.scores : {};
  if (!isObject(input.scores)) errors.push('scores_required');
  for (const field of ['capability', 'regression', 'safety', 'costLatency', 'rewardHackingRisk', 'overall']) {
    numberInRange(errors, scores[field], `scores_${field}`);
  }

  const caseResults = Array.isArray(input.caseResults) ? input.caseResults : [];
  if (!Array.isArray(input.caseResults)) errors.push('caseResults_must_be_array');
  if (caseResults.length !== Number(summary.caseCount)) errors.push(`caseResults_count_mismatch:${caseResults.length}/${summary.caseCount}`);
  const statusCounts = { passed: 0, failed: 0, blocked: 0 };
  for (const result of caseResults) {
    if (!isObject(result)) {
      errors.push('caseResult_must_be_object');
      continue;
    }
    pushMissing(errors, clean(result.caseId).length > 0, 'caseResult_caseId_required');
    const status = clean(result.status);
    if (!['passed', 'failed', 'blocked'].includes(status)) errors.push(`caseResult_status_unknown:${status || 'blank'}`);
    else statusCounts[status] += 1;
    stringList(errors, result.evidenceRefs, 'caseResult_evidenceRefs');
    stringList(errors, result.failedChecks, 'caseResult_failedChecks');
  }
  for (const status of ['passed', 'failed', 'blocked']) {
    if (Number(summary[status]) !== statusCounts[status]) errors.push(`summary_${status}_mismatch:${statusCounts[status]}/${summary[status]}`);
  }
  if (input.ok === true && (statusCounts.failed > 0 || statusCounts.blocked > 0)) errors.push('score_ok_true_with_failed_or_blocked_cases');
  if (input.ok === false && caseResults.length > 0 && statusCounts.failed === 0 && statusCounts.blocked === 0) errors.push('score_ok_false_without_failed_or_blocked_cases');

  const invariants = isObject(input.invariants) ? input.invariants : {};
  if (!isObject(input.invariants)) errors.push('invariants_required');
  for (const field of REQUIRED_SCORE_INVARIANTS) {
    if (invariants[field] !== true) errors.push(`invariant_${field}_must_be_true`);
  }
  if (hasPrivateHoldoutLeak(input)) errors.push('private_holdout_path_leak');
  return { ok: errors.length === 0, errors, warnings };
}

export function validateNeoEvalRawScore(input = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(input)) return { ok: false, errors: ['raw_score_must_be_object'], warnings };
  pushMissing(errors, input.schemaVersion === NEO_EVAL_SCHEMA_VERSION, 'schema_version_must_be_1');
  pushMissing(errors, clean(input.kind) === 'neo_eval_raw_score', `raw_score_kind_unknown:${clean(input.kind) || 'blank'}`);
  pushMissing(errors, clean(input.runId).length > 0, 'raw_score_runId_required');
  pushMissing(errors, clean(input.runRef).length > 0, 'raw_score_runRef_required');
  stringList(errors, input.evaluatedCaseRefs ?? [], 'raw_score_evaluatedCaseRefs');

  const policy = isObject(input.policy) ? input.policy : {};
  if (!isObject(input.policy)) errors.push('raw_score_policy_required');
  if (policy.readOnly !== true) errors.push('raw_score_policy_readOnly_must_be_true');
  for (const field of REQUIRED_RAW_POLICY_FALSE) {
    if (policy[field] !== false) errors.push(`raw_score_policy_${field}_must_be_false`);
  }

  for (const field of ['runValidation', 'scoreValidation']) {
    const item = isObject(input[field]) ? input[field] : {};
    if (!isObject(input[field])) {
      errors.push(`raw_score_${field}_required`);
      continue;
    }
    if (typeof item.ok !== 'boolean') errors.push(`raw_score_${field}_ok_boolean_required`);
    stringList(errors, item.errors ?? [], `raw_score_${field}_errors`);
    stringList(errors, item.warnings ?? [], `raw_score_${field}_warnings`);
  }
  if (hasPrivateHoldoutLeak(input)) errors.push('private_holdout_path_leak');
  return { ok: errors.length === 0, errors, warnings };
}

export function validateNeoEvalArtifact(input = {}, { kind = '' } = {}) {
  const resolvedKind = kind || (isObject(input) && input.kind === 'neo_eval_raw_score'
    ? 'raw_score'
    : input.caseSet
      ? 'run'
      : input.caseResults
        ? 'score'
        : 'case');
  if (resolvedKind === 'case') return validateNeoEvalCase(input);
  if (resolvedKind === 'run') return validateNeoEvalRun(input);
  if (resolvedKind === 'score') return validateNeoEvalScore(input);
  if (resolvedKind === 'raw_score') return validateNeoEvalRawScore(input);
  return { ok: false, errors: [`unknown_artifact_kind:${resolvedKind || 'blank'}`], warnings: [] };
}
