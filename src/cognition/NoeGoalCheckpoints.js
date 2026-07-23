// @ts-check
// Durable-ish goal step checkpoints: intent/evidence/recovery records for Noe goals.
// This is deliberately small and SQLite-local; it gives audit/recovery evidence before
// considering heavier LangGraph/Temporal-style workflow engines.

import { createHash, randomUUID } from 'node:crypto';

export const NOE_GOAL_CHECKPOINT_WORKFLOW_SCHEMA_VERSION = 1;

const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function clean(value = '', max = 2000) {
  return String(value ?? '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeJson(value = null, max = 20_000) {
  if (value === undefined || value === null) return null;
  try {
    const redacted = clean(JSON.stringify(value), max + 2000);
    if (redacted.length <= max) return redacted;
    return JSON.stringify({
      truncated: true,
      originalChars: redacted.length,
      preview: redacted.slice(0, Math.max(0, max - 240)),
    });
  } catch {
    return JSON.stringify({ text: clean(String(value), Math.max(0, max - 80)) });
  }
}

export function serializeGoalCheckpointPayload(value = null) {
  return safeJson(value);
}

// 读回 payload 列的安全解析:本模块写入恒为合法 JSON(safeJson),但旧 schema 行 / 外部篡改 /
// 跨版本回填可能留下损坏 payload。逐行隔离——损坏行该字段记 null + 不可解析标记,绝不让
// 单行坏数据抛错吞掉整张目标审计表(与 readEvents / parseSelfTalkAuditJsonl 的 per-row 容错一致)。
function safeParsePayload(raw) {
  if (raw == null || raw === '') return null;
  try { return JSON.parse(raw); } catch { return { _payloadParseError: true }; }
}

function stableValue(value, depth = 0) {
  if (depth > 8) return '[depth-limit]';
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return clean(value, 4000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => stableValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      const next = stableValue(value[key], depth + 1);
      if (next !== undefined) acc[clean(key, 160)] = next;
      return acc;
    }, {});
  }
  return clean(String(value), 1000);
}

function digest(value = {}) {
  return createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function payloadObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function refsList(value) {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(arr.map((item) => clean(item, 1000)).filter(Boolean))];
}

function compactActionEvidence(payload = {}) {
  const evidence = payload.actionEvidence || payload.actionEvidenceSummary || null;
  return evidence && typeof evidence === 'object' ? evidence : null;
}

function isReadOnlyAction(action = '', payload = {}, actionEvidence = null) {
  if (payload.readonly === true || payload.readOnly === true) return true;
  if (payload.actionSpec?.payload?.readonly === true) return true;
  if (actionEvidence?.runtime?.readonly === true) return true;
  if (action === 'shell.exec' && payload.readonly !== false && payload.readOnly !== false) return payload.readonly === true || payload.readOnly === true;
  return false;
}

function rollbackEvidenceFor({
  phase = '',
  status = '',
  kind = '',
  action = '',
  payload = {},
  replaySafe = false,
} = {}) {
  const actionEvidence = compactActionEvidence(payload);
  const rollbackRefs = refsList(
    actionEvidence?.refs?.rollback
    || payload.rollbackRefs
    || payload.rollbackRef
    || payload.rollbackEvidenceRef
  );
  const dryRunOnly = payload.dryRunOnly === true || actionEvidence?.dryRunOnly === true;
  const completed = ['done', 'completed'].includes(String(status || '').toLowerCase()) && payload.ok !== false;

  if (replaySafe || kind !== 'act') return { required: false, status: 'not_required', reason: 'replay_safe_or_non_act_checkpoint', refs: [] };
  if (phase !== 'evidence') return { required: false, status: 'not_required', reason: 'checkpoint_is_not_action_evidence', refs: [] };
  if (!completed) return { required: false, status: 'not_required', reason: 'action_not_completed', refs: [] };
  if (dryRunOnly) return { required: false, status: 'not_required', reason: 'dry_run_only_no_external_side_effect', refs: [] };
  if (isReadOnlyAction(action, payload, actionEvidence)) return { required: false, status: 'not_required', reason: 'readonly_action_no_external_side_effect', refs: [] };
  if (['macos.app.activate', 'browser.open_url', 'browser.state_probe', 'browser.observe_page', 'visual.action.plan'].includes(action)) {
    return { required: false, status: 'not_required', reason: 'transient_local_ui_action', refs: [] };
  }
  if (action === 'noe.note.write') {
    return { required: false, status: 'not_required', reason: 'local_autonomy_note_write', refs: [] };
  }
  if (rollbackRefs.length) return { required: true, status: 'available', reason: 'rollback_refs_present', refs: rollbackRefs };
  if (actionEvidence?.dryRunOnly === false || payload.dryRunOnly === false) {
    return { required: true, status: 'missing', reason: 'real_side_effect_without_rollback_ref', refs: [] };
  }
  return { required: false, status: 'unknown', reason: 'side_effect_status_unknown', refs: [] };
}

