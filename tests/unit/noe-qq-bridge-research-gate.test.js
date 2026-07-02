import { describe, expect, it } from 'vitest';
import {
  buildQqBridgeResearchGate,
  createQqBridgeResearchGate,
  normalizeQqOfficialEvent,
  previewQqOfficialEvent,
} from '../../src/runtime/NoeQqBridgeResearchGate.js';

describe('NoeQqBridgeResearchGate', () => {
  it('selects official QQ Bot webhook while reporting no-secret credential status projections', () => {
    const gate = buildQqBridgeResearchGate({
      env: {
        QQ_BOT_APP_ID: 'appid-secret-value',
        QQ_BOT_APP_SECRET: 'appsecret-secret-value',
        QQ_BOT_WEBHOOK_SECRET: 'webhook-secret-value',
        QQ_BOT_PUBLIC_CALLBACK_URL: '',
      },
    });
    expect(gate).toMatchObject({
      status: 'research_gate_done_live_blocked',
      selectedTransport: 'qq_official_webhook',
      readyForDryRun: true,
      credentials: {
        appId: true,
        appSecret: true,
        webhookSecret: true,
        publicCallbackUrl: true,
        credentialStatuses: {
          appId: { status: 'available', available: true },
          appSecret: { status: 'available', available: true },
          webhookSecret: { status: 'available', available: true },
          publicCallbackUrl: { status: 'configured_unavailable', available: false },
        },
      },
      credentialSummary: {
        total: 4,
        available: 3,
        configuredUnavailable: 1,
      },
      policy: {
        baiLongmaHasQqConnector: false,
        noPersonalQqClientByDefault: true,
      },
    });
    const serialized = JSON.stringify(gate);
    expect(serialized).not.toContain('appid-secret-value');
    expect(serialized).not.toContain('appsecret-secret-value');
    expect(serialized).not.toContain('webhook-secret-value');
    expect(gate.blockers).toContain('qq_public_callback_url_configured_unavailable');
    expect(gate.blockers).toContain('live_signature_verification_not_enabled');
  });

  it('normalizes QQ official webhook-like events without credential fields', () => {
    const normalized = normalizeQqOfficialEvent({
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'qq-msg-1',
        group_openid: 'group-1',
        content: 'hello qq',
        author: { id: 'user-1', username: 'owner' },
        access_token: 'secret-token',
      },
    });
    expect(normalized).toMatchObject({
      channel: 'qq_official',
      chatId: 'group-1',
      userId: 'user-1',
      text: 'hello qq',
      messageId: 'qq-msg-1',
    });
    expect(JSON.stringify(normalized)).not.toContain('secret-token');
  });

  it('dry-runs QQ official events through Noe inbound gateway', async () => {
    const captured = [];
    const writes = [];
    const gate = createQqBridgeResearchGate({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
      now: () => 1_000,
    });
    const result = await gate.dryRun({
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'qq-msg-2',
        c2c_openid: 'c2c-1',
        content: 'hello c2c',
        author: { user_openid: 'user-openid-1' },
      },
    });
    expect(result).toMatchObject({ ok: true, channel: 'qq_official' });
    expect(captured[0]).toMatchObject({ channel: 'qq_official', from: 'user-openid-1', peer: 'c2c-1', text: 'hello c2c' });
    expect(writes[0]).toMatchObject({ scope: 'external_social_signal', sourceType: 'social_inbound' });
  });

  it('uses the shared social turn guard for duplicate QQ events', async () => {
    const captured = [];
    const writes = [];
    const gate = createQqBridgeResearchGate({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
      now: () => 1_000,
    });
    const event = {
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'qq-dup-1',
        c2c_openid: 'c2c-dup',
        content: 'hello once',
        author: { user_openid: 'user-openid-dup' },
      },
    };
    expect(await gate.dryRun(event)).toMatchObject({ ok: true, accepted: true, admission: { kind: 'dispatch' } });
    expect(await gate.dryRun(event)).toMatchObject({ ok: true, accepted: false, reason: 'duplicate_message' });
    expect(captured).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(gate.status().receiver.turnGuard).toMatchObject({ secretValuesReturned: false });
  });

  it('suppresses QQ bot-to-bot loop probes before writing memory', async () => {
    const captured = [];
    const writes = [];
    const gate = createQqBridgeResearchGate({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
      now: () => 1_000,
    });
    for (const id of ['bot-loop-1', 'bot-loop-2', 'bot-loop-3']) {
      expect(await gate.dryRun({
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id,
          group_openid: 'bot-room',
          content: 'bot hello',
          author: { id: 'bot-a', bot: true },
          receiverKind: 'bot',
        },
      })).toMatchObject({ ok: true, accepted: true });
    }
    expect(await gate.dryRun({
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'bot-loop-4',
        group_openid: 'bot-room',
        content: 'bot loop',
        author: { id: 'bot-a', bot: true },
        receiverKind: 'bot',
      },
    })).toMatchObject({ ok: true, accepted: false, reason: 'bot_loop_suppressed' });
    expect(captured).toHaveLength(3);
    expect(writes).toHaveLength(3);
  });

  it('previews QQ official events without delivering or writing memory', () => {
    const captured = [];
    const writes = [];
    const gate = createQqBridgeResearchGate({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
    });
    const result = gate.preview({
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'qq-preview-1',
        group_openid: 'group-preview',
        content: 'hello preview',
        author: { id: 'preview-user' },
        access_token: 'preview-secret-token',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      accepted: false,
      dryRunOnly: true,
      liveMessageSent: false,
      normalized: {
        channel: 'qq_official',
        peer: 'group-preview',
        from: 'preview-user',
        text: 'hello preview',
      },
    });
    expect(captured).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('preview-secret-token');
  });

  it('exposes a pure preview helper for empty-event blockers', () => {
    expect(previewQqOfficialEvent({ d: { id: 'empty' } })).toMatchObject({
      ok: false,
      accepted: false,
      dryRunOnly: true,
      liveMessageSent: false,
      reason: 'empty_message',
    });
  });
});
