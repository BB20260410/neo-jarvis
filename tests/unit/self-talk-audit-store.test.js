import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSelfTalkAuditStore,
  parseSelfTalkAuditJsonl,
  sanitizeSelfTalkAuditRecord,
  summarizeSelfTalkAudit,
} from '../../src/cognition/SelfTalkAuditStore.js';
import {
  createSelfTalkCommitResult,
  createSelfTalkLandingEffect,
  createSelfTalkOutcome,
  createSelfTalkProposal,
} from '../../src/cognition/SelfTalkOutcome.js';
import { createRuminationAuditRecord, decideRuminationGuard } from '../../src/cognition/RuminationGuard.js';

const T0 = 1_781_253_000_000;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-self-talk-audit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function outcome({ id, thought = '主人说了很私人的原文', landing = null, committed = true } = {}) {
  const proposal = createSelfTalkProposal({
    proposalId: id,
    thought,
    generatedAt: T0,
    rawMetrics: {
      semanticSim: 0.2,
      groundingScore: 0.8,
      abstractDensity: 0.1,
      recentSelfTalkRatio: 0.5,
      landingStreak: 1,
    },
  });
  return createSelfTalkOutcome({
    proposal,
    commit: createSelfTalkCommitResult({
      proposalId: proposal.proposalId,
      committed,
      committedAt: committed ? T0 + 10 : null,
      blockedReason: committed ? null : 'guard_blocked',
      eventId: committed ? 7 : null,
    }),
    landing,
    heartbeatLedger: { scheduled: true, inFlight: false },
  });
}

