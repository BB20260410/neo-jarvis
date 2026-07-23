import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import { activityLog } from '../audit/ActivityLog.js';
import {
  planBacklogExpiry,
  applyBacklogExpiry,
  DEFAULT_APPROVAL_PENDING_TTL_MS,
} from './NoeBacklogExpiry.js';

export const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled']);
export const APPROVAL_TYPES = new Set(['dangerous_command', 'budget_override', 'manual']);

function nowMs() {
  return Date.now();
}

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function normalizeType(value) {
  const v = String(value || 'manual').toLowerCase();
  if (!APPROVAL_TYPES.has(v)) throw new Error(`invalid approval type: ${value}`);
  return v;
}

function normalizeStatus(value) {
  const v = String(value || 'pending').toLowerCase();
  if (!APPROVAL_STATUSES.has(v)) throw new Error(`invalid approval status: ${value}`);
  return v;
}

function safePayload(value) {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

function rowToApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requesterType: row.requester_type || null,
    requesterId: row.requester_id || null,
    dedupeKey: row.dedupe_key || null,
    payload: parseJson(row.payload),
    decisionBy: row.decision_by || null,
    decisionReason: row.decision_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at || null,
    expiresAt: row.expires_at || null,
  };
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function hashDedupe(parts = []) {
  return createHash('sha256').update(parts.map((p) => String(p || '')).join('\n---\n')).digest('hex').slice(0, 32);
}

/**
 * Generates a deduplication key for dangerous command approvals.
 * Combines command, source, requesterId, and cwd into a stable hash
 * to prevent duplicate approvals for the same command context.
 *
 * @param {Object} options - The options object.
 * @param {string} [options.command] - The command string to approve.
 * @param {string} [options.source] - The source of the command (e.g., user, system).
 * @param {string} [options.requesterId] - The ID of the requester.
 * @param {string} [options.cwd] - The current working directory.
 * @returns {string} A 32-character hex SHA-256 hash string.
 */
export function dangerousCommandDedupeKey({ command, source, requesterId, cwd } = {}) {
  return hashDedupe(['dangerous_command', source, requesterId, cwd, command]);
}

export class ApprovalStore {
  constructor({ audit = activityLog } = {}) {
    this.audit = audit;
    // 可选决议钩子（server.js 注入）：审批 approved/rejected/cancelled 后联动治理工作队列。
    // 解耦 approval→governance，失败由 decide 内 try/catch 吞掉，不阻断决议。
    this._decisionHook = null;
  }

  // 注入决议钩子；传 null 清除。签名 (id, { status, approval }) => void
  setDecisionHook(fn) {
    this._decisionHook = typeof fn === 'function' ? fn : null;
  }

  db() {
    return getDb();
  }

