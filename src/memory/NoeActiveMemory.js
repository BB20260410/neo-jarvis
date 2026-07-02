import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_ACTIVE_MEMORY_SCHEMA_VERSION = 1;
const FOCUS_CONCLUSION_SCOPE = 'focus_conclusion';
const DEFAULT_RECALL_FAILURE_THRESHOLD = 3;
const DEFAULT_RECALL_COOLDOWN_MS = 60_000;

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function shouldRecall({ enabled = true, directSession = true, goal = '', minChars = 8 } = {}) {
  return enabled !== false && directSession !== false && clean(goal).length >= minChars;
}

function normalizeMemoryItem(item = {}) {
  return {
    id: clean(item.id, 160),
    scope: clean(item.scope, 120),
    text: redactSensitiveText(clean(item.text || item.body || item.content || item.title || '', 1200)),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
  };
}

export function sanitizeActiveMemoryRecallError(error, max = 180) {
  const raw = typeof error === 'string' ? error : (error?.message || error?.code || error?.name || 'recall_failed');
  return redactSensitiveText(clean(raw, max))
    .replace(/\bBearer\s+\S{12,}/gi, 'Bearer [redacted]')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:tp|sk|pk|rk|gh[pousr]|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim() || 'recall_failed';
}

export function createActiveMemoryRecallCircuitBreaker({
  failureThreshold = DEFAULT_RECALL_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_RECALL_COOLDOWN_MS,
  now = Date.now,
} = {}) {
  const threshold = Math.max(1, Number(failureThreshold) || DEFAULT_RECALL_FAILURE_THRESHOLD);
  const cooldown = Math.max(1, Number(cooldownMs) || DEFAULT_RECALL_COOLDOWN_MS);
  const clock = typeof now === 'function' ? now : Date.now;
  const states = new Map();
  const keyOf = (key) => clean(key || 'default', 240) || 'default';
  const freshState = () => ({ failures: 0, openedAt: 0, retryAt: 0, lastError: '' });

  function current(key) {
    const k = keyOf(key);
    const state = states.get(k) || freshState();
    const t = clock();
    if (state.retryAt && t >= state.retryAt) {
      state.openedAt = 0;
      state.retryAt = 0;
      states.set(k, state);
    }
    return { key: k, state, nowMs: t };
  }

  return {
    canAttempt(key = 'default') {
      const { key: k, state, nowMs } = current(key);
      if (state.retryAt && nowMs < state.retryAt) {
        return {
          ok: false,
          open: true,
          reason: 'active_memory_circuit_open',
          key: k,
          failures: state.failures,
          retryAt: state.retryAt,
          remainingMs: Math.max(0, state.retryAt - nowMs),
          lastError: state.lastError,
        };
      }
      return {
        ok: true,
        open: false,
        reason: '',
        key: k,
        failures: state.failures,
        retryAt: state.retryAt,
        remainingMs: 0,
        lastError: state.lastError,
      };
    },
    recordSuccess(key = 'default') {
      const k = keyOf(key);
      states.delete(k);
      return { ok: true, open: false, key: k, failures: 0, retryAt: 0, remainingMs: 0, lastError: '' };
    },
    recordFailure(key = 'default', error = null) {
      const k = keyOf(key);
      const state = states.get(k) || freshState();
      const t = clock();
      state.failures += 1;
      state.lastError = sanitizeActiveMemoryRecallError(error);
      if (state.failures >= threshold) {
        state.openedAt = t;
        state.retryAt = t + cooldown;
      }
      states.set(k, state);
      return {
        ok: false,
        open: Boolean(state.retryAt && t < state.retryAt),
        reason: state.retryAt ? 'active_memory_circuit_open' : 'active_memory_recall_failed',
        key: k,
        failures: state.failures,
        retryAt: state.retryAt,
        remainingMs: state.retryAt ? Math.max(0, state.retryAt - t) : 0,
        lastError: state.lastError,
      };
    },
    status(key = 'default') {
      return this.canAttempt(key);
    },
    reset(key = '') {
      if (key) states.delete(keyOf(key));
      else states.clear();
      return { ok: true };
    },
  };
}

