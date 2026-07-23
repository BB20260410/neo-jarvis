// @ts-check
/**
 * High-risk pending confirm cards for Home (file write/delete + shell/exec).
 * Pure models over existing approval/act queues — no second queue.
 *
 * ActStore row shape (production): { id, action, status, title, payload, riskLevel, ... }
 * ActStore statuses do NOT include 'pending' — owner-wait is `awaiting_approval`.
 * ApprovalStore pending status IS `pending`.
 */
import {
  evaluateHighRiskConfirmation,
  isHighRiskAction,
} from './NoeHighRiskConfirmation.js';

export const CONFIRM_CARD_SCHEMA = 'neo.pending.confirm-card.v1';

/** Act statuses that surface as "待你确认" on Home (real ActStore set — never "pending"). */
export const ACT_CONFIRM_STATUSES = Object.freeze([
  'awaiting_approval',
]);

/** Broader act backlog statuses (optional collector); still never uses invalid "pending". */
export const ACT_OWNER_VISIBLE_PENDING_STATUSES = Object.freeze([
  'awaiting_approval',
  'blocked_safety',
]);

const FILE_TYPES = new Set([
  'fs_write', 'fs_delete', 'fs_write_system', 'file_write', 'file_delete',
  'write_file', 'delete_file', 'patch_file',
]);
const SHELL_TYPES = new Set([
  'shell_write', 'shell_exec', 'shell', 'exec', 'command', 'dangerous_command',
  'pty_exec', 'run_command',
]);

/**
 * Resolve action type string from ActStore / ApprovalStore / generic fixtures.
 * Prefer ActStore `action`, then actionType/type, then payload hints.
 * @param {object} item
 */
export function resolveActActionType(item = {}) {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const candidates = [
    item.actionType,
    item.action, // ActStore SSOT field
    item.type, // ApprovalStore type e.g. dangerous_command
    item.actType,
    item.kind,
    payload.actionType,
    payload.action,
    payload.tool,
    payload.op,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s) return s;
  }
  // Infer from payload content when action string is generic
  if (payload.command || item.command) return 'shell_write';
  if (payload.path || item.path || payload.targetPath) {
    if (/delete|unlink|rm/i.test(String(payload.op || payload.mode || item.title || ''))) {
      return 'fs_delete';
    }
    return 'fs_write';
  }
  return '';
}

/**
 * @param {string} type
 */
export function classifyPendingRiskKind(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return 'other';
  // dotted / namespaced actions: noe.act.shell_write, fs.write, shell.exec
  const compact = t.replace(/[./:-]+/g, '_');
  if (
    FILE_TYPES.has(t)
    || FILE_TYPES.has(compact)
    || /fs[_]?|file[_]?|write[_]?file|delete[_]?file|patch[_]?file|unlink/.test(compact)
  ) {
    return 'file';
  }
  if (
    SHELL_TYPES.has(t)
    || SHELL_TYPES.has(compact)
    || /shell|exec|command|pty|dangerous_command/.test(compact)
  ) {
    return 'shell';
  }
  if (isHighRiskAction(t) || isHighRiskAction(compact)) return 'high_risk';
  return 'other';
}

/**
 * Human-readable risk label.
 * @param {string} kind
 * @param {string} [type]
 */
export function riskLabelFor(kind, type = '') {
  if (kind === 'file') return '文件写入/删除';
  if (kind === 'shell') return 'Shell / 命令执行';
  if (kind === 'high_risk') return `高风险操作（${type || 'unknown'}）`;
  return type || '待确认操作';
}

/**
 * Whether this status should show as a pending confirm card.
 * Approvals: pending. Acts: awaiting_approval (not "pending" — invalid on ActStore).
 * @param {string} status
 * @param {'act'|'approval'} [source]
 */
export function isPendingConfirmStatus(status, source = 'act') {
  const s = String(status || '').toLowerCase();
  if (source === 'approval') {
    return s === 'pending' || s === 'awaiting_approval';
  }
  // acts
  return (
    s === 'awaiting_approval'
    || s === 'blocked_safety'
    // tolerate hand fixtures that still use "pending" in pure unit tests
    || s === 'pending'
  );
}

/**
 * Build one confirm card from a pending act or approval-like record.
 * @param {object} item
 * @param {'act'|'approval'} [source]
 */
export function buildConfirmCard(item = {}, source = 'act') {
  const id = String(item.id || item.approvalId || item.actId || '');
  const actionType = resolveActActionType(item);
  const kind = classifyPendingRiskKind(actionType);
  const status = String(item.status || (source === 'approval' ? 'pending' : 'awaiting_approval')).toLowerCase();
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const path = String(
    item.path || payload.path || item.targetPath || payload.targetPath || payload.file || '',
  ).slice(0, 500);
  const command = String(
    item.command || payload.command || item.cmd || payload.cmd || '',
  ).slice(0, 500);
  const summary = String(
    item.summary
    || item.title
    || item.reason
    || item.decisionReason
    || command
    || path
    || item.target
    || actionType
    || '待确认',
  ).slice(0, 400);

  const gateActionType = actionType
    || (kind === 'shell' ? 'shell_write' : kind === 'file' ? 'fs_delete' : 'read_file');

  const decision = evaluateHighRiskConfirmation({
    actionType: gateActionType,
    ownerConfirmed: item.ownerConfirmed === true || status === 'approved',
    dryRun: item.dryRun === true || status === 'dry_run',
    confirmationToken: item.confirmationToken,
    expectedToken: item.expectedToken,
  });

  return {
    schema: CONFIRM_CARD_SCHEMA,
    id,
    source,
    actionType: actionType || kind,
    riskKind: kind,
    riskLabel: riskLabelFor(kind, actionType),
    summary,
    path: path || null,
    command: command || null,
    status,
    pending: isPendingConfirmStatus(status, source),
    executed: status === 'executed' || status === 'completed' || item.executed === true,
    allowAllowed: decision.allowed === true && (status === 'approved' || item.ownerConfirmed === true),
    gate: {
      highRisk: decision.highRisk,
      reason: decision.reason,
      version: decision.version,
    },
  };
}

