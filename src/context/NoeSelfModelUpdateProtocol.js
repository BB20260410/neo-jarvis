// @ts-check
// P7-C2: proposal protocol for changing the versioned NoeSelfModel identity layer.
// Reflection may propose evidence-backed diffs; applying them still goes through
// NoeSelfModelVersionStore and owner-confirm gates for core identity fields.

import { randomUUID } from 'node:crypto';
import { normalizeSelfModelIdentity } from './NoeSelfModelVersionStore.js';

export const SELF_MODEL_PROPOSAL_SCHEMA_VERSION = 1;
export const ALLOWED_SELF_MODEL_PATCH_FIELDS = Object.freeze(['name', 'relationship', 'disposition', 'values']);
const CORE_CONFIRM_FIELDS = new Set(['name', 'relationship', 'values']);
const FORBIDDEN_FIELD = /(?:api.?key|token|secret|cookie|password|oauth|credential|authorization)/i;
const SECRET_LIKE_VALUE = /\b(?:sk|sk-cp|sk-ant|AIza|ghp|github_pat|xox[baprs]|tp-c[0-9a-z]+)[A-Za-z0-9._~+/=-]{8,}\b/i;

function cleanEvidenceRefs(refs) {
  return Array.isArray(refs) ? refs.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
}

function patchUnknownFields(patch = {}) {
  const allowed = new Set(ALLOWED_SELF_MODEL_PATCH_FIELDS);
  return Object.keys(patch).filter((key) => !allowed.has(key));
}

function patchForbiddenFields(patch = {}) {
  return Object.keys(patch).filter((key) => FORBIDDEN_FIELD.test(key));
}

function patchHasSecretLikeValue(patch = {}) {
  return SECRET_LIKE_VALUE.test(JSON.stringify(patch));
}

function requiresOwnerConfirmation(currentIdentity = {}, patch = {}) {
  for (const key of CORE_CONFIRM_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (JSON.stringify(currentIdentity?.[key] ?? null) !== JSON.stringify(patch[key] ?? null)) return true;
  }
  return false;
}

export function createSelfModelDiffProposal({
  currentIdentity = {},
  patch = {},
  reason = '',
  evidenceRefs = [],
  source = 'reflection',
  now = Date.now,
  proposalId = randomUUID(),
} = {}) {
  const normalizedPatch = normalizeSelfModelIdentity(patch);
  const blockers = [];
  for (const field of patchUnknownFields(patch)) blockers.push(`field_not_allowed:${field}`);
  for (const field of patchForbiddenFields(patch)) blockers.push(`field_forbidden:${field}`);
  if (!Object.keys(normalizedPatch).length) blockers.push('patch_empty');
  const evidence = cleanEvidenceRefs(evidenceRefs);
  if (!evidence.length) blockers.push('evidence_required');
  if (patchHasSecretLikeValue(patch)) blockers.push('secret_like_value_forbidden');
  const ownerRequired = requiresOwnerConfirmation(currentIdentity, normalizedPatch);
  return {
    schemaVersion: SELF_MODEL_PROPOSAL_SCHEMA_VERSION,
    proposalId,
    createdAt: now(),
    source: String(source || 'reflection').slice(0, 80),
    status: blockers.length ? 'blocked' : 'proposed',
    blockers,
    reason: String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    evidenceRefs: evidence,
    patch: normalizedPatch,
    requiresOwnerConfirmation: ownerRequired,
  };
}

export function applySelfModelDiffProposal({ store, proposal, ownerConfirmed = false } = {}) {
  if (!store || typeof store.writeNextVersion !== 'function') return { ok: false, reason: 'store_required' };
  if (!proposal || proposal.schemaVersion !== SELF_MODEL_PROPOSAL_SCHEMA_VERSION) return { ok: false, reason: 'invalid_proposal' };
  if (proposal.status !== 'proposed' || proposal.blockers?.length) return { ok: false, reason: 'proposal_blocked', blockers: proposal.blockers || [] };
  if (!Array.isArray(proposal.evidenceRefs) || !proposal.evidenceRefs.length) return { ok: false, reason: 'evidence_required' };
  if (proposal.requiresOwnerConfirmation && ownerConfirmed !== true) {
    return { ok: false, reason: 'owner_confirmation_required_for_identity_core', proposalId: proposal.proposalId };
  }
  const result = store.writeNextVersion({
    identity: proposal.patch,
    reason: proposal.reason,
    evidenceRefs: proposal.evidenceRefs,
    proposalId: proposal.proposalId,
    ownerConfirmed,
  });
  return result.ok ? { ...result, proposalId: proposal.proposalId } : result;
}
