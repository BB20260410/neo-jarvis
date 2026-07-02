import { activityLog } from '../audit/ActivityLog.js';
import { approvalStore as defaultApprovalStore } from '../approval/ApprovalStore.js';
import { budgetPolicyStore as defaultBudgetStore, BudgetLimitExceededError } from '../budget/BudgetPolicyStore.js';
import { agentRunStore as defaultAgentRunStore } from '../agents/AgentRunStore.js';

const DEFAULT_GATE_POLL_MS = 30_000;

function str(value, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactRoom(room = {}) {
  return {
    id: room.id || null,
    name: room.name || '',
    mode: room.mode || '',
    status: room.status || '',
    cwd: room.cwd || null,
  };
}

export function noeDelegateStartApprovalDedupeKey(roomId) {
  return `noe-delegate-start:${roomId}`;
}

function deferGate({ job, reason, runAfter, approval = null, budgetBlocked = [] } = {}) {
  return {
    __defer: true,
    runAfter,
    reason,
    result: {
      ok: true,
      waiting: reason,
      jobId: job?.id || null,
      roomId: job?.roomId || job?.payload?.roomId || null,
      approvalId: approval?.id || null,
      budgetBlocked,
      agentRunId: job?.payload?.agentRunId || null,
    },
  };
}

function ensureApproval({ approvalStore, job, room, plan, now, pollMs } = {}) {
  if (job.payload?.requireApproval === false) return { ok: true, approval: null };
  const approvalId = str(job.payload?.approvalId, 160);
  const dedupeKey = noeDelegateStartApprovalDedupeKey(room.id);
  const approval = approvalId
    ? approvalStore.getApproval(approvalId)
    : approvalStore.getLatestByDedupeKey?.(dedupeKey);
  if (approval) {
    if (approval.status === 'approved') return { ok: true, approval };
    if (approval.status === 'pending') {
      return { ok: false, deferred: deferGate({ job, reason: 'approval_pending', runAfter: now + pollMs, approval }) };
    }
    throw new Error(`noe delegate start approval ${approval.status}`);
  }
  const created = approvalStore.createApproval({
    type: 'manual',
    requesterType: 'autopilot',
    requesterId: job.id,
    dedupeKey,
    payload: {
      title: `启动 Noe 派活房间：${plan?.title || room.name || room.id}`,
      roomId: room.id,
      roomName: room.name || '',
      targetMode: room.mode || plan?.targetMode || '',
      targetAdapter: plan?.targetAdapter || '',
      jobId: job.id,
      agentRunId: job.payload?.agentRunId || null,
      risk: 'Autopilot will start this Noe-delegated room after approval and budget gates pass.',
    },
  });
  return { ok: false, deferred: deferGate({ job, reason: 'approval_created', runAfter: now + pollMs, approval: created }) };
}

function checkBudget({ budgetStore, job, room, now, pollMs } = {}) {
  const estimate = job.payload?.budgetEstimate || job.payload?.budget || {};
  try {
    return budgetStore.preflight({
      projectId: job.projectId || room.cwd || null,
      cwd: room.cwd || null,
      roomId: room.id,
      adapterId: estimate.adapterId || job.payload?.adapterId || 'noe-delegate-autostart',
      taskId: job.taskId || `noe-delegate:${room.id}`,
      agentRunId: job.payload?.agentRunId || null,
      estimateUSD: num(estimate.estimateUSD ?? estimate.usd, 0),
      estimateTokens: num(estimate.estimateTokens ?? estimate.tokens, 0),
      estimateCalls: num(estimate.estimateCalls ?? estimate.calls, 1),
    });
  } catch (e) {
    if (e instanceof BudgetLimitExceededError || e?.code === 'BUDGET_LIMIT_EXCEEDED') {
      return deferGate({ job, reason: 'budget_blocked', runAfter: now + pollMs, budgetBlocked: e.blocked || [] });
    }
    throw e;
  }
}

export function makeNoeDelegationAutostartHandler({
  approvalStore = defaultApprovalStore,
  budgetStore = defaultBudgetStore,
  roomStore,
  startRoom,
  sendChatMessage,
  agentRunStore = defaultAgentRunStore,
  now = () => Date.now(),
  gatePollMs = DEFAULT_GATE_POLL_MS,
} = {}) {
  if (!roomStore) throw new Error('makeNoeDelegationAutostartHandler requires roomStore');
  if (typeof startRoom !== 'function') throw new Error('makeNoeDelegationAutostartHandler requires startRoom');

  return async function noeDelegationAutostart(job) {
    const ts = now();
    const pollMs = Math.max(1_000, Math.trunc(num(job.payload?.gatePollMs, gatePollMs)));
    const roomId = str(job.payload?.roomId || job.roomId || job.targetId, 160);
    if (!roomId) throw new Error('start_noe_delegate job requires roomId');
    const room = roomStore.get(roomId);
    if (!room) throw new Error('room not found');
    const plan = job.payload?.plan || room.delegatedFromNoe?.plan || {};
    const agentRunId = job.payload?.agentRunId || null;

    const approvalGate = ensureApproval({ approvalStore, job, room, plan, now: ts, pollMs });
    if (!approvalGate.ok) {
      if (agentRunId) {
        try { agentRunStore.transition(agentRunId, 'deferred', { deferReason: approvalGate.deferred.reason, approvalId: approvalGate.deferred.result?.approvalId || null, roomId }); } catch {}
      }
      return approvalGate.deferred;
    }

    const budgetGate = checkBudget({ budgetStore, job, room, now: ts, pollMs });
    if (budgetGate?.__defer) {
      if (agentRunId) {
        try { agentRunStore.transition(agentRunId, 'deferred', { deferReason: 'budget_blocked', approvalId: approvalGate.approval?.id || null, roomId }); } catch {}
      }
      return budgetGate;
    }

    const autoStart = job.payload?.autoStart !== false;
    const instructions = str(plan.instructions || job.payload?.instructions || room.topic, 8000);
    let startResult = { started: false, reason: 'auto_start_disabled', roomId };
    if (autoStart) {
      if ((room.mode || 'debate') === 'chat') {
        if (typeof sendChatMessage !== 'function') throw new Error('sendChatMessage required for chat room autostart');
        const message = await sendChatMessage(room, instructions, { job, approval: approvalGate.approval });
        startResult = { started: true, roomId, mode: 'chat', message };
      } else {
        startResult = await startRoom({ room, delegation: { title: plan.title, instructions }, job });
      }
    }

    activityLog.recordSafe({
      action: 'noe.delegate.autostart',
      actorType: 'autopilot',
      actorId: job.id,
      roomId,
      taskId: job.taskId || `noe-delegate:${roomId}`,
      entityType: 'room',
      entityId: roomId,
      status: startResult.started ? 'started' : 'created',
      details: { roomId, targetMode: room.mode || null, started: !!startResult.started, approvalId: approvalGate.approval?.id || null, agentRunId },
    });
    if (agentRunId) {
      try { agentRunStore.transition(agentRunId, 'succeeded', { approvalId: approvalGate.approval?.id || null, roomId, started: !!startResult.started }); } catch {}
    }
    return { ok: true, room: compactRoom(room), started: !!startResult.started, startResult, approvalId: approvalGate.approval?.id || null, agentRunId };
  };
}
