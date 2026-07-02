// @ts-check
// SelfTalkOutcome — P6-A0 contract for self-talk side effects.
//
// This module is intentionally pure. It gives inner self-talk a proposal id,
// explicit commit/landing/delivery states, and an audit snapshot that can be
// stored without leaking owner-private prompt text.

import { randomUUID } from 'node:crypto';

export const SELF_TALK_STREAM_TYPE = 'self_talk';

export const LANDING_TYPES = Object.freeze([
  'expectation',
  'commitment',
  'goal',
  'memory',
  'awareness',
  'silent',
]);

export const DELIVERY_STATUSES = Object.freeze([
  'not_attempted',
  'queued',
  'synthesized',
  'played_to_user_confirmed',
  'tts_failed',
  'play_failed',
]);

export const DELIVERY_CONFIRMATION_SOURCES = Object.freeze([
  'telemetry',
  'manual_evidence',
]);

export const AUDIT_REDACTION_POLICIES = Object.freeze([
  'strict',
  'default',
  'minimal',
  'none',
]);

const RAW_METRIC_KEYS = Object.freeze([
  'semanticSim',
  'groundingScore',
  'abstractDensity',
  'recentSelfTalkRatio',
  'landingStreak',
]);

/**
 * @typedef {object} SelfTalkProposal
 * @property {string} proposalId
 * @property {string} thought
 * @property {number} generatedAt
 * @property {'self_talk'} streamType
 * @property {string|null} anchorRef
 * @property {Record<string, number|null>} rawMetrics
 * @property {string|null} guardDecision
 * @property {boolean} wouldBlock
 */

/**
 * @typedef {object} SelfTalkCommitResult
 * @property {string} proposalId
 * @property {boolean} committed
 * @property {string|null} blockedReason
 * @property {number|null} committedAt
 * @property {string|number|null} eventId
 */

/**
 * @typedef {object} SelfTalkDelivery
 * @property {'not_attempted'|'queued'|'synthesized'|'played_to_user_confirmed'|'tts_failed'|'play_failed'} status
 * @property {number|null} confirmedAt
 * @property {'telemetry'|'manual_evidence'|null} confirmationSource
 */

/**
 * @typedef {object} SelfTalkLandingEffect
 * @property {string} proposalId
 * @property {'expectation'|'commitment'|'goal'|'memory'|'awareness'|'silent'} type
 * @property {string|null} targetId
 * @property {number} at
 * @property {SelfTalkDelivery} delivery
 */

/**
 * @typedef {object} SelfTalkOutcome
 * @property {SelfTalkProposal} proposal
 * @property {SelfTalkCommitResult} commit
 * @property {SelfTalkLandingEffect|null} landing
 * @property {{scheduled:boolean, inFlight:boolean, proposalId:string}} heartbeatLedger
 */

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function toMs(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`${field} must be a non-negative timestamp`);
  return n;
}

function normalizeRawMetrics(rawMetrics = {}) {
  const normalized = {};
  for (const key of RAW_METRIC_KEYS) {
    const value = rawMetrics?.[key];
    normalized[key] = Number.isFinite(Number(value)) ? Number(value) : null;
  }
  return Object.freeze(normalized);
}

/** @param {string} status */
export function isStrongDeliveryStatus(status) {
  return status === 'played_to_user_confirmed';
}

export function createSelfTalkDelivery({
  status = 'not_attempted',
  confirmedAt = null,
  confirmationSource = null,
} = {}) {
  const normalizedStatus = /** @type {SelfTalkDelivery['status']} */ (assertOneOf(status, DELIVERY_STATUSES, 'delivery.status'));
  if (normalizedStatus === 'played_to_user_confirmed') {
    if (confirmedAt == null) throw new TypeError('delivery.confirmedAt is required when playback is confirmed');
    assertOneOf(confirmationSource, DELIVERY_CONFIRMATION_SOURCES, 'delivery.confirmationSource');
  }
  return Object.freeze({
    status: normalizedStatus,
    confirmedAt: confirmedAt == null ? null : toMs(confirmedAt, 'delivery.confirmedAt'),
    confirmationSource: confirmationSource == null ? null : /** @type {SelfTalkDelivery['confirmationSource']} */ (assertOneOf(confirmationSource, DELIVERY_CONFIRMATION_SOURCES, 'delivery.confirmationSource')),
  });
}

