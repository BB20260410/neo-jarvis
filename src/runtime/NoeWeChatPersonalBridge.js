// @ts-check
// No-secret contract for a future personal WeChat bridge. It does not start a
// live WeChat client; it only fixes the safe QR/status/inbound/outbound shape.
import { createHash } from 'node:crypto';
import { normalizeWeChatClawbotMessage } from '../channels/InboundChannels.js';
import { createInboundGateway } from './NoeInboundGateway.js';
import { buildGatewayPayload, buildSocialInboundMemory } from './NoeSocialWebhookInbound.js';
import { buildSocialTurnDeliveryReceipt, createSocialTurnGuard } from './NoeSocialTurnGuard.js';

export const WECHAT_PERSONAL_CHANNEL = 'wechat_clawbot';

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function hasConfiguredKey(env = {}, key = '') {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

function boolEnv(env = {}, key = '') {
  return /^(1|true|yes|on)$/i.test(clean(env?.[key], 40));
}

function tokenHash(value = '') {
  const token = clean(value, 4096);
  return token ? createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 24) : '';
}

function safeLoginState(value = '') {
  const state = clean(value || 'not_configured', 80).toLowerCase();
  return ['not_configured', 'offline', 'qr_pending', 'connected', 'expired', 'error'].includes(state) ? state : 'unknown';
}

export function buildWeChatPersonalReadiness(env = {}) {
  return {
    transportSelected: hasConfiguredKey(env, 'WECHAT_PERSONAL_BRIDGE_TRANSPORT'),
    qrProviderConfigured: hasConfiguredKey(env, 'WECHAT_PERSONAL_BRIDGE_QR_PROVIDER'),
    liveClientAllowedByEnv: boolEnv(env, 'WECHAT_PERSONAL_BRIDGE_ENABLED'),
    liveClientStarted: false,
    outboundRequiresOwnerVisibleEvidence: true,
    note: 'Only booleans and safe contract state are reported. QR payloads, cookies, context tokens, and session secrets are never returned.',
  };
}

export function sanitizeWeChatPersonalStatus(raw = {}, { env = {} } = {}) {
  const readiness = buildWeChatPersonalReadiness(env);
  return {
    ok: true,
    channel: WECHAT_PERSONAL_CHANNEL,
    loginState: safeLoginState(raw.loginState || raw.state || (readiness.transportSelected ? 'offline' : 'not_configured')),
    transport: readiness.transportSelected ? clean(env.WECHAT_PERSONAL_BRIDGE_TRANSPORT, 80) : 'not_configured',
    liveClientStarted: false,
    qrPending: Boolean(raw.qrPending) && readiness.qrProviderConfigured,
    lastInboundAt: Number.isFinite(Number(raw.lastInboundAt)) ? Number(raw.lastInboundAt) : null,
    ownerVisibleEvidenceRequired: true,
    readiness,
  };
}

export function sanitizeWeChatPersonalQr(raw = {}) {
  const available = raw.available === true;
  return {
    ok: true,
    available,
    state: safeLoginState(raw.state || (available ? 'qr_pending' : 'not_configured')),
    qr: {
      id: clean(raw.id || raw.qrId || '', 120),
      expiresAt: clean(raw.expiresAt || '', 80),
      rawImageReturned: false,
      rawContentReturned: false,
    },
    reason: available ? '' : clean(raw.reason || 'transport_not_configured', 160),
    note: 'The QR image/content is intentionally withheld because scanning material is session-sensitive.',
  };
}

export function validateWeChatPersonalOutboundEvidence(payload = {}) {
  const evidence = payload.ownerVisibleEvidence || payload.evidence || {};
  const channel = clean(evidence.channel || payload.channel, 80);
  const hasPeer = Boolean(clean(evidence.sessionKey || evidence.chatId || evidence.userId || payload.chatId, 240));
  const hasInboundRef = Boolean(clean(evidence.messageId || evidence.gatewayMessageId || evidence.sourceId, 240))
    || Number.isFinite(Number(evidence.lastInboundAt));
  const ownerVisible = evidence.ownerVisible === true || evidence.source === 'owner_visible_inbound';
  const errors = [];
  if (![WECHAT_PERSONAL_CHANNEL, 'wechat_personal'].includes(channel)) errors.push('owner_visible_channel_mismatch');
  if (!hasPeer) errors.push('missing_owner_visible_peer');
  if (!hasInboundRef) errors.push('missing_recent_inbound_reference');
  if (!ownerVisible) errors.push('owner_visible_evidence_required');
  return {
    ok: errors.length === 0,
    errors,
    channel: channel || WECHAT_PERSONAL_CHANNEL,
    dryRunOnly: true,
    liveMessageSent: false,
  };
}

export function createWeChatPersonalContextTokenStore({ now = () => Date.now() } = {}) {
  const tokens = new Map();
  function key(accountId = '', peerId = '') {
    return `${clean(accountId || 'local-wechat-personal', 120)}:${clean(peerId || 'unknown', 240)}`;
  }
  function meta(record = null) {
    return record
      ? {
          available: true,
          contextTokenRef: record.contextTokenRef,
          updatedAt: record.updatedAt,
          rawTokenReturned: false,
          secretValuesReturned: false,
        }
      : {
          available: false,
          contextTokenRef: '',
          updatedAt: null,
          rawTokenReturned: false,
          secretValuesReturned: false,
        };
  }
  return {
    set(accountId = '', peerId = '', token = '') {
      const ref = tokenHash(token);
      if (!ref) return meta(null);
      const record = { contextTokenRef: `sha256:${ref}`, updatedAt: Number(now()) };
      tokens.set(key(accountId, peerId), record);
      return meta(record);
    },
    get(accountId = '', peerId = '') {
      return meta(tokens.get(key(accountId, peerId)) || null);
    },
    summary() {
      let lastUpdatedAt = null;
      for (const record of tokens.values()) {
        if (lastUpdatedAt === null || record.updatedAt > lastUpdatedAt) lastUpdatedAt = record.updatedAt;
      }
      return {
        trackedPeers: tokens.size,
        lastUpdatedAt,
        rawTokenReturned: false,
        secretValuesReturned: false,
      };
    },
  };
}

