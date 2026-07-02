// @ts-check
// SelfTalkAuditStore — append-only P6 audit channel with strict redaction.
//
// This is separate from the autobiographical timeline. It stores diagnostic
// decisions and numeric metrics for replay, not owner-private prompts or text.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isOwnerPerceivedDelivery } from './SelfTalkDeliveryAck.js';
import { createAuditSnapshot } from './SelfTalkOutcome.js';
import { computeSelfTalkLandingWindow } from './SelfTalkLandingPolicy.js';
import { rate } from './_mathUtils.js';

const REDACTION_POLICIES = Object.freeze(['strict', 'default', 'minimal', 'none']);
const TEXT_KEYS = new Set(['thought', 'text', 'summary', 'detail', 'body', 'content', 'prompt', 'messages']);

function assertPolicy(policy) {
  if (!REDACTION_POLICIES.includes(policy)) throw new TypeError(`redactionPolicy must be one of: ${REDACTION_POLICIES.join(', ')}`);
  return policy;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numericMetrics(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (key === 'rawCounts' && value && typeof value === 'object') {
      out.rawCounts = Object.freeze({
        selfTalk: finiteNumber(value.selfTalk),
        realExperiences: finiteNumber(value.realExperiences),
      });
      continue;
    }
    const n = finiteNumber(value);
    if (n != null) out[key] = n;
  }
  return Object.freeze(out);
}

function compactCommit(commit = null) {
  if (!commit) return null;
  return Object.freeze({
    committed: commit.committed === true,
    blockedReason: commit.blockedReason == null ? null : String(commit.blockedReason),
    committedAt: finiteNumber(commit.committedAt),
    eventIdPresent: commit.eventId != null,
  });
}

function compactLanding(landing = null) {
  if (!landing) return null;
  return Object.freeze({
    type: landing.type || null,
    targetIdPresent: landing.targetIdPresent === true || landing.targetId != null,
    at: finiteNumber(landing.at),
    delivery: landing.delivery ? Object.freeze({
      status: landing.delivery.status || 'not_attempted',
      confirmedAt: finiteNumber(landing.delivery.confirmedAt),
      confirmationSource: landing.delivery.confirmationSource || null,
    }) : null,
  });
}

function rejectUnexpectedText(record) {
  const seen = [];
  const visit = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (TEXT_KEYS.has(key) && typeof child === 'string' && child.trim()) seen.push(nextPath);
      else if (child && typeof child === 'object') visit(child, nextPath);
    }
  };
  visit(record);
  return seen;
}

export function sanitizeSelfTalkAuditRecord(record = {}, {
  redactionPolicy = 'strict',
  now = Date.now,
} = {}) {
  const policy = assertPolicy(record.redactionPolicy || redactionPolicy);
  const includeText = policy === 'none';
  const channel = record.channel === 'rumination_guard' ? 'rumination_guard' : 'self_talk_outcome';
  const unsafeTextFields = includeText ? [] : rejectUnexpectedText(record);

  const sanitized = {
    ts: finiteNumber(record.ts) ?? now(),
    channel,
    proposalId: record.proposalId ? String(record.proposalId) : null,
    streamType: record.streamType || null,
    redactionPolicy: policy,
    llmContextAllowed: false,
    auditTextPersisted: includeText && typeof record.thought === 'string',
    thought: includeText && typeof record.thought === 'string' ? record.thought : null,
    unsafeTextFieldCount: unsafeTextFields.length,
    anchorRefPresent: record.anchorRefPresent === true || record.anchorRef != null,
    rawMetrics: numericMetrics(record.rawMetrics),
    guardDecision: record.guardDecision || record.state || null,
    state: record.state || null,
    action: record.action || null,
    wouldBlock: record.wouldBlock === true,
    shadowWouldBlock: record.shadowWouldBlock === true,
    reasons: Array.isArray(record.reasons) ? record.reasons.map(String) : [],
    commit: compactCommit(record.commit),
    landing: compactLanding(record.landing),
    heartbeatLedger: record.heartbeatLedger ? Object.freeze({
      proposalId: record.heartbeatLedger.proposalId ? String(record.heartbeatLedger.proposalId) : null,
      scheduled: record.heartbeatLedger.scheduled === true,
      inFlight: record.heartbeatLedger.inFlight === true,
    }) : null,
    signalContract: record.signalContract ? Object.freeze({
      readsVad: record.signalContract.readsVad === true,
      readsRawTimeline: record.signalContract.readsRawTimeline === true,
      reason: record.signalContract.reason ? String(record.signalContract.reason) : null,
    }) : null,
  };
  return Object.freeze(sanitized);
}

