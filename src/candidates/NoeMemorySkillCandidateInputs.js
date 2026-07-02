// @ts-check

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_SKILL_CANDIDATE_INPUTS_SCHEMA_VERSION = 1;

const SENSITIVE_REF_RE = /(^|\/)(?:\.env(?:$|[./_-][^/]*)?|\.npmrc|\.netrc|owner[-_]?token(?:\.txt)?|ownertoken(?:\.txt)?|room-adapters\.json|.*secret.*|.*token.*|.*cookie.*|.*oauth.*|evals\/neo\/private_holdout)(?:\/|$)/i;
const DANGEROUS_SOURCE_KEYS = new Set([
  'actionExecution',
  'apply',
  'command',
  'commands',
  'commit',
  'directWrites',
  'executesAction',
  'executorEnabled',
  'hotLoad',
  'hotLoadSkill',
  'installRuntimeHook',
  'liveAction',
  'memoryV2Writes',
  'memoryWriteback',
  'patch',
  'patchApplied',
  'patchExecutorEnabled',
  'privateHoldoutRead',
  'publish',
  'push',
  'realExecute',
  'restart51835',
  'restartsRuntime',
  'runtimeHook',
  'runtimePortTouch',
  'runtimeRestart',
  'secretAccess',
  'selfCode',
  'selfCodeExecution',
  'skillHotLoad',
  'skillReload',
  'skillStoreWrite',
  'writesMemoryV2',
  'writesMemoryV2Log',
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

function isInside(root, ref) {
  const full = resolve(root, ref);
  const rel = relative(root, full);
  return Boolean(rel && rel !== '..' && !rel.startsWith('..') && !rel.startsWith('/'));
}

function insidePath(root, file) {
  const rel = relative(root, file).replaceAll('\\', '/');
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'));
}

function nearestExistingPath(file) {
  let current = file;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function validateInputRef(root, ref) {
  const text = safeRef(ref);
  const decoded = decodeRef(text);
  if (!text) return 'input_ref_required';
  if (/^file:/i.test(text) || /^file:/i.test(decoded)) return 'input_ref_forbidden_scheme';
  if (SENSITIVE_REF_RE.test(text) || SENSITIVE_REF_RE.test(decoded)) return 'sensitive_input_ref_forbidden';
  if (!isInside(root, decoded)) return 'input_ref_outside_root';
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  const file = resolve(root, decoded);
  const existingPath = existsSync(file) ? file : nearestExistingPath(file);
  if (existsSync(existingPath) && lstatSync(existingPath).isSymbolicLink()) return 'input_ref_symlink_forbidden';
  if (existsSync(existingPath) && !insidePath(rootReal, realpathSync(existingPath))) return 'input_ref_realpath_outside_root';
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) return 'input_ref_symlink_forbidden';
    if (!insidePath(rootReal, realpathSync(file))) return 'input_ref_realpath_outside_root';
  }
  return '';
}

function readJsonl(root, ref) {
  const error = validateInputRef(root, ref);
  if (error) {
    return { records: [], errors: [{ ref, error }] };
  }
  const file = resolve(root, decodeRef(ref));
  if (!existsSync(file)) return { records: [], errors: [] };
  const records = [];
  const errors = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      errors.push({ ref, line: index + 1, error: 'json_parse_failed' });
    }
  });
  return { records, errors };
}

function normalizeTests(value) {
  return arr(value).map((test) => ({
    name: clean(test?.name || test?.script || 'candidate-test', 160),
    ok: test?.ok === true,
    reportRef: safeRef(test?.reportRef || test?.evidenceRef, 500),
  }));
}

function normalizeHoldout(value) {
  const holdout = value && typeof value === 'object' ? value : {};
  return {
    status: clean(holdout.status || holdout.result || '', 80),
    reportRef: safeRef(holdout.reportRef || holdout.resultRef, 500),
    reason: clean(holdout.reason || holdout.note || '', 240),
    accessedPrivateHoldout: holdout.accessedPrivateHoldout === true || holdout.privateHoldoutRead === true,
  };
}

