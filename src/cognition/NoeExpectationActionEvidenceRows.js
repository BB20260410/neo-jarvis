import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const SENSITIVE_KEY_RE = /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization|oauth|credential|private[_-]?key|refresh[_-]?token|session[_-]?token)/i;
const CONTEXT_KEY_ALIASES = new Map([
  ['goal', 'goal'],
  ['goaltitle', 'goalTitle'],
  ['goal_title', 'goalTitle'],
  ['expectation', 'expectation'],
  ['expectedclaim', 'expectedClaim'],
  ['expected_claim', 'expectedClaim'],
  ['claim', 'claim'],
  ['checkpoint', 'checkpoint'],
  ['step', 'step'],
  ['steptext', 'stepText'],
  ['step_text', 'stepText'],
  ['task', 'task'],
  ['intent', 'intent'],
  ['plan', 'plan'],
]);

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).replace(/\s+/g, ' ').slice(0, max);
}

function isTerminalStatus(status = '') {
  return ['completed', 'done', 'succeeded'].includes(String(status || '').toLowerCase());
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedContextKey(key = '') {
  return String(key || '').replace(/[-\s]+/g, '_').toLowerCase();
}

function collectSemanticContext(value, out = {}, depth = 0, key = '') {
  if (depth > 4 || value == null) return out;
  if (SENSITIVE_KEY_RE.test(String(key || ''))) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    const canonical = CONTEXT_KEY_ALIASES.get(normalizedContextKey(key));
    if (canonical && !out[canonical]) {
      const text = clean(value, 500);
      if (text && text !== '[REDACTED]') out[canonical] = text;
    }
    return out;
  }
  if (typeof value === 'boolean' || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectSemanticContext(item, out, depth + 1, key);
    return out;
  }
  for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
    collectSemanticContext(childValue, out, depth + 1, childKey);
  }
  return out;
}

function hasAuditBackedEvidence(row = {}, payload = {}) {
  if (row.evidence_event_id != null || row.evidenceEventId != null) return true;
  if (clean(row.log_ref || row.logRef || row.evidence_ref || row.evidenceRef, 1000)) return true;
  if (Object.keys(plainObject(payload.actionEvidence)).length) return true;
  if (Object.keys(plainObject(payload.actionEvidenceSummary)).length) return true;
  return false;
}

export function buildMinimalActionEvidencePayload({
  status = '',
  action = '',
  title = '',
  phase = '',
  semanticTrace = null,
  context = {},
} = {}) {
  const safeStatus = clean(status, 80);
  const terminal = isTerminalStatus(safeStatus);
  const safeAction = clean(action, 160);
  const safeTitle = clean(title, 240);
  return {
    status: safeStatus,
    completed: terminal,
    ok: terminal,
    result: terminal ? 'done' : safeStatus,
    action: safeAction,
    title: safeTitle,
    ...collectSemanticContext(context),
    ...(phase ? { phase: clean(phase, 80) } : {}),
    actionEvidence: {
      action: safeAction,
      title: safeTitle,
      ...collectSemanticContext(context),
      ...(semanticTrace && typeof semanticTrace === 'object' ? { semanticTrace } : {}),
    },
  };
}

function safeSemanticTrace(value) {
  const trace = plainObject(value);
  if (!Object.keys(trace).length) return null;
  const compact = {};
  for (const [key, raw] of Object.entries(trace).slice(0, 80)) {
    if (key === 'fingerprint' || SENSITIVE_KEY_RE.test(key)) continue;
    if (Array.isArray(raw)) {
      const items = raw.map((item) => clean(item, 500)).filter(Boolean).slice(0, 12);
      if (items.length) compact[key] = items;
    } else if (raw != null && typeof raw !== 'object') {
      const text = clean(raw, 500);
      if (text) compact[key] = text;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

export function buildNoeActExpectationEvidenceRow(row = {}, { sinceTs = 0 } = {}) {
  const payload = plainObject(row.payload);
  const evidence = plainObject(payload.actionEvidence);
  const semanticTrace = safeSemanticTrace(evidence.semanticTrace);
  const terminal = isTerminalStatus(row.status);
  if (!semanticTrace && (!terminal || !hasAuditBackedEvidence(row, payload))) return null;
  return {
    id: `noe_act:${clean(row.id, 160)}`,
    ts: Number(row.updated_at ?? row.updatedAt) || Number(sinceTs) || 0,
    kind: semanticTrace ? 'noe_act_semantic_trace' : 'noe_act_evidence_summary',
    entityType: 'noe_act',
    entityId: clean(row.id, 160),
    payload: buildMinimalActionEvidencePayload({
      status: row.status,
      action: evidence.action || row.action,
      title: evidence.title || row.title,
      semanticTrace,
      context: { ...payload, ...evidence },
    }),
  };
}

export function buildGoalCheckpointExpectationEvidenceRow(row = {}, { sinceTs = 0 } = {}) {
  const payload = plainObject(row.payload);
  const summary = plainObject(payload.actionEvidenceSummary);
  const semanticTrace = safeSemanticTrace(summary.semanticTrace);
  const terminal = isTerminalStatus(row.status);
  if (!semanticTrace && (!terminal || !hasAuditBackedEvidence(row, payload))) return null;
  return {
    id: `goal_checkpoint:${Number(row.id) || clean(row.id, 80)}`,
    ts: Number(row.ts ?? row.created_at ?? row.createdAt) || Number(sinceTs) || 0,
    kind: semanticTrace ? 'noe_goal_checkpoint_semantic_trace' : 'noe_goal_checkpoint_evidence_summary',
    entityType: 'noe_goal_checkpoint',
    entityId: clean(row.id, 80),
    payload: buildMinimalActionEvidencePayload({
      status: row.status,
      action: summary.action || row.action,
      title: summary.title || '',
      phase: row.phase,
      semanticTrace,
      context: { ...payload, ...summary },
    }),
  };
}