function asTime(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(date) {
  const d = startOfDay(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d;
}

export function parseNoeChineseTimeWindow(query = '', { now = new Date() } = {}) {
  const text = clean(query, 1000);
  const current = now instanceof Date ? now : new Date(now);
  if (/刚刚|刚才|上一轮|上一次|最近/.test(text)) {
    return { matched: true, label: 'recent', startMs: current.getTime() - 24 * 60 * 60 * 1000, endMs: current.getTime() + 1 };
  }
  if (/昨天/.test(text)) {
    const start = addDays(startOfDay(current), -1);
    return { matched: true, label: 'yesterday', startMs: start.getTime(), endMs: startOfDay(current).getTime() };
  }
  if (/前天/.test(text)) {
    const start = addDays(startOfDay(current), -2);
    return { matched: true, label: 'day_before_yesterday', startMs: start.getTime(), endMs: addDays(start, 1).getTime() };
  }
  if (/上周|上星期/.test(text)) {
    const thisWeek = startOfWeekMonday(current);
    const lastWeek = addDays(thisWeek, -7);
    return { matched: true, label: 'last_week', startMs: lastWeek.getTime(), endMs: thisWeek.getTime() };
  }
  return { matched: false, label: '', startMs: 0, endMs: 0 };
}

function focusConclusionWriteAuthorized({ userAck = false, consensusAck = null } = {}) {
  if (userAck === true) return true;
  if (!consensusAck || typeof consensusAck !== 'object') return false;
  return consensusAck.ledgerVerified === true
    && consensusAck.source === 'validated_consensus_ledger'
    && (consensusAck.passed === true || consensusAck.gate?.passed === true || consensusAck.gate?.ok === true);
}

export function writeFocusConclusionMemory({
  memory,
  focus = {},
  summary = '',
  projectId = 'noe',
  evidenceRefs = [],
  userAck = false,
  consensusAck = null,
} = {}) {
  if (!focusConclusionWriteAuthorized({ userAck, consensusAck })) {
    return { ok: false, error: 'focus_conclusion_ack_required', memory: null };
  }
  if (!memory?.write) return { ok: false, error: 'memory_write_unavailable', memory: null };
  const title = clean(focus.title || focus.focusId || focus.id || 'focus_conclusion', 240);
  const body = [
    'focus_conclusion',
    `标题：${title}`,
    `摘要：${clean(summary || focus.summary || focus.currentDecision || title, 4000)}`,
    evidenceRefs?.length ? `证据：${evidenceRefs.map((ref) => clean(ref, 500)).filter(Boolean).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const written = memory.write({
    projectId,
    scope: FOCUS_CONCLUSION_SCOPE,
    title: `focus_conclusion: ${title}`,
    body,
    sourceType: 'focus_conclusion',
    sourceId: clean(focus.focusId || focus.id, 160) || null,
    tags: ['focus', 'focus_conclusion'],
  });
  return { ok: true, memory: written };
}

export function recallFocusConclusions({
  query = '',
  projectId = 'noe',
  memory,
  now = new Date(),
  limit = 6,
} = {}) {
  if (!memory?.recall) return { ok: true, skipped: true, timeWindow: parseNoeChineseTimeWindow(query, { now }), memories: [] };
  const timeWindow = parseNoeChineseTimeWindow(query, { now });
  if (!timeWindow.matched) return { ok: true, skipped: true, timeWindow, memories: [] };
  const raw = memory.recall({ q: '', projectId, scope: FOCUS_CONCLUSION_SCOPE, limit: Math.max(limit * 4, 20), bumpHits: false });
  const memories = (Array.isArray(raw) ? raw : [])
    .filter((item) => {
      const ts = asTime(item.updatedAt || item.updated_at || item.createdAt || item.created_at);
      return ts >= timeWindow.startMs && ts < timeWindow.endMs;
    })
    .map(normalizeMemoryItem)
    .filter((item) => item.text)
    .slice(0, limit);
  return { ok: true, skipped: memories.length === 0, timeWindow, memories };
}

export function buildActiveMemoryContext({
  goal = '',
  projectId = 'noe',
  scope = '',
  memory,
  enabled = true,
  directSession = true,
  limit = 6,
  now = new Date(),
  circuitBreaker = null,
  circuitKey = '',
} = {}) {
  if (!shouldRecall({ enabled, directSession, goal })) {
    return {
      schemaVersion: NOE_ACTIVE_MEMORY_SCHEMA_VERSION,
      ok: true,
      skipped: true,
      reason: 'active_memory_not_applicable',
      systemPromptAddition: '',
      memories: [],
      debug: { projectId, scope, directSession: Boolean(directSession) },
    };
  }
  const recallKey = circuitKey || `${projectId}:${scope || 'all'}:active-memory`;
  const circuit = circuitBreaker?.canAttempt?.(recallKey);
  if (circuit && circuit.ok === false) {
    return {
      schemaVersion: NOE_ACTIVE_MEMORY_SCHEMA_VERSION,
      ok: true,
      skipped: true,
      reason: 'active_memory_circuit_open',
      systemPromptAddition: '',
      memories: [],
      debug: { projectId, scope, directSession: Boolean(directSession), circuitBreaker: circuit },
    };
  }
  let raw = [];
  let focusRecall = { memories: [], timeWindow: parseNoeChineseTimeWindow(goal, { now }) };
  try {
    raw = memory?.recall ? memory.recall({ q: clean(goal, 1000), projectId, scope: scope || undefined, limit }) : [];
    focusRecall = recallFocusConclusions({ query: goal, projectId, memory, now, limit });
    circuitBreaker?.recordSuccess?.(recallKey);
  } catch (error) {
    const failure = circuitBreaker?.recordFailure?.(recallKey, error);
    return {
      schemaVersion: NOE_ACTIVE_MEMORY_SCHEMA_VERSION,
      ok: false,
      skipped: true,
      reason: 'active_memory_recall_failed',
      systemPromptAddition: '',
      memories: [],
      debug: {
        projectId,
        scope,
        directSession: Boolean(directSession),
        circuitBreaker: failure || null,
        error: sanitizeActiveMemoryRecallError(error),
      },
    };
  }
  const seen = new Set();
  const memories = [...(Array.isArray(raw) ? raw : []).map(normalizeMemoryItem), ...(focusRecall.memories || [])]
    .filter((item) => item.text && !seen.has(item.id || item.text) && seen.add(item.id || item.text))
    .slice(0, limit);
  const systemPromptAddition = memories.length
    ? `<memory-context source="noe-active-memory" trust="local-untrusted">\n${memories.map((item) => `- ${item.text}`).join('\n')}\n</memory-context>`
    : '';
  return {
    schemaVersion: NOE_ACTIVE_MEMORY_SCHEMA_VERSION,
    ok: true,
    skipped: memories.length === 0,
    reason: memories.length ? '' : 'active_memory_no_recall',
    systemPromptAddition,
    memories,
    debug: {
      projectId,
      scope,
      directSession: Boolean(directSession),
      memoryCount: memories.length,
      focusConclusionTimeWindow: focusRecall.timeWindow?.matched ? focusRecall.timeWindow.label : '',
    },
  };
}
