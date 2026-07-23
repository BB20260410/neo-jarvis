// @ts-check
/**
 * Pending approval / act backlog expiry policy (pure).
 * Soft-cancels pending items; never hard-deletes audit rows.
 */

export const DEFAULT_APPROVAL_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const DEFAULT_ACT_PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3d

export const ACT_PENDING_STATUSES = Object.freeze([
  'queued',
  'planning',
  'proposed',
  'budget_checked',
  'permission_checked',
  'dry_run',
  'awaiting_approval',
  'retrying',
]);

/**
 * @param {object} approval
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.ttlMs]
 * @returns {{ expire: boolean, reason: string }}
 */
export function shouldExpirePendingApproval(approval = {}, {
  nowMs = Date.now(),
  ttlMs = DEFAULT_APPROVAL_PENDING_TTL_MS,
} = {}) {
  if (String(approval.status || '') !== 'pending') {
    return { expire: false, reason: 'not_pending' };
  }
  const expiresAt = Number(approval.expiresAt ?? approval.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && nowMs >= expiresAt) {
    return { expire: true, reason: 'past_expires_at' };
  }
  const createdAt = Number(approval.createdAt ?? approval.created_at);
  if (Number.isFinite(createdAt) && createdAt > 0 && ttlMs > 0 && nowMs - createdAt >= ttlMs) {
    return { expire: true, reason: 'past_ttl' };
  }
  return { expire: false, reason: 'within_ttl' };
}

/**
 * @param {object} act
 * @param {object} [opts]
 */
export function shouldExpirePendingAct(act = {}, {
  nowMs = Date.now(),
  ttlMs = DEFAULT_ACT_PENDING_TTL_MS,
} = {}) {
  const status = String(act.status || '');
  if (!ACT_PENDING_STATUSES.includes(status)) {
    return { expire: false, reason: 'not_pending_status' };
  }
  const createdAt = Number(act.createdAt ?? act.created_at);
  const updatedAt = Number(act.updatedAt ?? act.updated_at) || createdAt;
  const anchor = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : createdAt;
  if (Number.isFinite(anchor) && anchor > 0 && ttlMs > 0 && nowMs - anchor >= ttlMs) {
    return { expire: true, reason: 'past_ttl' };
  }
  return { expire: false, reason: 'within_ttl' };
}

/**
 * Plan which pending approvals/acts to cancel.
 * @param {{ approvals?: object[], acts?: object[], nowMs?: number, approvalTtlMs?: number, actTtlMs?: number, limit?: number }} input
 */
export function planBacklogExpiry(input = {}) {
  const nowMs = Number(input.nowMs) || Date.now();
  const approvalTtlMs = Number.isFinite(Number(input.approvalTtlMs))
    ? Number(input.approvalTtlMs)
    : DEFAULT_APPROVAL_PENDING_TTL_MS;
  const actTtlMs = Number.isFinite(Number(input.actTtlMs))
    ? Number(input.actTtlMs)
    : DEFAULT_ACT_PENDING_TTL_MS;
  const limit = Math.max(1, Math.min(5000, Number(input.limit) || 500));

  const approvals = [];
  for (const a of Array.isArray(input.approvals) ? input.approvals : []) {
    const d = shouldExpirePendingApproval(a, { nowMs, ttlMs: approvalTtlMs });
    if (d.expire) {
      approvals.push({
        id: a.id,
        reason: d.reason,
        createdAt: a.createdAt ?? a.created_at ?? null,
        expiresAt: a.expiresAt ?? a.expires_at ?? null,
      });
    }
    if (approvals.length >= limit) break;
  }

  const acts = [];
  for (const act of Array.isArray(input.acts) ? input.acts : []) {
    const d = shouldExpirePendingAct(act, { nowMs, ttlMs: actTtlMs });
    if (d.expire) {
      acts.push({
        id: act.id,
        reason: d.reason,
        status: act.status,
        createdAt: act.createdAt ?? act.created_at ?? null,
        updatedAt: act.updatedAt ?? act.updated_at ?? null,
      });
    }
    if (acts.length >= limit) break;
  }

  return {
    nowMs,
    approvalTtlMs,
    actTtlMs,
    approvals,
    acts,
    counts: { approvals: approvals.length, acts: acts.length },
  };
}

/**
 * Apply plan via store methods (cancel only — keeps rows for audit).
 * @param {object} plan from planBacklogExpiry
 * @param {{ approvalStore?: { cancel?: Function }, actStore?: { cancel?: Function }, dryRun?: boolean, decisionBy?: string }} deps
 */
export function applyBacklogExpiry(plan, {
  approvalStore = null,
  actStore = null,
  dryRun = true,
  decisionBy = 'backlog-expiry',
} = {}) {
  const results = { dryRun: !!dryRun, approvals: [], acts: [] };
  for (const item of plan?.approvals || []) {
    if (dryRun) {
      results.approvals.push({ id: item.id, action: 'would_cancel', reason: item.reason });
      continue;
    }
    try {
      const out = approvalStore?.cancel?.(item.id, {
        decisionBy,
        reason: `expired:${item.reason}`,
      });
      results.approvals.push({ id: item.id, action: 'cancelled', reason: item.reason, status: out?.status || 'cancelled' });
    } catch (e) {
      results.approvals.push({ id: item.id, action: 'error', reason: e?.message || String(e) });
    }
  }
  for (const item of plan?.acts || []) {
    if (dryRun) {
      results.acts.push({ id: item.id, action: 'would_cancel', reason: item.reason });
      continue;
    }
    try {
      const out = actStore?.cancel?.(item.id, { reason: `expired:${item.reason}` });
      results.acts.push({ id: item.id, action: 'cancelled', reason: item.reason, status: out?.status || 'cancelled' });
    } catch (e) {
      results.acts.push({ id: item.id, action: 'error', reason: e?.message || String(e) });
    }
  }
  return results;
}
