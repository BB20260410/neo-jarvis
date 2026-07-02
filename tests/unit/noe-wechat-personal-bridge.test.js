import { describe, expect, it } from 'vitest';
import {
  buildWeChatPersonalReadiness,
  createWeChatPersonalContextTokenStore,
  createWeChatPersonalBridge,
  sanitizeWeChatPersonalQr,
  sanitizeWeChatPersonalStatus,
  validateWeChatPersonalOutboundEvidence,
} from '../../src/runtime/NoeWeChatPersonalBridge.js';

describe('NoeWeChatPersonalBridge', () => {
  it('reports only safe readiness and status fields', () => {
    const env = {
      WECHAT_PERSONAL_BRIDGE_TRANSPORT: 'wechat-ilink-client',
      WECHAT_PERSONAL_BRIDGE_QR_PROVIDER: 'local-owner-only',
      WECHAT_PERSONAL_BRIDGE_ENABLED: 'true',
      WECHAT_PERSONAL_SECRET: 'unit-secret-value',
    };
    const readiness = buildWeChatPersonalReadiness(env);
    expect(readiness).toMatchObject({
      transportSelected: true,
      qrProviderConfigured: true,
      liveClientAllowedByEnv: true,
      liveClientStarted: false,
      outboundRequiresOwnerVisibleEvidence: true,
    });
    const status = sanitizeWeChatPersonalStatus({
      loginState: 'connected',
      qrPending: true,
      sessionCookie: 'unit-cookie-secret',
      context_token: 'unit-context-secret',
    }, { env });
    const serialized = JSON.stringify({ readiness, status });
    expect(status.loginState).toBe('connected');
    expect(status.qrPending).toBe(true);
    expect(serialized).not.toContain('unit-secret-value');
    expect(serialized).not.toContain('unit-cookie-secret');
    expect(serialized).not.toContain('unit-context-secret');
  });

  it('returns a no-secret QR contract instead of raw scanning material', () => {
    const qr = sanitizeWeChatPersonalQr({
      available: true,
      id: 'qr-safe-ref',
      expiresAt: '2026-06-13T01:00:00.000Z',
      imageDataUrl: 'data:image/png;base64,secret',
      rawContent: 'secret-qr-content',
    });
    const serialized = JSON.stringify(qr);
    expect(qr).toMatchObject({
      available: true,
      qr: { id: 'qr-safe-ref', rawImageReturned: false, rawContentReturned: false },
    });
    expect(serialized).not.toContain('secret-qr-content');
    expect(serialized).not.toContain('data:image');
  });

  it('delivers normalized WeChat personal dry-run messages without context-token leakage', async () => {
    const captured = [];
    const writes = [];
    const bridge = createWeChatPersonalBridge({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
      now: () => 1_000,
    });
    const result = await bridge.receive({
      from_user_id: 'wx-owner',
      nickname: 'owner',
      text: 'hello personal wechat',
      context_token: 'unit-context-secret',
    });
    expect(result).toMatchObject({ ok: true, channel: 'wechat_clawbot' });
    expect(result.contextToken).toMatchObject({
      available: true,
      rawTokenReturned: false,
      secretValuesReturned: false,
    });
    expect(result.contextToken.contextTokenRef).toMatch(/^sha256:/);
    expect(captured[0]).toMatchObject({
      channel: 'wechat_clawbot',
      from: 'wx-owner',
      text: 'hello personal wechat',
    });
    expect(writes[0]).toMatchObject({ scope: 'external_social_signal', sourceType: 'social_inbound' });
    const status = bridge.status();
    expect(status.receiver.contextTokens).toMatchObject({ trackedPeers: 1, rawTokenReturned: false, secretValuesReturned: false });
    expect(JSON.stringify({ result, captured, writes, status })).not.toContain('unit-context-secret');
  });

  it('suppresses duplicate personal WeChat long-poll packets that lack message ids', async () => {
    const captured = [];
    const writes = [];
    const bridge = createWeChatPersonalBridge({
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
      now: () => 1_000,
    });
    const raw = { from_user_id: 'wx-owner', text: 'same packet without id', context_token: 'ctx-1' };
    expect(await bridge.receive(raw)).toMatchObject({ ok: true, accepted: true, admission: { kind: 'dispatch' } });
    expect(await bridge.receive(raw)).toMatchObject({ ok: true, accepted: false, reason: 'duplicate_content' });
    expect(captured).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it('requires owner-visible inbound evidence before any outbound personal WeChat reply', () => {
    const missing = validateWeChatPersonalOutboundEvidence({
      channel: 'wechat_clawbot',
      text: 'reply',
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(expect.arrayContaining(['missing_owner_visible_peer', 'missing_recent_inbound_reference', 'owner_visible_evidence_required']));

    const allowed = validateWeChatPersonalOutboundEvidence({
      text: 'reply',
      ownerVisibleEvidence: {
        channel: 'wechat_clawbot',
        sessionKey: 'wechat_clawbot:wx-owner:direct',
        messageId: 'in-1',
        ownerVisible: true,
      },
    });
    expect(allowed).toMatchObject({ ok: true, dryRunOnly: true, liveMessageSent: false });
  });

  it('blocks outbound dry-run when reply text is missing even with owner-visible evidence', () => {
    const bridge = createWeChatPersonalBridge({ now: () => 2_000 });
    const out = bridge.outboundDryRun({
      ownerVisibleEvidence: {
        channel: 'wechat_clawbot',
        sessionKey: 'wechat_clawbot:wx-owner:direct',
        messageId: 'in-1',
        ownerVisible: true,
      },
    });
    expect(out).toMatchObject({
      ok: false,
      allowed: false,
      errors: ['missing_reply_text'],
      replyGenerated: false,
      deliveryStatus: 'unsupported',
      finalReplyDelivered: false,
      deliveryReceipt: {
        status: 'unsupported',
        replyGenerated: false,
        dryRun: true,
        visibleReplySent: false,
        finalReplyDelivered: false,
      },
    });
  });

  it('reports context-token availability for outbound dry-run without returning the token', async () => {
    const store = createWeChatPersonalContextTokenStore({ now: () => 2_000 });
    const bridge = createWeChatPersonalBridge({
      contextTokenStore: store,
      env: { WECHAT_PERSONAL_BRIDGE_ACCOUNT_ID: 'owner-wechat' },
      now: () => 2_000,
    });
    await bridge.receive({ from_user_id: 'wx-owner', text: 'token-bearing inbound', context_token: 'unit-context-secret' });
    const out = bridge.outboundDryRun({
      text: 'unit reply body should not echo',
      ownerVisibleEvidence: {
        channel: 'wechat_clawbot',
        sessionKey: 'wechat_clawbot:wx-owner:direct',
        messageId: 'in-1',
        ownerVisible: true,
      },
    });
    expect(out).toMatchObject({
      ok: true,
      allowed: true,
      contextTokenAvailable: true,
      contextTokenWouldBeUsed: true,
      rawContextTokenReturned: false,
      replyGenerated: true,
      deliveryStatus: 'handled_no_send',
      finalReplyDelivered: false,
      deliveryReceipt: {
        status: 'handled_no_send',
        replyGenerated: true,
        deliveryAttempted: false,
        dryRun: true,
        visibleReplySent: false,
        finalReplyDelivered: false,
        reason: 'dry_run_no_live_delivery',
      },
    });
    expect(out.contextTokenRef).toMatch(/^sha256:/);
    expect(JSON.stringify(out)).not.toContain('unit-context-secret');
    expect(JSON.stringify(out)).not.toContain('unit reply body should not echo');
  });
});