export function createWeChatPersonalBridge({
  gateway = null,
  memory = null,
  onInboundMessage = null,
  projectId = 'noe',
  env = process.env,
  statusProvider = null,
  qrProvider = null,
  now = () => Date.now(),
  turnGuard = null,
  selfIds = [],
  contextTokenStore = null,
} = {}) {
  const delivered = [];
  const accountId = clean(env.WECHAT_PERSONAL_BRIDGE_ACCOUNT_ID || 'local-wechat-personal', 120);
  const guard = turnGuard || createSocialTurnGuard({ now, selfIds });
  const tokenStore = contextTokenStore || createWeChatPersonalContextTokenStore({ now });
  const inboundGateway = gateway || createInboundGateway({
    now,
    turnGuard: guard,
    onMessage: async (message) => {
      delivered.push(message);
      if (memory?.write) {
        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* memory write must not break dry-run ack */ }
      }
      if (typeof onInboundMessage === 'function') await onInboundMessage(message);
    },
  });
  if (!inboundGateway.has?.(WECHAT_PERSONAL_CHANNEL)) inboundGateway.register(WECHAT_PERSONAL_CHANNEL, {});

  return {
    gateway: inboundGateway,
    delivered,
    readiness() {
      return buildWeChatPersonalReadiness(env);
    },
    status() {
      const raw = typeof statusProvider === 'function' ? statusProvider() || {} : {};
      return {
        ...sanitizeWeChatPersonalStatus(raw, { env }),
        receiver: {
          delivered: delivered.length,
          turnGuard: guard.stats?.() || null,
          contextTokens: tokenStore.summary(),
        },
      };
    },
    qr() {
      const raw = typeof qrProvider === 'function' ? qrProvider() || {} : {};
      return sanitizeWeChatPersonalQr(raw);
    },
    async receive(raw = {}) {
      const normalized = normalizeWeChatClawbotMessage(raw);
      if (!normalized) return { ok: false, reason: 'empty_message' };
      const contextToken = clean(raw.context_token || raw.contextToken, 4096);
      const tokenMeta = contextToken ? tokenStore.set(accountId, normalized.userId || normalized.chatId, contextToken) : tokenStore.get(accountId, normalized.userId || normalized.chatId);
      const payload = buildGatewayPayload(normalized);
      const result = await inboundGateway.receive(WECHAT_PERSONAL_CHANNEL, payload);
      if (!result.ok) return result;
      return {
        ok: true,
        accepted: result.accepted !== false,
        channel: WECHAT_PERSONAL_CHANNEL,
        gatewayMessageId: result.message?.id,
        messageId: payload.messageId || '',
        contextToken: tokenMeta,
        ...(result.admission ? { admission: result.admission } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
    outboundDryRun(payload = {}) {
      const evidence = validateWeChatPersonalOutboundEvidence(payload);
      const evidenceBody = payload.ownerVisibleEvidence || payload.evidence || {};
      const replyText = clean(payload.text || payload.body || payload.content, 16000);
      const errors = [...evidence.errors];
      if (!replyText) errors.push('missing_reply_text');
      const allowed = evidence.ok && Boolean(replyText);
      const peerId = clean(evidenceBody.userId || evidenceBody.chatId || payload.chatId, 240)
        || clean(String(evidenceBody.sessionKey || '').split(':')[1], 240);
      const contextToken = peerId ? tokenStore.get(accountId, peerId) : tokenStore.summary();
      const deliveryReceipt = buildSocialTurnDeliveryReceipt({
        now,
        message: {
          id: clean(evidenceBody.gatewayMessageId || evidenceBody.messageId || evidenceBody.sourceId, 160),
          channel: evidence.channel,
          raw: {
            messageId: clean(evidenceBody.messageId || evidenceBody.sourceId || evidenceBody.gatewayMessageId, 160),
          },
        },
        delivery: {
          ok: allowed,
          status: allowed ? 'handled_no_send' : 'unsupported',
          reason: allowed ? 'dry_run_no_live_delivery' : 'outbound_gate_blocked',
          replyGenerated: allowed,
          deliveryAttempted: false,
          dryRun: true,
          visibleReplySent: false,
        },
      });
      return {
        ok: allowed,
        allowed,
        errors,
        channel: evidence.channel,
        dryRunOnly: true,
        liveMessageSent: false,
        contextTokenAvailable: contextToken.available === true,
        contextTokenRef: contextToken.contextTokenRef || '',
        contextTokenWouldBeUsed: allowed && contextToken.available === true,
        rawContextTokenReturned: false,
        replyGenerated: allowed,
        deliveryStatus: deliveryReceipt.status,
        deliveryReceipt,
        finalReplyDelivered: deliveryReceipt.finalReplyDelivered,
        reason: allowed ? 'owner_visible_evidence_present_dry_run_no_delivery' : 'outbound_gate_blocked',
      };
    },
  };
}
