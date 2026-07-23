// @ts-check
// NoeTaskReportbackQueue — owner-visible task progress spine.
//
// The conversation layer may say "I will go check it", but the real work runs
// later in NoeWorkspace. This queue gives that async path a durable, UI-consumable
// progress channel: accepted/running/done/failed/blocked/awaiting_approval.

import { randomUUID } from 'node:crypto';
import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

const VERSION = 1;
const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_SPEECH_LEASE_MS = 180_000;
const ACTIVE_STATUSES = new Set(['accepted', 'queued', 'running', 'awaiting_approval']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'blocked']);
const SPEECH_CONFIRM_STATUSES = new Set([...TERMINAL_STATUSES, 'awaiting_approval']);
const STATUS_SET = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const QUIET_SYSTEM_REPAIR_RE = /^系统自修复：/;

function redactText(value, max = 800) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeStatus(status) {
  const s = String(status || '').trim();
  return STATUS_SET.has(s) ? s : 'running';
}

function normalizeItem(input = {}, { idGen, now }) {
  const t = now();
  const goalId = redactText(input.goalId || '', 180) || null;
  const taskId = redactText(input.taskId || goalId || '', 180) || null;
  const status = normalizeStatus(input.status);
  const stepIndex = Number.isInteger(input.stepIndex) ? input.stepIndex : Number.isInteger(Number(input.stepIndex)) ? Number(input.stepIndex) : null;
  const title = redactText(input.title || input.goalTitle || input.task || '', 180) || (goalId ? `任务 ${goalId.slice(0, 8)}` : 'Noe 任务');
  const summary = redactText(input.summary || input.note || input.message || '', 900);
  const kind = redactText(input.kind || input.source || '', 80) || null;
  const dedupeKey = redactText(input.dedupeKey || `${taskId || goalId || title}:${stepIndex ?? ''}:${status}:${kind || ''}`, 260);
  const systemRepairReport = QUIET_SYSTEM_REPAIR_RE.test(title) || kind === 'incident_repair' || input.source === 'incident_escalator';
  return {
    id: redactText(input.id || `trb_${idGen()}`, 120),
    taskId,
    goalId,
    title,
    summary,
    status,
    kind,
    stepIndex,
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.map((x) => redactText(x, 220)).filter(Boolean).slice(0, 10)
      : [],
    speak: input.speak === undefined ? !systemRepairReport && (TERMINAL_STATUSES.has(status) || status === 'awaiting_approval') : input.speak === true,
    dedupeKey,
    source: redactText(input.source || 'workspace', 80),
    createdAt: Number(input.createdAt) || t,
    updatedAt: t,
    deliveredAt: null,
    spokenAt: input.spokenAt || null,
    speechFailedAt: input.speechFailedAt || null,
    speechError: input.speechError ? redactText(input.speechError, 180) : null,
    systemSpeechFallbackAt: input.systemSpeechFallbackAt || null,
    speechLeaseUntil: Number(input.speechLeaseUntil) || null,
    systemSpeechFallback: input.systemSpeechFallback && typeof input.systemSpeechFallback === 'object'
      ? {
          attempted: input.systemSpeechFallback.attempted === true,
          command: redactText(input.systemSpeechFallback.command || '', 40) || null,
          provider: redactText(input.systemSpeechFallback.provider || '', 40) || null,
          reason: redactText(input.systemSpeechFallback.reason || '', 120) || null,
          error: redactText(input.systemSpeechFallback.error || '', 120) || null,
        }
      : null,
  };
}

function isSpeechConfirmable(item) {
  return item?.speak === true && SPEECH_CONFIRM_STATUSES.has(String(item.status || '')) && !item.spokenAt && !item.speechFailedAt;
}

function speechLeaseActive(item, at) {
  return isSpeechConfirmable(item) && Number(item.speechLeaseUntil || 0) > at;
}

function needsSpeechConfirmation(item, at = Date.now()) {
  return isSpeechConfirmable(item) && !speechLeaseActive(item, at);
}

