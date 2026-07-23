// @ts-check

import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const KIND_TO_SCOPE = Object.freeze({
  fact: 'fact',
  preference: 'fact',
  identity: 'fact',
  skill: 'project',
  insight: 'insight',
  episode_summary: 'project',
  project: 'project',
});

const ALLOWED_KINDS = new Set(Object.keys(KIND_TO_SCOPE));
const ALLOWED_RISKS = new Set(['low', 'medium', 'high']);
const ALLOWED_WRITE_MODES = new Set(['auto', 'owner_confirmed', 'validated_consensus']);
const ALLOWED_PRIVACY = new Set(['private', 'local', 'shareable']);
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|token|secret|password|cookie)\s*[:=]\s*['"]?[^'"\s]{8,})/i;
const EPHEMERAL_FACT_RE = /(临时|一次性|刚刚|刚才|当前屏幕|当前页面|现在页面|点击了|按钮|窗口|标签页|tab|toast|弹窗|调试输出|debug|console|日志里看到)/i;

function clean(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return redactSensitiveText(String(value).trim().slice(0, max));
}

function clamp01(value, fallback = 0.6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampSalience(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

function cleanList(value, maxItems = 20, maxLen = 240) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, maxLen)).filter(Boolean))].slice(0, maxItems);
}

function isIncomplete(input = {}) {
  const finish = String(input.finishReason ?? input.finish_reason ?? '').toLowerCase();
  return input.incomplete === true
    || input.continuationRequired === true
    || input.truncated === true
    || finish === 'length'
    || finish === 'max_tokens';
}

export function detectsSensitiveText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return SECRET_RE.test(text) || redactSensitiveText(text) !== text;
}

export function normalizeMemoryCandidate(input = {}, { now = Date.now() } = {}) {
  const rawBody = String(input.body ?? input.text ?? input.content ?? '').trim();
  const body = clean(rawBody, 20_000);
  const kind = ALLOWED_KINDS.has(String(input.kind || '').trim())
    ? String(input.kind).trim()
    : 'fact';
  const projectId = clean(input.projectId ?? input.project_id ?? input.project ?? 'noe', 240) || 'noe';
  const scope = clean(input.scope || KIND_TO_SCOPE[kind] || 'project', 80) || 'project';
  const sourceType = clean(input.sourceType ?? input.source_type ?? kind, 80) || kind;
  const sourceEpisodeId = clean(input.sourceEpisodeId ?? input.source_episode_id, 240) || null;
  const evidenceRefs = cleanList(input.evidenceRefs ?? input.evidence_refs, 20, 240);
  const sourceEventIds = cleanList(input.sourceEventIds ?? input.source_event_ids, 20, 120);
  const tags = cleanList(input.tags, 40, 80);
  const risk = ALLOWED_RISKS.has(String(input.risk || '').trim()) ? String(input.risk).trim() : 'low';
  const writeMode = ALLOWED_WRITE_MODES.has(String(input.writeMode || '').trim())
    ? String(input.writeMode).trim()
    : 'auto';
  const privacy = ALLOWED_PRIVACY.has(String(input.privacy || '').trim())
    ? String(input.privacy).trim()
    : 'private';
  const createdAt = Number.isFinite(Number(input.createdAt ?? input.created_at))
    ? Number(input.createdAt ?? input.created_at)
    : now;
  const sensitive = detectsSensitiveText(rawBody)
    || detectsSensitiveText(input.title)
    || tags.some(detectsSensitiveText)
    || evidenceRefs.some(detectsSensitiveText);
  const candidate = {
    id: clean(input.id, 180) || `memcand-${randomUUID()}`,
    projectId,
    kind,
    scope,
    title: clean(input.title || body.split(/\s+/).slice(0, 12).join(' '), 500),
    body,
    sourceType,
    sourceId: clean(input.sourceId ?? input.source_id, 240) || null,
    targetMemoryId: clean(input.targetMemoryId ?? input.target_memory_id ?? input.memoryId ?? input.memory_id, 180) || null,
    sourceEpisodeId,
    sourceEventIds,
    evidenceRefs,
    tags,
    noWriteReason: clean(input.noWriteReason ?? input.no_write_reason ?? input.reason, 500),
    actor: clean(input.actor || 'noe', 80) || 'noe',
    privacy,
    confidence: clamp01(input.confidence, 0.6),
    salience: clampSalience(input.salience, 3),
    risk,
    writeMode,
    validFrom: Number.isFinite(Number(input.validFrom ?? input.valid_from))
      ? Number(input.validFrom ?? input.valid_from)
      : createdAt,
    validTo: Number.isFinite(Number(input.validTo ?? input.valid_to))
      ? Number(input.validTo ?? input.valid_to)
      : null,
    ttlMs: Number.isFinite(Number(input.ttlMs ?? input.ttl_ms)) ? Number(input.ttlMs ?? input.ttl_ms) : null,
    expiresAt: Number.isFinite(Number(input.expiresAt ?? input.expires_at)) ? Number(input.expiresAt ?? input.expires_at) : null,
    mergeTrace: Array.isArray(input.mergeTrace ?? input.merge_trace) ? (input.mergeTrace ?? input.merge_trace) : [],
    incomplete: isIncomplete(input),
    sensitive,
    createdAt,
  };
  return candidate;
}

export function candidateHasSourceEvidence(candidate = {}) {
  return Boolean(candidate.sourceEpisodeId)
    || (Array.isArray(candidate.sourceEventIds) && candidate.sourceEventIds.length > 0)
    || (Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length > 0);
}

export function candidateNeedsSourceEvidence(candidate = {}) {
  if (candidate.writeMode === 'owner_confirmed') return false;
  return ['fact', 'preference', 'identity', 'skill', 'insight'].includes(String(candidate.kind || ''));
}

export function candidateNeedsReview(candidate = {}) {
  if (candidate.writeMode === 'owner_confirmed' || candidate.writeMode === 'validated_consensus') return false;
  if (candidate.risk === 'high') return true;
  if (candidate.salience >= 5) return true;
  if (candidate.kind === 'identity') return true;
  return false;
}

export function candidateLooksEphemeral(candidate = {}) {
  const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
  if (tags.includes('skill') || tags.includes('incident') || candidate.kind === 'skill') return false;
  if (!['fact', 'preference', 'identity'].includes(String(candidate.kind || ''))) return false;
  const body = `${candidate.title || ''}\n${candidate.body || ''}`;
  return EPHEMERAL_FACT_RE.test(body);
}

export function candidateToMemoryInput(candidate = {}) {
  return {
    projectId: candidate.projectId,
    id: candidate.targetMemoryId || undefined,
    scope: candidate.scope,
    title: candidate.title,
    body: candidate.body,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    tags: candidate.tags,
    confidence: candidate.confidence,
    salience: candidate.salience,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    ttlMs: candidate.ttlMs,
    expiresAt: candidate.expiresAt,
    sourceEpisodeId: candidate.sourceEpisodeId,
    mergeTrace: [
      ...(Array.isArray(candidate.mergeTrace) ? candidate.mergeTrace : []),
      { at: candidate.createdAt, gate: 'noe_memory_write_gate', candidateId: candidate.id },
    ],
  };
}
