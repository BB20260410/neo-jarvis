// @ts-check
// QQ bridge research gate. BaiLongma has no QQ connector, so Noe must select a
// transport explicitly and prove a dry-run adapter before any live QQ login.
import { createInboundGateway } from './NoeInboundGateway.js';
import {
  CREDENTIAL_STATUS,
  buildGatewayPayload,
  buildSocialInboundMemory,
  projectEnvCredential,
  summarizeCredentialStatuses,
} from './NoeSocialWebhookInbound.js';
import { createSocialTurnGuard } from './NoeSocialTurnGuard.js';

export const QQ_OFFICIAL_CHANNEL = 'qq_official';

export const QQ_TRANSPORT_RESEARCH_SOURCES = Object.freeze([
  {
    id: 'qq_official_intro',
    title: 'QQ Bot official introduction',
    url: 'https://bot.q.qq.com/wiki/',
    evidence: 'Official QQ Bot platform supports standardized API and webhook events; production uses IP whitelist restrictions.',
  },
  {
    id: 'qq_official_webhook',
    title: 'QQ Bot event subscription and webhook',
    url: 'https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html',
    evidence: 'Official docs describe receiving events through HTTP callbacks, signature verification, and callback port constraints.',
  },
  {
    id: 'onebot_v12',
    title: 'OneBot V12 protocol',
    url: 'https://onebots.pages.dev/en/protocol/onebot-v12/',
    evidence: 'Community protocol option, useful for local adapters but not an official QQ transport by itself.',
  },
  {
    id: 'llonebot',
    title: 'LLOneBot / LLBot',
    url: 'https://www.llonebot.com/',
    evidence: 'Community QQNT-based bot framework supporting OneBot 11, Milky, and Satori protocols.',
  },
]);

const QQ_TRANSPORT_OPTIONS = Object.freeze([
  {
    id: 'qq_official_webhook',
    label: 'QQ Official Bot Webhook',
    selectedForNoe: true,
    official: true,
    liveLoginType: 'bot_app',
    requirements: [
      'QQ Bot AppID/AppSecret stored through secret broker or environment readiness only',
      'public HTTPS callback on an allowed QQ webhook port before live mode',
      'signature verification implemented before public webhook exposure',
      'sandbox allowlist exercised before production review',
    ],
    risks: ['ip_whitelist_required', 'public_callback_required', 'credential_secret', 'platform_review'],
  },
  {
    id: 'qq_official_websocket',
    label: 'QQ Official Bot WebSocket',
    selectedForNoe: false,
    official: true,
    liveLoginType: 'bot_app',
    requirements: ['Gateway URL retrieval', 'heartbeat/reconnect ledger', 'intent subscription audit'],
    risks: ['gateway_lifecycle', 'provider_mode_drift'],
  },
  {
    id: 'onebot_qqnt',
    label: 'OneBot over QQNT/LLOneBot',
    selectedForNoe: false,
    official: false,
    liveLoginType: 'local_personal_client',
    requirements: ['explicit owner approval', 'local client process isolation', 'no credential scraping', 'read-only dry-run first'],
    risks: ['personal_account_terms', 'local_client_security', 'plugin_supply_chain', 'session_secret'],
  },
]);

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value, 2000);
    if (text) return text;
  }
  return '';
}

function credentialReadiness(env = {}) {
  const credentialStatuses = {
    appId: projectEnvCredential(env, ['QQ_BOT_APP_ID', 'QQ_APP_ID'], { id: 'appId', label: 'QQ Bot AppID' }),
    appSecret: projectEnvCredential(env, ['QQ_BOT_APP_SECRET', 'QQ_CLIENT_SECRET'], { id: 'appSecret', label: 'QQ Bot AppSecret' }),
    webhookSecret: projectEnvCredential(env, ['QQ_BOT_WEBHOOK_SECRET', 'QQ_WEBHOOK_SECRET'], { id: 'webhookSecret', label: 'QQ webhook secret' }),
    publicCallbackUrl: projectEnvCredential(env, ['QQ_BOT_PUBLIC_CALLBACK_URL', 'QQ_PUBLIC_CALLBACK_URL'], { id: 'publicCallbackUrl', label: 'QQ public callback URL' }),
  };
  return {
    appId: credentialStatuses.appId.configured,
    appSecret: credentialStatuses.appSecret.configured,
    webhookSecret: credentialStatuses.webhookSecret.configured,
    publicCallbackUrl: credentialStatuses.publicCallbackUrl.configured,
    credentialStatuses,
    credentialSummary: summarizeCredentialStatuses(credentialStatuses),
  };
}

function pushCredentialBlocker(blockers, record, missing, unavailable) {
  if (!record || record.status === CREDENTIAL_STATUS.MISSING) blockers.push(missing);
  else if (record.status === CREDENTIAL_STATUS.CONFIGURED_UNAVAILABLE) blockers.push(unavailable);
}