export function createTaskReportbackQueue({
  file = null,
  now = Date.now,
  idGen = randomUUID,
  maxItems = DEFAULT_MAX_ITEMS,
  speechLeaseMs = DEFAULT_SPEECH_LEASE_MS,
} = {}) {
  let state = { version: VERSION, items: [] };

  function load() {
    if (!file) return;
    const data = readJsonWithCorruptBackup(file, { label: 'noe-task-reportbacks' });
    if (data && Array.isArray(data.items)) {
      state = { version: VERSION, items: data.items.filter(Boolean).slice(-maxItems) };
    }
  }

  function save() {
    state.items = state.items.slice(-maxItems);
    if (file) atomicWriteJson(file, state, { mode: 0o600 });
  }

  function add(input = {}) {
    load();
    const item = normalizeItem(input, { idGen, now });
    const existing = state.items.find((x) => x.dedupeKey === item.dedupeKey);
    if (existing) {
      Object.assign(existing, {
        ...item,
        id: existing.id,
        createdAt: existing.createdAt,
        deliveredAt: null,
      });
      save();
      return { ...existing };
    }
    state.items.push(item);
    save();
    return { ...item };
  }

  function list({ limit = 50, delivered = null } = {}) {
    load();
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const t = now();
    return state.items
      .filter((item) => delivered === null ? true : delivered ? Boolean(item.deliveredAt) : (!item.deliveredAt || needsSpeechConfirmation(item, t)))
      .slice(-lim)
      .map((item) => ({ ...item }));
  }

  function claimSpeechItem(item, t) {
    item.speechLeaseUntil = t + Math.max(30_000, Number(speechLeaseMs) || DEFAULT_SPEECH_LEASE_MS);
    item.deliveredAt = t;
  }

  function consume({ limit = 50 } = {}) {
    load();
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const t = now();
    let speechLeaseTaken = state.items.some((item) => speechLeaseActive(item, t));
    const picked = [];
    for (const item of state.items) {
      if (picked.length >= lim) break;
      if (isSpeechConfirmable(item)) {
        if (speechLeaseTaken || speechLeaseActive(item, t)) continue;
        claimSpeechItem(item, t);
        speechLeaseTaken = true;
        picked.push(item);
      } else if (!item.deliveredAt) {
        item.deliveredAt = t;
        picked.push(item);
      }
    }
    if (picked.length) save();
    return picked.map((item) => ({ ...item }));
  }

  function consumeSpeech({ limit = 1, since = 0 } = {}) {
    load();
    const lim = Math.max(1, Math.min(10, Number(limit) || 1));
    const minCreatedAt = Math.max(0, Number(since) || 0);
    const t = now();
    if (state.items.some((item) => speechLeaseActive(item, t))) return [];
    const picked = [];
    for (const item of state.items) {
      if (picked.length >= lim) break;
      if (!isSpeechConfirmable(item)) continue;
      if (minCreatedAt && Number(item.createdAt || 0) < minCreatedAt) continue;
      claimSpeechItem(item, t);
      picked.push(item);
    }
    if (picked.length) save();
    return picked.map((item) => ({ ...item }));
  }

  function current({ limit = 20 } = {}) {
    load();
    const latest = new Map();
    for (const item of state.items) {
      const key = item.taskId || item.goalId || item.id;
      const prev = latest.get(key);
      if (!prev || Number(item.updatedAt || 0) >= Number(prev.updatedAt || 0)) latest.set(key, item);
    }
    return [...latest.values()]
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((item) => ({ ...item }));
  }

  function markSpoken(id, { ok = true, at = now(), error = null, systemSpeechFallback = null } = {}) {
    load();
    const item = state.items.find((x) => x.id === id);
    if (!item) return null;
    item.spokenAt = ok ? at : null;
    item.speechFailedAt = ok ? null : at;
    item.speechError = ok ? null : redactText(error || 'speech_failed', 180);
    item.speechLeaseUntil = null;
    if (systemSpeechFallback) {
      item.systemSpeechFallbackAt = at;
      item.systemSpeechFallback = {
        attempted: systemSpeechFallback.attempted === true,
        command: redactText(systemSpeechFallback.command || '', 40) || null,
        provider: redactText(systemSpeechFallback.provider || '', 40) || null,
        reason: redactText(systemSpeechFallback.reason || '', 120) || null,
        error: redactText(systemSpeechFallback.error || '', 120) || null,
      };
    }
    save();
    return { ...item };
  }

  load();
  return { add, list, consume, consumeSpeech, current, markSpoken, isTerminalStatus: (status) => TERMINAL_STATUSES.has(String(status || '')) };
}
