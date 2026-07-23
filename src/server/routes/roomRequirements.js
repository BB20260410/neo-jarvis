import { randomUUID } from 'node:crypto';

export const ROOM_REQUIREMENT_MAX_LEN = 32000;
export const ROOM_REQUIREMENT_MAX_COUNT = 50;
export const ROOM_REQUIREMENT_AUDIT_MAX_COUNT = 100;

const ROOM_REQUIREMENT_REOPEN_ROOM_STATUSES = new Set([
  'blocked',
  'complete',
  'completed',
  'done',
  'error',
  'escalated',
  'failed',
  'paused',
]);

const ROOM_REQUIREMENT_REOPEN_TASK_STATUSES = new Set([
  'blocked',
  'escalated',
  'failed',
  'paused',
]);

const ROOM_REQUIREMENT_REOPEN_STAGE_IDS = new Set([
  'requirements',
  'technical_design',
  'task_planning',
  'implementation',
  'unit_test',
  'integration_test',
  'functional_validation',
  'documentation',
  'acceptance',
  'retrospective',
]);

function nextRequirementRevision(room) {
  const current = Number(room?.requirementRevision);
  return Number.isFinite(current) && current > 0 ? Math.floor(current) + 1 : 1;
}

function cloneRequirementStateValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function captureRoomRequirementState(room = {}) {
  return {
    status: cloneRequirementStateValue(room.status),
    requirementInjections: cloneRequirementStateValue(room.requirementInjections),
    requirementRevision: cloneRequirementStateValue(room.requirementRevision),
    latestRequirementInjection: cloneRequirementStateValue(room.latestRequirementInjection),
    requirementInjectionAuditTrail: cloneRequirementStateValue(room.requirementInjectionAuditTrail),
    requirementReopenState: cloneRequirementStateValue(room.requirementReopenState),
    goalMode: cloneRequirementStateValue(room.goalMode),
    taskList: cloneRequirementStateValue(room.taskList),
  };
}

function restoreRoomRequirementState(room, snapshot = {}) {
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] === undefined) delete room[key];
    else room[key] = cloneRequirementStateValue(snapshot[key]);
  }
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isTaskDone(task) {
  return normalizedStatus(task?.status) === 'done';
}

function firstRequirementReopenIndex(tasks) {
  const explicit = tasks.findIndex((task) => ROOM_REQUIREMENT_REOPEN_STAGE_IDS.has(normalizedStatus(task?.stageId)));
  return explicit >= 0 ? explicit : 0;
}

function shouldReopenCompletedRoom(room, tasks) {
  const roomStatus = normalizedStatus(room?.status);
  const allTasksDone = tasks.length > 0 && tasks.every(isTaskDone);
  return ROOM_REQUIREMENT_REOPEN_ROOM_STATUSES.has(roomStatus) && allTasksDone;
}

function resetTaskForRequirementReopen(task, injection, reason) {
  const previousStatus = task.status || 'pending';
  task.status = 'pending';
  task.blocking = false;
  task.rounds = [];
  task.qualityGateFeedback = reason;
  task.qualityGateRepairs = 0;
  task.requirementReopenHistory = [
    ...(Array.isArray(task.requirementReopenHistory) ? task.requirementReopenHistory : []),
    {
      at: injection.at,
      injectionId: injection.id,
      revision: injection.revision,
      previousStatus,
      reason,
    },
  ].slice(-20);
  delete task.consensus;
  delete task.stageArtifact;
  delete task.acceptanceReport;
  delete task.retrospectiveReport;
  delete task.escalateReason;
}

function maybeUpdateRoomStatusForRequirement(room, reopenCompletedRoom, reopenedTaskIds) {
  const roomStatus = normalizedStatus(room?.status);
  if (roomStatus === 'running' || roomStatus === 'debating' || roomStatus === 'active' || roomStatus === 'processing') {
    return { changed: false, previousStatus: room.status || '', nextStatus: room.status || '' };
  }
  if (!reopenCompletedRoom && reopenedTaskIds.length === 0) {
    return { changed: false, previousStatus: room.status || '', nextStatus: room.status || '' };
  }
  if (!ROOM_REQUIREMENT_REOPEN_ROOM_STATUSES.has(roomStatus)) {
    return { changed: false, previousStatus: room.status || '', nextStatus: room.status || '' };
  }
  const previousStatus = room.status || '';
  room.status = 'paused';
  return { changed: previousStatus !== room.status, previousStatus, nextStatus: room.status };
}

