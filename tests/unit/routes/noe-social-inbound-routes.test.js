import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerNoeSocialInboundRoutes } from '../../../src/server/routes/noeSocialInbound.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function makeReq({ query = {}, body = {}, rawBody = undefined, headers = {} } = {}) {
  return {
    query,
    body,
    rawBody,
    headers,
    get(name) {
      const lower = String(name || '').toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) return value;
      }
      return undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    json(body) { this.payload = body; return this; },
    send(body) { this.payload = body; return this; },
    end(body) { this.payload = body; return this; },
  };
}

function route(routes, method, path) {
  return routes.find((item) => item.method === method && item.path === path).handlers.at(-1);
}

function wechatSignature(token, timestamp, nonce) {
  return createHash('sha1').update([token, timestamp, nonce].sort().join(''), 'utf8').digest('hex');
}

describe('noe social inbound routes', () => {
  it('exposes owner-protected status without leaking configured values', async () => {
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: {
        WECHAT_OFFICIAL_TOKEN: 'secret-wechat-token',
        WECOM_INCOMING_TOKEN: 'secret-wecom-token',
        FEISHU_VERIFICATION_TOKEN: 'secret-feishu-token',
        DISCORD_BOT_TOKEN: 'secret-discord-token',
        WECHAT_PERSONAL_BRIDGE_TRANSPORT: 'wechat-ilink-client',
        WECHAT_PERSONAL_BRIDGE_QR_PROVIDER: 'local-owner-only',
        QQ_BOT_APP_ID: 'secret-qq-app-id',
        QQ_BOT_APP_SECRET: 'secret-qq-app-secret',
      },
    });
    const res = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/status')(makeReq(), res);
    expect(res.payload).toMatchObject({
      ok: true,
      readiness: {
        wechatOfficial: true,
        wecomIncoming: true,
        feishuVerification: true,
        discordGateway: true,
        credentialStatuses: {
          wechatOfficialToken: { status: 'available', available: true },
          wecomIncomingToken: { status: 'available', available: true },
          feishuVerificationToken: { status: 'available', available: true },
          discordBotToken: { status: 'available', available: true },
        },
        credentialSummary: {
          total: 4,
          available: 4,
          configuredUnavailable: 0,
          missing: 0,
        },
      },
      discord: {
        supportedHere: false,
      },
      wechatPersonal: {
        channel: 'wechat_clawbot',
        liveClientStarted: false,
        ownerVisibleEvidenceRequired: true,
        receiver: {
          delivered: 0,
          turnGuard: {
            admittedTurns: 0,
            rawIdsReturned: false,
            secretValuesReturned: false,
          },
        },
        readiness: {
          transportSelected: true,
          qrProviderConfigured: true,
          outboundRequiresOwnerVisibleEvidence: true,
        },
      },
      qq: {
        selectedTransport: 'qq_official_webhook',
        readyForDryRun: true,
        credentials: {
          appId: true,
          appSecret: true,
          credentialStatuses: {
            appId: { status: 'available', available: true },
            appSecret: { status: 'available', available: true },
            webhookSecret: { status: 'missing', available: false },
            publicCallbackUrl: { status: 'missing', available: false },
          },
        },
        credentialSummary: {
          total: 4,
          available: 2,
          missing: 2,
        },
        policy: {
          baiLongmaHasQqConnector: false,
        },
      },
      ownerEndpoints: {
        qqPreview: '/api/noe/social-inbound/qq/preview',
      },
    });
    const serialized = JSON.stringify(res.payload);
    expect(serialized).not.toContain('secret-wechat-token');
    expect(serialized).not.toContain('secret-wecom-token');
    expect(serialized).not.toContain('secret-feishu-token');
    expect(serialized).not.toContain('secret-discord-token');
    expect(serialized).not.toContain('secret-qq-app-id');
    expect(serialized).not.toContain('secret-qq-app-secret');
  });

  it('exposes personal WeChat owner-only contract routes without sending live messages', async () => {
    const captured = [];
    const writes = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: {
        WECHAT_PERSONAL_BRIDGE_TRANSPORT: 'wechat-ilink-client',
        WECHAT_PERSONAL_BRIDGE_QR_PROVIDER: 'local-owner-only',
      },
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
    });

    const statusRes = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/wechat-personal/status')(makeReq(), statusRes);
    expect(statusRes.payload).toMatchObject({
      ok: true,
      bridge: {
        channel: 'wechat_clawbot',
        liveClientStarted: false,
        ownerVisibleEvidenceRequired: true,
      },
    });

    const qrRes = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/wechat-personal/qr')(makeReq(), qrRes);
    expect(qrRes.payload).toMatchObject({
      ok: true,
      available: false,
      qr: { rawImageReturned: false, rawContentReturned: false },
    });

    const inboundRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-personal/inbound-test')(makeReq({
      body: { from_user_id: 'wx-owner', text: 'hello from personal wechat', context_token: 'unit-context-secret' },
    }), inboundRes);
    expect(inboundRes.payload).toMatchObject({ ok: true, accepted: true, channel: 'wechat_clawbot' });
    expect(inboundRes.payload.contextToken).toMatchObject({ available: true, rawTokenReturned: false, secretValuesReturned: false });
    expect(inboundRes.payload.contextToken.contextTokenRef).toMatch(/^sha256:/);
    expect(captured[0]).toMatchObject({ channel: 'wechat_clawbot', from: 'wx-owner', text: 'hello from personal wechat' });
    expect(writes[0]).toMatchObject({ scope: 'external_social_signal' });

    const duplicateInboundRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-personal/inbound-test')(makeReq({
      body: { from_user_id: 'wx-owner', text: 'hello from personal wechat', context_token: 'unit-context-secret' },
    }), duplicateInboundRes);
    expect(duplicateInboundRes.payload).toMatchObject({ ok: true, accepted: false, channel: 'wechat_clawbot', reason: 'duplicate_content' });
    expect(captured).toHaveLength(1);
    expect(writes).toHaveLength(1);

    const statusAfterInboundRes = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/wechat-personal/status')(makeReq(), statusAfterInboundRes);
    expect(statusAfterInboundRes.payload.bridge.receiver).toMatchObject({
      delivered: 1,
      turnGuard: {
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
          },
        },
        lastAdmission: {
          channel: 'wechat_clawbot',
          accepted: false,
          reason: 'duplicate_content',
          rawIdsReturned: false,
        },
      },
      contextTokens: { trackedPeers: 1, rawTokenReturned: false, secretValuesReturned: false },
    });

    const deniedRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-personal/outbound-dry-run')(makeReq({
      body: { channel: 'wechat_clawbot', text: 'reply without evidence' },
    }), deniedRes);
    expect(deniedRes.statusCode).toBe(400);
    expect(deniedRes.payload).toMatchObject({
      ok: false,
      liveMessageSent: false,
      replyGenerated: false,
      deliveryStatus: 'unsupported',
      deliveryReceipt: {
        status: 'unsupported',
        dryRun: true,
        finalReplyDelivered: false,
      },
    });

    const allowedRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-personal/outbound-dry-run')(makeReq({
      body: {
        text: 'reply with evidence',
        ownerVisibleEvidence: {
          channel: 'wechat_clawbot',
          sessionKey: 'wechat_clawbot:wx-owner:direct',
          messageId: inboundRes.payload.gatewayMessageId,
          ownerVisible: true,
        },
      },
    }), allowedRes);
    expect(allowedRes.payload).toMatchObject({
      ok: true,
      allowed: true,
      dryRunOnly: true,
      liveMessageSent: false,
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
      },
    });

    expect(JSON.stringify({ status: statusAfterInboundRes.payload, qr: qrRes.payload, inbound: inboundRes.payload, duplicate: duplicateInboundRes.payload, captured, writes, allowed: allowedRes.payload })).not.toContain('unit-context-secret');
    expect(JSON.stringify(allowedRes.payload)).not.toContain('reply with evidence');
  });

  it('exposes QQ owner-only research gate and dry-run adapter without live login', async () => {
    const captured = [];
    const writes = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: {
        QQ_BOT_APP_ID: 'unit-qq-app-id',
        QQ_BOT_APP_SECRET: 'unit-qq-app-secret',
      },
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
    });

    const gateRes = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/qq/research-gate')(makeReq(), gateRes);
    expect(gateRes.payload).toMatchObject({
      ok: true,
      gate: {
        selectedTransport: 'qq_official_webhook',
        readyForDryRun: true,
        readyForLiveWebhook: false,
        credentials: { appId: true, appSecret: true },
        policy: { baiLongmaHasQqConnector: false, noLiveLoginBeforeDryRun: true },
      },
    });

    const previewRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/qq/preview')(makeReq({
      body: {
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'qq-preview-1',
          group_openid: 'group-preview',
          content: 'hello preview',
          author: { id: 'preview-user' },
          access_token: 'unit-qq-preview-token-secret',
        },
      },
    }), previewRes);
    expect(previewRes.payload).toMatchObject({
      ok: true,
      accepted: false,
      dryRunOnly: true,
      liveMessageSent: false,
      normalized: {
        channel: 'qq_official',
        from: 'preview-user',
        peer: 'group-preview',
        text: 'hello preview',
      },
    });
    expect(captured).toHaveLength(0);
    expect(writes).toHaveLength(0);

    const dryRunRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/qq/dry-run')(makeReq({
      body: {
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'qq-msg-1',
          group_openid: 'group-1',
          content: 'hello qq',
          author: { id: 'user-1' },
          access_token: 'unit-qq-token-secret',
        },
      },
    }), dryRunRes);
    expect(dryRunRes.payload).toMatchObject({ ok: true, accepted: true, channel: 'qq_official' });
    expect(captured[0]).toMatchObject({ channel: 'qq_official', from: 'user-1', peer: 'group-1', text: 'hello qq' });
    expect(writes[0]).toMatchObject({ scope: 'external_social_signal' });

    expect(JSON.stringify({ gate: gateRes.payload, preview: previewRes.payload, dryRun: dryRunRes.payload, captured, writes })).not.toContain('unit-qq-token-secret');
    expect(JSON.stringify(previewRes.payload)).not.toContain('unit-qq-preview-token-secret');
    expect(JSON.stringify(gateRes.payload)).not.toContain('unit-qq-app-secret');
  });

  it('verifies WeChat official callbacks, delivers XML messages, and blocks replay', async () => {
    const token = 'unit-wechat-token';
    const timestamp = '1000';
    const nonce = 'nonce-1';
    const signature = wechatSignature(token, timestamp, nonce);
    const captured = [];
    const writes = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: { WECHAT_OFFICIAL_TOKEN: token },
      now: () => 1000_000,
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
    });

    const verifyRes = makeRes();
    await route(routes, 'get', '/api/noe/social-inbound/wechat-official')(makeReq({
      query: { signature, timestamp, nonce, echostr: 'echo-ok' },
    }), verifyRes);
    expect(verifyRes.payload).toBe('echo-ok');

    const rawBody = '<xml><ToUserName><![CDATA[to]]></ToUserName><FromUserName><![CDATA[from_openid]]></FromUserName><MsgType><![CDATA[text]]></MsgType><MsgId>m1</MsgId><Content><![CDATA[hello wechat]]></Content></xml>';
    const postReq = makeReq({ query: { signature, timestamp, nonce }, rawBody });
    const postRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-official')(postReq, postRes);
    expect(postRes.statusCode).toBe(200);
    expect(String(postRes.payload)).toContain('进入 Noe 入站队列');
    expect(captured[0]).toMatchObject({
      channel: 'wechat_official',
      from: 'from_openid',
      text: 'hello wechat',
    });
    expect(writes[0]).toMatchObject({ scope: 'external_social_signal', sourceType: 'social_inbound' });

    const replayRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wechat-official')(postReq, replayRes);
    expect(replayRes.statusCode).toBe(409);
    expect(replayRes.payload).toBe('duplicate');
  });

  it('handles Feishu challenge and message events without copying verification token', async () => {
    const captured = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: { FEISHU_VERIFICATION_TOKEN: 'unit-feishu-token' },
      onInboundMessage: (message) => captured.push(message),
    });
    const challengeRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/feishu')(makeReq({
      body: { challenge: 'challenge-ok', token: 'unit-feishu-token' },
    }), challengeRes);
    expect(challengeRes.payload).toEqual({ challenge: 'challenge-ok' });

    const eventReq = makeReq({
      body: {
        token: 'unit-feishu-token',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou-1' } },
          message: { chat_id: 'oc-1', message_id: 'om-1', content: JSON.stringify({ text: 'hello feishu' }) },
        },
      },
    });
    const eventRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/feishu')(eventReq, eventRes);
    expect(eventRes.payload).toMatchObject({ ok: true, accepted: true, channel: 'feishu', replayGuarded: true });
    expect(captured[0]).toMatchObject({ channel: 'feishu', from: 'ou-1', peer: 'oc-1', text: 'hello feishu' });
    expect(JSON.stringify(captured[0])).not.toContain('unit-feishu-token');

    const replayRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/feishu')(eventReq, replayRes);
    expect(replayRes.statusCode).toBe(409);
  });

  it('accepts WeCom bearer-auth webhooks and rejects duplicate event ids', async () => {
    const captured = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: { WECOM_INCOMING_TOKEN: 'unit-wecom-token' },
      onInboundMessage: (message) => captured.push(message),
    });
    const req = makeReq({
      headers: { Authorization: 'Bearer unit-wecom-token', 'X-Noe-Event-Id': 'evt-1' },
      body: { from_id: 'wecom:webhook:default', text: { content: 'hello wecom' } },
    });
    const res = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wecom')(req, res);
    expect(res.payload).toMatchObject({ ok: true, accepted: true, channel: 'wecom', replayGuarded: true });
    expect(captured[0]).toMatchObject({
      channel: 'wecom',
      from: 'wecom:webhook:default',
      text: 'hello wecom',
    });

    const replayRes = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wecom')(req, replayRes);
    expect(replayRes.statusCode).toBe(409);
  });

  it('rejects WeCom webhooks with no message id / event id instead of silently accepting (replay-undedupable)', async () => {
    // B1.5 bug①：无 message_id 且无 X-Noe-Event-Id → replay key 为空 → 不可去重 → 必须拒绝(409)，
    // 绝不能静默放行 200（否则同一条无 id 消息可被无限重放，且 handler/memory 被反复触发）。
    const captured = [];
    const writes = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: { WECOM_INCOMING_TOKEN: 'unit-wecom-token' },
      onInboundMessage: (message) => captured.push(message),
      memory: { write: (item) => { writes.push(item); return item; } },
    });
    const req = makeReq({
      headers: { Authorization: 'Bearer unit-wecom-token' },
      body: { from_id: 'wecom:webhook:default', text: { content: 'no id message' } },
    });
    const res = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/wecom')(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ ok: false, error: 'missing_replay_key' });
    // 关键安全断言：未去重的消息绝不能进 handler / 写记忆
    expect(captured).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('rejects Feishu message events with no message_id instead of silently accepting (replay-undedupable)', async () => {
    // B1.5 bug①：飞书事件缺 message_id → replay key 为空 → 拒绝，不静默放行。
    const captured = [];
    const { app, routes } = makeApp();
    registerNoeSocialInboundRoutes(app, {
      env: { FEISHU_VERIFICATION_TOKEN: 'unit-feishu-token' },
      onInboundMessage: (message) => captured.push(message),
    });
    const eventReq = makeReq({
      body: {
        token: 'unit-feishu-token',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou-1' } },
          message: { chat_id: 'oc-1', content: JSON.stringify({ text: 'no id feishu' }) },
        },
      },
    });
    const res = makeRes();
    await route(routes, 'post', '/api/noe/social-inbound/feishu')(eventReq, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ ok: false, error: 'missing_replay_key' });
    expect(captured).toHaveLength(0);
  });
});
