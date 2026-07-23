import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSelfTalkRuntimeEvidence, SELF_TALK_AUDIT_EVENT_KIND } from '../../src/cognition/SelfTalkRuntimeEvidence.js';
import {
  createSelfTalkCommitResult,
  createSelfTalkOutcome,
  createSelfTalkProposal,
} from '../../src/cognition/SelfTalkOutcome.js';
import { createRuminationAuditRecord, decideRuminationGuard } from '../../src/cognition/RuminationGuard.js';

const T0 = 1_781_253_600_000;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-self-talk-runtime-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeOutcome(proposalId) {
  const proposal = createSelfTalkProposal({
    proposalId,
    thought: 'private owner text must not persist',
    generatedAt: T0,
  });
  return createSelfTalkOutcome({
    proposal,
    commit: createSelfTalkCommitResult({
      proposalId,
      committed: true,
      committedAt: T0 + 1,
      eventId: 42,
    }),
    heartbeatLedger: { scheduled: true, inFlight: false },
  });
}

describe('SelfTalkRuntimeEvidence', () => {
  it('writes redacted audit records to JSONL and SQLite event appenders', () => {
    const events = [];
    const runtime = createSelfTalkRuntimeEvidence({
      auditFile: join(dir, 'audit.jsonl'),
      appendEvent: (event) => events.push(event),
      now: () => T0,
    });

    const written = runtime.appendOutcome(makeOutcome('p6-runtime-1'));

    expect(written.thought).toBe(null);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: SELF_TALK_AUDIT_EVENT_KIND,
      tag: 'self_talk_outcome',
      entityType: 'noe_self_talk',
      entityId: 'p6-runtime-1',
    });
    expect(JSON.stringify(events[0])).not.toContain('private owner text');
    expect(runtime.summary().selfTalkOutcomes).toBe(1);
  });

  it('summarizes DB event payloads and delivery acks as owner-perceived landing evidence', () => {
    const events = [];
    const runtime = createSelfTalkRuntimeEvidence({
      auditFile: join(dir, 'audit.jsonl'),
      appendEvent: (event) => events.push(event),
      listEvents: () => events,
      now: () => T0,
    });
    runtime.appendOutcome(makeOutcome('p6-runtime-2'));
    runtime.recordDeliveryAck({
      proposalId: 'p6-runtime-2',
      status: 'played_to_user_confirmed',
      at: T0 + 50,
      confirmationSource: 'telemetry',
      type: 'awareness',
      targetId: 'spoken-1',
    });

    const summary = runtime.dbSummary();
    expect(summary.selfTalkOutcomes).toBe(1);
    expect(summary.confirmedDelivery).toBe(1);
    expect(summary.confirmedSelfTalkLandingRate).toBe(1);
  });

  it('keeps guard records separate from outcome records', () => {
    const events = [];
    const runtime = createSelfTalkRuntimeEvidence({
      auditFile: join(dir, 'audit.jsonl'),
      appendEvent: (event) => events.push(event),
      listEvents: () => events,
      now: () => T0,
    });

    runtime.appendRecord(createRuminationAuditRecord({
      proposalId: 'p6-runtime-guard',
      decision: decideRuminationGuard({ mode: 'audit', metrics: { landingStreak: 6 } }),
    }));

    expect(runtime.dbSummary().guardRecords).toBe(1);
    expect(runtime.dbSummary().ruminationGuardTripRate).toBe(1);
  });
});
