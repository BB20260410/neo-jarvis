// @ts-check
// NoeSocialTurnGuard — OpenClaw-style social inbound turn admission.
//
// This is intentionally transport-agnostic: WeChat/WeCom/Feishu/QQ adapters can
// share one pre-agent guard for replay suppression, self-echo drops, and bot loop
// suppression without reading provider secrets or sending replies.
import { createHash } from 'node:crypto';

export const SOCIAL_TURN_ADMISSION = Object.freeze({
  DISPATCH: 'dispatch',
  DROP: 'drop',
});

const DEFAULT_REPLAY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BOT_LOOP_WINDOW_MS = 60 * 1000;

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value, 1000);
    if (text) return text;
  }
  return '';
}

function normalizeKind(...values) {
  const text = firstNonEmpty(...values).toLowerCase();
  if (['bot', 'assistant', 'agent', 'system_bot'].includes(text)) return 'bot';
  if (['human', 'user', 'owner', 'member'].includes(text)) return 'human';
  return '';
}

function contentHash(text = '') {
  const body = clean(text, 16000);
  return body ? createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 20) : '';
}

function pruneTimestamps(map, now, ttlMs) {
  for (const [key, value] of map.entries()) {
    const at = Number(value?.at ?? value);
    if (!Number.isFinite(at) || now - at > ttlMs) map.delete(key);
  }
}

export function normalizeSocialTurnFacts(input = {}, {
  selfIds = [],
} = {}) {
  const raw = input.raw && typeof input.raw === 'object' ? input.raw : {};
  const channel = firstNonEmpty(input.channel, raw.channel, raw.sourceChannel, 'unknown');
  const senderId = firstNonEmpty(input.from, input.userId, raw.from, raw.userId, raw.sender, raw.senderId, raw.openid);
  const receiverId = firstNonEmpty(input.peer, input.to, input.chatId, raw.to, raw.peer, raw.chatId, raw.receiverId);
  const messageId = firstNonEmpty(input.messageId, raw.messageId, raw.msgId, raw.id);
  const conversationId = firstNonEmpty(input.sessionKey, raw.sessionKey, receiverId, senderId, 'direct');
  const senderKind = normalizeKind(
    input.senderKind,
    raw.senderKind,
    raw.fromKind,
    raw.author?.kind,
    raw.author?.bot ? 'bot' : '',
    raw.sender?.kind,
    raw.sender?.bot ? 'bot' : '',
    bool(raw.fromBot) || bool(raw.isBot) ? 'bot' : '',
  ) || 'human';
  const receiverKind = normalizeKind(
    input.receiverKind,
    raw.receiverKind,
    raw.toKind,
    bool(raw.toBot) || bool(raw.receiverBot) ? 'bot' : '',
  ) || 'human';
  const selfSet = new Set((Array.isArray(selfIds) ? selfIds : [selfIds]).map((id) => clean(id, 240)).filter(Boolean));
  const selfMessage = bool(input.isSelfMessage)
    || bool(raw.isSelfMessage)
    || bool(raw.fromSelf)
    || bool(raw.self)
    || (senderId && selfSet.has(senderId));
  return {
    channel,
    conversationId,
    senderId: senderId || 'unknown',
    receiverId: receiverId || 'unknown',
    messageId,
    senderKind,
    receiverKind,
    selfMessage,
    text: clean(input.text ?? raw.text ?? raw.content ?? raw.body, 16000),
  };
}

