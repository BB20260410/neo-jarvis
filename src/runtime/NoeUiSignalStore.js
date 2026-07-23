import {
  NOE_UI_SIGNAL_EVENTS,
  buildUiSignalsContextBlock,
  makeUiSignalFrame,
  summarizeUiSignalFrames,
  validateGatewayFrame,
} from './NoeGatewayProtocol.js';

export const NOE_UI_SIGNAL_STORE_SCHEMA_VERSION = 1;

function clean(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function cleanLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function normalizeEvent(value) {
  return clean(value, 80);
}

export class NoeUiSignalStore {
  constructor({ maxSignals = 200 } = {}) {
    this.maxSignals = Math.max(20, Math.min(2000, Number(maxSignals) || 200));
    this.items = [];
  }

  record(input = {}) {
    const event = normalizeEvent(input.event || input.type || input.frame?.payload?.event || 'card.action');
    if (!NOE_UI_SIGNAL_EVENTS.has(event)) {
      return { ok: false, error: `invalid_ui_signal_event:${event || 'missing'}` };
    }
    const frameInput = input.frame && typeof input.frame === 'object'
      ? { ...(input.frame.payload || {}), id: input.frame.id }
      : input;
    const frame = makeUiSignalFrame({ ...frameInput, event });
    const validation = validateGatewayFrame(frame);
    if (!validation.ok) return { ok: false, error: validation.errors[0] || 'invalid_ui_signal_frame', errors: validation.errors };
    const [signal] = summarizeUiSignalFrames([frame]);
    const item = {
      id: clean(frame.id, 160),
      schemaVersion: NOE_UI_SIGNAL_STORE_SCHEMA_VERSION,
      consumed: false,
      recordedAt: new Date().toISOString(),
      frame,
      signal,
    };
    this.items.push(item);
    if (this.items.length > this.maxSignals) this.items.splice(0, this.items.length - this.maxSignals);
    return { ok: true, item, signal };
  }

  list({ includeConsumed = false, limit = 20 } = {}) {
    const max = cleanLimit(limit);
    return this.items
      .filter((item) => includeConsumed || !item.consumed)
      .slice(-max)
      .map((item) => ({
        id: item.id,
        schemaVersion: item.schemaVersion,
        consumed: item.consumed,
        recordedAt: item.recordedAt,
        signal: item.signal,
      }));
  }

  /**
   * 非消费式读法：取未消费信号拼上下文块，但**不**标记 consumed。
   * 供聊天注入（NoeTurnContextEngine ui-signals 段）用——consume() 是 noeLocalCouncil
   * 议会路径的消费语义（读后清），聊天注入绝不能抢消费饿死议会，只允许 peek。
   */
  peekContextBlock({ limit = 20 } = {}) {
    const frames = this.items
      .filter((item) => !item.consumed)
      .slice(-cleanLimit(limit))
      .map((item) => item.frame);
    return buildUiSignalsContextBlock(frames);
  }

  consume({ limit = 20 } = {}) {
    const selected = this.items.filter((item) => !item.consumed).slice(-cleanLimit(limit));
    for (const item of selected) item.consumed = true;
    const frames = selected.map((item) => item.frame);
    return {
      ok: true,
      count: selected.length,
      signals: selected.map((item) => ({
        id: item.id,
        recordedAt: item.recordedAt,
        signal: item.signal,
      })),
      contextBlock: buildUiSignalsContextBlock(frames),
    };
  }

  clearConsumed() {
    const before = this.items.length;
    this.items = this.items.filter((item) => !item.consumed);
    return { ok: true, removed: before - this.items.length };
  }

  snapshot() {
    return {
      schemaVersion: NOE_UI_SIGNAL_STORE_SCHEMA_VERSION,
      total: this.items.length,
      unconsumed: this.items.filter((item) => !item.consumed).length,
      consumed: this.items.filter((item) => item.consumed).length,
    };
  }
}

export const defaultNoeUiSignalStore = new NoeUiSignalStore();
