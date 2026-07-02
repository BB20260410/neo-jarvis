// @ts-check
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../NoeContextScrubber.js';

export const NOE_MISSION_SCHEMA_VERSION = 1;

export const NOE_MISSION_STATUSES = new Set([
  'running',
  'recovering',
  'waiting_approval',
  'blocked',
  'paused',
  'cancelled',
  'succeeded',
]);

export const NOE_MISSION_AUTONOMY_LEVELS = new Set([
  'read_only',
  'local_write',
  'live_write',
  'external_write',
]);

export const NOE_MISSION_LEADERS = new Set(['cloud', 'local', 'owner']);
export const NOE_MISSION_EXECUTORS = new Set(['local']);
export const NOE_MISSION_REVIEWERS = new Set(['local_review', 'cloud_review']);
export const NOE_MISSION_CLOUD_CONTEXT_POLICIES = new Set(['redacted_brief', 'selected_files', 'full_project_allowed']);
export const NOE_MISSION_PATCH_AUTHORITIES = new Set(['plan_only', 'generate_patch', 'request_apply']);
export const NOE_MISSION_LOCAL_AUTONOMY_MODES = new Set(['observe', 'verify', 'apply', 'repair', 'resume']);

const REQUIRED_FIELDS = [
  'objective',
  'scope',
  'forbidden',
  'completionCriteria',
  'evidenceRequirements',
  'rollbackPlan',
  'autonomyLevel',
  'reviewPolicy',
  'expectedArtifacts',
];

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

export function safeMissionId(value = '') {
  return clean(value, 160).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

function safeValue(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return clean(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => safeValue(item, depth + 1));
  if (typeof value !== 'object') return clean(value, 500);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const k = clean(key, 160);
    out[k] = /secret|token|key|password|authorization|cookie/i.test(k) ? '[redacted]' : safeValue(item, depth + 1);
  }
  return out;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeValue(item)).filter((item) => item != null && String(item).trim() !== '');
}

function normalizeObjectList(value) {
  return normalizeList(value).map((item, index) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return { id: clean(item.id || `item-${index + 1}`, 160), ...item };
    }
    return { id: `item-${index + 1}`, description: clean(item, 1000) };
  });
}

function pickEnum(value, allowed, fallback, max = 80) {
  const cleaned = clean(value || fallback, max);
  return allowed.has(cleaned) ? cleaned : fallback;
}

function normalizeReviewers(value) {
  return normalizeList(value)
    .map((item) => clean(item, 80))
    .filter((item) => NOE_MISSION_REVIEWERS.has(item));
}

export function normalizeMissionContract(input = {}, deps = {}) {
  const at = new Date(Number(deps.nowMs || Date.now())).toISOString();
  const missionId = safeMissionId(input.missionId || input.id || `mission-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const autonomyLevel = clean(input.autonomyLevel || 'read_only', 80);
  return {
    schemaVersion: NOE_MISSION_SCHEMA_VERSION,
    missionId,
    objective: clean(input.objective, 8000),
    scope: normalizeList(input.scope),
    forbidden: normalizeList(input.forbidden),
    completionCriteria: normalizeObjectList(input.completionCriteria),
    evidenceRequirements: normalizeObjectList(input.evidenceRequirements),
    rollbackPlan: normalizeList(input.rollbackPlan),
    autonomyLevel: NOE_MISSION_AUTONOMY_LEVELS.has(autonomyLevel) ? autonomyLevel : 'read_only',
    leader: pickEnum(input.leader, NOE_MISSION_LEADERS, 'local'),
    executor: pickEnum(input.executor, NOE_MISSION_EXECUTORS, 'local'),
    reviewers: normalizeReviewers(input.reviewers),
    cloudContextPolicy: pickEnum(input.cloudContextPolicy, NOE_MISSION_CLOUD_CONTEXT_POLICIES, 'redacted_brief'),
    patchAuthority: pickEnum(input.patchAuthority, NOE_MISSION_PATCH_AUTHORITIES, 'plan_only'),
    localAutonomy: pickEnum(input.localAutonomy, NOE_MISSION_LOCAL_AUTONOMY_MODES, 'observe'),
    reviewPolicy: safeValue(input.reviewPolicy || {}),
    expectedArtifacts: normalizeObjectList(input.expectedArtifacts),
    plan: normalizeObjectList(input.plan || input.actions || []),
    metadata: safeValue(input.metadata || {}),
    createdAt: input.createdAt || at,
    updatedAt: at,
  };
}

export function validateMissionContract(contract = {}) {
  const errors = [];
  if (contract.schemaVersion !== NOE_MISSION_SCHEMA_VERSION) errors.push('unsupported_mission_schema_version');
  for (const field of REQUIRED_FIELDS) {
    if (contract[field] == null) errors.push(`mission_${field}_required`);
  }
  if (!clean(contract.missionId, 160)) errors.push('mission_id_required');
  if (!clean(contract.objective, 8000)) errors.push('mission_objective_required');
  for (const field of ['scope', 'forbidden', 'completionCriteria', 'evidenceRequirements', 'rollbackPlan', 'expectedArtifacts']) {
    if (!Array.isArray(contract[field]) || contract[field].length === 0) errors.push(`mission_${field}_non_empty_required`);
  }
  if (!NOE_MISSION_AUTONOMY_LEVELS.has(contract.autonomyLevel)) errors.push(`mission_autonomy_invalid:${contract.autonomyLevel}`);
  if (!NOE_MISSION_LEADERS.has(contract.leader)) errors.push(`mission_leader_invalid:${contract.leader}`);
  if (!NOE_MISSION_EXECUTORS.has(contract.executor)) errors.push(`mission_executor_invalid:${contract.executor}`);
  if (!Array.isArray(contract.reviewers)) errors.push('mission_reviewers_array_required');
  for (const reviewer of contract.reviewers || []) {
    if (!NOE_MISSION_REVIEWERS.has(reviewer)) errors.push(`mission_reviewer_invalid:${reviewer}`);
  }
  if (!NOE_MISSION_CLOUD_CONTEXT_POLICIES.has(contract.cloudContextPolicy)) {
    errors.push(`mission_cloud_context_policy_invalid:${contract.cloudContextPolicy}`);
  }
  if (!NOE_MISSION_PATCH_AUTHORITIES.has(contract.patchAuthority)) errors.push(`mission_patch_authority_invalid:${contract.patchAuthority}`);
  if (!NOE_MISSION_LOCAL_AUTONOMY_MODES.has(contract.localAutonomy)) errors.push(`mission_local_autonomy_invalid:${contract.localAutonomy}`);
  for (const criterion of contract.completionCriteria || []) {
    if (!clean(criterion.id, 160)) errors.push('mission_criterion_id_required');
    if (!clean(criterion.type || criterion.description, 500)) errors.push(`mission_criterion_type_or_description_required:${criterion.id || 'unknown'}`);
  }
  for (const requirement of contract.evidenceRequirements || []) {
    if (!clean(requirement.id, 160)) errors.push('mission_evidence_id_required');
    if (!clean(requirement.ref || requirement.path || requirement.description, 1000)) {
      errors.push(`mission_evidence_ref_or_description_required:${requirement.id || 'unknown'}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function requireValidMissionContract(input = {}, deps = {}) {
  const contract = normalizeMissionContract(input, deps);
  const validation = validateMissionContract(contract);
  if (!validation.ok) {
    const error = new Error(`invalid mission contract: ${validation.errors.join(', ')}`);
    error.validation = validation;
    throw error;
  }
  return contract;
}