function dangerousValuePresent(value) {
  if (value === false || value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function cleanFieldPath(value) {
  return clean(value, 240).replace(/[^A-Za-z0-9._:-]+/g, '.').replace(/^\.+|\.+$/g, '');
}

function collectDangerousSourceFields(value, prefix = '', depth = 0, out = []) {
  if (depth > 5 || !value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (DANGEROUS_SOURCE_KEYS.has(key) && dangerousValuePresent(item)) {
      const safeField = cleanFieldPath(field);
      if (safeField && !out.includes(safeField)) out.push(safeField);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      collectDangerousSourceFields(item, field, depth + 1, out);
    }
  }
  return out;
}

export function memoryPendingToGateCandidate(record = {}) {
  return {
    candidateId: clean(record.candidateId || record.id, 180),
    type: 'memory',
    sourceEpisodeId: clean(record.sourceEpisodeId || record.source_episode_id || record.source?.episodeId, 240),
    evidenceRefs: arr(record.evidenceRefs || record.evidence_refs).map((ref) => safeRef(ref)).filter(Boolean),
    tests: normalizeTests(record.tests || record.testResults),
    rollbackPlan: arr(record.rollbackPlan).map((item) => clean(item, 500)).filter(Boolean),
    rollbackRef: safeRef(record.rollbackRef || record.rollback?.planRef, 500),
    privateHoldout: normalizeHoldout(record.privateHoldout || record.private_holdout || record.holdout),
    writesMemoryCore: record.writesMemoryCore === true || record.writesProductionMemoryCore === true,
    directWrites: arr(record.directWrites).map((item) => clean(item, 160)).filter(Boolean),
    sourceInputDangerousFields: collectDangerousSourceFields(record),
  };
}

function rawItem(record = {}) {
  const raw = record.proposal?.raw;
  if (raw?.item && typeof raw.item === 'object') return raw.item;
  if (raw && typeof raw === 'object') return raw;
  return {};
}

export function skillDraftQueueToGateCandidate(record = {}) {
  const item = rawItem(record);
  return {
    candidateId: clean(record.candidateId || record.proposal?.proposalId || record.executionKey, 180),
    type: 'skill',
    sourceEpisodeId: clean(record.sourceEpisodeId || record.source_episode_id || item.sourceEpisodeId || record.proposal?.sourceEpisodeId, 240),
    evidenceRefs: [
      safeRef(record.proposal?.sourceReportRef, 500),
      ...arr(record.evidenceRefs || item.evidenceRefs).map((ref) => safeRef(ref)),
    ].filter(Boolean),
    tests: normalizeTests(record.tests || item.tests || record.testResults),
    rollbackPlan: arr(record.rollbackPlan || item.rollbackPlan).map((value) => clean(value, 500)).filter(Boolean),
    rollbackRef: safeRef(record.rollbackRef || item.rollbackRef, 500),
    privateHoldout: normalizeHoldout(record.privateHoldout || item.privateHoldout || record.holdout),
    writesSkillStore: record.writesSkillStore === true,
    hotLoadSkill: record.hotLoadSkill === true || item.hotLoadSkill === true,
    enabled: record.enabled === true || item.enabled === true,
    directWrites: arr(record.directWrites).map((itemValue) => clean(itemValue, 160)).filter(Boolean),
    sourceInputDangerousFields: collectDangerousSourceFields(record),
  };
}

export function loadNoeMemorySkillCandidateInputs({
  root = process.cwd(),
  memoryPendingRef = 'output/noe-memory-candidates/pending.jsonl',
  skillDraftQueueRef = 'output/noe-proposal-executions/queues/skill-drafts.jsonl',
} = {}) {
  const rootAbs = resolve(root);
  const memory = readJsonl(rootAbs, memoryPendingRef);
  const skill = readJsonl(rootAbs, skillDraftQueueRef);
  return {
    ok: memory.errors.length === 0 && skill.errors.length === 0,
    schemaVersion: NOE_MEMORY_SKILL_CANDIDATE_INPUTS_SCHEMA_VERSION,
    refs: {
      memoryPendingRef,
      skillDraftQueueRef,
    },
    errors: [...memory.errors, ...skill.errors],
    candidates: [
      ...memory.records.map(memoryPendingToGateCandidate),
      ...skill.records.map(skillDraftQueueToGateCandidate),
    ],
    counts: {
      memoryPending: memory.records.length,
      skillDraftQueue: skill.records.length,
    },
  };
}
