import { describe, expect, it } from 'vitest';
import {
  buildSocialTurnDeliveryReceipt,
  createSocialTurnGuard,
  normalizeSocialTurnFacts,
} from '../../src/runtime/NoeSocialTurnGuard.js';

describe('NoeSocialTurnGuard', () => {
  it('normalizes transport-neutral turn facts without exposing provider payloads', () => {
    const facts = normalizeSocialTurnFacts({
      channel: 'qq_official',
      from: 'user-1',
      peer: 'group-1',
      text: 'hello',
      raw: { messageId: 'm-1', senderKind: 'human', access_token: 'secret-token' },
    });
    expect(facts).toMatchObject({
      channel: 'qq_official',
      conversationId: 'group-1',
      senderId: 'user-1',
      receiverId: 'group-1',
      messageId: 'm-1',
      senderKind: 'human',
    });
    expect(JSON.stringify(facts)).not.toContain('secret-token');
  });

  it('suppresses duplicate provider message ids within the replay window', () => {
    let t = 1_000;
    const guard = createSocialTurnGuard({ now: () => t, replayTtlMs: 100 });
    const input = { channel: 'feishu', from: 'u-1', peer: 'chat-1', text: 'hi', raw: { messageId: 'm-1' } };
    expect(guard.admit(input)).toMatchObject({ accepted: true, admission: { kind: 'dispatch' } });
    expect(guard.admit(input)).toMatchObject({ accepted: false, admission: { reason: 'duplicate_message', ackProvider: true } });
    t = 1_200;
    expect(guard.admit(input)).toMatchObject({ accepted: true, admission: { kind: 'dispatch' } });
  });

  it('uses content fingerprints for providers that omit message ids', () => {
    const guard = createSocialTurnGuard();
    const input = { channel: 'wechat_clawbot', from: 'wx-owner', peer: 'wx-owner', text: 'same long-poll packet' };
    expect(guard.admit(input)).toMatchObject({ accepted: true, admission: { kind: 'dispatch' } });
    expect(guard.admit(input)).toMatchObject({
      accepted: false,
      admission: { reason: 'duplicate_content', ackProvider: true },
    });
    expect(guard.stats()).toMatchObject({
      admittedTurns: 2,
      acceptedTurns: 1,
      droppedTurns: 1,
      reasons: { duplicate_content: 1, turn_allowed: 1 },
      dropReasons: { duplicate_content: 1 },
      channels: {
        wechat_clawbot: {
          accepted: 1,
          dropped: 1,
          total: 2,
          reasons: { duplicate_content: 1, turn_allowed: 1 },
        },
      },
      lastAdmission: {
        channel: 'wechat_clawbot',
        accepted: false,
        reason: 'duplicate_content',
        rawIdsReturned: false,
        secretValuesReturned: false,
      },
      rawIdsReturned: false,
      secretValuesReturned: false,
    });
    const serialized = JSON.stringify(guard.stats());
    expect(serialized).not.toContain('wx-owner');
    expect(serialized).not.toContain('same long-poll packet');
  });

  it('drops self echo messages before they can start an agent turn', () => {
    const guard = createSocialTurnGuard({ selfIds: ['bot-self'] });
    expect(guard.admit({
      channel: 'wechat_official',
      from: 'bot-self',
      peer: 'owner',
      text: 'echo',
      raw: { messageId: 'self-1' },
    })).toMatchObject({
      accepted: false,
      admission: { reason: 'self_message_ignored', canStartAgentTurn: false, ackProvider: true },
    });
  });

  it('suppresses bot-to-bot loops without dropping the first legitimate handshakes', () => {
    let t = 1_000;
    const guard = createSocialTurnGuard({ now: () => t, botLoopLimit: 2, botLoopWindowMs: 1_000 });
    const base = {
      channel: 'wecom',
      from: 'bot-a',
      peer: 'bot-b',
      text: 'loop',
      raw: { senderKind: 'bot', receiverKind: 'bot' },
    };
    expect(guard.admit({ ...base, raw: { ...base.raw, messageId: 'm-1' } })).toMatchObject({ accepted: true });
    expect(guard.admit({ ...base, raw: { ...base.raw, messageId: 'm-2' } })).toMatchObject({ accepted: true });
    expect(guard.admit({ ...base, raw: { ...base.raw, messageId: 'm-3' } })).toMatchObject({
      accepted: false,
      admission: { reason: 'bot_loop_suppressed', count: 3, limit: 2 },
    });
    t = 3_000;
    expect(guard.admit({ ...base, raw: { ...base.raw, messageId: 'm-4' } })).toMatchObject({ accepted: true });
  });

  it('builds durable delivery receipts without including reply body text', () => {
    const receipt = buildSocialTurnDeliveryReceipt({
      now: () => 123,
      message: { id: 'in-1', channel: 'qq_official', raw: { messageId: 'qq-1' } },
      delivery: { ok: true, visibleReplySent: true, body: '不要出现在回执里' },
    });
    expect(receipt).toMatchObject({
      status: 'handled_visible',
      channel: 'qq_official',
      messageId: 'qq-1',
      gatewayMessageId: 'in-1',
      finalReplyDelivered: true,
      secretValuesReturned: false,
    });
    expect(JSON.stringify(receipt)).not.toContain('不要出现在回执里');
  });

  it('builds unsupported dry-run receipts for gated outbound attempts', () => {
    const receipt = buildSocialTurnDeliveryReceipt({
      now: () => 456,
      message: { id: 'in-2', channel: 'wechat_clawbot', raw: { messageId: 'wx-1' } },
      delivery: {
        ok: false,
        status: 'unsupported',
        reason: 'outbound_gate_blocked',
        replyGenerated: false,
        dryRun: true,
        body: '不能出现在回执里',
      },
    });
    expect(receipt).toMatchObject({
      status: 'unsupported',
      channel: 'wechat_clawbot',
      messageId: 'wx-1',
      gatewayMessageId: 'in-2',
      replyGenerated: false,
      deliveryAttempted: false,
      dryRun: true,
      visibleReplySent: false,
      finalReplyDelivered: false,
      reason: 'outbound_gate_blocked',
    });
    expect(JSON.stringify(receipt)).not.toContain('不能出现在回执里');
  });
});