  createApproval(input = {}) {
    const fields = this._buildApprovalFields(input);
    if (fields.dedupeKey) {
      const existing = this.db().prepare(`
        SELECT * FROM approvals
        WHERE dedupe_key = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(fields.dedupeKey);
      if (existing) return rowToApproval(existing);
    }
    this._insertApprovalRow(fields);
    const approval = this.getApproval(fields.id);
    this.audit.recordSafe({
      action: 'approval.created',
      actorType: 'system',
      entityType: 'approval',
      entityId: fields.id,
      status: approval.status,
      severity: fields.type === 'dangerous_command' ? 'warn' : 'info',
      details: approval,
    });
    return approval;
  }

  _buildApprovalFields(input = {}) {
    const pickFirst = (...vals) => {
      for (const v of vals) {
        if (v) return v;
      }
      return undefined;
    };
    return {
      type: normalizeType(input.type),
      status: normalizeStatus(input.status || 'pending'),
      requesterType: str(pickFirst(input.requesterType, input.requester_type), 80),
      requesterId: str(pickFirst(input.requesterId, input.requester_id), 512),
      dedupeKey: str(pickFirst(input.dedupeKey, input.dedupe_key), 160),
      decisionBy: str(pickFirst(input.decisionBy, input.decision_by), 160),
      decisionReason: str(pickFirst(input.decisionReason, input.decision_reason), 2000),
      decidedAt: pickFirst(input.decidedAt, input.decided_at) || null,
      expiresAt: pickFirst(input.expiresAt, input.expires_at) || null,
      id: str(input.id, 160) || `approval-${randomUUID().slice(0, 12)}`,
      payload: safePayload(input.payload),
      now: nowMs(),
    };
  }

  _insertApprovalRow(f) {
    this.db().prepare(`
      INSERT INTO approvals(
        id, type, status, requester_type, requester_id, dedupe_key, payload,
        decision_by, decision_reason, created_at, updated_at, decided_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      f.id,
      f.type,
      f.status,
      f.requesterType,
      f.requesterId,
      f.dedupeKey,
      JSON.stringify(f.payload),
      f.decisionBy,
      f.decisionReason,
      f.now,
      f.now,
      f.decidedAt,
      f.expiresAt
    );
  }

  createDangerousCommandApproval({ command, hits = [], worstSeverity, source, cwd, requesterType, requesterId, metadata = {} } = {}) {
    const cleanCommand = str(command, 4000);
    if (!cleanCommand) throw new Error('command required');
    return this.createApproval({
      type: 'dangerous_command',
      requesterType,
      requesterId,
      dedupeKey: dangerousCommandDedupeKey({ command: cleanCommand, source, requesterId, cwd }),
      payload: {
        command: cleanCommand,
        source: source || 'unknown',
        cwd: cwd || null,
        worstSeverity: worstSeverity || null,
        hits: Array.isArray(hits) ? hits.slice(0, 20) : [],
        metadata,
      },
    });
  }

  getApproval(id) {
    return rowToApproval(this.db().prepare('SELECT * FROM approvals WHERE id = ?').get(id));
  }

  getLatestByDedupeKey(dedupeKey) {
    const key = str(dedupeKey, 160);
    if (!key) return null;
    return rowToApproval(this.db().prepare(`
      SELECT * FROM approvals
      WHERE dedupe_key = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(key));
  }

  listApprovals({ status, type, requesterType, requesterId, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(normalizeStatus(status)); }
    if (type) { where.push('type = ?'); args.push(normalizeType(type)); }
    if (requesterType) { where.push('requester_type = ?'); args.push(requesterType); }
    if (requesterId) { where.push('requester_id = ?'); args.push(requesterId); }
    args.push(Math.max(1, Math.min(1000, Number(limit) || 500)));
    return this.db().prepare(`
      SELECT * FROM approvals
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...args).map(rowToApproval);
  }

  decide(id, { status, decisionBy = 'owner', reason = '' } = {}) {
    const next = normalizeStatus(status);
    if (next !== 'approved' && next !== 'rejected' && next !== 'cancelled') {
      throw new Error('decision status must be approved/rejected/cancelled');
    }
    const current = this.getApproval(id);
    if (!current) return null;
    if (current.status !== 'pending') return current;
    const now = nowMs();
    this.db().prepare(`
      UPDATE approvals SET
        status = ?, decision_by = ?, decision_reason = ?, updated_at = ?, decided_at = ?
      WHERE id = ?
    `).run(next, str(decisionBy, 160), str(reason, 2000), now, now, id);
    const approval = this.getApproval(id);
    this.audit.recordSafe({
      action: `approval.${next}`,
      actorType: 'user',
      actorId: str(decisionBy, 160),
      entityType: 'approval',
      entityId: id,
      status: next,
      severity: next === 'approved' ? 'warn' : 'info',
      details: approval,
    });
    if (this._decisionHook) {
      try { this._decisionHook(id, { status: next, approval }); }
      catch { /* 联动失败不阻断决议 */ }
    }
    return approval;
  }

  approve(id, input = {}) {
    return this.decide(id, { ...input, status: 'approved' });
  }

  reject(id, input = {}) {
    return this.decide(id, { ...input, status: 'rejected' });
  }

  cancel(id, input = {}) {
    return this.decide(id, { ...input, status: 'cancelled' });
  }

  /**
   * Soft-expire pending approvals by TTL / expiresAt (keeps rows for audit).
   * @param {{ nowMs?: number, ttlMs?: number, limit?: number, dryRun?: boolean, decisionBy?: string }} [opts]
   */
  expirePending(opts = {}) {
    const nowMs = Number(opts.nowMs) || Date.now();
    const ttlMs = Number.isFinite(Number(opts.ttlMs))
      ? Number(opts.ttlMs)
      : Number(process.env.NOE_APPROVAL_PENDING_TTL_MS) || DEFAULT_APPROVAL_PENDING_TTL_MS;
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
    // default dryRun=true unless explicitly false
    const dryRun = opts.dryRun !== false;
    const pending = this.listApprovals({ status: 'pending', limit });
    const plan = planBacklogExpiry({ approvals: pending, acts: [], nowMs, approvalTtlMs: ttlMs, limit });
    const applied = applyBacklogExpiry(plan, {
      approvalStore: this,
      dryRun,
      decisionBy: opts.decisionBy || 'backlog-expiry',
    });
    return { plan, applied, dryRun };
  }
}

export const approvalStore = new ApprovalStore();