/**
 * @param {{ acts?: object[], approvals?: object[] }} [queues]
 */
export function buildConfirmCardQueue(queues = {}) {
  const cards = [];
  for (const a of Array.isArray(queues.acts) ? queues.acts : []) {
    const card = buildConfirmCard(a, 'act');
    if (card.pending) cards.push(card);
  }
  for (const a of Array.isArray(queues.approvals) ? queues.approvals : []) {
    const card = buildConfirmCard(a, 'approval');
    if (card.pending) cards.push(card);
  }
  return {
    schema: CONFIRM_CARD_SCHEMA,
    pendingCount: cards.length,
    cards,
  };
}

/**
 * Pending chip count must match queue length of pending items.
 * @param {object[]} pendingList
 * @param {'act'|'approval'|'mixed'} [sourceHint]
 */
export function pendingCountFromQueue(pendingList = [], sourceHint = 'mixed') {
  const list = Array.isArray(pendingList) ? pendingList : [];
  return list.filter((x) => {
    const hasAction = x && (x.action != null || x.actionType != null || x.type != null);
    const source = sourceHint === 'mixed'
      ? (x?.type && !x?.action && !x?.actionType ? 'approval' : (x?.action != null ? 'act' : 'approval'))
      : sourceHint;
    // Prefer explicit status semantics
    if (x?.action != null || (hasAction && source === 'act')) {
      return isPendingConfirmStatus(x?.status, 'act');
    }
    return isPendingConfirmStatus(x?.status, 'approval');
  }).length;
}

/**
 * Safely list acts that need owner confirm from a real ActStore-like API.
 * NEVER calls list({ status: 'pending' }) — that throws on ActStore.
 * Errors from actStore.list are swallowed so approvals can still return.
 *
 * @param {{ list?: Function }} actStore
 * @param {{ projectId?: string, limit?: number, statuses?: string[] }} [opts]
 * @returns {object[]}
 */
export function listPendingActsForConfirm(actStore, opts = {}) {
  if (!actStore || typeof actStore.list !== 'function') return [];
  const projectId = opts.projectId || 'noe';
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length
    ? opts.statuses
    : ACT_CONFIRM_STATUSES;
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const status of statuses) {
    if (String(status) === 'pending') continue; // hard guard — invalid on ActStore
    try {
      const rows = actStore.list({ projectId, status, limit }) || [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = row?.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(row);
      }
    } catch {
      // list may throw on bad status / DB; keep collecting other statuses
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * Collect approvals safely (status pending is valid on ApprovalStore).
 * @param {{ listApprovals?: Function }} approvalStore
 * @param {{ limit?: number }} [opts]
 */
export function listPendingApprovalsForConfirm(approvalStore, opts = {}) {
  if (!approvalStore || typeof approvalStore.listApprovals !== 'function') return [];
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));
  try {
    return approvalStore.listApprovals({ status: 'pending', limit }) || [];
  } catch {
    return [];
  }
}

/**
 * Build Home pending-confirms payload from real stores (route helper).
 * Approvals still return even if act listing throws.
 *
 * @param {{ actStore?: object, approvalStore?: object, projectId?: string, limit?: number }} deps
 */
export function buildPendingConfirmsFromStores(deps = {}) {
  const projectId = deps.projectId || 'noe';
  const limit = Number(deps.limit) || 50;
  const acts = listPendingActsForConfirm(deps.actStore, { projectId, limit });
  const approvals = listPendingApprovalsForConfirm(deps.approvalStore, { limit });
  const queue = buildConfirmCardQueue({ acts, approvals });
  return {
    ok: true,
    pendingCount: queue.pendingCount,
    cards: queue.cards,
    actsListed: acts.length,
    approvalsListed: approvals.length,
  };
}

/**
 * Apply allow/deny transition (pure). Deny never marks executed.
 * @param {object} card
 * @param {'allow'|'deny'} decision
 * @param {{ confirmationToken?: string, expectedToken?: string }} [opts]
 */
export function applyConfirmDecision(card = {}, decision = 'deny', opts = {}) {
  const actionType = card.actionType || 'shell_write';
  if (decision === 'deny') {
    return {
      ...card,
      status: 'denied',
      pending: false,
      executed: false,
      ownerConfirmed: false,
      decision: 'deny',
      gate: evaluateHighRiskConfirmation({
        actionType,
        ownerConfirmed: false,
        dryRun: false,
      }),
    };
  }
  const gate = evaluateHighRiskConfirmation({
    actionType,
    ownerConfirmed: true,
    dryRun: false,
    confirmationToken: opts.confirmationToken || card.confirmationToken,
    expectedToken: opts.expectedToken || card.expectedToken,
  });
  return {
    ...card,
    status: gate.allowed ? 'approved' : 'awaiting_approval',
    pending: !gate.allowed,
    executed: false,
    ownerConfirmed: true,
    decision: 'allow',
    gate,
  };
}
