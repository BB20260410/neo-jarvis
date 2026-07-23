import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { getCurrentTier, hasFeature } from '../license/LicenseManager.js';

const VALID_MODES = new Set(['chat', 'debate', 'squad', 'arena']);
const SINGLE_ADAPTERS = new Set(['claude', 'codex', 'minimax', 'ollama']);

function safeText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function hasAdapter(pool, id) {
  if (!pool || !id || typeof pool.has !== 'function') return true;
  try { return pool.has(id); } catch { return false; }
}

function displayName(pool, id, fallback) {
  try { return pool?.get?.(id)?.displayName || fallback || id; } catch { return fallback || id; }
}

function pickChatAdapter(plan, pool) {
  if (SINGLE_ADAPTERS.has(plan.targetAdapter)) return plan.targetAdapter;
  for (const id of ['codex', 'claude', 'minimax', 'ollama']) {
    if (hasAdapter(pool, id)) return id;
  }
  return 'codex';
}

function member(pool, adapterId, display, extra = {}) {
  return {
    adapterId,
    displayName: displayName(pool, adapterId, display),
    enabled: hasAdapter(pool, adapterId),
    ...extra,
  };
}

function membersForPlan(plan, pool) {
  const mode = VALID_MODES.has(plan.targetMode) ? plan.targetMode : 'debate';
  if (mode === 'chat') {
    const adapterId = pickChatAdapter(plan, pool);
    return [member(pool, adapterId, adapterId)];
  }
  if (mode === 'squad') {
    return [
      member(pool, 'claude', 'Claude · PM', { role: 'pm' }),
      member(pool, 'claude', 'Claude · Dev', { role: 'dev' }),
      member(pool, 'codex', 'Codex · Dev', { role: 'dev' }),
      member(pool, 'codex', 'Codex · QA', { role: 'qa' }),
    ];
  }
  if (mode === 'arena') {
    return [
      member(pool, 'claude', 'Claude Judge', { role: 'judge' }),
      member(pool, 'codex', 'Codex'),
      member(pool, 'gemini-cli', 'Gemini CLI'),
      member(pool, 'minimax', 'MiniMax'),
    ].filter((m) => m.enabled || m.adapterId === 'claude' || m.adapterId === 'codex');
  }
  return [
    member(pool, 'claude', 'Claude'),
    member(pool, 'codex', 'Codex'),
    member(pool, 'ollama', 'Ollama'),
  ];
}

export function normalizeTaskPlan(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const instructions = safeText(input.instructions || input.prompt || input.title, 1200);
  if (!instructions) return null;
  const targetAdapter = safeText(input.targetAdapter || input.target_adapter || 'auto', 40).toLowerCase() || 'auto';
  const targetMode = safeText(input.targetMode || input.target_mode || (targetAdapter === 'squad' ? 'squad' : targetAdapter === 'arena' ? 'arena' : 'debate'), 40).toLowerCase();
  return {
    intent: 'delegate_task',
    targetAdapter,
    targetMode: VALID_MODES.has(targetMode) ? targetMode : 'debate',
    title: safeText(input.title || instructions, 80) || 'Noe 派活任务',
    instructions,
    approvalRequired: true,
    dryRunOnly: true,
  };
}

export function validateTaskDelegationPlan(plan, { roomAdapterPool = null } = {}) {
  const normalized = normalizeTaskPlan(plan);
  if (!normalized) return { ok: false, status: 422, error: 'delegate task plan required' };
  const mode = normalized.targetMode;
  if ((mode === 'squad' || mode === 'arena') && !hasFeature(mode)) {
    return {
      ok: false,
      status: 402,
      error: `${mode === 'squad' ? 'AI 团队拆活（squad）' : '多模型联网核对（arena）'} 模式需要 Pro license`,
      tier: getCurrentTier(),
      feature: mode,
    };
  }
  const members = membersForPlan(normalized, roomAdapterPool);
  const required = mode === 'chat' ? members : members.filter((m) => ['claude', 'codex'].includes(m.adapterId));
  const missingAdapters = required.filter((m) => !m.enabled).map((m) => m.adapterId);
  if (missingAdapters.length) {
    return { ok: false, status: 409, error: `target adapters unavailable: ${missingAdapters.join(', ')}`, missingAdapters };
  }
  return { ok: true, plan: normalized, members };
}

export function buildNoeDelegatedTopic(plan) {
  return `# Noe 派活计划：${plan.title}

来源：Noe 认知/语音入口

## 任务
${plan.instructions}

## 安全约束
- 当前只创建待启动房间，不启动 CLI，不消耗外部配额。
- 后续启动必须走用户确认和审批链。
- 如需高风险命令，必须继续走权限治理。`;
}

export function createNoeDelegationRoom({
  plan,
  roomStore,
  roomAdapterPool = null,
  cwd = process.cwd(),
} = {}) {
  if (!roomStore || typeof roomStore.create !== 'function') throw new Error('roomStore required');
  const checked = validateTaskDelegationPlan(plan, { roomAdapterPool });
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.statusCode = checked.status;
    err.extra = checked;
    throw err;
  }
  const projectCwd = cwd || homedir();
  const room = roomStore.create({
    name: `Noe派活：${checked.plan.title}`,
    cwd: projectCwd,
    members: checked.members,
    mode: checked.plan.targetMode,
    objective: {
      id: `obj-noe-delegate-${randomUUID().slice(0, 8)}`,
      title: checked.plan.title,
      description: checked.plan.instructions,
      acceptanceCriteria: ['用户确认后再启动执行链', '执行产出可回溯到 Noe 派活计划'],
    },
    lineage: {
      projectId: projectCwd,
      taskId: `noe-delegate:${randomUUID().slice(0, 12)}`,
      source: 'noe_delegate',
    },
  });
  const updated = roomStore.update?.(room.id, {
    topic: buildNoeDelegatedTopic(checked.plan),
    delegatedFromNoe: {
      plan: checked.plan,
      createdAt: new Date().toISOString(),
      dryRunOnly: true,
    },
  }) || room;
  return { plan: checked.plan, room: roomStore.get?.(room.id) || updated || room };
}

export function createNoeDelegationStartApproval({ approvalStore, room, plan } = {}) {
  if (!approvalStore || typeof approvalStore.createApproval !== 'function') throw new Error('approvalStore required');
  return approvalStore.createApproval({
    type: 'manual',
    requesterType: 'noe',
    requesterId: 'delegate_task',
    dedupeKey: `noe-delegate-start:${room.id}`,
    payload: {
      title: `启动 Noe 派活房间：${plan.title}`,
      roomId: room.id,
      roomName: room.name,
      targetMode: plan.targetMode,
      targetAdapter: plan.targetAdapter,
      instructions: plan.instructions,
      risk: 'Approval only. This route does not start CLI adapters; approved startup must go through the normal room start path.',
    },
  });
}

export function formatNoeDelegationCreatedReply({ room, plan, approval = null } = {}) {
  const base = `已创建待启动房间：${room?.name || plan?.title || 'Noe派活'}。未启动 CLI、未消耗外部配额。`;
  if (!approval) return `${base} 后续需要在房间里手动启动。`;
  return `${base} 已生成启动审批 ${approval.id}，审批通过后仍需走正常启动链。`;
}