describe('SelfTalkAuditStore', () => {
  it('appends strict-redacted outcome records without owner-private thought text', () => {
    const store = createSelfTalkAuditStore({
      filePath: join(dir, 'audit.jsonl'),
      redactionPolicy: 'strict',
      now: () => T0,
    });
    const written = store.appendOutcome(outcome({ id: 'audit-001' }));

    expect(written.redactionPolicy).toBe('strict');
    expect(written.thought).toBe(null);
    expect(written.auditTextPersisted).toBe(false);
    expect(written.llmContextAllowed).toBe(false);
    expect(written.unsafeTextFieldCount).toBe(0);

    const parsed = store.readRecords();
    expect(parsed.records).toHaveLength(1);
    expect(JSON.stringify(parsed.records[0])).not.toContain('主人说了很私人的原文');
  });

  it('never allows audit records into LLM context, even when redaction is none', () => {
    const record = sanitizeSelfTalkAuditRecord({
      proposalId: 'audit-none',
      thought: 'local debug text',
      redactionPolicy: 'none',
      rawMetrics: { semanticSim: 0.1 },
    });

    expect(record.thought).toBe('local debug text');
    expect(record.auditTextPersisted).toBe(true);
    expect(record.llmContextAllowed).toBe(false);
  });

  it('counts confirmed playback separately from synthesized audio', () => {
    const confirmed = createSelfTalkLandingEffect({
      proposalId: 'landing-confirmed',
      type: 'awareness',
      targetId: 'spoken-1',
      at: T0 + 20,
      delivery: {
        status: 'played_to_user_confirmed',
        confirmedAt: T0 + 30,
        confirmationSource: 'telemetry',
      },
    });
    const synthesized = createSelfTalkLandingEffect({
      proposalId: 'landing-synth',
      type: 'awareness',
      targetId: 'spoken-2',
      at: T0 + 20,
      delivery: { status: 'synthesized' },
    });
    const records = [
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'landing-confirmed', landing: confirmed }), proposalId: 'landing-confirmed' }),
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'landing-synth', landing: synthesized }), proposalId: 'landing-synth' }),
    ];

    const summary = summarizeSelfTalkAudit(records);
    expect(summary.selfTalkOutcomes).toBe(2);
    expect(summary.landedSelfTalk).toBe(2);
    expect(summary.confirmedDelivery).toBe(1);
    expect(summary.synthesizedOnlyDelivery).toBe(1);
    expect(summary.selfTalkLandingRate).toBe(1);
    expect(summary.confirmedSelfTalkLandingRate).toBe(0.5);
    expect(summary.landingComplianceRate).toBe(1);
    expect(summary.externalLandingRate).toBe(1);
    expect(summary.mustLandNext).toBe(false);
  });

  it('uses the latest outcome per proposalId so landing updates do not double count', () => {
    const proposalId = 'landing-update';
    const initial = sanitizeSelfTalkAuditRecord({ ...outcome({ id: proposalId }), proposalId });
    const landing = createSelfTalkLandingEffect({
      proposalId,
      type: 'commitment',
      targetId: 'cm-1',
      at: T0 + 20,
      delivery: { status: 'queued' },
    });
    const updated = sanitizeSelfTalkAuditRecord({ ...outcome({ id: proposalId, landing }), proposalId });

    const summary = summarizeSelfTalkAudit([initial, updated]);
    expect(summary.selfTalkOutcomes).toBe(1);
    expect(summary.landedSelfTalk).toBe(1);
    expect(summary.selfTalkLandingRate).toBe(1);
    expect(summary.unlandedSelfTalkStreak).toBe(0);
  });

  it('reports silent closure as compliance without treating it as external or confirmed delivery', () => {
    const silent = createSelfTalkLandingEffect({
      proposalId: 'landing-silent',
      type: 'silent',
      at: T0 + 20,
      delivery: { status: 'not_attempted' },
    });
    const records = [
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'landing-silent', landing: silent }), proposalId: 'landing-silent' }),
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'no-landing-1' }), proposalId: 'no-landing-1' }),
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'no-landing-2' }), proposalId: 'no-landing-2' }),
      sanitizeSelfTalkAuditRecord({ ...outcome({ id: 'no-landing-3' }), proposalId: 'no-landing-3' }),
    ];

    const summary = summarizeSelfTalkAudit(records);
    expect(summary.silentClosures).toBe(1);
    expect(summary.landedSelfTalk).toBe(0);
    expect(summary.confirmedDelivery).toBe(0);
    expect(summary.landingComplianceRate).toBe(0.25);
    expect(summary.externalLandingRate).toBe(0);
    expect(summary.unlandedSelfTalkStreak).toBe(3);
    expect(summary.mustLandNext).toBe(true);
  });

  it('counts blocked silent closure as compliance but not as external or confirmed delivery', () => {
    const silent = createSelfTalkLandingEffect({
      proposalId: 'blocked-silent',
      type: 'silent',
      at: T0 + 20,
      delivery: { status: 'not_attempted' },
    });
    const records = [
      sanitizeSelfTalkAuditRecord({
        ...outcome({ id: 'blocked-silent', landing: silent, committed: false }),
        proposalId: 'blocked-silent',
      }),
    ];

    const summary = summarizeSelfTalkAudit(records);
    expect(summary.committedSelfTalk).toBe(0);
    expect(summary.blockedSelfTalk).toBe(1);
    expect(summary.silentClosures).toBe(1);
    expect(summary.landingComplianceRate).toBe(1);
    expect(summary.externalLandingRate).toBe(0);
    expect(summary.confirmedDelivery).toBe(0);
    expect(summary.mustLandNext).toBe(false);
  });

  it('computes guard trip rate from separate rumination guard records', () => {
    const normal = createRuminationAuditRecord({
      proposalId: 'guard-normal',
      decision: decideRuminationGuard({
        mode: 'audit',
        metrics: { semanticSim: 0.1, groundingScore: 0.8, recentSelfTalkRatio: 0.2, landingStreak: 0 },
      }),
    });
    const cooldown = createRuminationAuditRecord({
      proposalId: 'guard-cooldown',
      decision: decideRuminationGuard({
        mode: 'audit',
        metrics: { semanticSim: 0.1, groundingScore: 0.8, recentSelfTalkRatio: 0.2, landingStreak: 6 },
      }),
    });

    const summary = summarizeSelfTalkAudit([normal, cooldown]);
    expect(summary.guardRecords).toBe(2);
    expect(summary.ruminationGuardTripRate).toBe(0.5);
    expect(summary.llmContextAllowed).toBe(false);
  });

  it('keeps malformed jsonl visible in replay summaries', () => {
    const parsed = parseSelfTalkAuditJsonl('{"proposalId":"ok"}\nnot-json\n');
    const summary = summarizeSelfTalkAudit(parsed.records, { malformed: parsed.malformed });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.malformed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.malformed).toBe(1);
  });
});
