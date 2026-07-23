// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_SKILL_CANDIDATE_GATE_SCHEMA_VERSION = 1;

const TYPES = new Set(['memory', 'skill']);
const HOLDOUT_STATUSES = new Set(['not_accessed', 'structure_only', 'passed']);
const BLOCKED_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const DANGEROUS_UNKNOWN_KEYS = new Set([
  'apply',
  'commit',
  'commands',
  'command',
  'diff',
  'executorEnabled',
  'hotReload',
  'memoryWriteback',
  'packageScriptsTouched',
  'patch',
  'patchExecutorEnabled',
  'privateHoldoutRead',
  'publish',
  'push',
  'rawDiff',
  'realExecute',
  'runtimePortTouch',
  'secretAccess',
  'skillReload',
  'skillStoreWrite',
  'writesRepoFiles',
]);

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
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

function refBlocked(ref) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  return Boolean(text && (
    text.startsWith('/')
    || text.startsWith('../')
    || text.includes('/../')
    || /^file:/i.test(text)
    || decoded.startsWith('/')
    || decoded.startsWith('../')
    || decoded.includes('/../')
    || /^file:/i.test(decoded)
    || BLOCKED_REF_RE.test(text)
    || BLOCKED_REF_RE.test(decoded)
  ));
}

function collectRefs(candidate = {}) {
  const refs = [
    ...arr(candidate.evidenceRefs),
    ...arr(candidate.sourceEventIds),
    candidate.sourceEpisodeRef,
    candidate.sourceReportRef,
    candidate.rollbackRef,
    candidate.rollback?.planRef,
    candidate.rollback?.snapshotRef,
    candidate.privateHoldout?.reportRef,
    candidate.privateHoldout?.resultRef,
    candidate.holdout?.reportRef,
  ];
  for (const test of arr(candidate.tests ?? candidate.testResults)) {
    refs.push(test?.reportRef, test?.evidenceRef);
  }
  return refs.map((ref) => safeRef(ref)).filter(Boolean);
}

function sourceEpisodeId(candidate = {}) {
  return clean(candidate.sourceEpisodeId
    ?? candidate.source_episode_id
    ?? candidate.source?.episodeId
    ?? candidate.provenance?.sourceEpisodeId, 240);
}

function evidenceRefs(candidate = {}) {
  return arr(candidate.evidenceRefs ?? candidate.evidence_refs)
    .map((ref) => safeRef(ref))
    .filter(Boolean)
    .slice(0, 30);
}

function testResults(candidate = {}) {
  return arr(candidate.tests ?? candidate.testResults)
    .map((test) => ({
      name: clean(test?.name || test?.script || 'unnamed', 160) || 'unnamed',
      ok: test?.ok === true,
      reportRef: safeRef(test?.reportRef || test?.evidenceRef, 500),
    }))
    .slice(0, 50);
}

function rollbackEvidence(candidate = {}) {
  const plan = arr(candidate.rollbackPlan)
    .map((item) => clean(item, 500))
    .filter(Boolean);
  const ref = safeRef(candidate.rollbackRef || candidate.rollback?.planRef || candidate.rollback?.snapshotRef, 500);
  return { ok: plan.length > 0 || hasText(ref), planCount: plan.length, ref };
}

function holdoutResult(candidate = {}) {
  const raw = candidate.privateHoldout ?? candidate.private_holdout ?? candidate.holdout ?? {};
  const status = clean(raw.status || raw.result || '', 80);
  return {
    status,
    ok: HOLDOUT_STATUSES.has(status),
    reportRef: safeRef(raw.reportRef || raw.resultRef, 500),
    reason: clean(raw.reason || raw.note || '', 240),
    accessedPrivateHoldout: raw.accessedPrivateHoldout === true || raw.privateHoldoutRead === true,
  };
}

function directWrites(candidate = {}) {
  return arr(candidate.directWrites)
    .map((item) => clean(item, 160))
    .filter(Boolean)
    .slice(0, 30);
}

