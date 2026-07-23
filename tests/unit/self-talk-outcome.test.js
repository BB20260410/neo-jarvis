import { describe, expect, it } from 'vitest';
import {
  createAuditSnapshot,
  createSelfTalkCommitResult,
  createSelfTalkDelivery,
  createSelfTalkLandingEffect,
  createSelfTalkOutcome,
  createSelfTalkProposal,
  isStrongDeliveryStatus,
} from '../../src/cognition/SelfTalkOutcome.js';

const T0 = 1_781_252_100_000;

describe('SelfTalkOutcome P6-A0 contract', () => {
  it('can allocate proposalId before self-talk text or guard metrics exist', () => {
    const proposal = createSelfTalkProposal({
      proposalId: 'p6-entry-001',
      generatedAt: T0,
    });

    expect(proposal.proposalId).toBe('p6-entry-001');
    expect(proposal.thought).toBe('');
    expect(proposal.streamType).toBe('self_talk');
    expect(proposal.rawMetrics).toEqual({
      semanticSim: null,
      groundingScore: null,
      abstractDensity: null,
      recentSelfTalkRatio: null,
      landingStreak: null,
    });
  });

  it('keeps synthesized audio separate from confirmed owner playback', () => {
    expect(isStrongDeliveryStatus('synthesized')).toBe(false);
    expect(isStrongDeliveryStatus('played_to_user_confirmed')).toBe(true);

    expect(createSelfTalkDelivery({ status: 'synthesized' })).toMatchObject({
      status: 'synthesized',
      confirmedAt: null,
      confirmationSource: null,
    });

    expect(createSelfTalkDelivery({
      status: 'played_to_user_confirmed',
      confirmedAt: T0 + 100,
      confirmationSource: 'telemetry',
    })).toMatchObject({
      status: 'played_to_user_confirmed',
      confirmedAt: T0 + 100,
      confirmationSource: 'telemetry',
    });
  });

  it('requires confirmation evidence for played_to_user_confirmed', () => {
    expect(() => createSelfTalkDelivery({ status: 'played_to_user_confirmed' })).toThrow(/confirmedAt/);
    expect(() => createSelfTalkDelivery({
      status: 'played_to_user_confirmed',
      confirmedAt: T0,
      confirmationSource: 'browser_log',
    })).toThrow(/confirmationSource/);
  });

  it('ties proposal, commit, landing, and heartbeat ledger to the same id', () => {
    const proposal = createSelfTalkProposal({
      proposalId: 'p6-entry-002',
      thought: '主人刚刚说项目卡住了，我想把它转成一个可执行目标。',
      generatedAt: T0,
      rawMetrics: {
        semanticSim: 0.31,
        groundingScore: 0.82,
        abstractDensity: 0.18,
        recentSelfTalkRatio: 0.2,
        landingStreak: 3,
      },
      guardDecision: 'normal',
    });
    const commit = createSelfTalkCommitResult({
      proposalId: proposal.proposalId,
      committed: true,
      committedAt: T0 + 10,
      eventId: 42,
    });
    const landing = createSelfTalkLandingEffect({
      proposalId: proposal.proposalId,
      type: 'goal',
      targetId: 'goal-owner-local-001',
      at: T0 + 20,
      delivery: { status: 'not_attempted' },
    });
    const outcome = createSelfTalkOutcome({
      proposal,
      commit,
      landing,
      heartbeatLedger: { scheduled: true, inFlight: false },
    });

    expect(outcome.heartbeatLedger).toEqual({
      proposalId: 'p6-entry-002',
      scheduled: true,
      inFlight: false,
    });
    expect(outcome.landing?.type).toBe('goal');
    expect(() => createSelfTalkOutcome({
      proposal,
      commit: createSelfTalkCommitResult({ proposalId: 'other-id' }),
    })).toThrow(/proposalId mismatch/);
  });

  it('redacts audit snapshots by default while retaining numeric guard evidence', () => {
    const proposal = createSelfTalkProposal({
      proposalId: 'p6-entry-003',
      thought: '主人今天说了一个很私人的原文片段，不应进入 audit jsonl。',
      generatedAt: T0,
      anchorRef: 'timeline-event-owner-private-id',
      rawMetrics: {
        semanticSim: 0.7,
        groundingScore: 0.5,
        abstractDensity: 0.44,
        recentSelfTalkRatio: 0.9,
        landingStreak: 8,
      },
      guardDecision: 'rotate',
      wouldBlock: true,
    });
    const outcome = createSelfTalkOutcome({
      proposal,
      commit: createSelfTalkCommitResult({
        proposalId: proposal.proposalId,
        committed: false,
        blockedReason: 'rumination_guard_rotate',
      }),
      heartbeatLedger: { scheduled: true, inFlight: true },
    });

    const audit = createAuditSnapshot(outcome);
    expect(audit.redactionPolicy).toBe('strict');
    expect(audit.auditTextPersisted).toBe(false);
    expect(audit.thought).toBe(null);
    expect(audit.anchorRefPresent).toBe(true);
    expect(audit.rawMetrics).toEqual(proposal.rawMetrics);
    expect(audit.guardDecision).toBe('rotate');
    expect(audit.wouldBlock).toBe(true);
  });

  it('only explicit none redaction keeps raw thought text for local debugging', () => {
    const proposal = createSelfTalkProposal({
      proposalId: 'p6-entry-004',
      thought: 'local-only debug thought',
      generatedAt: T0,
    });
    const outcome = createSelfTalkOutcome({
      proposal,
      commit: createSelfTalkCommitResult({ proposalId: proposal.proposalId }),
    });

    expect(createAuditSnapshot(outcome, { redactionPolicy: 'default' }).thought).toBe(null);
    expect(createAuditSnapshot(outcome, { redactionPolicy: 'none' }).thought).toBe('local-only debug thought');
  });
});