export function buildQqBridgeResearchGate({ env = {}, selectedTransport = 'qq_official_webhook' } = {}) {
  const credentials = credentialReadiness(env);
  const selected = QQ_TRANSPORT_OPTIONS.find((item) => item.id === selectedTransport) || QQ_TRANSPORT_OPTIONS[0];
  const credentialSummary = credentials.credentialSummary || summarizeCredentialStatuses(credentials.credentialStatuses || {});
  const readyForLiveWebhook = selected.id === 'qq_official_webhook'
    && credentialSummary.ready;
  const blockers = [];
  if (selected.id !== 'qq_official_webhook') blockers.push('selected_transport_not_qq_official_webhook');
  pushCredentialBlocker(blockers, credentials.credentialStatuses?.appId, 'qq_bot_app_id_not_configured', 'qq_bot_app_id_configured_unavailable');
  pushCredentialBlocker(blockers, credentials.credentialStatuses?.appSecret, 'qq_bot_app_secret_not_configured', 'qq_bot_app_secret_configured_unavailable');
  pushCredentialBlocker(blockers, credentials.credentialStatuses?.webhookSecret, 'qq_webhook_secret_not_configured', 'qq_webhook_secret_configured_unavailable');
  pushCredentialBlocker(blockers, credentials.credentialStatuses?.publicCallbackUrl, 'qq_public_callback_url_not_configured', 'qq_public_callback_url_configured_unavailable');
  blockers.push('live_signature_verification_not_enabled');
  return {
    ok: true,
    status: 'research_gate_done_live_blocked',
    selectedTransport: selected.id,
    selectedTransportLabel: selected.label,
    readyForDryRun: true,
    readyForLiveWebhook,
    credentials,
    credentialSummary,
    blockers: readyForLiveWebhook ? ['live_signature_verification_not_enabled'] : blockers,
    transports: QQ_TRANSPORT_OPTIONS,
    sources: QQ_TRANSPORT_RESEARCH_SOURCES,
    policy: {
      baiLongmaHasQqConnector: false,
      noPersonalQqClientByDefault: true,
      noLiveLoginBeforeDryRun: true,
      noSecretValuesReturned: true,
    },
  };
}

export function normalizeQqOfficialEvent(event = {}) {
  const data = event.d || event.event || event.message || event;
  const author = data.author || data.user || data.member?.user || event.author || {};
  const userId = firstNonEmpty(author.id, author.user_openid, data.author_id, data.user_openid, data.openid, data.sender?.id);
  const chatId = firstNonEmpty(data.group_openid, data.guild_id, data.channel_id, data.c2c_openid, data.chat_id, userId);
  const text = firstNonEmpty(data.content, data.text, data.message?.content, event.content, event.text);
  if (!text) return null;
  return {
    channel: QQ_OFFICIAL_CHANNEL,
    chatId,
    userId: userId || chatId || 'unknown',
    userName: firstNonEmpty(author.username, author.name, data.member?.nick),
    text,
    platform: 'qq-official-bot',
    messageId: firstNonEmpty(data.id, data.message_id, data.msg_id, event.id, event.message_id),
    msgType: firstNonEmpty(event.t, event.type, data.type, 'message'),
    senderKind: author.bot === true || data.senderKind === 'bot' || event.senderKind === 'bot' ? 'bot' : 'human',
    receiverKind: firstNonEmpty(data.receiverKind, event.receiverKind),
  };
}

export function previewQqOfficialEvent(event = {}) {
  const normalized = normalizeQqOfficialEvent(event);
  if (!normalized) {
    return {
      ok: false,
      reason: 'empty_message',
      accepted: false,
      dryRunOnly: true,
      liveMessageSent: false,
    };
  }
  return {
    ok: true,
    reason: 'preview_only_no_delivery',
    accepted: false,
    dryRunOnly: true,
    liveMessageSent: false,
    channel: QQ_OFFICIAL_CHANNEL,
    normalized: {
      channel: normalized.channel,
      platform: normalized.platform,
      peer: normalized.chatId,
      from: normalized.userId,
      userName: normalized.userName,
      text: normalized.text,
      messageId: normalized.messageId,
      msgType: normalized.msgType,
    },
  };
}

export function createQqBridgeResearchGate({
  gateway = null,
  memory = null,
  onInboundMessage = null,
  projectId = 'noe',
  env = process.env,
  now = () => Date.now(),
  turnGuard = null,
  selfIds = [],
} = {}) {
  const delivered = [];
  const guard = turnGuard || createSocialTurnGuard({ now, selfIds });
  const inboundGateway = gateway || createInboundGateway({
    now,
    turnGuard: guard,
    onMessage: async (message) => {
      delivered.push(message);
      if (memory?.write) {
        try { memory.write(buildSocialInboundMemory(message, { projectId })); } catch { /* dry-run memory write must not break ack */ }
      }
      if (typeof onInboundMessage === 'function') await onInboundMessage(message);
    },
  });
  if (!inboundGateway.has?.(QQ_OFFICIAL_CHANNEL)) inboundGateway.register(QQ_OFFICIAL_CHANNEL, {});

  return {
    gateway: inboundGateway,
    status() {
      return { ...buildQqBridgeResearchGate({ env }), receiver: { delivered: delivered.length, turnGuard: guard.stats?.() || null } };
    },
    async dryRun(event = {}) {
      const normalized = normalizeQqOfficialEvent(event);
      if (!normalized) return { ok: false, reason: 'empty_message' };
      const payload = buildGatewayPayload(normalized);
      const result = await inboundGateway.receive(QQ_OFFICIAL_CHANNEL, payload);
      if (!result.ok) return result;
      return {
        ok: true,
        accepted: result.accepted !== false,
        channel: QQ_OFFICIAL_CHANNEL,
        gatewayMessageId: result.message?.id,
        messageId: payload.messageId || '',
        ...(result.admission ? { admission: result.admission } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
    preview(event = {}) {
      return previewQqOfficialEvent(event);
    },
  };
}
