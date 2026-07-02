// @ts-check
// SelfTalkRuntimeEvidence — runtime bridge for P6 self-talk audit evidence.
//
// It writes the same redacted audit record to JSONL and SQLite events. The
// records are diagnostic summaries only: no prompt, owner text, token, or raw DB
// row is required for replay.

import { createSelfTalkAuditStore, summarizeSelfTalkAudit } from './SelfTalkAuditStore.js';
import { createSelfTalkDeliveryAck, deliveryFromAck } from './SelfTalkDeliveryAck.js';
import { createSelfTalkLandingEffect, createAuditSnapshot } from './SelfTalkOutcome.js';

export const SELF_TALK_AUDIT_EVENT_KIND = 'noe_self_talk_audit';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultSignalContract() {
  return Object.freeze({
    readsVad: false,
    readsRawTimeline: true,
    reason: 'rumination_guard_reads_raw_timeline',
  });
}

export function summarizeSelfTalkAuditEvents(rows = []) {
  const records = asArray(rows)
    .map((row) => row?.payload || row)
    .filter((payload) => payload && typeof payload === 'object');
  return summarizeSelfTalkAudit(records);
}

export function createSelfTalkRuntimeEvidence({
  auditFile,
  redactionPolicy = process.env.NOE_AUDIT_REDACTION || 'strict',
  appendEvent = null,
  listEvents = null,
  now = Date.now,
  signalContract = defaultSignalContract,
} = {}) {
  if (!auditFile) throw new TypeError('auditFile is required');
  const auditStore = createSelfTalkAuditStore({ filePath: auditFile, redactionPolicy, now });

  function normalizeRecord(record = {}) {
    const contract = typeof signalContract === 'function'
      ? (signalContract() || defaultSignalContract())
      : (signalContract || defaultSignalContract());
    return {
      ...record,
      ts: record.ts ?? now(),
      signalContract: record.signalContract || contract,
    };
  }

  function appendRecord(record = {}) {
    const sanitized = auditStore.appendRecord(normalizeRecord(record));
    if (typeof appendEvent === 'function') {
      try {
        appendEvent({
          kind: SELF_TALK_AUDIT_EVENT_KIND,
          ts: sanitized.ts,
          tag: sanitized.channel,
          entityType: 'noe_self_talk',
          entityId: sanitized.proposalId || null,
          ...sanitized,
        });
      } catch {
        // SQLite persistence is evidence, not the reflection control path.
      }
    }
    return sanitized;
  }

  function appendOutcome(outcome) {
    return appendRecord(createAuditSnapshot(outcome, { redactionPolicy }));
  }

  function recordDeliveryAck(input = {}) {
    const ack = createSelfTalkDeliveryAck(input);
    const landing = createSelfTalkLandingEffect({
      proposalId: ack.proposalId,
      type: input.type || input.landingType || 'awareness',
      targetId: input.targetId || ack.playbackId || null,
      at: ack.at,
      delivery: deliveryFromAck(ack),
    });
    const record = appendRecord({
      channel: 'self_talk_outcome',
      proposalId: ack.proposalId,
      streamType: 'self_talk',
      commit: {
        committed: true,
        blockedReason: null,
        committedAt: ack.at,
        eventId: null,
      },
      landing,
    });
    return Object.freeze({ ack, landing, record });
  }

  function summary() {
    return auditStore.summarize();
  }

  function dbSummary({ limit = 10_000 } = {}) {
    if (typeof listEvents !== 'function') return summarizeSelfTalkAuditEvents([]);
    try {
      return summarizeSelfTalkAuditEvents(listEvents({ kind: SELF_TALK_AUDIT_EVENT_KIND, limit, order: 'ASC' }));
    } catch {
      return summarizeSelfTalkAuditEvents([]);
    }
  }

  return Object.freeze({
    auditFile,
    redactionPolicy,
    appendRecord,
    appendOutcome,
    recordDeliveryAck,
    summary,
    dbSummary,
  });
}