export function appendRoomRequirementInjection(room, content, {
  now = new Date().toISOString(),
  id = randomUUID(),
} = {}) {
  if (!room || typeof room !== 'object') return { ok: false, error: 'room required' };
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'content required' };
  if (text.length > ROOM_REQUIREMENT_MAX_LEN) {
    return { ok: false, status: 413, error: `content too long (max ${ROOM_REQUIREMENT_MAX_LEN})` };
  }
  const existing = Array.isArray(room.requirementInjections) ? room.requirementInjections : [];
  if (existing.length >= ROOM_REQUIREMENT_MAX_COUNT) {
    return { ok: false, status: 429, error: `too many requirement injections (max ${ROOM_REQUIREMENT_MAX_COUNT})` };
  }

  const revision = nextRequirementRevision(room);
  const injection = { id, at: now, content: text, source: 'user_midrun_requirement', revision };
  room.requirementInjections = [...existing, injection];
  room.requirementRevision = revision;
  room.latestRequirementInjection = {
    id,
    at: now,
    revision,
    source: injection.source,
  };

  const appliedTaskIds = [];
  const runningTaskIds = [];
  const skippedDoneTaskIds = [];
  const reopenedTaskIds = [];
  const tasks = Array.isArray(room.taskList) ? room.taskList : [];
  const reopenCompletedRoom = shouldReopenCompletedRoom(room, tasks);
  const reopenFromIndex = reopenCompletedRoom ? firstRequirementReopenIndex(tasks) : -1;
  const reopenReason = `用户在第 ${revision} 版追加需求后要求继续完成: ${text.slice(0, 500)}`;
  if (Array.isArray(room.taskList)) {
    for (let index = 0; index < room.taskList.length; index += 1) {
      const task = room.taskList[index];
      if (!task) continue;
      const shouldReopenDoneTask = reopenCompletedRoom && index >= reopenFromIndex;
      if (isTaskDone(task) && !shouldReopenDoneTask) {
        if (task.id) skippedDoneTaskIds.push(task.id);
        continue;
      }
      const taskInjections = Array.isArray(task.userInjections) ? task.userInjections : [];
      if (taskInjections.length >= ROOM_REQUIREMENT_MAX_COUNT) continue;
      task.userInjections = [...taskInjections, injection];
      task.requirementRevision = revision;
      task.requirementInjectionIds = [
        ...(Array.isArray(task.requirementInjectionIds) ? task.requirementInjectionIds : []),
        id,
      ].slice(-ROOM_REQUIREMENT_MAX_COUNT);
      if (task.id) appliedTaskIds.push(task.id);
      if (task.status === 'running' && task.id) runningTaskIds.push(task.id);
      const shouldReopenBlockedTask = ROOM_REQUIREMENT_REOPEN_TASK_STATUSES.has(normalizedStatus(task.status))
        || task.blocking === true;
      if (shouldReopenDoneTask || shouldReopenBlockedTask) {
        resetTaskForRequirementReopen(task, injection, reopenReason);
        if (task.id) reopenedTaskIds.push(task.id);
      }
    }
  }

  const statusChange = maybeUpdateRoomStatusForRequirement(room, reopenCompletedRoom, reopenedTaskIds);
  if (reopenCompletedRoom || reopenedTaskIds.length > 0 || statusChange.changed) {
    room.requirementReopenState = {
      at: now,
      injectionId: id,
      revision,
      reopenedTaskIds,
      reopenCompletedRoom,
      previousStatus: statusChange.previousStatus,
      nextStatus: statusChange.nextStatus,
      reason: reopenReason,
    };
  }

  if (room.goalMode && typeof room.goalMode === 'object' && room.goalMode.enabled === true) {
    room.goalMode = {
      ...room.goalMode,
      requirementRevision: revision,
      latestRequirementInjectionId: id,
      latestRequirementInjectionAt: now,
      requirementReopenTaskIds: reopenedTaskIds,
      lastReworkDigest: '',
      repeatedBlockerCount: 0,
    };
  }

  const auditEvent = {
    type: 'room_requirement_added',
    injectionId: id,
    at: now,
    revision,
    roomStatus: room.status || 'unknown',
    goalModeEnabled: room.goalMode?.enabled === true,
    appliedTaskIds,
    runningTaskIds,
    skippedDoneTaskIds,
    reopenedTaskIds,
    reopenCompletedRoom,
    previousStatus: statusChange.previousStatus,
    nextStatus: statusChange.nextStatus,
  };
  room.requirementInjectionAuditTrail = [
    ...(Array.isArray(room.requirementInjectionAuditTrail) ? room.requirementInjectionAuditTrail : []),
    auditEvent,
  ].slice(-ROOM_REQUIREMENT_AUDIT_MAX_COUNT);

  return {
    ok: true,
    injection,
    appliedTaskIds,
    runningTaskIds,
    skippedDoneTaskIds,
    reopenedTaskIds,
    reopenCompletedRoom,
    statusChange,
    auditEvent,
    revision,
  };
}

