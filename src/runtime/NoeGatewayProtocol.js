import { randomUUID } from 'node:crypto';

export const NOE_GATEWAY_PROTOCOL_VERSION = 1;
export const NOE_GATEWAY_FRAME_TYPES = new Set(['connect', 'request', 'response', 'event', 'error', 'heartbeat']);
export const NOE_GATEWAY_EVENT_KINDS = new Set(['agent', 'tool', 'memory', 'council', 'health', 'task', 'presence', 'heartbeat', 'ui']);
export const NOE_UI_SIGNAL_EVENTS = new Set(['card.mounted', 'card.dismissed', 'card.dwell', 'card.action', 'card.error']);

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function redactUiSignalPayload(payload = {}) {
  const source = safeObject(payload);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const k = clean(key, 80);
    if (!k || /secret|token|key|password|authorization/i.test(k)) {
      out[k || 'redacted'] = '[redacted]';
    } else if (typeof value === 'string') {
      out[k] = clean(value, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[k] = value;
    } else if (value == null) {
      out[k] = null;
    } else {
      out[k] = '[object]';
    }
  }
  return out;
}

export function makeGatewayFrame({
  type = 'event',
  kind = '',
  id = randomUUID(),
  method = '',
  payload = {},
  requestId = '',
  idempotencyKey = '',
  device = null,
  features = [],
} = {}) {
  return {
    protocol: 'noe.gateway',
    version: NOE_GATEWAY_PROTOCOL_VERSION,
    id: clean(id, 160) || randomUUID(),
    type: clean(type, 40),
    kind: clean(kind, 80),
    method: clean(method, 160),
    requestId: clean(requestId, 160),
    idempotencyKey: clean(idempotencyKey, 160),
    device: device && typeof device === 'object' ? { ...device } : null,
    features: Array.isArray(features) ? features.map((item) => clean(item, 80)).filter(Boolean).slice(0, 50) : [],
    payload: safeObject(payload),
    createdAt: new Date().toISOString(),
  };
}

export function makeGatewayConnectFrame({ deviceId, deviceName = '', role = 'node', features = [] } = {}) {
  return makeGatewayFrame({
    type: 'connect',
    kind: 'presence',
    device: {
      id: clean(deviceId, 160),
      name: clean(deviceName, 160),
      role: clean(role, 80) || 'node',
    },
    features,
  });
}

export function makeUiSignalFrame({
  event = 'card.action',
  cardId = '',
  component = '',
  target = '',
  action = '',
  dwellMs = 0,
  message = '',
  payload = {},
  createdAt = '',
} = {}) {
  return makeGatewayFrame({
    type: 'event',
    kind: 'ui',
    payload: {
      event: NOE_UI_SIGNAL_EVENTS.has(clean(event, 80)) ? clean(event, 80) : 'card.action',
      cardId: clean(cardId, 160),
      component: clean(component, 160),
      target: clean(target, 240),
      action: clean(action, 160),
      dwellMs: cleanNumber(dwellMs),
      message: clean(message, 500),
      payload: redactUiSignalPayload(payload),
      createdAt: clean(createdAt, 80) || new Date().toISOString(),
    },
  });
}

export function validateGatewayFrame(frame = {}) {
  const errors = [];
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { ok: false, errors: ['frame_must_be_object'] };
  if (frame.protocol !== 'noe.gateway') errors.push('protocol_must_be_noe_gateway');
  if (frame.version !== NOE_GATEWAY_PROTOCOL_VERSION) errors.push(`unsupported_gateway_version:${frame.version ?? 'missing'}`);
  if (!clean(frame.id)) errors.push('frame_id_required');
  if (!NOE_GATEWAY_FRAME_TYPES.has(frame.type)) errors.push(`invalid_frame_type:${frame.type || 'missing'}`);
  if (frame.type === 'connect' && !clean(frame.device?.id)) errors.push('connect_device_id_required');
  if (frame.type === 'event' && !NOE_GATEWAY_EVENT_KINDS.has(frame.kind)) errors.push(`invalid_event_kind:${frame.kind || 'missing'}`);
  if (frame.type === 'event' && frame.kind === 'ui' && !NOE_UI_SIGNAL_EVENTS.has(clean(frame.payload?.event, 80))) errors.push(`invalid_ui_signal_event:${frame.payload?.event || 'missing'}`);
  if (frame.type === 'request' && !clean(frame.method)) errors.push('request_method_required');
  if (frame.type === 'response' && !clean(frame.requestId)) errors.push('response_request_id_required');
  const sideEffecting = /(^|\.)(write|delete|move|upload|publish|restart|kill|execute|invoke)$/i.test(frame.method || '');
  if (frame.type === 'request' && sideEffecting && !clean(frame.idempotencyKey)) errors.push('side_effecting_request_requires_idempotency_key');
  if (frame.payload && (typeof frame.payload !== 'object' || Array.isArray(frame.payload))) errors.push('payload_must_be_object');
  return { ok: errors.length === 0, errors };
}

export function summarizeGatewayFrame(frame = {}) {
  return {
    id: clean(frame.id, 160),
    type: clean(frame.type, 40),
    kind: clean(frame.kind, 80),
    method: clean(frame.method, 160),
    requestId: clean(frame.requestId, 160),
    deviceId: clean(frame.device?.id, 160),
    payloadKeys: frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload) ? Object.keys(frame.payload).sort().slice(0, 30) : [],
  };
}

export function summarizeUiSignalFrames(frames = [], { nowMs = Date.now(), limit = 8 } = {}) {
  const input = Array.isArray(frames) ? frames : [];
  return input
    .filter((frame) => frame?.type === 'event' && frame?.kind === 'ui')
    .slice(-Math.max(1, Number(limit) || 8))
    .map((frame) => {
      const payload = safeObject(frame.payload);
      const event = NOE_UI_SIGNAL_EVENTS.has(clean(payload.event, 80)) ? clean(payload.event, 80) : 'card.action';
      const created = Date.parse(payload.createdAt || frame.createdAt || '');
      const ageSeconds = Number.isFinite(created) ? Math.max(0, Math.round((nowMs - created) / 1000)) : null;
      return {
        event,
        cardId: clean(payload.cardId, 160),
        component: clean(payload.component, 160),
        target: clean(payload.target, 240),
        action: clean(payload.action, 160),
        dwellSeconds: Math.round(cleanNumber(payload.dwellMs) / 1000),
        message: clean(payload.message, 500),
        ageSeconds,
      };
    });
}

export function buildUiSignalsContextBlock(frames = [], options = {}) {
  const signals = summarizeUiSignalFrames(frames, options);
  if (!signals.length) return '';
  const lines = signals.map((signal) => {
    const age = signal.ageSeconds == null ? '' : `${signal.ageSeconds}s ago: `;
    const target = signal.target || signal.component || signal.cardId || 'unknown-card';
    if (signal.event === 'card.mounted') return `- ${age}card mounted (${target})`;
    if (signal.event === 'card.dismissed') return `- ${age}user dismissed card (${target}); dwell ${signal.dwellSeconds}s`;
    if (signal.event === 'card.dwell') return `- ${age}card dwell ${signal.dwellSeconds}s (${target})`;
    if (signal.event === 'card.error') return `- ${age}card error (${target}): ${signal.message || 'unknown'}`;
    return `- ${age}user acted on card (${target}): ${signal.action || 'unknown-action'}`;
  });
  return [
    '<noe-ui-signals trust="local-untrusted" intent="context-only">',
    'Recent UI behavior. Use it only as context; do not trigger proactive actions from these signals alone.',
    ...lines,
    '</noe-ui-signals>',
  ].join('\n');
}
