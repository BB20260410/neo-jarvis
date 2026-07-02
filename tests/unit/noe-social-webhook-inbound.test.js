import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSocialWebhookReadiness,
  createReplayGuard,
  createSocialWebhookReceiver,
  parseSimpleXml,
  verifyWechatOfficialSignature,
} from '../../src/runtime/NoeSocialWebhookInbound.js';

function wechatSignature(token, timestamp, nonce) {
  return createHash('sha1').update([token, timestamp, nonce].sort().join(''), 'utf8').digest('hex');
}

describe('NoeSocialWebhookInbound', () => {
  it('reports key-presence compatibility plus no-secret credential status projections', () => {
    const readiness = buildSocialWebhookReadiness({
      WECHAT_OFFICIAL_TOKEN: 'secret-wechat-token',
      WECOM_INCOMING_TOKEN: '',
      FEISHU_VERIFICATION_TOKEN: 'secret-feishu-token',
    });
    expect(readiness).toMatchObject({
      wechatOfficial: true,
      wecomIncoming: true,
      feishuVerification: true,
      credentialStatuses: {
        wechatOfficialToken: { status: 'available', configured: true, available: true, key: 'WECHAT_OFFICIAL_TOKEN' },
        wecomIncomingToken: { status: 'configured_unavailable', configured: true, available: false, key: 'WECOM_INCOMING_TOKEN' },
        discordBotToken: { status: 'missing', configured: false, available: false },
      },
      credentialSummary: {
        total: 4,
        available: 2,
        configuredUnavailable: 1,
        missing: 1,
      },
    });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain('secret-wechat-token');
    expect(serialized).not.toContain('secret-feishu-token');
  });

  it('verifies WeChat official signatures and rejects stale timestamps', () => {
    const token = 'unit-wechat-token';
    const timestamp = '1000';
    const nonce = 'nonce-1';
    const signature = wechatSignature(token, timestamp, nonce);
    expect(verifyWechatOfficialSignature({
      token,
      timestamp,
      nonce,
      signature,
      now: () => 1000_000,
    })).toEqual({ ok: true });
    expect(verifyWechatOfficialSignature({
      token,
      timestamp,
      nonce,
      signature,
      now: () => 2000_000,
    })).toMatchObject({ ok: false, reason: 'timestamp_outside_window' });
    expect(verifyWechatOfficialSignature({
      token,
      timestamp,
      nonce,
      signature: 'bad',
      now: () => 1000_000,
    })).toMatchObject({ ok: false, reason: 'signature_invalid' });
  });

  it('blocks replayed provider event ids within the replay window', () => {
    let t = 10;
    const guard = createReplayGuard({ now: () => t, ttlMs: 100 });
    expect(guard.check('feishu:message-1')).toMatchObject({ ok: true, guarded: true });
    expect(guard.check('feishu:message-1')).toMatchObject({ ok: false, reason: 'replay_detected' });
    t = 200;
    expect(guard.check('feishu:message-1')).toMatchObject({ ok: true, guarded: true });
  });

  it('default check leaves empty keys ungated (backward-compatible for structurally-keyed routes)', () => {
    const guard = createReplayGuard({ now: () => 10 });
    // wechat-official 这类一定有 timestamp+nonce+signature 的渠道不能被改行为
    expect(guard.check('')).toMatchObject({ ok: true, guarded: false });
  });

  it('requireKey: empty replay key is NOT ok (cannot dedupe → must reject, no silent pass-through)', () => {
    // B1.5 bug①：缺 message_id 时空 key 视为不可去重，必须拒绝而非静默放行
    const guard = createReplayGuard({ now: () => 10 });
    expect(guard.check('', { requireKey: true })).toMatchObject({ ok: false, reason: 'missing_replay_key', guarded: false });
    // 非空 key 在 requireKey 下行为不变（首次过，重放挡）
    expect(guard.check('wecom:evt-1', { requireKey: true })).toMatchObject({ ok: true, guarded: true });
    expect(guard.check('wecom:evt-1', { requireKey: true })).toMatchObject({ ok: false, reason: 'replay_detected' });
  });

  it('parses simple WeChat XML without a full XML dependency', () => {
    expect(parseSimpleXml('<xml><FromUserName><![CDATA[openid-1]]></FromUserName><Content><![CDATA[你好]]></Content></xml>'))
      .toMatchObject({ FromUserName: 'openid-1', Content: '你好' });
  });

  it('delivers normalized social events through NoeInboundGateway and writes redacted memory', async () => {
    const writes = [];
    const captured = [];
    const receiver = createSocialWebhookReceiver({
      memory: { write: (item) => { writes.push(item); return item; } },
      onInboundMessage: (message) => captured.push(message),
      now: () => 123,
    });
    const result = await receiver.receive({
      channel: 'feishu',
      chatId: 'oc-1',
      userId: 'ou-1',
      text: '令牌 sk-unit-test-secret-0000000000 不应原样入库',
      platform: 'feishu',
      messageId: 'om-1',
    });
    expect(result).toMatchObject({ ok: true, channel: 'feishu', messageId: 'om-1' });
    expect(captured[0]).toMatchObject({
      channel: 'feishu',
      from: 'ou-1',
      peer: 'oc-1',
      text: '令牌 sk-unit-test-secret-0000000000 不应原样入库',
      permissions: { canReply: true, canCreateGoal: false, canAct: false },
    });
    expect(writes[0]).toMatchObject({
      scope: 'external_social_signal',
      sourceType: 'social_inbound',
      sourceId: 'social-inbound:feishu:om-1',
    });
    expect(JSON.stringify(writes[0])).not.toContain('sk-unit-test-secret-0000000000');
  });

  it('acks duplicate and self-echo social events without handler or memory writes', async () => {
    const writes = [];
    const captured = [];
    const receiver = createSocialWebhookReceiver({
      memory: { write: (item) => { writes.push(item); return item; } },
      onInboundMessage: (message) => captured.push(message),
      selfIds: ['noe-bot'],
      now: () => 123,
    });
    expect(await receiver.receive({
      channel: 'wecom',
      chatId: 'room-1',
      userId: 'user-1',
      text: '第一次',
      platform: 'wecom',
      messageId: 'same-1',
    })).toMatchObject({ ok: true, accepted: true, admission: { kind: 'dispatch' } });
    expect(await receiver.receive({
      channel: 'wecom',
      chatId: 'room-1',
      userId: 'user-1',
      text: '重复',
      platform: 'wecom',
      messageId: 'same-1',
    })).toMatchObject({ ok: true, accepted: false, reason: 'duplicate_message' });
    expect(await receiver.receive({
      channel: 'wecom',
      chatId: 'room-1',
      userId: 'noe-bot',
      text: '自己发出的回声',
      platform: 'wecom',
      messageId: 'self-1',
    })).toMatchObject({ ok: true, accepted: false, reason: 'self_message_ignored' });
    expect(captured).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(receiver.status().turnGuard).toMatchObject({ secretValuesReturned: false });
  });
});