export function buildGoalCheckpointWorkflow({
  checkpointId = '',
  goalId = '',
  stepIndex = -1,
  phase = '',
  status = '',
  kind = '',
  action = '',
  step = '',
  note = '',
  evidenceRef = '',
  payload = null,
  replaySafe = false,
} = {}) {
  const p = payloadObject(payload);
  const actionEvidence = compactActionEvidence(p);
  const idempotencyKey = `goal-step:${digest({
    goalId,
    stepIndex,
    kind,
    action,
    step,
    actionSpec: p.actionSpec || null,
    query: p.query || null,
  }).slice(0, 40)}`;
  const sideEffectFingerprint = digest({
    goalId,
    stepIndex,
    phase,
    status,
    kind,
    action,
    evidenceRef,
    replaySafe: replaySafe === true,
    actionEvidenceSha256: actionEvidence?.sha256 || null,
    dryRunOnly: p.dryRunOnly ?? actionEvidence?.dryRunOnly ?? null,
    ok: p.ok ?? null,
    note,
  });
  return {
    schemaVersion: NOE_GOAL_CHECKPOINT_WORKFLOW_SCHEMA_VERSION,
    checkpointId: clean(checkpointId, 200),
    idempotencyKey,
    resumeCursor: {
      goalId: clean(goalId, 200),
      stepIndex: Number(stepIndex) || 0,
      phase: clean(phase, 80),
      status: clean(status, 80),
      checkpointId: clean(checkpointId, 200),
      replaySafe: replaySafe === true,
    },
    sideEffectFingerprint,
    rollbackEvidence: rollbackEvidenceFor({ phase, status, kind, action, payload: p, replaySafe }),
  };
}

export function withGoalCheckpointWorkflow(payload = null, context = {}) {
  const p = payloadObject(payload);
  const existing = p.workflow && typeof p.workflow === 'object' ? p.workflow : {};
  return {
    ...p,
    workflow: {
      ...existing,
      ...buildGoalCheckpointWorkflow({ ...context, payload: p }),
    },
  };
}

export function ensureGoalCheckpointTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS noe_goal_checkpoints (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      goal_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      step TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '',
      payload TEXT,
      replay_safe INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_noe_goal_checkpoints_goal_step_ts
      ON noe_goal_checkpoints(goal_id, step_index, ts);
    CREATE INDEX IF NOT EXISTS idx_noe_goal_checkpoints_phase_ts
      ON noe_goal_checkpoints(phase, ts);
  `);
}

export function appendGoalCheckpoint(db, {
  now = Date.now,
  goal = null,
  goalId = '',
  stepIndex = -1,
  phase = 'step_update',
  status = '',
  kind = '',
  action = '',
  step = '',
  note = '',
  evidenceRef = '',
  payload = null,
  replaySafe = false,
} = {}) {
  ensureGoalCheckpointTable(db);
  const t = Number(now()) || Date.now();
  const plan = Array.isArray(goal?.plan) ? goal.plan : [];
  const st = Number(stepIndex) >= 0 ? plan[Number(stepIndex)] || {} : {};
  const id = `goal-cp-${randomUUID().slice(0, 12)}`;
  const cleanGoalId = clean(goalId || goal?.id, 200);
  const cleanPhase = clean(phase, 80);
  const cleanStatus = clean(status || st.status || goal?.status, 80);
  const cleanKind = clean(kind || st.kind, 80);
  const cleanAction = clean(action || st.action, 180);
  const cleanStep = clean(step || st.step || goal?.title, 500);
  const cleanNote = clean(note || st.note, 1000);
  const cleanEvidenceRef = clean(evidenceRef, 1000);
  const safeReplay = replaySafe === true;
  const payloadWithWorkflow = withGoalCheckpointWorkflow(payload, {
    checkpointId: id,
    goalId: cleanGoalId,
    stepIndex: Number(stepIndex) || 0,
    phase: cleanPhase,
    status: cleanStatus,
    kind: cleanKind,
    action: cleanAction,
    step: cleanStep,
    note: cleanNote,
    evidenceRef: cleanEvidenceRef,
    replaySafe: safeReplay,
  });
  db.prepare(`
    INSERT INTO noe_goal_checkpoints(id, ts, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    t,
    cleanGoalId,
    Number(stepIndex) || 0,
    cleanPhase,
    cleanStatus,
    cleanKind,
    cleanAction,
    cleanStep,
    cleanNote,
    cleanEvidenceRef,
    safeJson(payloadWithWorkflow),
    safeReplay ? 1 : 0,
    t,
  );
  return id;
}

export function listGoalCheckpoints(db, { goalId = '', stepIndex = null, limit = 100 } = {}) {
  ensureGoalCheckpointTable(db);
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const args = [String(goalId || '')];
  let where = 'goal_id = ?';
  if (stepIndex !== null && stepIndex !== undefined) { where += ' AND step_index = ?'; args.push(Number(stepIndex)); }
  return db.prepare(`SELECT * FROM noe_goal_checkpoints WHERE ${where} ORDER BY ts ASC, created_at ASC LIMIT ?`).all(...args, lim)
    .map((row) => ({ ...row, replaySafe: row.replay_safe === 1, payload: safeParsePayload(row.payload) }));
}

export function latestGoalCheckpoint(db, { goalId = '', stepIndex = null } = {}) {
  const rows = listGoalCheckpoints(db, { goalId, stepIndex, limit: 500 });
  return rows[rows.length - 1] || null;
}