export function createSelfTalkProposal({
  proposalId = randomUUID(),
  thought = '',
  generatedAt = Date.now(),
  anchorRef = null,
  rawMetrics = {},
  guardDecision = null,
  wouldBlock = false,
} = {}) {
  return Object.freeze({
    proposalId: assertNonEmptyString(proposalId, 'proposalId'),
    thought: String(thought || ''),
    generatedAt: toMs(generatedAt, 'generatedAt'),
    streamType: SELF_TALK_STREAM_TYPE,
    anchorRef: anchorRef == null ? null : String(anchorRef),
    rawMetrics: normalizeRawMetrics(rawMetrics),
    guardDecision: guardDecision == null ? null : String(guardDecision),
    wouldBlock: wouldBlock === true,
  });
}

export function createSelfTalkCommitResult({
  proposalId,
  committed = false,
  blockedReason = null,
  committedAt = committed ? Date.now() : null,
  eventId = null,
} = {}) {
  return Object.freeze({
    proposalId: assertNonEmptyString(proposalId, 'proposalId'),
    committed: committed === true,
    blockedReason: blockedReason == null ? null : String(blockedReason),
    committedAt: committedAt == null ? null : toMs(committedAt, 'committedAt'),
    eventId: eventId == null ? null : eventId,
  });
}

export function createSelfTalkLandingEffect({
  proposalId,
  type,
  targetId = null,
  at = Date.now(),
  delivery = {},
} = {}) {
  return Object.freeze({
    proposalId: assertNonEmptyString(proposalId, 'proposalId'),
    type: /** @type {SelfTalkLandingEffect['type']} */ (assertOneOf(type, LANDING_TYPES, 'landing.type')),
    targetId: targetId == null ? null : String(targetId),
    at: toMs(at, 'landing.at'),
    delivery: createSelfTalkDelivery(delivery),
  });
}

export function createSelfTalkOutcome({
  proposal,
  commit,
  landing = null,
  heartbeatLedger = {},
} = {}) {
  if (!proposal?.proposalId) throw new TypeError('proposal is required');
  if (!commit?.proposalId) throw new TypeError('commit is required');
  if (proposal.proposalId !== commit.proposalId) throw new TypeError('proposalId mismatch between proposal and commit');
  if (landing && landing.proposalId !== proposal.proposalId) throw new TypeError('proposalId mismatch between proposal and landing');

  return Object.freeze({
    proposal,
    commit,
    landing,
    heartbeatLedger: Object.freeze({
      proposalId: proposal.proposalId,
      scheduled: heartbeatLedger.scheduled === true,
      inFlight: heartbeatLedger.inFlight === true,
    }),
  });
}

export function createAuditSnapshot(outcome, { redactionPolicy = 'strict' } = {}) {
  assertOneOf(redactionPolicy, AUDIT_REDACTION_POLICIES, 'redactionPolicy');
  const proposal = outcome?.proposal;
  if (!proposal?.proposalId) throw new TypeError('outcome.proposal is required');
  const includeText = redactionPolicy === 'none';

  return Object.freeze({
    proposalId: proposal.proposalId,
    streamType: proposal.streamType,
    redactionPolicy,
    auditTextPersisted: includeText,
    thought: includeText ? proposal.thought : null,
    anchorRefPresent: Boolean(proposal.anchorRef),
    rawMetrics: proposal.rawMetrics,
    guardDecision: proposal.guardDecision,
    wouldBlock: proposal.wouldBlock,
    commit: outcome.commit,
    landing: outcome.landing ? {
      type: outcome.landing.type,
      targetIdPresent: Boolean(outcome.landing.targetId),
      at: outcome.landing.at,
      delivery: outcome.landing.delivery,
    } : null,
    heartbeatLedger: outcome.heartbeatLedger,
  });
}