export function registerRoomRequirementsRoutes(app, {
  roomStore,
  requireOwnerToken,
  broadcastRoom = () => {},
}) {
  app.post('/api/rooms/:id/requirements', requireOwnerToken, (req, res) => {
    const room = roomStore.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const rollbackSnapshot = captureRoomRequirementState(room);
    const result = appendRoomRequirementInjection(room, req.body?.content);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    try {
      if (typeof roomStore.update === 'function') {
        roomStore.update(room.id, {
          requirementInjections: room.requirementInjections,
          requirementRevision: room.requirementRevision,
          latestRequirementInjection: room.latestRequirementInjection,
          requirementInjectionAuditTrail: room.requirementInjectionAuditTrail,
          requirementReopenState: room.requirementReopenState,
          goalMode: room.goalMode,
          status: room.status,
          taskList: room.taskList,
        });
      } else if (typeof roomStore.save === 'function') {
        roomStore.save();
      }
      if (typeof roomStore.flush === 'function') roomStore.flush();
    } catch (e) {
      restoreRoomRequirementState(room, rollbackSnapshot);
      try {
        if (typeof roomStore.update === 'function') {
          roomStore.update(room.id, rollbackSnapshot);
        }
      } catch (rollbackErr) {
        // 强健（2026-06-10）：回滚持久化失败记日志，不静默吞——内存已回滚但磁盘可能不一致，留痕便于排障
        console.error('[room-requirements] 回滚 update 失败:', rollbackErr?.message || rollbackErr);
      }
      return res.status(500).json({
        error: 'requirement persist failed',
        detail: e?.message || String(e),
        injection: result.injection,
        revision: result.revision,
        rolledBack: true,
      });
    }
    broadcastRoom(room.id, {
      type: 'room_requirement_added',
      injection: result.injection,
      appliedTaskIds: result.appliedTaskIds,
      runningTaskIds: result.runningTaskIds,
      skippedDoneTaskIds: result.skippedDoneTaskIds,
      reopenedTaskIds: result.reopenedTaskIds,
      reopenCompletedRoom: result.reopenCompletedRoom,
      auditEvent: result.auditEvent,
      revision: result.revision,
    });
    return res.json({
      ok: true,
      injection: result.injection,
      appliedTaskIds: result.appliedTaskIds,
      runningTaskIds: result.runningTaskIds,
      skippedDoneTaskIds: result.skippedDoneTaskIds,
      reopenedTaskIds: result.reopenedTaskIds,
      reopenCompletedRoom: result.reopenCompletedRoom,
      status: room.status,
      requirementReopenState: room.requirementReopenState,
      revision: result.revision,
      auditEvent: result.auditEvent,
      persisted: true,
      note: room.status === 'running'
        ? '当前正在执行的子进程不会被强制中断；新增需求会进入后续阶段/下一轮提示。'
        : '新增需求已写入房间上下文。',
    });
  });
}
