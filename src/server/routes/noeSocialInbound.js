// @ts-check
// Public provider webhook endpoints for social inbound signals. These endpoints
// are protected by provider signatures/tokens, while the status endpoint stays
// owner-token protected.
import {
  buildSocialWebhookReadiness,
  createReplayGuard,
  createSocialWebhookReceiver,
  parseSimpleXml,
  readWebhookBody,
  timingSafeStringEqual,
  verifyWechatOfficialSignature,
} from '../../runtime/NoeSocialWebhookInbound.js';
import { createQqBridgeResearchGate } from '../../runtime/NoeQqBridgeResearchGate.js';
import { createWeChatPersonalBridge } from '../../runtime/NoeWeChatPersonalBridge.js';
import {
  normalizeFeishuWebhookEvent,
  normalizeWeChatOfficialMessage,
  normalizeWeComWebhookMessage,
} from '../../channels/InboundChannels.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function envValue(env = {}, key = '') {
  return Object.prototype.hasOwnProperty.call(env || {}, key) ? String(env[key] ?? '') : '';
}

// M6 修复：Express(4.x) async 路由 handler 若 reject 未被捕获会让请求永久挂起；包一层统一兜底响应。
function safeAsync(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(() => {
    try { if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal error' }); } catch { /* 兜底失败不再抛 */ }
  });
}

function header(req = {}, name = '') {
  if (typeof req.get === 'function') return req.get(name) || '';
  const lower = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function query(req = {}, name = '') {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function status(res, code) {
  return typeof res.status === 'function' ? res.status(code) : res;
}

function json(res, code, body) {
  const target = code === 200 ? res : status(res, code);
  if (typeof target.json === 'function') return target.json(body);
  target.end?.(JSON.stringify(body));
  return target;
}

function send(res, code, body, contentType = 'text/plain; charset=utf-8') {
  const target = code === 200 ? res : status(res, code);
  if (typeof target.set === 'function') target.set('Content-Type', contentType);
  else if (typeof target.type === 'function') target.type(contentType);
  if (typeof target.send === 'function') return target.send(body);
  target.end?.(body);
  return target;
}

function parseJsonBody(raw = '') {
  try { return JSON.parse(String(raw || '{}') || '{}'); } catch { return null; }
}

function wechatAckXml({ fromUser = '', toUser = '' } = {}) {
  const escape = (value) => String(value || '').replace(/]]>/g, ']]&gt;');
  return [
    '<xml>',
    `<ToUserName><![CDATA[${escape(fromUser)}]]></ToUserName>`,
    `<FromUserName><![CDATA[${escape(toUser)}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    '<Content><![CDATA[已收到，我会进入 Noe 入站队列处理。]]></Content>',
    '</xml>',
  ].join('');
}

function replayKey(provider, ...parts) {
  const body = parts.map((part) => text(part, 500)).filter(Boolean).join(':');
  return body ? `${provider}:${body}` : '';
}

export function registerNoeSocialInboundRoutes(app, {
  env = process.env,
  memory = null,
  gateway = null,
  onInboundMessage = null,
  now = () => Date.now(),
} = {}) {
  const replayGuard = createReplayGuard({ now });
  const receiver = createSocialWebhookReceiver({ gateway, memory, onInboundMessage, now });
  const wechatPersonal = createWeChatPersonalBridge({ memory, onInboundMessage, env, now });
  const qqGate = createQqBridgeResearchGate({ memory, onInboundMessage, env, now });

  app.get('/api/noe/social-inbound/status', requireOwnerToken, (_req, res) => {
    return json(res, 200, {
      ok: true,
      readiness: buildSocialWebhookReadiness(env),
      receiver: receiver.status(),
      wechatPersonal: wechatPersonal.status(),
      qq: qqGate.status(),
      publicEndpoints: {
        wechatOfficial: '/api/noe/social-inbound/wechat-official',
        wecom: '/api/noe/social-inbound/wecom',
        feishu: '/api/noe/social-inbound/feishu',
      },
      ownerEndpoints: {
        wechatPersonalStatus: '/api/noe/social-inbound/wechat-personal/status',
        wechatPersonalQr: '/api/noe/social-inbound/wechat-personal/qr',
        wechatPersonalInboundTest: '/api/noe/social-inbound/wechat-personal/inbound-test',
        wechatPersonalOutboundDryRun: '/api/noe/social-inbound/wechat-personal/outbound-dry-run',
        qqResearchGate: '/api/noe/social-inbound/qq/research-gate',
        qqPreview: '/api/noe/social-inbound/qq/preview',
        qqDryRun: '/api/noe/social-inbound/qq/dry-run',
      },
      discord: {
        supportedHere: false,
        reason: 'BaiLongma uses a Discord gateway connector, not an inbound webhook endpoint.',
      },
    });
  });

  app.get('/api/noe/social-inbound/wechat-personal/status', requireOwnerToken, (_req, res) => {
    return json(res, 200, { ok: true, bridge: wechatPersonal.status() });
  });

  app.get('/api/noe/social-inbound/wechat-personal/qr', requireOwnerToken, (_req, res) => {
    return json(res, 200, wechatPersonal.qr());
  });

  app.post('/api/noe/social-inbound/wechat-personal/inbound-test', requireOwnerToken, async (req, res) => {
    const raw = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseJsonBody(await readWebhookBody(req));
    if (!raw) return json(res, 400, { ok: false, error: 'invalid json' });
    const result = await wechatPersonal.receive(raw);
    return json(res, result.ok ? 200 : 202, {
      ok: true,
      accepted: result.ok === true && result.accepted !== false,
      channel: 'wechat_clawbot',
      gatewayMessageId: result.gatewayMessageId || '',
      contextToken: result.contextToken || undefined,
      admission: result.admission || undefined,
      reason: result.reason || '',
    });
  });

  app.post('/api/noe/social-inbound/wechat-personal/outbound-dry-run', requireOwnerToken, (req, res) => {
    const result = wechatPersonal.outboundDryRun(req.body || {});
    return json(res, result.allowed ? 200 : 400, result.allowed ? { ok: true, ...result } : { ok: false, ...result });
  });

  app.get('/api/noe/social-inbound/qq/research-gate', requireOwnerToken, (_req, res) => {
    return json(res, 200, { ok: true, gate: qqGate.status() });
  });

  app.post('/api/noe/social-inbound/qq/preview', requireOwnerToken, async (req, res) => {
    const raw = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseJsonBody(await readWebhookBody(req));
    if (!raw) return json(res, 400, { ok: false, error: 'invalid json' });
    const result = qqGate.preview(raw);
    return json(res, result.ok ? 200 : 400, result.ok ? { ok: true, ...result } : { ok: false, ...result });
  });

  app.post('/api/noe/social-inbound/qq/dry-run', requireOwnerToken, async (req, res) => {
    const raw = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseJsonBody(await readWebhookBody(req));
    if (!raw) return json(res, 400, { ok: false, error: 'invalid json' });
    const result = await qqGate.dryRun(raw);
    return json(res, result.ok ? 200 : 202, {
      ok: true,
      accepted: result.ok === true && result.accepted !== false,
      channel: 'qq_official',
      gatewayMessageId: result.gatewayMessageId || '',
      admission: result.admission || undefined,
      reason: result.reason || '',
    });
  });

  app.get('/api/noe/social-inbound/wechat-official', async (req, res) => {
    const token = envValue(env, 'WECHAT_OFFICIAL_TOKEN');
    if (!token) return send(res, 503, 'wechat official token not configured');
    const verification = verifyWechatOfficialSignature({
      token,
      signature: query(req, 'signature'),
      timestamp: query(req, 'timestamp'),
      nonce: query(req, 'nonce'),
      now,
    });
    if (!verification.ok) return send(res, 403, 'forbidden');
    return send(res, 200, text(query(req, 'echostr'), 1000));
  });

  app.post('/api/noe/social-inbound/wechat-official', safeAsync(async (req, res) => {
    const token = envValue(env, 'WECHAT_OFFICIAL_TOKEN');
    if (!token) return send(res, 503, 'wechat official token not configured');
    const signature = query(req, 'signature');
    const timestamp = query(req, 'timestamp');
    const nonce = query(req, 'nonce');
    const verification = verifyWechatOfficialSignature({ token, signature, timestamp, nonce, now });
    if (!verification.ok) return send(res, 403, 'forbidden');
    const replay = replayGuard.check(replayKey('wechat-official', timestamp, nonce, signature));
    if (!replay.ok) return send(res, 409, 'duplicate');

    const raw = await readWebhookBody(req);
    const msg = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseSimpleXml(raw);
    const normalized = normalizeWeChatOfficialMessage(msg);
    const result = await receiver.receive(normalized);
    if (!result.ok || result.accepted === false) return json(res, 202, { ok: true, accepted: false, reason: result.reason || 'not_delivered', admission: result.admission || undefined });
    return send(res, 200, wechatAckXml({ fromUser: msg.FromUserName || msg.fromUserName, toUser: msg.ToUserName || msg.toUserName }), 'application/xml; charset=utf-8');
  }));

  app.post('/api/noe/social-inbound/wecom', safeAsync(async (req, res) => {
    const expected = envValue(env, 'WECOM_INCOMING_TOKEN');
    if (!expected) return json(res, 503, { ok: false, error: 'wecom incoming token not configured' });
    const provided = text(header(req, 'authorization')).replace(/^Bearer\s+/i, '');
    if (!timingSafeStringEqual(provided, expected)) return json(res, 403, { ok: false, error: 'invalid token' });
    const raw = await readWebhookBody(req);
    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseJsonBody(raw);
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    const eventId = body.message_id || body.messageId || header(req, 'x-noe-event-id');
    // requireKey：缺 message_id/event-id → 空 replay key → 无法去重，拒绝而非静默放行 200
    // （否则同一条无 id 消息可被无限重放）。replay_detected 与 missing_replay_key 都返 409。
    const replay = replayGuard.check(replayKey('wecom', eventId), { requireKey: true });
    if (!replay.ok) return json(res, 409, { ok: false, error: replay.reason === 'missing_replay_key' ? 'missing_replay_key' : 'duplicate' });
    const result = await receiver.receive(normalizeWeComWebhookMessage(body));
    return json(res, result.ok ? 200 : 202, { ok: true, accepted: result.ok === true && result.accepted !== false, channel: 'wecom', replayGuarded: replay.guarded === true, reason: result.reason || '', admission: result.admission || undefined });
  }));

  app.post('/api/noe/social-inbound/feishu', safeAsync(async (req, res) => {
    const expected = envValue(env, 'FEISHU_VERIFICATION_TOKEN');
    if (!expected) return json(res, 503, { ok: false, error: 'feishu verification token not configured' });
    const raw = await readWebhookBody(req);
    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : parseJsonBody(raw);
    if (!body) return json(res, 400, { ok: false, error: 'invalid json' });
    if (body.challenge) {
      if (!timingSafeStringEqual(body.token, expected)) return json(res, 403, { ok: false, error: 'invalid token' });
      return json(res, 200, { challenge: body.challenge });
    }
    if (body.encrypt) return json(res, 400, { ok: false, error: 'encrypted feishu events are not enabled' });
    if (!timingSafeStringEqual(body.token, expected)) return json(res, 403, { ok: false, error: 'invalid token' });
    const message = body.event?.message || body.message || {};
    // requireKey：飞书事件缺 message_id → 空 replay key → 无法去重，拒绝而非静默放行 200。
    const replay = replayGuard.check(replayKey('feishu', message.message_id || body.message_id), { requireKey: true });
    if (!replay.ok) return json(res, 409, { ok: false, error: replay.reason === 'missing_replay_key' ? 'missing_replay_key' : 'duplicate' });
    const result = await receiver.receive(normalizeFeishuWebhookEvent(body));
    return json(res, result.ok ? 200 : 202, { ok: true, accepted: result.ok === true && result.accepted !== false, channel: 'feishu', replayGuarded: replay.guarded === true, reason: result.reason || '', admission: result.admission || undefined });
  }));

  return receiver;
}