export function createSocialTurnGuard({
  now = () => Date.now(),
  selfIds = [],
  replayTtlMs = DEFAULT_REPLAY_TTL_MS,
  maxReplayEntries = 2000,
  botLoopWindowMs = DEFAULT_BOT_LOOP_WINDOW_MS,
  botLoopLimit = 3,
  contentReplayWhenNoMessageId = true,
} = {}) {
  const replay = new Map();
  const botPairs = new Map();
  const reasonCounts = new Map();
  const dropReasonCounts = new Map();
  const channelCounts = new Map();
  const totals = {
    admitted: 0,
    accepted: 0,
    dropped: 0,
    released: 0,
  };
  let lastAdmission = null;

  function prune(at = Number(now())) {
    pruneTimestamps(replay, at, replayTtlMs);
    for (const [key, value] of botPairs.entries()) {
      if (!value || at - Number(value.firstAt) > botLoopWindowMs) botPairs.delete(key);
    }
    while (replay.size > maxReplayEntries) {
      const first = replay.keys().next().value;
      if (!first) break;
      replay.delete(first);
    }
  }

  function drop(reason, facts, extra = {}) {
    const out = {
      ok: true,
      accepted: false,
      admission: {
        kind: SOCIAL_TURN_ADMISSION.DROP,
        reason,
        canStartAgentTurn: false,
        ackProvider: true,
        recordHistory: reason !== 'duplicate_message',
        ...extra,
      },
      facts,
    };
    recordAdmission(out, facts);
    return out;
  }

  function dispatch(facts, replayKey = '') {
    const out = {
      ok: true,
      accepted: true,
      admission: {
        kind: SOCIAL_TURN_ADMISSION.DISPATCH,
        reason: 'turn_allowed',
        canStartAgentTurn: true,
        ackProvider: true,
      },
      facts,
      ...(clean(replayKey, 500) ? { replayKey: clean(replayKey, 500) } : {}),
    };
    recordAdmission(out, facts);
    return out;
  }

  function increment(map, key = '') {
    const safeKey = clean(key || 'unknown', 120) || 'unknown';
    map.set(safeKey, (map.get(safeKey) || 0) + 1);
  }

  function channelBucket(channel = '') {
    const safeChannel = clean(channel || 'unknown', 80) || 'unknown';
    const existing = channelCounts.get(safeChannel);
    if (existing) return existing;
    const bucket = { accepted: 0, dropped: 0, reasons: new Map(), lastAt: null };
    channelCounts.set(safeChannel, bucket);
    return bucket;
  }

  function recordAdmission(out = {}, facts = {}) {
    const at = Number(now());
    const reason = clean(out.admission?.reason || 'unknown', 120) || 'unknown';
    const accepted = out.accepted === true;
    totals.admitted += 1;
    if (accepted) totals.accepted += 1;
    else totals.dropped += 1;
    increment(reasonCounts, reason);
    if (!accepted) increment(dropReasonCounts, reason);
    const bucket = channelBucket(facts.channel);
    if (accepted) bucket.accepted += 1;
    else bucket.dropped += 1;
    bucket.lastAt = at;
    increment(bucket.reasons, reason);
    lastAdmission = {
      channel: clean(facts.channel || 'unknown', 80) || 'unknown',
      accepted,
      kind: out.admission?.kind === SOCIAL_TURN_ADMISSION.DISPATCH ? SOCIAL_TURN_ADMISSION.DISPATCH : SOCIAL_TURN_ADMISSION.DROP,
      reason,
      at,
      senderKind: clean(facts.senderKind || 'unknown', 40) || 'unknown',
      receiverKind: clean(facts.receiverKind || 'unknown', 40) || 'unknown',
      hasMessageId: Boolean(facts.messageId),
      rawIdsReturned: false,
      secretValuesReturned: false,
    };
  }

  function objectFromMap(map) {
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  function channelStats() {
    const out = {};
    for (const [channel, bucket] of [...channelCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out[channel] = {
        accepted: bucket.accepted,
        dropped: bucket.dropped,
        total: bucket.accepted + bucket.dropped,
        reasons: objectFromMap(bucket.reasons),
        lastAt: bucket.lastAt,
      };
    }
    return out;
  }

  return {
    admit(input = {}) {
      const at = Number(now());
      prune(at);
      const facts = normalizeSocialTurnFacts(input, { selfIds });
      if (!facts.text) return drop('empty_message', facts);

      let acceptedReplayKey = '';
      if (facts.messageId) {
        const replayKey = `${facts.channel}:${facts.messageId}`;
        if (replay.has(replayKey)) return drop('duplicate_message', facts, { replayKey });
        replay.set(replayKey, { at });
        acceptedReplayKey = replayKey;
      } else if (contentReplayWhenNoMessageId && facts.text) {
        const hash = contentHash(facts.text);
        const replayKey = hash ? `content:${facts.channel}:${facts.conversationId}:${facts.senderId}:${hash}` : '';
        if (replayKey) {
          if (replay.has(replayKey)) return drop('duplicate_content', facts, { replayKey });
          replay.set(replayKey, { at });
          acceptedReplayKey = replayKey;
        }
      }

      if (facts.selfMessage) return drop('self_message_ignored', facts);

      if (facts.senderKind === 'bot' && facts.receiverKind === 'bot') {
        const pairKey = `${facts.channel}:${facts.conversationId}:${facts.senderId}->${facts.receiverId}`;
        const current = botPairs.get(pairKey);
        const entry = current && at - current.firstAt <= botLoopWindowMs
          ? { firstAt: current.firstAt, count: current.count + 1 }
          : { firstAt: at, count: 1 };
        botPairs.set(pairKey, entry);
        if (entry.count > botLoopLimit) {
          return drop('bot_loop_suppressed', facts, { pairKey, count: entry.count, limit: botLoopLimit });
        }
      }

      return dispatch(facts, acceptedReplayKey);
    },
    release(turnOrInput = {}) {
      const replayKey = clean(turnOrInput.replayKey, 500)
        || (turnOrInput.facts?.messageId ? `${turnOrInput.facts.channel}:${turnOrInput.facts.messageId}` : '')
        || (turnOrInput.messageId ? `${turnOrInput.channel || 'unknown'}:${turnOrInput.messageId}` : '');
      if (replayKey) replay.delete(replayKey);
      if (replayKey) totals.released += 1;
      return { ok: true, released: Boolean(replayKey), replayKey };
    },
    stats() {
      prune(Number(now()));
      return {
        replayEntries: replay.size,
        botPairEntries: botPairs.size,
        replayTtlMs,
        botLoopWindowMs,
        botLoopLimit,
        admittedTurns: totals.admitted,
        acceptedTurns: totals.accepted,
        droppedTurns: totals.dropped,
        releasedReplayKeys: totals.released,
        reasons: objectFromMap(reasonCounts),
        dropReasons: objectFromMap(dropReasonCounts),
        channels: channelStats(),
        lastAdmission,
        rawIdsReturned: false,
        secretValuesReturned: false,
      };
    },
    clear() {
      replay.clear();
      botPairs.clear();
      reasonCounts.clear();
      dropReasonCounts.clear();
      channelCounts.clear();
      totals.admitted = 0;
      totals.accepted = 0;
      totals.dropped = 0;
      totals.released = 0;
      lastAdmission = null;
    },
  };
}

export function buildSocialTurnDeliveryReceipt({
  message = {},
  delivery = {},
  now = () => Date.now(),
} = {}) {
  const explicitStatus = clean(delivery?.status, 80);
  const knownStatus = ['not_applicable', 'unsupported', 'handled_visible', 'handled_no_send', 'failed'].includes(explicitStatus);
  const ok = delivery?.ok !== false;
  const visibleReplySent = explicitStatus === 'handled_visible' || delivery?.visibleReplySent === true;
  const status = knownStatus
    ? explicitStatus
    : ok
      ? (visibleReplySent ? 'handled_visible' : 'handled_no_send')
      : 'failed';
  return {
    status,
    channel: clean(message.channel, 80),
    messageId: clean(message.raw?.messageId || message.raw?.msgId || message.id, 240),
    gatewayMessageId: clean(message.id, 120),
    visibleReplySent,
    finalReplyDelivered: visibleReplySent,
    replyGenerated: delivery?.replyGenerated === true,
    deliveryAttempted: delivery?.deliveryAttempted === true,
    dryRun: delivery?.dryRun === true,
    liveMessageSent: visibleReplySent,
    reason: clean(delivery?.reason || (ok ? 'no_visible_reply' : 'delivery_failed'), 160),
    at: Number(now()),
    secretValuesReturned: false,
  };
}