function sourceInputDangerousFields(candidate = {}) {
  return arr(candidate.sourceInputDangerousFields)
    .map((item) => clean(item, 240).replace(/[^A-Za-z0-9._:-]+/g, '.').replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .slice(0, 50);
}

function add(errors, condition, id) {
  if (!condition) errors.push(id);
}

function dangerousValuePresent(value) {
  if (value === false || value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateDangerousUnknownKeys(candidate = {}, errors = []) {
  for (const key of Object.keys(candidate)) {
    if (DANGEROUS_UNKNOWN_KEYS.has(key) && dangerousValuePresent(candidate[key])) {
      errors.push(`candidate_dangerous_unknown_field_forbidden:${key}`);
    }
  }
}

function evaluateGlobalForbidden(candidate, errors) {
  evaluateDangerousUnknownKeys(candidate, errors);
  for (const field of sourceInputDangerousFields(candidate)) {
    errors.push(`candidate_source_input_dangerous_field_forbidden:${field}`);
  }
  if (candidate.writesMemoryV2 === true || candidate.memoryV2Writes === true || candidate.writesMemoryV2Log === true) {
    errors.push('candidate_memory_v2_write_forbidden');
  }
  if (candidate.liveAction === true || candidate.actionExecution === true || candidate.executesAction === true) {
    errors.push('candidate_live_action_forbidden');
  }
  if (candidate.runtimeHook === true || candidate.installRuntimeHook === true) {
    errors.push('candidate_runtime_hook_forbidden');
  }
  if (candidate.restart51835 === true || candidate.runtimeRestart === true || candidate.restartsRuntime === true) {
    errors.push('candidate_runtime_restart_forbidden');
  }
  if (candidate.selfCodeExecution === true || candidate.selfCode === true) {
    errors.push('candidate_self_code_forbidden');
  }
  for (const item of directWrites(candidate)) {
    if (/memory-v2|memoryv2|51835|runtime\s*restart|restart|live\s*action|self-code|self_code/i.test(item)) {
      errors.push('candidate_direct_write_forbidden');
      break;
    }
  }
}

function evaluateTypeSpecific(candidate, type, errors) {
  if (type === 'memory') {
    if (candidate.writesMemoryCore === true || candidate.writesProductionMemoryCore === true) {
      errors.push('memory_candidate_must_not_write_memory_core');
    }
    if (directWrites(candidate).some((item) => /MemoryCore|noe_memory\b/i.test(item))) {
      errors.push('memory_candidate_direct_write_forbidden');
    }
  }
  if (type === 'skill') {
    if (candidate.writesSkillStore === true) errors.push('skill_candidate_must_not_write_skill_store');
    if (candidate.hotLoadSkill === true || candidate.hotLoad === true) errors.push('skill_candidate_hot_load_forbidden');
    if (candidate.enabled === true || candidate.skill?.enabled === true || candidate.skillWrite?.enabled === true) {
      errors.push('skill_candidate_must_stay_disabled');
    }
    if (directWrites(candidate).some((item) => /SkillStore|\.noe-panel\/skills|skills\//i.test(item))) {
      errors.push('skill_candidate_direct_write_forbidden');
    }
  }
}

export function evaluateNoeMemorySkillCandidateGate(candidate = {}, {
  requirePassedHoldout = false,
} = {}) {
  const errors = [];
  const warnings = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      ok: false,
      schemaVersion: NOE_MEMORY_SKILL_CANDIDATE_GATE_SCHEMA_VERSION,
      errors: ['candidate_must_be_object'],
      warnings,
      gates: {},
    };
  }
  const type = clean(candidate.type || candidate.kind, 80);
  const candidateId = clean(candidate.candidateId, 180);
  const srcEpisode = sourceEpisodeId(candidate);
  const refs = evidenceRefs(candidate);
  const tests = testResults(candidate);
  const rollback = rollbackEvidence(candidate);
  const holdout = holdoutResult(candidate);
  const blockedRefs = collectRefs(candidate).filter(refBlocked);

  add(errors, TYPES.has(type), `candidate_type_unknown:${type || 'blank'}`);
  add(errors, hasText(candidateId), 'candidate_id_required');
  add(errors, hasText(srcEpisode), 'candidate_source_episode_required');
  add(errors, refs.length > 0, 'candidate_evidence_refs_required');
  if (blockedRefs.length) errors.push('candidate_ref_forbidden');
  add(errors, tests.length > 0, 'candidate_tests_required');
  for (const test of tests) {
    if (!test.ok) errors.push(`candidate_test_failed:${test.name}`);
    if (!test.reportRef) errors.push(`candidate_test_report_ref_required:${test.name}`);
  }
  add(errors, rollback.ok, 'candidate_rollback_plan_required');
  add(errors, holdout.ok, 'candidate_private_holdout_result_required');
  if (holdout.accessedPrivateHoldout) errors.push('candidate_private_holdout_read_forbidden');
  if (requirePassedHoldout && holdout.status !== 'passed') errors.push(`candidate_private_holdout_pass_required:${holdout.status || 'blank'}`);
  evaluateGlobalForbidden(candidate, errors);
  evaluateTypeSpecific(candidate, type, errors);

  return {
    ok: errors.length === 0,
    schemaVersion: NOE_MEMORY_SKILL_CANDIDATE_GATE_SCHEMA_VERSION,
    candidateId,
    type,
    errors,
    warnings,
    gates: {
      identity: hasText(candidateId) && TYPES.has(type),
      sourceEpisode: hasText(srcEpisode),
      evidenceRefs: refs.length > 0 && blockedRefs.length === 0,
      tests: tests.length > 0 && tests.every((test) => test.ok && test.reportRef),
      rollback: rollback.ok,
      privateHoldout: holdout.ok && !holdout.accessedPrivateHoldout && (!requirePassedHoldout || holdout.status === 'passed'),
      noProductionWrite: !errors.some((error) => /write|hot_load|disabled/.test(error)),
    },
    summary: {
      evidenceRefCount: refs.length,
      testCount: tests.length,
      rollbackPlanCount: rollback.planCount,
      rollbackRef: rollback.ref,
      privateHoldoutStatus: holdout.status,
      directWrites: directWrites(candidate),
    },
  };
}

export function buildNoeMemorySkillCandidateGateReport(candidates = [], {
  generatedAt = new Date().toISOString(),
  requirePassedHoldout = false,
  inputRef = '',
} = {}) {
  const list = arr(candidates);
  const results = list.map((candidate) => evaluateNoeMemorySkillCandidateGate(candidate, { requirePassedHoldout }));
  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    schemaVersion: NOE_MEMORY_SKILL_CANDIDATE_GATE_SCHEMA_VERSION,
    generatedAt,
    inputRef: safeRef(inputRef, 500),
    policy: {
      candidateOnly: true,
      noMemoryCoreWrite: true,
      noSkillStoreWrite: true,
      noSkillHotLoad: true,
      privateHoldoutRead: false,
      noLiveAction: true,
      noRuntimeRestart: true,
      noMemoryV2Write: true,
      requirePassedHoldout,
    },
    counts: {
      candidates: list.length,
      passed: results.filter((result) => result.ok).length,
      failed: failed.length,
      memory: results.filter((result) => result.type === 'memory').length,
      skill: results.filter((result) => result.type === 'skill').length,
    },
    results,
  };
}
