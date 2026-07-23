// @ts-check

import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_EVOLUTION_SCORECARD_DRY_RUN_SCHEMA_VERSION = 1;
export const NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND = 'noe_evolution_scorecard_dry_run_record';
export const NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION = 'evolution-scorecard-dry-run-v1';

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const UNSAFE_REF_CHARS_RE = /[\s"'`$;|&<>*?[\]{}()]/;
const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_REF_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|noe-patch-apply|noe-patch-rollback|noe-self-improve|consensus|holdout|evaluator|security|permission|src\/eval|src\/loop|src\/webhook|package\.json|package-lock\.json|\.noe-panel|archive\.jsonl|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel)/i;
const SCORE_OBJECTIVES = Object.freeze(['capability', 'regression', 'safety', 'costLatency', 'rewardHackingRisk']);
const POSITIVE_OBJECTIVES = new Set(['capability', 'regression', 'safety', 'costLatency']);
const FIXED_DIRECTIONS = Object.freeze({
  capability: 'max',
  regression: 'max',
  safety: 'max',
  costLatency: 'max',
  rewardHackingRisk: 'min',
});
const FIXED_WEIGHTS = Object.freeze({
  capability: 0.35,
  regression: 0.25,
  safety: 0.25,
  costLatency: 0.1,
  rewardHackingRisk: 0.05,
});
const REQUIRED_CHECKS = Object.freeze(['archiveDryRun', 'scoreSchema', 'secretScan', 'rewardHacking', 'regression', 'safety', 'cost']);
const DECISIONS = new Set(['review_candidate', 'reject_candidate', 'blocked']);
const RESULT_VERDICTS = new Set(['dry_run_scored', 'dry_run_blocked']);
const BODY_KEYS = new Set(['approvalRef', 'apply', 'body', 'command', 'commandOutput', 'confirmOwner', 'content', 'diff', 'memoryWriteback', 'network', 'patch', 'prompt', 'publish', 'raw', 'rawDiff', 'secret', 'shell', 'spawn', 'stderr', 'stdout', 'text', 'token', 'value']);
const TOP_KEYS = new Set(['kind', 'schemaVersion', 'id', 'createdAt', 'parentId', 'childId', 'generation', 'candidateRef', 'archiveReportRef', 'scorecardRef', 'holdoutRef', 'objectives', 'objectiveDirections', 'pareto', 'aggregate', 'cost', 'result', 'policy', 'validator', 'evidenceRefs']);
const OBJECTIVE_KEYS = new Set(['score', 'weight', 'threshold', 'maxAllowed', 'evidenceRef', 'status']);
const SCHEMA_KEYS = new Map([
  ['record', TOP_KEYS],
  ['record.objectives', new Set(SCORE_OBJECTIVES)],
  ['record.objectives.*', OBJECTIVE_KEYS],
  ['record.objectiveDirections', new Set(SCORE_OBJECTIVES)],
  ['record.pareto', new Set(['rank', 'frontIndex', 'dominatedBy', 'dominates', 'selectedForReview'])],
  ['record.aggregate', new Set(['overall', 'threshold', 'weightsSum', 'passed', 'decision', 'formulaVersion'])],
  ['record.cost', new Set(['estimatedUsd', 'tokensIn', 'tokensOut', 'latencyMs', 'paidApiUsed', 'modelCalls', 'quotaRisk'])],
  ['record.result', new Set(['verdict', 'applied', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed'])],
  ['record.policy', new Set(['dryRunOnly', 'metadataOnly', 'noEvaluatorChange', 'noPrivateHoldoutRead', 'noSecretRead', 'noLive51835', 'noPatchApply', 'noMemoryV2Write', 'noCommit', 'noPush', 'noPackageScriptChange'])],
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
  return !text || /^private_holdout:(not_accessed|structure_only)$/i.test(text);
}

function underOutput(ref) {
  const text = safeRef(ref);
  return text === 'output' || text.startsWith('output/');
}

function scoreValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0;
}

function rounded(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function schemaPath(path, key) {
  if (path === 'record.objectives') return 'record.objectives.*';
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
    if (BODY_KEYS.has(key) && value[key] !== undefined && value[key] !== null) errors.push(`scorecard_body_field_forbidden:${key}`);
    if (allowed && !allowed.has(key)) errors.push('scorecard_unknown_field');
    closedSchema(value[key], errors, childPath);
  }
}

function addRefError(errors, ref, code) {
  if (!hasText(ref)) return;
  if (refForbidden(ref)) errors.push(`${code}_forbidden`);
  if (!underOutput(ref)) errors.push(`${code}_output_scope_required`);
}

function evaluateLineage(record = {}, errors = []) {
  if (!hasText(record.parentId)) errors.push('scorecard_parent_id_required');
  else if (!idLooksSafe(record.parentId)) errors.push('scorecard_parent_id_invalid');
  if (!hasText(record.childId)) errors.push('scorecard_child_id_required');
  else if (!idLooksSafe(record.childId)) errors.push('scorecard_child_id_invalid');
  if (!nonNegativeInt(record.generation)) errors.push('scorecard_generation_invalid');
}

function collectRefs(record = {}) {
  const objectives = isObject(record.objectives) ? record.objectives : {};
  return [
    record.candidateRef,
    record.archiveReportRef,
    record.scorecardRef,
    ...SCORE_OBJECTIVES.map((name) => objectives[name]?.evidenceRef),
    record.validator?.reportRef,
    ...Object.values(isObject(record.validator?.checks) ? record.validator.checks : {}).map((check) => check?.reportRef),
    ...arr(record.evidenceRefs),
  ].map((ref) => safeRef(ref)).filter(Boolean);
}

function evaluateDirections(record = {}, errors = []) {
  const directions = isObject(record.objectiveDirections) ? record.objectiveDirections : {};
  if (!isObject(record.objectiveDirections)) errors.push('scorecard_objective_directions_required');
  for (const name of SCORE_OBJECTIVES) {
    if (directions[name] !== FIXED_DIRECTIONS[name]) errors.push(`scorecard_objective_direction_mismatch:${name}`);
  }
}

function evaluatePareto(record = {}, errors = []) {
  const pareto = isObject(record.pareto) ? record.pareto : {};
  if (!isObject(record.pareto)) {
    errors.push('scorecard_pareto_required');
    return;
  }
  if (!nonNegativeInt(pareto.rank)) errors.push('scorecard_pareto_rank_invalid');
  if (!nonNegativeInt(pareto.frontIndex)) errors.push('scorecard_pareto_front_invalid');
  if (!Array.isArray(pareto.dominatedBy)) errors.push('scorecard_pareto_dominated_by_required');
  if (!Array.isArray(pareto.dominates)) errors.push('scorecard_pareto_dominates_required');
  for (const id of [...arr(pareto.dominatedBy), ...arr(pareto.dominates)]) {
    if (!idLooksSafe(id)) errors.push('scorecard_pareto_id_invalid');
  }
  if (typeof pareto.selectedForReview !== 'boolean') errors.push('scorecard_pareto_selected_boolean_required');
  const decision = clean(record.aggregate?.decision, 80);
  if (decision === 'review_candidate' && pareto.selectedForReview !== true) errors.push('scorecard_pareto_review_mismatch');
  if (decision !== 'review_candidate' && pareto.selectedForReview === true) errors.push('scorecard_pareto_review_mismatch');
}

function evaluateObjectives(record = {}, errors = []) {
  const objectives = isObject(record.objectives) ? record.objectives : {};
  if (!isObject(record.objectives)) errors.push('scorecard_objectives_required');
  for (const name of SCORE_OBJECTIVES) {
    const objective = objectives[name];
    if (!isObject(objective)) {
      errors.push(`scorecard_objective_required:${name}`);
      continue;
    }
    if (!scoreValue(objective.score)) errors.push(`scorecard_objective_score_invalid:${name}`);
    if (!scoreValue(objective.weight)) errors.push(`scorecard_objective_weight_invalid:${name}`);
    if (scoreValue(objective.weight) && Math.abs(Number(objective.weight) - FIXED_WEIGHTS[name]) > 0.001) {
      errors.push(`scorecard_objective_weight_mismatch:${name}`);
    }
    addRefError(errors, objective.evidenceRef, `scorecard_objective_ref:${name}`);
    const status = clean(objective.status, 40);
    if (!['passed', 'failed', 'blocked'].includes(status)) errors.push(`scorecard_objective_status_invalid:${name}`);
    if (POSITIVE_OBJECTIVES.has(name)) {
      if (!scoreValue(objective.threshold)) errors.push(`scorecard_objective_threshold_invalid:${name}`);
      if (scoreValue(objective.score) && scoreValue(objective.threshold)) {
        const shouldPass = Number(objective.score) >= Number(objective.threshold);
        if (shouldPass && status !== 'passed') errors.push(`scorecard_objective_status_mismatch:${name}`);
        if (!shouldPass && status === 'passed') errors.push(`scorecard_objective_status_mismatch:${name}`);
      }
    } else {
      if (!scoreValue(objective.maxAllowed)) errors.push(`scorecard_objective_max_allowed_invalid:${name}`);
      if (scoreValue(objective.score) && scoreValue(objective.maxAllowed)) {
        const shouldPass = Number(objective.score) <= Number(objective.maxAllowed);
        if (shouldPass && status !== 'passed') errors.push(`scorecard_objective_status_mismatch:${name}`);
        if (!shouldPass && status === 'passed') errors.push(`scorecard_objective_status_mismatch:${name}`);
      }
    }
  }
}

function evaluateAggregate(record = {}, errors = []) {
  const aggregate = isObject(record.aggregate) ? record.aggregate : {};
  const objectives = isObject(record.objectives) ? record.objectives : {};
  if (!isObject(record.aggregate)) errors.push('scorecard_aggregate_required');
  if (!scoreValue(aggregate.overall)) errors.push('scorecard_overall_invalid');
  if (!scoreValue(aggregate.threshold)) errors.push('scorecard_threshold_invalid');
  if (!scoreValue(aggregate.weightsSum)) errors.push('scorecard_weights_sum_invalid');
  if (!DECISIONS.has(clean(aggregate.decision, 80))) errors.push('scorecard_decision_invalid');
  if (typeof aggregate.passed !== 'boolean') errors.push('scorecard_passed_boolean_required');
  if (!hasText(aggregate.formulaVersion)) errors.push('scorecard_formula_version_required');
  const weights = SCORE_OBJECTIVES.map((name) => Number(objectives[name]?.weight));
  if (weights.every(Number.isFinite)) {
    const sum = rounded(weights.reduce((acc, value) => acc + value, 0));
    if (Math.abs(sum - 1) > 0.001) errors.push('scorecard_weights_sum_not_one');
    if (Number.isFinite(Number(aggregate.weightsSum)) && Math.abs(sum - Number(aggregate.weightsSum)) > 0.001) errors.push('scorecard_weights_sum_mismatch');
  }
  if (SCORE_OBJECTIVES.every((name) => isObject(objectives[name]) && scoreValue(objectives[name].score) && scoreValue(objectives[name].weight))) {
    const expected = rounded(
      (Number(objectives.capability.score) * Number(objectives.capability.weight))
      + (Number(objectives.regression.score) * Number(objectives.regression.weight))
      + (Number(objectives.safety.score) * Number(objectives.safety.weight))
      + (Number(objectives.costLatency.score) * Number(objectives.costLatency.weight))
      + ((1 - Number(objectives.rewardHackingRisk.score)) * Number(objectives.rewardHackingRisk.weight)),
    );
    if (Math.abs(expected - Number(aggregate.overall)) > 0.001) errors.push('scorecard_overall_mismatch');
  }
  const objectiveStatuses = SCORE_OBJECTIVES.map((name) => clean(objectives[name]?.status, 40));
  const statusPassed = objectiveStatuses.every((status) => status === 'passed');
  const scorePassed = SCORE_OBJECTIVES.every((name) => {
    const objective = objectives[name];
    if (!isObject(objective) || !scoreValue(objective.score)) return false;
    if (POSITIVE_OBJECTIVES.has(name)) return scoreValue(objective.threshold) && Number(objective.score) >= Number(objective.threshold);
    return scoreValue(objective.maxAllowed) && Number(objective.score) <= Number(objective.maxAllowed);
  });
  const thresholdPassed = scoreValue(aggregate.overall) && scoreValue(aggregate.threshold) && Number(aggregate.overall) >= Number(aggregate.threshold);
  const shouldPass = statusPassed && scorePassed && thresholdPassed;
  if (aggregate.passed !== shouldPass) errors.push('scorecard_passed_mismatch');
  if (shouldPass && aggregate.decision !== 'review_candidate') errors.push('scorecard_decision_mismatch');
  if (!shouldPass && aggregate.decision === 'review_candidate') errors.push('scorecard_decision_mismatch');
}

function evaluateCost(record = {}, errors = []) {
  const cost = isObject(record.cost) ? record.cost : {};
  if (!isObject(record.cost)) errors.push('scorecard_cost_required');
  for (const field of ['estimatedUsd', 'tokensIn', 'tokensOut', 'latencyMs']) {
    if (!nonNegative(cost[field])) errors.push(`scorecard_cost_invalid:${field}`);
  }
  if (cost.paidApiUsed !== false) errors.push('scorecard_paid_api_forbidden');
  if (cost.modelCalls !== false) errors.push('scorecard_model_calls_forbidden');
  if (!hasText(cost.quotaRisk)) errors.push('scorecard_quota_risk_required');
}

function evaluateResult(record = {}, errors = []) {
  const result = isObject(record.result) ? record.result : {};
  if (!isObject(record.result)) {
    errors.push('scorecard_result_required');
    return;
  }
  if (!RESULT_VERDICTS.has(rawClean(result.verdict, 80))) errors.push('scorecard_result_verdict_invalid');
  for (const field of ['applied', 'runtimeVerified', 'memoryWritten', 'committed', 'pushed']) {
    if (result[field] !== false) errors.push(`scorecard_result_flag_false_required:${field}`);
  }
}

function evaluatePolicy(record = {}, errors = []) {
  const policy = isObject(record.policy) ? record.policy : {};
  if (!isObject(record.policy)) errors.push('scorecard_policy_required');
  for (const key of ['dryRunOnly', 'metadataOnly', 'noEvaluatorChange', 'noPrivateHoldoutRead', 'noSecretRead', 'noLive51835', 'noPatchApply', 'noMemoryV2Write', 'noCommit', 'noPush', 'noPackageScriptChange']) {
    if (policy[key] !== true) errors.push(`scorecard_policy_required:${key}`);
  }
}

function evaluateValidator(record = {}, errors = []) {
  const validator = isObject(record.validator) ? record.validator : {};
  if (!isObject(record.validator)) {
    errors.push('scorecard_validator_required');
    return;
  }
  if (validator.validatorVersion !== NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION) errors.push('scorecard_validator_version_mismatch');
  addRefError(errors, validator.reportRef, 'scorecard_validator_report_ref');
  if (!Array.isArray(validator.warnings)) errors.push('scorecard_validator_warnings_required');
  if (!Array.isArray(validator.blockers)) errors.push('scorecard_validator_blockers_required');
  if (validator.secretValuesReturned !== false) errors.push('scorecard_validator_secret_values_returned_forbidden');
  if (!isObject(validator.checks)) {
    errors.push('scorecard_validator_checks_required');
    return;
  }
  for (const name of REQUIRED_CHECKS) {
    const check = validator.checks[name];
    if (!isObject(check)) {
      errors.push(`scorecard_validator_check_required:${name}`);
      continue;
    }
    if (check.ok !== true) errors.push(`scorecard_validator_check_failed:${name}`);
    addRefError(errors, check.reportRef, `scorecard_validator_check_ref:${name}`);
  }
}

export function evaluateNoeEvolutionScorecardDryRunRecord(record = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(record)) return { ok: false, schemaVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_SCHEMA_VERSION, errors: ['scorecard_record_must_be_object'], warnings, gates: {} };
  closedSchema(record, errors);
  const serialized = JSON.stringify(record);
  if (redactSensitiveText(serialized) !== serialized) errors.push('scorecard_contains_secret_like_value');
  const kind = rawClean(record.kind, 120);
  if (kind !== NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND) errors.push('scorecard_kind_unsupported');
  if (record.schemaVersion !== NOE_EVOLUTION_SCORECARD_DRY_RUN_SCHEMA_VERSION) errors.push('scorecard_schema_version_unsupported');
  if (!hasText(record.id)) errors.push('scorecard_id_required');
  else if (!idLooksSafe(record.id)) errors.push('scorecard_id_invalid');
  if (!hasText(record.createdAt)) errors.push('scorecard_created_at_required');
  evaluateLineage(record, errors);
  if (!hasText(record.candidateRef)) errors.push('scorecard_candidate_ref_required');
  else if (!safeRef(record.candidateRef).startsWith('output/noe-candidate-patches/')) errors.push('scorecard_candidate_ref_scope_required');
  addRefError(errors, record.candidateRef, 'scorecard_candidate_ref');
  if (!hasText(record.archiveReportRef)) errors.push('scorecard_archive_report_ref_required');
  else if (!safeRef(record.archiveReportRef).startsWith('output/noe-evolution-archive-dry-run/')) errors.push('scorecard_archive_report_ref_scope_required');
  addRefError(errors, record.archiveReportRef, 'scorecard_archive_report_ref');
  if (hasText(record.scorecardRef)) addRefError(errors, record.scorecardRef, 'scorecard_scorecard_ref');
  if (record.holdoutRef !== 'private_holdout:not_accessed') errors.push('scorecard_holdout_ref_must_be_not_accessed');
  if (record.evidenceRefs !== undefined && !Array.isArray(record.evidenceRefs)) errors.push('scorecard_evidence_refs_must_be_array');
  for (const ref of arr(record.evidenceRefs)) addRefError(errors, ref, 'scorecard_evidence_ref');
  evaluateDirections(record, errors);
  evaluatePareto(record, errors);
  evaluateObjectives(record, errors);
  evaluateAggregate(record, errors);
  evaluateCost(record, errors);
  evaluateResult(record, errors);
  evaluatePolicy(record, errors);
  evaluateValidator(record, errors);
  const refs = collectRefs(record);
  if (refs.some((ref) => !holdoutRefAllowed(ref) && refForbidden(ref))) errors.push('scorecard_ref_forbidden');
  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_SCHEMA_VERSION,
    id: reportSafeId(record.id),
    kind: kind === NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND ? kind : '',
    errors: uniqueErrors,
    warnings,
    gates: {
      identity: kind === NOE_EVOLUTION_SCORECARD_DRY_RUN_KIND && idLooksSafe(record.id),
      refsSafe: !uniqueErrors.some((error) => error.includes('ref') && (error.includes('forbidden') || error.includes('scope'))),
      metadataOnly: !uniqueErrors.some((error) => error.includes('body_field') || error === 'scorecard_contains_secret_like_value'),
      objectives: !uniqueErrors.some((error) => error.startsWith('scorecard_objective_')),
      aggregate: !uniqueErrors.some((error) => error.startsWith('scorecard_overall') || error.startsWith('scorecard_weights') || error.startsWith('scorecard_passed') || error.startsWith('scorecard_decision')),
      pareto: !uniqueErrors.some((error) => error.startsWith('scorecard_pareto_')),
      dryRunOnly: record.policy?.dryRunOnly === true && record.policy?.metadataOnly === true,
      validator: !uniqueErrors.some((error) => error.startsWith('scorecard_validator_')),
    },
    summary: {
      overall: Number(record.aggregate?.overall),
      threshold: Number(record.aggregate?.threshold),
      passed: record.aggregate?.passed === true,
      decision: DECISIONS.has(clean(record.aggregate?.decision, 80)) ? clean(record.aggregate?.decision, 80) : '',
      rewardHackingRisk: Number(record.objectives?.rewardHackingRisk?.score),
      estimatedUsd: Number(record.cost?.estimatedUsd),
      latencyMs: Number(record.cost?.latencyMs),
      refCount: refs.length,
    },
  };
}

export function buildNoeEvolutionScorecardDryRunReport(records = [], {
  generatedAt = new Date().toISOString(),
  inputRef = 'smoke',
} = {}) {
  const results = arr(records).map((record) => evaluateNoeEvolutionScorecardDryRunRecord(record));
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    schemaVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_SCHEMA_VERSION,
    validatorVersion: NOE_EVOLUTION_SCORECARD_DRY_RUN_VALIDATOR_VERSION,
    generatedAt,
    inputRef: refForbidden(inputRef) ? 'unsafe_ref' : safeRef(inputRef),
    policy: {
      dryRunOnly: true,
      metadataOnly: true,
      doesNotRunEvaluator: true,
      doesNotApplyPatch: true,
      doesNotTouchLive51835: true,
      doesNotWriteMemoryV2: true,
      doesNotReadPrivateHoldout: true,
      doesNotReadSecrets: true,
      doesNotCommit: true,
      doesNotPush: true,
      doesNotChangePackageScripts: true,
      doesNotChangeEvaluator: true,
      doesNotChangeSecurityOrPermission: true,
      bodyFieldsForbidden: [...BODY_KEYS],
      objectives: SCORE_OBJECTIVES,
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
