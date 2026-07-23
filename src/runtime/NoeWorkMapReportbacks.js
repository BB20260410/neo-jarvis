// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

const ACTIVE_STATUSES = new Set(['accepted', 'queued', 'running', 'awaiting_approval']);
const STALE_THRESHOLDS_MS = {
  accepted: 30 * 60 * 1000,
  queued: 30 * 60 * 1000,
  running: 60 * 60 * 1000,
};
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|owner[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function clean(value, max = 400) {
  return redactSensitiveText(String(value ?? ''))
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function countBy(rows = [], keyFn = (x) => x?.status || 'unknown') {
  const out = {};
  for (const row of rows || []) {
    const key = clean(keyFn(row) || 'unknown', 80) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function activeCountByStatus(counts = {}) {
  return Object.entries(counts).reduce((sum, [status, count]) => (
    ACTIVE_STATUSES.has(status) ? sum + Number(count || 0) : sum
  ), 0);
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes >= 24 * 60) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${minutes}m`;
}

function makeItem(input = {}) {
  const status = clean(input.status || 'unknown', 80);
  return {
    id: clean(input.id, 180),
    kind: 'reportback',
    title: clean(input.title || input.id || '未命名回报', 180),
    status,
    tone: input.tone || (input.stale ? 'blocked' : 'active'),
    source: clean(input.source || '', 80),
    detail: clean(input.detail || '', 260),
    priority: Number(input.priority || 0),
    updatedAt: input.updatedAt || null,
    evidenceCount: Number(input.evidenceCount || 0),
    parentId: clean(input.parentId || '', 180) || null,
    ref: clean(input.ref || '', 260) || null,
    stale: input.stale === true,
    staleAgeMinutes: Number.isFinite(input.staleAgeMinutes) ? Number(input.staleAgeMinutes) : null,
    nextAction: clean(input.nextAction || '', 120) || null,
  };
}

function staleAction(status) {
  if (status === 'running') return 'confirm_progress_or_mark_blocked';
  if (status === 'accepted' || status === 'queued') return 'start_or_block_with_reason';
  return '';
}

function staleInfo(item, nowMs) {
  const status = clean(item?.status || '', 80);
  const threshold = STALE_THRESHOLDS_MS[status];
  if (!threshold) return null;
  const lastMs = timeMs(item?.updatedAt || item?.createdAt);
  if (!lastMs || !Number.isFinite(nowMs)) return null;
  const ageMs = Math.max(0, nowMs - lastMs);
  if (ageMs < threshold) return null;
  return {
    ageMs,
    ageMinutes: Math.round(ageMs / 60_000),
    nextAction: staleAction(status),
  };
}

export function summarizeReportbacks({ dataDir, nowMs = Date.now() } = {}) {
  const raw = readJson(join(dataDir, 'task-reportbacks.json'), { items: [] });
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  const latest = new Map();
  for (const item of rows) {
    const key = clean(item?.taskId || item?.goalId || item?.id || '', 240);
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || Number(item?.updatedAt || 0) >= Number(prev?.updatedAt || 0)) latest.set(key, item);
  }
  const current = [...latest.values()];
  const staleItems = [];
  const items = current
    .filter((item) => ACTIVE_STATUSES.has(clean(item?.status, 80)))
    .slice(0, 40)
    .map((item) => {
      const stale = staleInfo(item, Number(nowMs));
      if (stale) staleItems.push({ item, stale });
      const summary = clean(item.summary || '', 180);
      const staleDetail = stale ? `stale ${formatDuration(stale.ageMs)} · next ${stale.nextAction}` : '';
      return makeItem({
        id: item.taskId || item.goalId || item.id,
        title: item.title || item.summary || item.kind,
        status: item.status || 'running',
        source: item.source || item.kind || 'reportback',
        tone: stale ? 'blocked' : 'active',
        detail: [staleDetail, summary].filter(Boolean).join(' · '),
        updatedAt: timeMs(item.updatedAt || item.createdAt) ? new Date(timeMs(item.updatedAt || item.createdAt)).toISOString() : null,
        evidenceCount: Array.isArray(item.evidenceRefs) ? item.evidenceRefs.length : 0,
        stale: Boolean(stale),
        staleAgeMinutes: stale?.ageMinutes ?? null,
        nextAction: stale?.nextAction || '',
      });
    });
  staleItems.sort((a, b) => b.stale.ageMs - a.stale.ageMs);
  const statusCounts = countBy(rows, (item) => item?.status || 'unknown');
  return {
    total: rows.length,
    current: current.length,
    active: activeCountByStatus(countBy(current, (item) => item?.status || 'unknown')),
    staleActive: staleItems.length,
    staleOldestAgeMinutes: staleItems[0] ? Math.round(staleItems[0].stale.ageMs / 60_000) : 0,
    staleItems: staleItems.slice(0, 8).map(({ item, stale }) => ({
      id: clean(item.taskId || item.goalId || item.id || '', 180),
      status: clean(item.status || '', 80),
      ageMinutes: stale.ageMinutes,
      nextAction: stale.nextAction,
      title: clean(item.title || item.summary || item.kind || '', 180),
    })),
    statusCounts,
    currentStatusCounts: countBy(current, (item) => item?.status || 'unknown'),
    items,
  };
}