export function parseSelfTalkAuditJsonl(text = '') {
  const records = [];
  let malformed = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export function summarizeSelfTalkAudit(records = [], { malformed = 0 } = {}) {
  const sanitized = records.map((record) => sanitizeSelfTalkAuditRecord(record));
  const outcomeMap = new Map();
  let anonymous = 0;
  for (const record of sanitized.filter((item) => item.channel === 'self_talk_outcome')) {
    const key = record.proposalId || `anonymous:${anonymous++}`;
    if (outcomeMap.has(key)) outcomeMap.delete(key);
    outcomeMap.set(key, record);
  }
  const outcomes = Array.from(outcomeMap.values());
  const guardRecords = sanitized.filter((record) => record.channel === 'rumination_guard');
  const landed = outcomes.filter((record) => record.landing && record.landing.type !== 'silent');
  const strongDelivered = landed.filter((record) => isOwnerPerceivedDelivery(record.landing));
  const synthesizedOnly = landed.filter((record) => record.landing?.delivery?.status === 'synthesized');
  const guardTrips = guardRecords.filter((record) => record.state && record.state !== 'normal');
  const blocked = outcomes.filter((record) => record.commit?.committed === false || record.wouldBlock);
  const landingWindow = computeSelfTalkLandingWindow(outcomes);

  return Object.freeze({
    ok: malformed === 0,
    malformed,
    totalRecords: sanitized.length,
    selfTalkOutcomes: outcomes.length,
    guardRecords: guardRecords.length,
    committedSelfTalk: outcomes.filter((record) => record.commit?.committed === true).length,
    blockedSelfTalk: blocked.length,
    landedSelfTalk: landed.length,
    confirmedDelivery: strongDelivered.length,
    synthesizedOnlyDelivery: synthesizedOnly.length,
    selfTalkLandingRate: rate(landed.length, outcomes.length),
    confirmedSelfTalkLandingRate: rate(strongDelivered.length, outcomes.length),
    ruminationGuardTripRate: rate(guardTrips.length, guardRecords.length),
    landingComplianceRate: landingWindow.landingComplianceRate,
    externalLandingRate: landingWindow.externalLandingRate,
    silentClosures: landingWindow.silentClosures,
    unlandedSelfTalkStreak: landingWindow.unlandedStreak,
    mustLandNext: landingWindow.mustLandNext,
    llmContextAllowed: sanitized.some((record) => record.llmContextAllowed === true),
  });
}

export function createSelfTalkAuditStore({
  filePath,
  redactionPolicy = process.env.NOE_AUDIT_REDACTION || 'strict',
  now = Date.now,
} = {}) {
  if (!filePath) throw new TypeError('filePath is required');
  const policy = assertPolicy(redactionPolicy);

  function appendRecord(record) {
    const sanitized = sanitizeSelfTalkAuditRecord(record, { redactionPolicy: policy, now });
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(sanitized)}\n`, 'utf8');
    return sanitized;
  }

  function appendOutcome(outcome) {
    return appendRecord(createAuditSnapshot(outcome, { redactionPolicy: policy }));
  }

  function readRecords() {
    if (!existsSync(filePath)) return { records: [], malformed: 0 };
    return parseSelfTalkAuditJsonl(readFileSync(filePath, 'utf8'));
  }

  function summarize() {
    const parsed = readRecords();
    return summarizeSelfTalkAudit(parsed.records, { malformed: parsed.malformed });
  }

  return Object.freeze({
    filePath,
    redactionPolicy: policy,
    appendRecord,
    appendOutcome,
    readRecords,
    summarize,
  });
}
