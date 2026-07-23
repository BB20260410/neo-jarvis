// @ts-check
// Social webhook inbound bridge: provider webhook -> normalized inbound event ->
// NoeInboundGateway. It deliberately records only a small redacted memory and
// never echoes provider secrets or raw signed payloads.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createInboundGateway } from './NoeInboundGateway.js';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { createSocialTurnGuard } from './NoeSocialTurnGuard.js';

export const SOCIAL_WEBHOOK_CHANNELS = Object.freeze(['wechat_official', 'wecom', 'feishu']);
export const SOCIAL_WEBHOOK_REPLAY_TTL_MS = 5 * 60 * 1000;
export const CREDENTIAL_STATUS = Object.freeze({
  AVAILABLE: 'available',
  CONFIGURED_UNAVAILABLE: 'configured_unavailable',
  MISSING: 'missing',
});

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function hasConfiguredKey(env = {}, key = '') {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

export function projectEnvCredential(env = {}, keys = [], {
  id = '',
  label = '',
  required = true,
  source = 'env',
} = {}) {
  const aliases = (Array.isArray(keys) ? keys : [keys]).map((key) => clean(key, 120)).filter(Boolean);
  const presentKey = aliases.find((key) => hasConfiguredKey(env, key));
  const safeId = clean(id || aliases[0] || 'credential', 120);
  if (!presentKey) {
    return {
      id: safeId,
      label: clean(label || safeId, 120),
      status: CREDENTIAL_STATUS.MISSING,
      configured: false,
      available: false,
      required: required === true,
      source,
      key: aliases[0] || safeId,
      aliases,
      reason: 'not_configured',
    };
  }
  const hasValue = clean(env[presentKey], 4096).length > 0;
  return {
    id: safeId,
    label: clean(label || safeId, 120),
    status: hasValue ? CREDENTIAL_STATUS.AVAILABLE : CREDENTIAL_STATUS.CONFIGURED_UNAVAILABLE,
    configured: true,
    available: hasValue,
    required: required === true,
    source,
    key: presentKey,
    aliases,
    reason: hasValue ? 'configured' : 'configured_empty_or_unavailable',
  };
}

export function summarizeCredentialStatuses(records = []) {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  const summary = {
    total: list.length,
    available: 0,
    configuredUnavailable: 0,
    missing: 0,
    required: 0,
    requiredAvailable: 0,
    requiredMissing: 0,
    requiredConfiguredUnavailable: 0,
  };
  for (const item of list) {
    if (!item) continue;
    if (item.required) summary.required += 1;
    if (item.status === CREDENTIAL_STATUS.AVAILABLE) {
      summary.available += 1;
      if (item.required) summary.requiredAvailable += 1;
    } else if (item.status === CREDENTIAL_STATUS.CONFIGURED_UNAVAILABLE) {
      summary.configuredUnavailable += 1;
      if (item.required) summary.requiredConfiguredUnavailable += 1;
    } else {
      summary.missing += 1;
      if (item.required) summary.requiredMissing += 1;
    }
  }
  return {
    ...summary,
    ready: summary.required > 0 && summary.requiredAvailable === summary.required,
  };
}

export function buildSocialWebhookReadiness(env = {}) {
  const credentialStatuses = {
    wechatOfficialToken: projectEnvCredential(env, 'WECHAT_OFFICIAL_TOKEN', { id: 'wechatOfficialToken', label: 'WeChat Official token' }),
    wecomIncomingToken: projectEnvCredential(env, 'WECOM_INCOMING_TOKEN', { id: 'wecomIncomingToken', label: 'WeCom incoming token' }),
    feishuVerificationToken: projectEnvCredential(env, 'FEISHU_VERIFICATION_TOKEN', { id: 'feishuVerificationToken', label: 'Feishu verification token' }),
    discordBotToken: projectEnvCredential(env, 'DISCORD_BOT_TOKEN', { id: 'discordBotToken', label: 'Discord bot token', required: false }),
  };
  return {
    wechatOfficial: credentialStatuses.wechatOfficialToken.configured,
    wecomIncoming: credentialStatuses.wecomIncomingToken.configured,
    feishuVerification: credentialStatuses.feishuVerificationToken.configured,
    discordGateway: credentialStatuses.discordBotToken.configured,
    credentialStatuses,
    credentialSummary: summarizeCredentialStatuses(credentialStatuses),
    note: 'Booleans preserve key-presence compatibility. credentialStatuses distinguish available/configured_unavailable/missing. Secret values are never returned.',
  };
}

export function timingSafeStringEqual(a = '', b = '') {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || !right.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyWechatOfficialSignature({
  token = '',
  signature = '',
  timestamp = '',
  nonce = '',
  now = () => Date.now(),
  toleranceMs = SOCIAL_WEBHOOK_REPLAY_TTL_MS,
} = {}) {
  const cleanToken = String(token || '');
  const cleanSignature = clean(signature, 128).toLowerCase();
  const cleanTimestamp = clean(timestamp, 32);
  const cleanNonce = clean(nonce, 128);
  if (!cleanToken || !cleanSignature || !cleanTimestamp || !cleanNonce) {
    return { ok: false, reason: 'missing_signature_fields' };
  }
  const tsMs = Number(cleanTimestamp) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Number(now()) - tsMs) > toleranceMs) {
    return { ok: false, reason: 'timestamp_outside_window' };
  }
  const expected = createHash('sha1')
    .update([cleanToken, cleanTimestamp, cleanNonce].sort().join(''), 'utf8')
    .digest('hex');
  return timingSafeStringEqual(cleanSignature, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature_invalid' };
}

export function createReplayGuard({ now = () => Date.now(), ttlMs = SOCIAL_WEBHOOK_REPLAY_TTL_MS, maxEntries = 1000 } = {}) {
  const seen = new Map();

  function prune(at = Number(now())) {
    for (const [key, value] of seen.entries()) {
      if (at - value > ttlMs) seen.delete(key);
    }
    while (seen.size > maxEntries) {
      const first = seen.keys().next().value;
      if (!first) break;
      seen.delete(first);
    }
  }

  return {
    // requireKey=true：空 key 表示「拿不到 message_id / event id」=无法去重，必须拒绝而非静默放行
    // （否则同一条无 id 消息可被无限重放，handler/记忆被反复触发）。默认 false 保持向后兼容：
    // 像 wechat-official 这类 key 由 timestamp+nonce+signature 组成、结构上永不为空的渠道行为不变。
    check(key = '', { requireKey = false } = {}) {
      const id = clean(key, 500);
      const at = Number(now());
      prune(at);
      if (!id) return requireKey ? { ok: false, reason: 'missing_replay_key', guarded: false } : { ok: true, guarded: false };
      if (seen.has(id)) return { ok: false, reason: 'replay_detected' };
      seen.set(id, at);
      return { ok: true, guarded: true };
    },
    size() {
      prune(Number(now()));
      return seen.size;
    },
  };
}

export function parseSimpleXml(text = '') {
  const out = {};
  const source = String(text || '');
  const re = /<([A-Za-z0-9_:-]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match = null;
  while ((match = re.exec(source))) {
    const key = match[1];
    const value = clean(match[2] ?? match[3] ?? '', 16000);
    if (key === 'xml') {
      Object.assign(out, parseSimpleXml(value));
      continue;
    }
    if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = value;
  }
  return out;
}

export async function readWebhookBody(req = {}) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return JSON.stringify(req.body);
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

export function buildGatewayPayload(normalized = {}) {
  const channel = clean(normalized.channel, 80);
  const userId = clean(normalized.userId || normalized.chatId || 'unknown', 240) || 'unknown';
  return {
    from: userId,
    to: clean(normalized.chatId, 240),
    userId,
    chatId: clean(normalized.chatId, 240),
    text: clean(normalized.text, 16000),
    platform: clean(normalized.platform || normalized.channel, 120),
    messageId: clean(normalized.messageId, 240),
    msgType: clean(normalized.msgType, 120),
    sourceChannel: channel,
    senderKind: clean(normalized.senderKind, 40),
    receiverKind: clean(normalized.receiverKind, 40),
    isSelfMessage: normalized.isSelfMessage === true,
  };
}

export function buildSocialInboundMemory(message = {}, { projectId = 'noe' } = {}) {
  const channel = clean(message.channel, 80);
  const from = clean(message.from, 240);
  const messageId = clean(message.raw?.messageId, 240);
  const sourceId = messageId ? `social-inbound:${channel}:${messageId}` : `social-inbound:${channel}:${from}:${message.id || message.at || Date.now()}`;
  const body = redactSensitiveText(`External social inbound via ${channel} from ${from}: ${clean(message.text, 800)}`);
  return {
    projectId,
    scope: 'external_social_signal',
    title: `External social inbound: ${channel}`,
    body,
    sourceType: 'social_inbound',
    sourceId,
    tags: ['social-inbound', channel].filter(Boolean),
    salience: 3,
    confidence: 0.72,
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  };
}

export function createSocialWebhookReceiver({
  gateway = null,
  memory = null,
  onInboundMessage = null,
  projectId = 'noe',
  now = () => Date.now(),
  turnGuard = null,
  selfIds = [],
} = {}) {
  const delivered = [];
  let deliveredCount = 0;
  const guard = turnGuard || createSocialTurnGuard({ now, selfIds });
  const inboundGateway = gateway || createInboundGateway({
    now,
    turnGuard: guard,
    onMessage: async (message) => {
      delivered.push(message);
      deliveredCount += 1;
      // L1 修复：delivered 无上限会随入站流量在长驻进程无界增长；只留最近 200 条引用，总数用计数器。
      if (delivered.length > 200) delivered.splice(0, delivered.length - 200);
      if (memory?.write) {
        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* memory write must not break provider ack */ }
      }
      if (typeof onInboundMessage === 'function') await onInboundMessage(message);
    },
  });

  for (const channel of SOCIAL_WEBHOOK_CHANNELS) {
    if (!inboundGateway.has?.(channel)) inboundGateway.register(channel, {});
  }

  return {
    gateway: inboundGateway,
    delivered,
    async receive(normalized = {}) {
      const channel = clean(normalized.channel, 80);
      if (!SOCIAL_WEBHOOK_CHANNELS.includes(channel)) return { ok: false, reason: 'unsupported_channel' };
      const payload = buildGatewayPayload(normalized);
      if (!payload.text) return { ok: false, reason: 'empty_message' };
      const result = await inboundGateway.receive(channel, payload);
      if (!result.ok) return result;
      return {
        ok: true,
        accepted: result.accepted !== false,
        channel,
        messageId: payload.messageId,
        gatewayMessageId: result.message?.id,
        ...(result.admission ? { admission: result.admission } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
    status() {
      return { channels: inboundGateway.list?.() || [], delivered: deliveredCount, turnGuard: guard.stats?.() || null };
    },
  };
}
