import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import {
  planBacklogExpiry,
  applyBacklogExpiry,
  DEFAULT_ACT_PENDING_TTL_MS,
  ACT_PENDING_STATUSES,
} from '../approval/NoeBacklogExpiry.js';

const ACT_STATUSES = new Set([
  'queued',
  'planning',
  'proposed',
  'budget_checked',
  'permission_checked',
  'dry_run',
  'executing', // R2-P2（2026-07-03）：真实执行中间态。旧版复用 'dry_run' 标真实执行 → 卡死/重启后停在
  //   dry_run、retry 不认（真失败被吞）+ 监控分不清真演练与卡住的真执行。独立中间态区分二者且进可重试集。
  'awaiting_approval',
  'blocked_safety',
  'completed',
  'failed',
  'retrying',
  'cancelled',
]);

function nowMs() {
  return Date.now();
}

function str(value, max = 1000) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function text(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function json(value) {
  try { return JSON.stringify(value && typeof value === 'object' ? value : {}); } catch { return '{}'; }
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function normalizeStatus(value, fallback = 'queued') {
  const status = str(value, 80) || fallback;
  if (!ACT_STATUSES.has(status)) throw new Error(`invalid act status: ${status}`);
  return status;
}

function rowToAct(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    action: row.action,
    riskLevel: row.risk_level,
    status: row.status,
    approvalId: row.approval_id || null,
    budgetState: row.budget_state || 'unknown',
    permissionState: row.permission_state || 'unknown',
    failureReason: row.failure_reason || '',
    evidenceEventId: row.evidence_event_id || null,
    logRef: row.log_ref || '',
    costEstimateUsd: Number(row.cost_estimate_usd) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: parseJson(row.payload),
  };
}

export class ActStore {
  constructor({ projectId = 'noe' } = {}) {
    this.projectId = str(projectId, 160) || 'noe';
  }

  db() {
    return getDb();
  }

  create(input = {}) {
    const now = nowMs();
    const id = str(input.id, 160) || `act-${randomUUID().slice(0, 12)}`;
    const projectId = str(input.projectId || input.project_id || this.projectId, 160) || this.projectId;
    const title = str(input.title || input.action || 'Noe act', 240) || 'Noe act';
    const action = str(input.action || 'noe.act.review', 160) || 'noe.act.review';
    const riskLevel = str(input.riskLevel || input.risk_level || 'low', 40) || 'low';
    const status = normalizeStatus(input.status || 'queued');
    this.db().prepare(`
      INSERT INTO noe_acts(
        id, project_id, title, action, risk_level, status, approval_id,
        budget_state, permission_state, failure_reason, evidence_event_id,
        log_ref, cost_estimate_usd, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      title,
      action,
      riskLevel,
      status,
      str(input.approvalId || input.approval_id, 160),
      str(input.budgetState || input.budget_state || 'pending', 80),
      str(input.permissionState || input.permission_state || 'pending', 80),
      text(input.failureReason || input.failure_reason || '', 1000),
      input.evidenceEventId || input.evidence_event_id || null,
      text(input.logRef || input.log_ref || '', 1000),
      Math.max(0, Number(input.costEstimateUsd ?? input.cost_estimate_usd) || 0),
      json(input.payload || {}),
      now,
      now
    );
    return this.get(id);
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) return null;
    const next = {
      status: normalizeStatus(patch.status || current.status, current.status),
      approvalId: patch.approvalId ?? patch.approval_id ?? current.approvalId,
      budgetState: patch.budgetState ?? patch.budget_state ?? current.budgetState,
      permissionState: patch.permissionState ?? patch.permission_state ?? current.permissionState,
      failureReason: patch.failureReason ?? patch.failure_reason ?? current.failureReason,
      evidenceEventId: patch.evidenceEventId ?? patch.evidence_event_id ?? current.evidenceEventId,
      logRef: patch.logRef ?? patch.log_ref ?? current.logRef,
      costEstimateUsd: patch.costEstimateUsd ?? patch.cost_estimate_usd ?? current.costEstimateUsd,
      payload: { ...(current.payload || {}), ...(patch.payload || {}) },
    };
    this.db().prepare(`
      UPDATE noe_acts SET
        status = ?,
        approval_id = ?,
        budget_state = ?,
        permission_state = ?,
        failure_reason = ?,
        evidence_event_id = ?,
        log_ref = ?,
        cost_estimate_usd = ?,
        payload = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.status,
      str(next.approvalId, 160),
      str(next.budgetState, 80),
      str(next.permissionState, 80),
      text(next.failureReason, 1000),
      next.evidenceEventId || null,
      text(next.logRef, 1000),
      Math.max(0, Number(next.costEstimateUsd) || 0),
      json(next.payload),
      nowMs(),
      id
    );
    return this.get(id);
  }

  get(id) {
    const actId = str(id, 160);
    if (!actId) return null;
    return rowToAct(this.db().prepare('SELECT * FROM noe_acts WHERE id = ?').get(actId));
  }

  list({ projectId = this.projectId, status, limit = 20 } = {}) {
    const where = [];
    const args = [];
    if (projectId) { where.push('project_id = ?'); args.push(str(projectId, 160)); }
    if (status) { where.push('status = ?'); args.push(normalizeStatus(status)); }
    args.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const rows = this.db().prepare(`
      SELECT * FROM noe_acts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(...args);
    return rows.map(rowToAct);
  }

  listByApprovalId(approvalId, { statuses = null, limit = 20 } = {}) {
    const id = str(approvalId, 160);
    if (!id) return [];
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const rawStatuses = Array.isArray(statuses) ? statuses : statuses ? [statuses] : [];
    const statusList = rawStatuses.length
      ? rawStatuses.map((s) => String(s || '').trim()).filter(Boolean).map((s) => normalizeStatus(s))
      : [];
    const args = [id];
    let statusSql = '';
    if (statusList.length) {
      statusSql = ` AND status IN (${statusList.map(() => '?').join(', ')})`;
      args.push(...statusList);
    }
    args.push(lim);
    const rows = this.db().prepare(`
      SELECT * FROM noe_acts
      WHERE approval_id = ?${statusSql}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(...args);
    return rows.map(rowToAct);
  }

  current({ projectId = this.projectId } = {}) {
    const rows = this.list({ projectId, limit: 1 });
    return rows[0] || null;
  }

  cancel(id, { reason = 'cancelled_by_owner' } = {}) {
    const current = this.get(id);
    if (!current) return null;
    if (['completed', 'failed', 'blocked_safety', 'cancelled'].includes(current.status)) return current;
    return this.update(id, {
      status: 'cancelled',
      failureReason: reason,
      payload: { cancelledAt: nowMs(), cancelReason: reason },
    });
  }

  summary({ projectId = this.projectId } = {}) {
    const rows = this.db().prepare(`
      SELECT status, COUNT(*) AS count FROM noe_acts
      WHERE project_id = ?
      GROUP BY status
    `).all(str(projectId, 160));
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count) || 0]));
    const current = this.current({ projectId });
    const pending = ['queued', 'planning', 'proposed', 'budget_checked', 'permission_checked', 'dry_run', 'awaiting_approval', 'retrying']
      .reduce((sum, status) => sum + (byStatus[status] || 0), 0);
    return { byStatus, pending, current };
  }

  /**
   * Soft-expire stale pending acts (cancel; keep rows for audit).
   * @param {{ projectId?: string, nowMs?: number, ttlMs?: number, limit?: number, dryRun?: boolean }} [opts]
   */
  expirePending(opts = {}) {
    const projectId = str(opts.projectId || this.projectId, 160) || this.projectId;
    const nowMs = Number(opts.nowMs) || Date.now();
    const ttlMs = Number.isFinite(Number(opts.ttlMs))
      ? Number(opts.ttlMs)
      : Number(process.env.NOE_ACT_PENDING_TTL_MS) || DEFAULT_ACT_PENDING_TTL_MS;
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
    const dryRun = opts.dryRun !== false;
    const pending = [];
    for (const status of ACT_PENDING_STATUSES) {
      const rows = this.list({ projectId, status, limit });
      pending.push(...rows);
      if (pending.length >= limit) break;
    }
    const plan = planBacklogExpiry({
      approvals: [],
      acts: pending.slice(0, limit),
      nowMs,
      actTtlMs: ttlMs,
      limit,
    });
    const applied = applyBacklogExpiry(plan, { actStore: this, dryRun });
    return { plan, applied, dryRun };
  }
}
