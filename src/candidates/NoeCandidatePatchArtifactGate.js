// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_CANDIDATE_PATCH_ARTIFACT_SCHEMA_VERSION = 1;
export const NOE_CANDIDATE_PATCH_ARTIFACT_KIND = 'neo_candidate_patch_artifact';
export const NOE_CANDIDATE_PATCH_VALIDATOR_VERSION = 'candidate-patch-artifact-gate-v1';

export const NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1 = Object.freeze({
  prefixes: Object.freeze([
    'docs/',
    'output/noe-candidate-patches/',
    'src/report/',
    'tests/fixtures/noe-candidate-patch/',
  ]),
  exact: Object.freeze([]),
  scriptPatterns: Object.freeze([
    '^scripts/[^/]*(validate|dry-run)[^/]*\\.mjs$',
  ]),
  testPatterns: Object.freeze([
    '^tests/unit/noe-candidate-patch-artifact-gate\\.test\\.js$',
  ]),
});

const MAX_CHANGED_FILES = 3;
const MAX_CHANGED_LINES = 200;
const MAX_DIFF_BYTES = 100 * 1024;
const PATCH_OPS = new Set(['modify_file', 'write_file']);
const HOLDOUT_STATUSES = new Set(['not_accessed', 'structure_only']);
const ALLOWED_AREAS = new Set([
  'candidate_gate',
  'candidate_planner',
  'diagnostics',
  'documentation',
  'dry_run_report',
  'eval_tool',
  'prompt_template',
  'report_formatter',
  'sorting_params',
]);
const SECRET_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const FORBIDDEN_EXACT = new Set([
  'electron-main.js',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'server.js',
  'yarn.lock',
]);
const FORBIDDEN_PREFIXES = [
  '.git/',
  '.noe-panel/',
  'build/',
  'dist/',
  'evals/neo/private_holdout/',
  'node_modules/',
  'release/',
  'scripts/noe-consensus',
  'scripts/noe-patch-apply',
  'scripts/noe-patch-rollback',
  'scripts/restart-panel',
  'src/eval/',
  'src/loop/',
  'src/permissions/',
  'src/security/',
  'src/webhook/',
];
const FORBIDDEN_EXACT_TARGETS = new Set([
  'src/room/NoeExecutionAuthority.js',
  'src/runtime/mission/NoePatchApplyChainDrill.js',
  'src/runtime/mission/NoePatchApplyExecutor.js',
  'src/runtime/mission/NoePatchTransaction.js',
]);
const FORBIDDEN_TARGET_PATTERN_RE = /(?:NoePatchApply|NoePatchTransaction|NoeSelfEvolution|NoeConsensus|NoeExecutionAuthority|consensus|holdout|evaluator|ci|security|permission|memoryV2|memory-v2|51735|51835|panel-runtime|runtime-restart|restart-panel)/i;
const GLOB_RE = /[*?[\]{}]/;
const BODY_KEYS = new Set([
  'body',
  'content',
  'diff',
  'patch',
  'raw',
  'rawDiff',
  'secret',
  'text',
  'value',
]);
const FORBIDDEN_OPERATION_FLAGS = [
  'apply',
  'chmod',
  'confirmOwner',
  'delete',
  'externalSideEffect',
  'git',
  'kill',
  'memoryWriteback',
  'move',
  'network',
  'publish',
  'realExecute',
  'restart',
  'shell',
  'spawn',
];
const FORBIDDEN_COMMAND_RE = /\b(?:timeout|npm|pnpm|yarn|npx|curl|wget|git|rm|mv|cp|sed|python|python3|bash|sh|zsh|osascript|launchctl|killall|pkill|server\.js|restart-panel|noe-patch-apply|noe-patch-rollback|noe-memory-candidate-apply|noe-memory-candidate-rollback|noe-skill-draft-apply|--apply|--confirm-owner|PORT\s*=\s*51835|51835|NOE_SELF_EVOLUTION_EXECUTORS\s*=\s*1|NOE_SELF_EVOLUTION_STANDING_GRANT\s*=\s*1)\b/i;
const COMMAND_META_RE = /[;&|><`$()]/;
const REQUIRED_VALIDATOR_CHECKS = Object.freeze([
  'sandbox',
  'secretScan',
  'sast',
  'sca',
  'rollbackDryRun',
  'rewardHacking',
]);
const TOP_LEVEL_KEYS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'createdAt',
  'parentRef',
  'diffRef',
  'patchPlanRef',
  'scope',
  'reason',
  'holdoutRef',
  'holdout',
  'provenance',
  'signature',
  'cost',
  'evalPlan',
  'rollbackPlan',
  'operations',
  'claims',
  'validator',
  'safety',
  'tests',
  'evidenceRefs',
]);
const SCHEMA_KEYS = new Map([
  ['artifact', TOP_LEVEL_KEYS],
  ['artifact.scope', new Set(['phase', 'changeType', 'allowedArea', 'targetFiles', 'changedFiles', 'changedLines', 'diffBytes', 'nonCoreOnly'])],
  ['artifact.reason', new Set(['problemRef', 'hypothesis', 'expectedBenefit'])],
  ['artifact.holdout', new Set(['status'])],
  ['artifact.provenance', new Set(['source', 'modelOrTool', 'sourceEpisodeId', 'sourceEpisodeRef', 'sourceReportRef', 'rawOutputRef', 'roundRef', 'redactionPolicy', 'sourceRefs'])],
  ['artifact.signature', new Set(['payloadSha256', 'verified', 'ref'])],
  ['artifact.cost', new Set(['estimatedUsd', 'quotaRisk', 'paidApiUsed', 'note'])],
  ['artifact.evalPlan', new Set(['reportRef', 'scoreRef', 'holdoutRef', 'holdoutStatus', 'devCommands', 'regressionCommands', 'successCriteria', 'tests'])],
  ['artifact.tests[]', new Set(['name', 'script', 'ok', 'reportRef', 'evidenceRef'])],
  ['artifact.evalPlan.tests[]', new Set(['name', 'script', 'ok', 'reportRef', 'evidenceRef'])],
  ['artifact.rollbackPlan', new Set(['mode', 'rollbackRef', 'reportRef', 'reversible', 'manualSteps', 'callsRollbackExecutor', 'confirmOwner'])],
  ['artifact.operations[]', new Set(['id', 'op', 'type', 'path', 'contentSha256', 'contentBytes', 'addedLines', 'removedLines', ...FORBIDDEN_OPERATION_FLAGS])],
  ['artifact.claims', new Set(['applied', 'claimedSucceeded', 'committed', 'consensusApproved', 'live51835Verified', 'memoryWritten', 'pushed', 'runtimeRestarted', 'runtimeVerified', 'standingApproved', 'userApproved', 'status', 'approvalRef'])],
  ['artifact.validator', new Set(['validatorVersion', 'reportRef', 'blockers', 'warnings', 'secretValuesReturned', 'checks'])],
  ['artifact.validator.checks', new Set(REQUIRED_VALIDATOR_CHECKS)],
  ['artifact.validator.checks.*', new Set(['ok', 'reportRef'])],
  ['artifact.safety', new Set(['dryRunOnly', 'sandboxed', 'secretScanPlanned', 'sastPlanned', 'scaPlanned', 'rollbackDryRunPlanned', 'rewardHackingChecked', 'ciTouched', 'commits', 'evaluatorTouched', 'executorEnabled', 'externalSideEffect', 'liveAction', 'memoryV2Write', 'memoryWriteback', 'modelCalls', 'packageScriptsTouched', 'patchExecutorEnabled', 'permissionTouched', 'privateHoldoutRead', 'pushes', 'realExecute', 'runtimePortTouch', 'runtimeRestart', 'secretAccess', 'securityTouched', 'selfEvolutionExecutorsEnabled', 'standingGrantEnabled', 'writesRepoFiles', 'writesMemoryV2', 'holdoutStatus'])],
]);

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function nonNegativeNumber(value, fallback = 0) {
  return finiteNonNegative(value) ? Number(value) : fallback;
}

function safeRef(value, max = 500) {
  return clean(value, max).replaceAll('\\', '/');
}

function decodeRef(value) {
  const text = safeRef(value);
  try {
    return decodeURIComponent(text).replaceAll('\\', '/');
  } catch {
    return text;
  }
}

function hasText(value) {
  return clean(value).length > 0;
}

function schemaChildPath(parentPath, key) {
  if (parentPath === 'artifact.validator.checks') return 'artifact.validator.checks.*';
  return `${parentPath}.${key}`;
}

function evaluateClosedSchema(value, errors = [], path = 'artifact') {
  if (Array.isArray(value)) {
    for (const item of value) evaluateClosedSchema(item, errors, `${path}[]`);
    return;
  }
  if (!isPlainObject(value)) return;
  const allowed = SCHEMA_KEYS.get(path);
  for (const key of Object.keys(value)) {
    const childPath = schemaChildPath(path, key);
    if (BODY_KEYS.has(key) && value[key] !== undefined && value[key] !== null) {
      errors.push(`artifact_body_field_forbidden:${childPath}`);
    }
    if (allowed && !allowed.has(key)) errors.push(`artifact_unknown_field:${childPath}`);
    evaluateClosedSchema(value[key], errors, childPath);
  }
}

function rawHasPathConfusion(value) {
  const raw = String(value ?? '');
  const text = safeRef(value);
  const decoded = decodeRef(text);
  return raw.includes('\\')
    || raw.includes('\0')
    || text.includes('\0')
    || decoded.includes('\0')
    || text.startsWith('~')
    || decoded.startsWith('~')
    || GLOB_RE.test(text)
    || GLOB_RE.test(decoded);
}

function refForbidden(ref) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  if (!text) return false;
  if (rawHasPathConfusion(ref)) return true;
  const checks = [
    (s) => s.startsWith('/'),
    (s) => s.startsWith('../'),
    (s) => s.includes('/../'),
    (s) => /^file:/i.test(s),
    (s) => /^https?:/i.test(s),
    (s) => SECRET_REF_RE.test(s),
  ];
  return checks.some((check) => check(text) || check(decoded));
}

function holdoutRefForbidden(ref) {
  const text = safeRef(ref);
  if (!text) return true;
  if (/^private_holdout:(not_accessed|structure_only)$/i.test(text)) return false;
  if (/^holdout:(not_accessed|structure_only)$/i.test(text)) return false;
  return refForbidden(text) || /evals\/neo\/private_holdout/i.test(text);
}

function allowedTarget(path) {
  const decoded = decodeRef(path);
  if (NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1.exact.includes(decoded)) return true;
  if (NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1.prefixes.some((prefix) => decoded.startsWith(prefix))) return true;
  if (NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1.scriptPatterns.some((pattern) => new RegExp(pattern).test(decoded))) return true;
  if (NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1.testPatterns.some((pattern) => new RegExp(pattern).test(decoded))) return true;
  return false;
}

function blockedTargetReason(path) {
  const text = safeRef(path);
  const decoded = decodeRef(text);
  if (!text) return 'target_path_required';
  if (refForbidden(text)) return `target_path_forbidden_ref:${text}`;
  if (FORBIDDEN_EXACT.has(decoded) || FORBIDDEN_EXACT_TARGETS.has(decoded)) {
    return `target_path_forbidden_exact:${decoded}`;
  }
  if (FORBIDDEN_PREFIXES.some((prefix) => decoded === prefix.slice(0, -1) || decoded.startsWith(prefix))) {
    return `target_path_forbidden_zone:${decoded}`;
  }
  if (FORBIDDEN_TARGET_PATTERN_RE.test(decoded)) return `target_path_forbidden_pattern:${decoded}`;
  if (!allowedTarget(decoded)) return `target_path_not_whitelisted:${decoded}`;
  return '';
}

// ——— P6 自改回归集复用入口 ———
// 把候选 patch gate 的「禁区识别思路」开放给 self-improve bench：候选 agent 进程绝不能写
// 评测产物/结果/conftest 类受控目录。这里只暴露纯判定（不含 allowlist），由 bench 在其上叠加
// 自己的评测目录前缀，沿用同一套路径混淆/secret/越界识别，避免重复实现正则与禁区集。
export const NOE_SELF_IMPROVE_FORBIDDEN_EVAL_PREFIXES = Object.freeze([
  'evals/neo/private_holdout/',
  'evals/neo/selfimprove-bench/',
  'output/noe-selfimprove-bench/',
]);

/**
 * 判定某路径是否落在「评测受控禁区」——候选改动声称要写它即视为越界（防 reward-hack：
 * agent 直接写结果文件 / conftest / 评测产物刷分）。
 * @param {string} path 候选改动目标相对路径
 * @param {{ extraPrefixes?: string[] }} [opts] 额外禁区前缀（如某次运行的临时结果目录相对名）
 * @returns {string} 命中返回 reason 串，未命中返回 ''
 */
export function selfImproveForbiddenEvalPathReason(path, { extraPrefixes = [] } = {}) {
  const text = safeRef(path);
  const decoded = decodeRef(text);
  if (!text) return '';
  if (rawHasPathConfusion(path) || refForbidden(text)) return `eval_path_forbidden_ref:${text}`;
  const prefixes = [...NOE_SELF_IMPROVE_FORBIDDEN_EVAL_PREFIXES, ...arr(extraPrefixes).map((p) => safeRef(p)).filter(Boolean)];
  for (const prefix of prefixes) {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (decoded === normalized.slice(0, -1) || decoded.startsWith(normalized)) {
      return `eval_path_forbidden_zone:${decoded}`;
    }
  }
  // 结果/产物/conftest 类文件名特征（即便不在已知前缀，也按"评测污染"挡）
  if (/(?:^|\/)(?:conftest\.[^/]+|.*\.result\.json|result\.json|score\.json|results\.json|pass\.flag|verdict\.json)$/i.test(decoded)) {
    return `eval_path_forbidden_result_artifact:${decoded}`;
  }
  return '';
}

function collectRefs(artifact = {}) {
  const refs = [
    artifact.parentRef,
    artifact.diffRef,
    artifact.patchPlanRef,
    artifact.holdoutRef,
    artifact.reason?.problemRef,
    artifact.evalPlan?.scoreRef,
    artifact.evalPlan?.holdoutRef,
    artifact.evalPlan?.reportRef,
    artifact.rollbackPlan?.rollbackRef,
    artifact.rollbackPlan?.reportRef,
    artifact.provenance?.roundRef,
    artifact.provenance?.rawOutputRef,
    artifact.provenance?.sourceEpisodeRef,
    artifact.provenance?.sourceReportRef,
    artifact.signature?.ref,
    artifact.validator?.reportRef,
    ...arr(artifact.evidenceRefs),
    ...arr(artifact.provenance?.sourceRefs),
  ];
  for (const checkName of REQUIRED_VALIDATOR_CHECKS) {
    refs.push(artifact.validator?.checks?.[checkName]?.reportRef);
  }
  for (const test of arr(artifact.tests ?? artifact.evalPlan?.tests)) {
    refs.push(test?.reportRef, test?.evidenceRef);
  }
  return refs.map((ref) => safeRef(ref)).filter(Boolean);
}

function _holdoutStatus(artifact = {}) {
  return clean(artifact.holdout?.status ?? artifact.evalPlan?.holdoutStatus ?? artifact.safety?.holdoutStatus ?? '', 80);
}

function holdoutStatusEntries(artifact = {}) {
  return [
    ['holdout.status', clean(artifact.holdout?.status, 80)],
    ['evalPlan.holdoutStatus', clean(artifact.evalPlan?.holdoutStatus, 80)],
    ['safety.holdoutStatus', clean(artifact.safety?.holdoutStatus, 80)],
  ].filter(([, status]) => status);
}

function evaluateHoldoutStatuses(artifact = {}, errors = []) {
  const entries = holdoutStatusEntries(artifact);
  if (!entries.length) {
    errors.push('artifact_holdout_status_forbidden:blank');
    return '';
  }
  for (const [path, status] of entries) {
    if (!HOLDOUT_STATUSES.has(status)) errors.push(`artifact_holdout_status_forbidden:${path}:${status}`);
  }
  const allowedStatuses = [...new Set(entries
    .map(([, status]) => status)
    .filter((status) => HOLDOUT_STATUSES.has(status)))];
  if (allowedStatuses.length > 1) {
    errors.push(`artifact_holdout_status_mismatch:${allowedStatuses.join('!=')}`);
  }
  return entries[0][1];
}

function normalizedTests(artifact = {}) {
  return arr(artifact.tests ?? artifact.evalPlan?.tests).map((test) => ({
    name: clean(test?.name || test?.script || 'unnamed', 160) || 'unnamed',
    ok: test?.ok === true,
    reportRef: safeRef(test?.reportRef || test?.evidenceRef, 500),
  })).slice(0, 80);
}

function operationLineCount(operation = {}) {
  return nonNegativeNumber(operation.addedLines) + nonNegativeNumber(operation.removedLines);
}

function scopeChangedFilesValue(scope = {}) {
  if (Array.isArray(scope.changedFiles)) return {
    valid: true,
    value: scope.changedFiles.length,
  };
  if (finiteNonNegative(scope.changedFiles)) return {
    valid: true,
    value: Number(scope.changedFiles),
  };
  return {
    valid: false,
    value: 0,
  };
}

function scopeMetric(value) {
  if (finiteNonNegative(value)) return { valid: true, value: Number(value) };
  return { valid: false, value: 0 };
}

function summarizeScopeMetrics(scope = {}, operations = []) {
  const targetFiles = arr(scope.targetFiles).map((item) => safeRef(item)).filter(Boolean);
  const operationPaths = operations.map((operation) => operation.path).filter(Boolean);
  const uniqueOperationPaths = [...new Set(operationPaths)];
  const changedFiles = scopeChangedFilesValue(scope);
  const changedLines = scopeMetric(scope.changedLines);
  const diffBytes = scopeMetric(scope.diffBytes);
  const operationLines = operations.reduce((sum, operation) => sum + operationLineCount(operation), 0);
  const operationBytes = operations.reduce((sum, operation) => sum + nonNegativeNumber(operation.contentBytes), 0);
  const requiredFiles = Math.max(targetFiles.length, uniqueOperationPaths.length);
  const requiredLines = operationLines;
  const requiredBytes = operationBytes;
  return {
    targetFiles,
    operationPaths,
    uniqueOperationPaths,
    changedFiles,
    changedLines,
    diffBytes,
    operationLines,
    operationBytes,
    requiredFiles,
    requiredLines,
    requiredBytes,
    maxFiles: Math.max(changedFiles.value, targetFiles.length, uniqueOperationPaths.length),
    maxLines: Math.max(changedLines.value, operationLines),
    maxBytes: Math.max(diffBytes.value, operationBytes),
    consistent: changedFiles.valid
      && changedLines.valid
      && diffBytes.valid
      && changedFiles.value >= requiredFiles
      && changedLines.value >= requiredLines
      && diffBytes.value >= requiredBytes,
  };
}

function add(errors, condition, id) {
  if (!condition) errors.push(id);
}

function evaluateScope(artifact = {}, operations = [], errors = []) {
  const scope = isPlainObject(artifact.scope) ? artifact.scope : {};
  if (!isPlainObject(artifact.scope)) {
    errors.push('artifact_scope_required');
    return scope;
  }
  const metrics = summarizeScopeMetrics(scope, operations);
  const { targetFiles, operationPaths } = metrics;
  const targetSet = new Set(targetFiles);
  if (clean(scope.phase, 80) !== 'phase4') errors.push(`artifact_scope_phase_required:${clean(scope.phase, 80) || 'blank'}`);
  if (!hasText(scope.changeType)) errors.push('artifact_scope_change_type_required');
  if (!ALLOWED_AREAS.has(clean(scope.allowedArea, 120))) errors.push(`artifact_scope_allowed_area_unknown:${clean(scope.allowedArea, 120) || 'blank'}`);
  if (scope.nonCoreOnly !== true) errors.push('artifact_scope_non_core_only_required');
  if (!targetFiles.length) errors.push('artifact_scope_target_files_required');
  if (!metrics.changedFiles.valid) errors.push(`artifact_scope_changed_files_required:${clean(scope.changedFiles, 80) || 'blank'}`);
  if (!metrics.changedLines.valid) errors.push(`artifact_scope_changed_lines_required:${clean(scope.changedLines, 80) || 'blank'}`);
  if (!metrics.diffBytes.valid) errors.push(`artifact_scope_diff_bytes_required:${clean(scope.diffBytes, 80) || 'blank'}`);
  for (const target of targetFiles) {
    const blocked = blockedTargetReason(target);
    if (blocked) errors.push(`artifact_scope_target_forbidden:${blocked}`);
  }
  for (const path of operationPaths) {
    if (!targetSet.has(path)) errors.push(`artifact_scope_target_files_mismatch:${path}`);
  }
  if (metrics.changedFiles.valid && metrics.changedFiles.value < metrics.requiredFiles) {
    errors.push(`artifact_scope_changed_files_inconsistent:${metrics.changedFiles.value}<${metrics.requiredFiles}`);
  }
  if (metrics.changedLines.valid && metrics.changedLines.value < metrics.requiredLines) {
    errors.push(`artifact_scope_changed_lines_inconsistent:${metrics.changedLines.value}<${metrics.requiredLines}`);
  }
  if (metrics.diffBytes.valid && metrics.diffBytes.value < metrics.requiredBytes) {
    errors.push(`artifact_scope_diff_bytes_inconsistent:${metrics.diffBytes.value}<${metrics.requiredBytes}`);
  }
  if (metrics.maxFiles > MAX_CHANGED_FILES) {
    errors.push(`artifact_scope_changed_files_limit_exceeded:${metrics.maxFiles}`);
  }
  if (metrics.maxLines > MAX_CHANGED_LINES) errors.push(`artifact_scope_changed_lines_limit_exceeded:${metrics.maxLines}`);
  if (metrics.maxBytes > MAX_DIFF_BYTES) errors.push(`artifact_scope_diff_bytes_limit_exceeded:${metrics.maxBytes}`);
  return scope;
}

function evaluateReason(artifact = {}, errors = []) {
  const reason = isPlainObject(artifact.reason) ? artifact.reason : {};
  if (!isPlainObject(artifact.reason)) {
    errors.push('artifact_reason_required');
    return;
  }
  if (!hasText(reason.problemRef)) errors.push('artifact_reason_problem_ref_required');
  if (!hasText(reason.hypothesis)) errors.push('artifact_reason_hypothesis_required');
  if (!hasText(reason.expectedBenefit)) errors.push('artifact_reason_expected_benefit_required');
}

function commandTokens(command) {
  return clean(command, 2000).split(/\s+/).filter(Boolean);
}

function commandTargetAllowed(path) {
  return !blockedTargetReason(path);
}

function vitestTargetAllowed(path) {
  const decoded = decodeRef(path);
  if (refForbidden(decoded)) return false;
  if (FORBIDDEN_EXACT.has(decoded) || FORBIDDEN_EXACT_TARGETS.has(decoded)) return false;
  if (FORBIDDEN_PREFIXES.some((prefix) => decoded === prefix.slice(0, -1) || decoded.startsWith(prefix))) return false;
  if (FORBIDDEN_TARGET_PATTERN_RE.test(decoded)) return false;
  return NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1.testPatterns.some((pattern) => new RegExp(pattern).test(decoded));
}

function commandOutDirAllowed(path) {
  const ref = safeRef(path);
  return ref === 'output' || ref.startsWith('output/');
}

const DRY_RUN_OPTION_VALIDATORS = {
  'artifact-file': commandTargetAllowed,
  'out-dir': (ref) => commandOutDirAllowed(ref) && !refForbidden(ref),
};

function parseDryRunOption(token, nextToken) {
  for (const flag of Object.keys(DRY_RUN_OPTION_VALIDATORS)) {
    if (token === `--${flag}`) return { flag, ref: nextToken || '', consumedNext: true };
    const eqPrefix = `--${flag}=`;
    if (token.startsWith(eqPrefix)) return { flag, ref: token.slice(eqPrefix.length), consumedNext: false };
  }
  return null;
}

function dryRunCommandOptionsAllowed(tokens) {
  for (let index = 5; index < tokens.length; index += 1) {
    const option = parseDryRunOption(tokens[index], tokens[index + 1]);
    if (option === null) return false;
    if (!DRY_RUN_OPTION_VALIDATORS[option.flag](option.ref)) return false;
    if (option.consumedNext) index += 1;
  }
  return true;
}

function matchesNodeCheckTokens(tokens) {
  return tokens.length === 3 && tokens[0] === 'node' && tokens[1] === '--check';
}

function matchesEnsureNodeVitestRunTokens(tokens) {
  return (
    tokens.length >= 7
    && tokens[0] === 'node'
    && tokens[1] === 'scripts/ensure-node22.mjs'
    && tokens[2] === '--require-22'
    && tokens[3] === '--exec'
    && tokens[4] === 'node_modules/vitest/vitest.mjs'
    && tokens[5] === 'run'
  );
}

function matchesEnsureNodeDryRunTokens(tokens) {
  return (
    tokens.length >= 5
    && tokens[0] === 'node'
    && tokens[1] === 'scripts/ensure-node22.mjs'
    && tokens[2] === '--require-22'
    && tokens[3] === '--exec'
    && tokens[4] === 'scripts/noe-candidate-patch-dry-run.mjs'
  );
}

function evalCommandAllowed(command) {
  const text = clean(command, 2000);
  if (!text) return { ok: false, reason: 'blank' };
  if (COMMAND_META_RE.test(text) || /[\r\n]/.test(text) || /^\w+=/.test(text)) {
    return { ok: false, reason: 'shell_meta_or_env' };
  }
  if (FORBIDDEN_COMMAND_RE.test(text)) return { ok: false, reason: 'forbidden_token' };
  const tokens = commandTokens(text);
  if (matchesNodeCheckTokens(tokens)) {
    return { ok: commandTargetAllowed(tokens[2]), reason: 'node_check_target' };
  }
  if (matchesEnsureNodeVitestRunTokens(tokens)) {
    const tests = tokens.slice(6);
    return {
      ok: tests.length > 0 && tests.every((target) => vitestTargetAllowed(target)),
      reason: 'vitest_targets',
    };
  }
  if (matchesEnsureNodeDryRunTokens(tokens)) {
    return {
      ok: dryRunCommandOptionsAllowed(tokens),
      reason: 'candidate_patch_dry_run',
    };
  }
  return { ok: false, reason: 'not_allowlisted' };
}

function evaluateEvalPlan(artifact = {}, errors = []) {
  const plan = isPlainObject(artifact.evalPlan) ? artifact.evalPlan : {};
  if (!isPlainObject(artifact.evalPlan)) {
    errors.push('artifact_eval_plan_required');
    return;
  }
  if (!arr(plan.devCommands).length) errors.push('artifact_eval_plan_dev_commands_required');
  if (!arr(plan.regressionCommands).length) errors.push('artifact_eval_plan_regression_commands_required');
  if (!hasText(plan.successCriteria)) errors.push('artifact_eval_plan_success_criteria_required');
  if (!hasText(plan.scoreRef)) errors.push('artifact_eval_plan_score_ref_required');
  for (const command of [...arr(plan.devCommands), ...arr(plan.regressionCommands)]) {
    const allowed = evalCommandAllowed(command);
    if (!allowed.ok) errors.push(`artifact_eval_plan_command_forbidden:${allowed.reason}:${clean(command, 160)}`);
  }
}

function evaluateRollbackPlan(artifact = {}, errors = []) {
  const rollback = isPlainObject(artifact.rollbackPlan) ? artifact.rollbackPlan : {};
  if (!isPlainObject(artifact.rollbackPlan)) {
    errors.push('artifact_rollback_plan_required');
    return;
  }
  if (rollback.reversible !== true) errors.push('artifact_rollback_reversible_required');
  if (!hasText(rollback.rollbackRef)) errors.push('artifact_rollback_ref_required');
  if (!arr(rollback.manualSteps).length) errors.push('artifact_rollback_manual_steps_required');
  if (rollback.callsRollbackExecutor === true || rollback.confirmOwner === true) errors.push('artifact_rollback_executor_call_forbidden');
}

function evaluateProvenance(artifact = {}, errors = []) {
  const provenance = isPlainObject(artifact.provenance) ? artifact.provenance : {};
  if (!isPlainObject(artifact.provenance)) {
    errors.push('artifact_provenance_required');
    return;
  }
  if (!hasText(provenance.sourceEpisodeId)) errors.push('artifact_source_episode_required');
  if (!hasText(provenance.source)) errors.push('artifact_provenance_source_required');
  if (!hasText(provenance.modelOrTool)) errors.push('artifact_provenance_model_or_tool_required');
  if (!hasText(provenance.rawOutputRef)) errors.push('artifact_provenance_raw_output_ref_required');
  if (!hasText(provenance.redactionPolicy)) errors.push('artifact_provenance_redaction_policy_required');
}

function evaluateSignature(artifact = {}, errors = []) {
  const signature = isPlainObject(artifact.signature) ? artifact.signature : {};
  if (!isPlainObject(artifact.signature)) {
    errors.push('artifact_signature_required');
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(clean(signature.payloadSha256, 80))) errors.push('artifact_signature_payload_sha256_required');
  if (signature.verified === true) errors.push('artifact_signature_verified_claim_forbidden');
}

function evaluateCost(artifact = {}, errors = []) {
  const cost = isPlainObject(artifact.cost) ? artifact.cost : {};
  if (!isPlainObject(artifact.cost)) {
    errors.push('artifact_cost_required');
    return;
  }
  if (!finiteNonNegative(cost.estimatedUsd)) errors.push('artifact_cost_estimated_usd_required');
  if (!hasText(cost.quotaRisk)) errors.push('artifact_cost_quota_risk_required');
  if (cost.paidApiUsed !== false) errors.push('artifact_cost_paid_api_forbidden');
}

function evaluateClaims(artifact = {}, errors = []) {
  const claims = isPlainObject(artifact.claims) ? artifact.claims : {};
  if (!isPlainObject(artifact.claims)) {
    errors.push('artifact_claims_required');
    return;
  }
  const forbiddenTrue = [
    'applied',
    'claimedSucceeded',
    'committed',
    'consensusApproved',
    'live51835Verified',
    'memoryWritten',
    'pushed',
    'runtimeRestarted',
    'runtimeVerified',
    'standingApproved',
    'userApproved',
  ];
  for (const key of forbiddenTrue) {
    if (claims[key] === true || artifact[key] === true) errors.push(`artifact_claim_forbidden:${key}`);
  }
  if (hasText(claims.approvalRef) || hasText(artifact.approvalRef)) errors.push('artifact_approval_ref_forbidden');
  if (/applied|succeeded|success/i.test(clean(artifact.status || claims.status, 120))) {
    errors.push(`artifact_status_claim_forbidden:${clean(artifact.status || claims.status, 120)}`);
  }
}

function evaluateValidator(artifact = {}, errors = []) {
  if (!isPlainObject(artifact.validator)) {
    errors.push('artifact_validator_required');
    return;
  }
  const validator = artifact.validator;
  validateValidatorVersion(validator, errors);
  if (!hasText(validator.reportRef)) errors.push('artifact_validator_report_ref_required');
  if (!Array.isArray(validator.blockers)) errors.push('artifact_validator_blockers_required');
  if (!Array.isArray(validator.warnings)) errors.push('artifact_validator_warnings_required');
  if (validator.secretValuesReturned !== false) errors.push('artifact_validator_secret_values_returned_forbidden');
  evaluateValidatorChecks(validator, errors);
}

function validateValidatorVersion(validator, errors) {
  if (!hasText(validator.validatorVersion)) {
    errors.push('artifact_validator_version_required');
  } else if (validator.validatorVersion !== NOE_CANDIDATE_PATCH_VALIDATOR_VERSION) {
    errors.push(`artifact_validator_version_mismatch:${clean(validator.validatorVersion, 120)}`);
  }
}

function evaluateValidatorChecks(validator, errors) {
  if (!isPlainObject(validator.checks)) {
    errors.push('artifact_validator_checks_required');
    return;
  }
  for (const checkName of REQUIRED_VALIDATOR_CHECKS) {
    const check = validator.checks[checkName];
    if (!isPlainObject(check)) {
      errors.push(`artifact_validator_check_required:${checkName}`);
      continue;
    }
    if (check.ok !== true) errors.push(`artifact_validator_check_failed:${checkName}`);
    validateCheckReportRef(checkName, check, errors);
  }
}

function validateCheckReportRef(checkName, check, errors) {
  if (!hasText(check.reportRef)) {
    errors.push(`artifact_validator_check_report_ref_required:${checkName}`);
  } else if (refForbidden(check.reportRef)) {
    errors.push(`artifact_validator_check_report_ref_forbidden:${checkName}`);
  }
}

function evaluateSafety(artifact = {}, errors = []) {
  const safety = isPlainObject(artifact.safety) ? artifact.safety : {};
  if (!isPlainObject(artifact.safety)) errors.push('artifact_safety_required');
  const mustBeTrue = [
    ['dryRunOnly', 'safety_dry_run_only_required'],
    ['sandboxed', 'safety_sandbox_required'],
    ['secretScanPlanned', 'safety_secret_scan_required'],
    ['sastPlanned', 'safety_sast_required'],
    ['scaPlanned', 'safety_sca_required'],
    ['rollbackDryRunPlanned', 'safety_rollback_dry_run_required'],
    ['rewardHackingChecked', 'safety_reward_hacking_check_required'],
  ];
  for (const [key, error] of mustBeTrue) {
    if (safety[key] !== true) errors.push(error);
  }
  const mustBeFalse = [
    ['ciTouched', 'safety_ci_touch_forbidden'],
    ['commits', 'safety_commit_forbidden'],
    ['evaluatorTouched', 'safety_evaluator_touch_forbidden'],
    ['executorEnabled', 'safety_executor_enable_forbidden'],
    ['externalSideEffect', 'safety_external_side_effect_forbidden'],
    ['liveAction', 'safety_live_action_forbidden'],
    ['memoryV2Write', 'safety_memory_v2_write_forbidden'],
    ['memoryWriteback', 'safety_memory_writeback_forbidden'],
    ['modelCalls', 'safety_model_call_forbidden'],
    ['packageScriptsTouched', 'safety_package_script_touch_forbidden'],
    ['patchExecutorEnabled', 'safety_patch_executor_enable_forbidden'],
    ['permissionTouched', 'safety_permission_touch_forbidden'],
    ['privateHoldoutRead', 'safety_private_holdout_read_forbidden'],
    ['pushes', 'safety_push_forbidden'],
    ['realExecute', 'safety_real_execute_forbidden'],
    ['runtimePortTouch', 'safety_runtime_port_touch_forbidden'],
    ['runtimeRestart', 'safety_runtime_restart_forbidden'],
    ['secretAccess', 'safety_secret_access_forbidden'],
    ['securityTouched', 'safety_security_touch_forbidden'],
    ['selfEvolutionExecutorsEnabled', 'safety_self_evolution_executor_enable_forbidden'],
    ['standingGrantEnabled', 'safety_standing_grant_forbidden'],
    ['writesRepoFiles', 'safety_repo_write_forbidden'],
    ['writesMemoryV2', 'safety_memory_v2_write_forbidden'],
  ];
  for (const [key, error] of mustBeFalse) {
    if (safety[key] === true || artifact[key] === true) errors.push(error);
  }
}

function evaluateOperations(artifact = {}, errors = []) {
  const operations = arr(artifact.operations);
  add(errors, operations.length > 0, 'artifact_operations_required');
  return operations.map((operation = {}, index) => {
    const op = clean(operation.op || operation.type, 80);
    const path = safeRef(operation.path, 500);
    const operationErrors = [];
    validateOperationBasicFields(operation, op, path, index, operationErrors);
    validateOperationContentFields(operation, path, index, operationErrors);
    errors.push(...operationErrors);
    return {
      id: clean(operation.id || `op-${index + 1}`, 160),
      op,
      path,
      contentSha256: clean(operation.contentSha256, 80),
      contentBytes: nonNegativeNumber(operation.contentBytes),
      addedLines: nonNegativeNumber(operation.addedLines),
      removedLines: nonNegativeNumber(operation.removedLines),
      errors: operationErrors,
    };
  });
}

function validateOperationBasicFields(operation, op, path, index, operationErrors) {
  if (!PATCH_OPS.has(op)) operationErrors.push(`operation_unsupported:${op || 'blank'}`);
  if (!hasText(operation.id)) operationErrors.push(`operation_id_required:${index + 1}`);
  const pathError = blockedTargetReason(path);
  if (pathError) operationErrors.push(pathError);
  for (const key of Object.keys(operation || {})) {
    if (BODY_KEYS.has(key) && operation[key] !== undefined && operation[key] !== null) {
      operationErrors.push(`operation_body_field_forbidden:${key}`);
    }
  }
  for (const key of FORBIDDEN_OPERATION_FLAGS) {
    if (operation[key] === true) operationErrors.push(`operation_forbidden_flag:${key}`);
  }
}

function validateOperationContentFields(operation, path, index, operationErrors) {
  if (!/^[a-f0-9]{64}$/i.test(clean(operation.contentSha256, 80))) {
    operationErrors.push(`operation_content_sha256_required:${path || index + 1}`);
  }
  if (!Number.isFinite(Number(operation.contentBytes)) || Number(operation.contentBytes) < 0) {
    operationErrors.push(`operation_content_bytes_required:${path || index + 1}`);
  }
  if (!finiteNonNegative(operation.addedLines) || !finiteNonNegative(operation.removedLines)) {
    operationErrors.push(`operation_line_counts_required:${path || index + 1}`);
  }
}

/**
 * Evaluates a Noe candidate patch artifact against schema, policy, and safety gates.
 * @param {Object} [artifact={}] - The artifact object to evaluate.
 * @returns {{ ok: boolean, schemaVersion: string, id: string, kind: string, errors: string[], warnings: string[], gates: Object, summary: Object }} Evaluation result.
 */
export function evaluateNoeCandidatePatchArtifact(artifact = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(artifact)) {
    return {
      ok: false,
      schemaVersion: NOE_CANDIDATE_PATCH_ARTIFACT_SCHEMA_VERSION,
      errors: ['artifact_must_be_object'],
      warnings,
      gates: {},
    };
  }

  evaluateClosedSchema(artifact, errors);
  const artifactText = JSON.stringify(artifact);
  if (redactSensitiveText(artifactText) !== artifactText) errors.push('artifact_contains_secret_like_value');
  const kind = clean(artifact.kind, 120);
  const id = clean(artifact.id, 180);
  const refs = collectRefs(artifact);
  const blockedRefs = refs.filter((ref) => ref !== artifact.holdoutRef && refForbidden(ref));
  const tests = normalizedTests(artifact);
  const operations = evaluateOperations(artifact, errors);
  const scope = evaluateScope(artifact, operations, errors);
  const scopeMetrics = summarizeScopeMetrics(scope, operations);
  const holdout = evaluateHoldoutStatuses(artifact, errors);

  if (artifact.schemaVersion !== NOE_CANDIDATE_PATCH_ARTIFACT_SCHEMA_VERSION) {
    errors.push(`artifact_schema_version_unsupported:${artifact.schemaVersion ?? 'blank'}`);
  }
  if (kind !== NOE_CANDIDATE_PATCH_ARTIFACT_KIND) errors.push(`artifact_kind_unsupported:${kind || 'blank'}`);
  add(errors, hasText(id), 'artifact_id_required');
  add(errors, hasText(artifact.createdAt), 'artifact_created_at_required');
  add(errors, hasText(artifact.parentRef), 'artifact_parent_ref_required');
  add(errors, hasText(artifact.diffRef) || hasText(artifact.patchPlanRef), 'artifact_diff_or_patch_plan_ref_required');
  add(errors, hasText(artifact.holdoutRef), 'artifact_holdout_ref_required');
  if (holdoutRefForbidden(artifact.holdoutRef)) errors.push('artifact_holdout_ref_must_not_read_private_holdout');
  if (blockedRefs.length) errors.push('artifact_ref_forbidden');
  add(errors, tests.length > 0, 'artifact_tests_required');
  for (const test of tests) {
    if (!test.ok) errors.push(`artifact_test_failed:${test.name}`);
    if (!test.reportRef) errors.push(`artifact_test_report_ref_required:${test.name}`);
    if (refForbidden(test.reportRef)) errors.push(`artifact_test_report_ref_forbidden:${test.name}`);
  }

  evaluateReason(artifact, errors);
  evaluateEvalPlan(artifact, errors);
  evaluateRollbackPlan(artifact, errors);
  evaluateProvenance(artifact, errors);
  evaluateSignature(artifact, errors);
  evaluateCost(artifact, errors);
  evaluateClaims(artifact, errors);
  evaluateValidator(artifact, errors);
  evaluateSafety(artifact, errors);

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: NOE_CANDIDATE_PATCH_ARTIFACT_SCHEMA_VERSION,
    id,
    kind,
    errors: uniqueErrors,
    warnings,
    gates: {
      identity: hasText(id) && kind === NOE_CANDIDATE_PATCH_ARTIFACT_KIND,
      requiredRefs: hasText(artifact.parentRef) && (hasText(artifact.diffRef) || hasText(artifact.patchPlanRef)) && blockedRefs.length === 0,
      dryRunOnly: artifact.safety?.dryRunOnly === true && artifact.safety?.realExecute === false,
      nonCoreWhitelist: operations.length > 0 && operations.every((operation) => operation.errors.length === 0),
      scopeLimited: isPlainObject(artifact.scope)
        && scope.nonCoreOnly === true
        && scopeMetrics.consistent
        && scopeMetrics.maxFiles <= MAX_CHANGED_FILES
        && scopeMetrics.maxLines <= MAX_CHANGED_LINES
        && scopeMetrics.maxBytes <= MAX_DIFF_BYTES,
      tests: tests.length > 0 && tests.every((test) => test.ok && test.reportRef && !refForbidden(test.reportRef)),
      rollback: isPlainObject(artifact.rollbackPlan) && artifact.rollbackPlan?.reversible === true,
      holdoutNotAccessed: HOLDOUT_STATUSES.has(holdout) && artifact.safety?.privateHoldoutRead !== true,
      noExecutionOrWrites: artifact.safety?.patchExecutorEnabled === false
        && artifact.safety?.executorEnabled === false
        && artifact.safety?.writesRepoFiles === false
        && artifact.safety?.runtimeRestart === false
        && artifact.safety?.runtimePortTouch === false
        && artifact.safety?.memoryV2Write === false,
    },
    summary: {
      operationCount: operations.length,
      targetPaths: operations.map((operation) => operation.path).filter(Boolean),
      testCount: tests.length,
      holdoutStatus: holdout,
      evidenceRefCount: refs.length,
      maxChangedFiles: MAX_CHANGED_FILES,
      maxChangedLines: MAX_CHANGED_LINES,
      maxDiffBytes: MAX_DIFF_BYTES,
      allowedTargets: NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1,
    },
  };
}

/**
 * Builds a report for a list of Noe candidate patch artifacts.
 * @param {Object[]} [artifacts=[]] - List of artifact objects to evaluate.
 * @param {Object} [options={}] - Report options.
 * @param {string} [options.generatedAt] - ISO timestamp for report generation.
 * @param {string} [options.inputRef] - Reference identifier for the input.
 * @returns {{ ok: boolean, schemaVersion: string, validatorVersion: string, generatedAt: string, inputRef: string, policy: Object, counts: Object, results: Object[] }} Report object.
 */
export function buildNoeCandidatePatchArtifactReport(artifacts = [], {
  generatedAt = new Date().toISOString(),
  inputRef = 'unknown',
} = {}) {
  const results = arr(artifacts).map((artifact) => evaluateNoeCandidatePatchArtifact(artifact));
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    schemaVersion: NOE_CANDIDATE_PATCH_ARTIFACT_SCHEMA_VERSION,
    validatorVersion: NOE_CANDIDATE_PATCH_VALIDATOR_VERSION,
    generatedAt,
    inputRef: safeRef(inputRef, 500),
    policy: {
      dryRunOnly: true,
      doesNotCallPatchApplyExecutor: true,
      doesNotCommitOrPush: true,
      doesNotRestartRuntime51835: true,
      doesNotWriteMemoryV2: true,
      artifactBodiesForbidden: [...BODY_KEYS],
      limits: {
        changedFiles: MAX_CHANGED_FILES,
        changedLines: MAX_CHANGED_LINES,
        diffBytes: MAX_DIFF_BYTES,
      },
      forbiddenZones: {
        exact: [...FORBIDDEN_EXACT, ...FORBIDDEN_EXACT_TARGETS],
        prefixes: FORBIDDEN_PREFIXES,
        patterns: [String(FORBIDDEN_TARGET_PATTERN_RE)],
      },
      allowedTargets: NOE_CANDIDATE_PATCH_ALLOWED_TARGETS_V1,
    },
    counts: {
      artifacts: results.length,
      passed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
    },
    results,
  };
}
