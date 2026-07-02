import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClusterHealthTrendReport } from './cluster-health-trend.js';
import { buildClusterResourceGuardReport } from './cluster-resource-guard.js';
import { buildClusterOpsGuardReport } from './cluster-ops-guard.js';
import { buildClusterCapabilityGuardReport } from './cluster-capability-guard.js';

const DEFAULT_CLUSTER_MAX_RUNNING_ROOMS = 5;
const DEFAULT_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = 3;
const DEFAULT_CLUSTER_START_RESERVATION_TTL_MS = 60_000;
const DEFAULT_CLUSTER_STALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CLUSTER_STALL_RECOVERY_WINDOW_MS = 2 * 60 * 60_000;
const DEFAULT_CLUSTER_MAX_STALL_RECOVERIES = 3;
const clusterStartReservations = new Map();
const GOAL_MODE_COMMAND_RE = /^\s*(?:[\/／]目标|\/goal)\s*[:：-]?\s*/i;

export function parseGoalModeCommandTopic(topic) {
  const raw = String(topic || '');
  if (!GOAL_MODE_COMMAND_RE.test(raw)) {
    return { topic: raw, goalModeCommand: false };
  }
  const stripped = raw.replace(GOAL_MODE_COMMAND_RE, '').trim();
  return {
    topic: stripped,
    goalModeCommand: true,
  };
}

function clusterHealthHistoryPath() {
  return process.env.PANEL_HEALTH_HISTORY_PATH || join(
    process.cwd(),
    'logs',
    `cluster-health-${Number(process.env.PORT || 51835)}.history.jsonl`,
  );
}

function readClusterHealthHistoryText() {
  if (!process.env.PANEL_HEALTH_HISTORY_PATH && process.env.NODE_ENV === 'test') return '';
  const historyPath = clusterHealthHistoryPath();
  try {
    return existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  } catch {
    return '';
  }
}

function buildClusterTrendCurrentReport({ health, readiness, diagnostics, repair = null }) {
  const ok = health?.status === 'passed'
    && readiness?.status !== 'blocked'
    && diagnostics?.status !== 'blocked'
    && repair?.ok !== false;
  return {
    ok,
    health,
    readiness,
    diagnostics,
    ...(repair ? { repair } : {}),
  };
}

export function buildClusterHealthTrend({ health, readiness, diagnostics, repair = null } = {}) {
  return buildClusterHealthTrendReport({
    historyText: readClusterHealthHistoryText(),
    currentReport: buildClusterTrendCurrentReport({ health, readiness, diagnostics, repair }),
  });
}

export function buildClusterResourceGuard() {
  return buildClusterResourceGuardReport();
}

function buildClusterOpsCurrentReport({ health, readiness, diagnostics, healthTrend, resourceGuard, repair = null }) {
  const ok = health?.status === 'passed'
    && readiness?.status !== 'blocked'
    && diagnostics?.status !== 'blocked'
    && healthTrend?.status !== 'blocked'
    && resourceGuard?.status !== 'blocked'
    && repair?.ok !== false;
  return {
    ok,
    health,
    readiness,
    diagnostics,
    healthTrend,
    resourceGuard,
    ...(repair ? { repair } : {}),
  };
}

export function buildClusterOpsGuard({ health, readiness, diagnostics, healthTrend, resourceGuard, repair = null, rooms = [] } = {}) {
  return buildClusterOpsGuardReport({
    historyText: readClusterHealthHistoryText(),
    currentReport: buildClusterOpsCurrentReport({ health, readiness, diagnostics, healthTrend, resourceGuard, repair }),
    rooms,
  });
}

function extractKnownClusterAdapterIds(roomAdapterPool = null) {
  if (!roomAdapterPool) return [];
  if (roomAdapterPool.adapters instanceof Map) return [...roomAdapterPool.adapters.keys()];
  if (roomAdapterPool.adapters && typeof roomAdapterPool.adapters === 'object') return Object.keys(roomAdapterPool.adapters);
  if (typeof roomAdapterPool.list === 'function') {
    try {
      return (roomAdapterPool.list() || []).map((item) => item?.id || item?.adapterId || '').filter(Boolean);
    } catch {}
  }
  return [];
}

export function buildClusterCapabilityGuard({ rooms = [], roomAdapterPool = null } = {}) {
  return buildClusterCapabilityGuardReport({
    rooms,
    knownAdapterIds: extractKnownClusterAdapterIds(roomAdapterPool),
  });
}

function positiveIntFromEnv(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export function listRoomsForConcurrency(roomStore) {
  if (!roomStore) return [];
  if (typeof roomStore.list === 'function') {
    try {
      const rooms = roomStore.list();
      return Array.isArray(rooms) ? rooms : [];
    } catch {}
  }
  if (roomStore.rooms && typeof roomStore.rooms.values === 'function') {
    try { return [...roomStore.rooms.values()]; } catch {}
  }
  if (roomStore._rooms && typeof roomStore._rooms.values === 'function') {
    try { return [...roomStore._rooms.values()]; } catch {}
  }
  return [];
}

function enabledAdapterIds(room = {}) {
  return [...new Set((Array.isArray(room.members) ? room.members : [])
    .filter((member) => member?.enabled !== false)
    .map((member) => String(member?.adapterId || '').trim())
    .filter(Boolean))];
}

export function clusterRoomId(room = {}) {
  return String(room?.roomId || room?.id || '').trim();
}

function clusterStallTimeoutMs() {
  return positiveIntFromEnv('PANEL_CLUSTER_STALL_TIMEOUT_MS', DEFAULT_CLUSTER_STALL_TIMEOUT_MS);
}

function clusterStallRecoveryWindowMs() {
  return positiveIntFromEnv('PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS', DEFAULT_CLUSTER_STALL_RECOVERY_WINDOW_MS);
}

function clusterMaxStallRecoveries() {
  return positiveIntFromEnv('PANEL_CLUSTER_MAX_STALL_RECOVERIES', DEFAULT_CLUSTER_MAX_STALL_RECOVERIES);
}

function clusterHeartbeatProgressMs(room = {}) {
  const raw = room?.clusterRuntimeHeartbeat?.lastProgressAt || room?.clusterRuntimeHeartbeat?.startedAt || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function buildClusterRuntimeResumePolicy(room, recoveryEvents, nowMs, nowIso) {
  const windowMs = clusterStallRecoveryWindowMs();
  const maxStallRecoveries = clusterMaxStallRecoveries();
  const recentStallEvents = (Array.isArray(recoveryEvents) ? recoveryEvents : [])
    .filter((event) => event?.reason === 'active_running_without_progress_timeout')
    .filter((event) => {
      const eventMs = Date.parse(event?.at || '');
      return Number.isFinite(eventMs) && nowMs - eventMs <= windowMs;
    });
  const stallRecoveryCount = recentStallEvents.length;
  const autoResumeAllowed = stallRecoveryCount < maxStallRecoveries;
  return {
    statusVersion: 'cluster-runtime-resume-policy-v1',
    updatedAt: nowIso,
    reason: 'stall_recovery',
    autoResumeAllowed,
    manualResumeAllowed: true,
    stallRecoveryCount,
    maxStallRecoveries,
    windowMs,
    nextAction: autoResumeAllowed
      ? 'auto_resume_allowed_with_watchdog'
      : 'manual_review_required_before_resume',
    lastRecoveryReason: room?.clusterRuntimeRecovery?.reason || 'active_running_without_progress_timeout',
  };
}

function pruneClusterStartReservations(now = Date.now()) {
  const ttl = positiveIntFromEnv('PANEL_CLUSTER_START_RESERVATION_TTL_MS', DEFAULT_CLUSTER_START_RESERVATION_TTL_MS);
  for (const [roomId, reservation] of clusterStartReservations.entries()) {
    if (!reservation?.createdAt || now - reservation.createdAt > ttl) clusterStartReservations.delete(roomId);
  }
}

export function reserveClusterStart(room = {}) {
  const roomId = clusterRoomId(room);
  if (!roomId) return { ok: false, reason: 'room_id_missing' };
  pruneClusterStartReservations();
  if (clusterStartReservations.has(roomId)) return { ok: false, reason: 'already_starting' };
  clusterStartReservations.set(roomId, {
    roomId,
    mode: 'cross_verify',
    status: 'starting',
    members: Array.isArray(room.members) ? room.members : [],
    createdAt: Date.now(),
  });
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      clusterStartReservations.delete(roomId);
    },
  };
}

export function clearClusterStartReservationsForTest() {
  clusterStartReservations.clear();
}

export function buildClusterActiveAbortRooms(dispatcher, roomStore) {
  const activeAborts = dispatcher?.activeAborts;
  if (!activeAborts || typeof activeAborts.entries !== 'function') return [];
  const rooms = [];
  for (const [roomId, aborter] of activeAborts.entries()) {
    if (aborter?.signal?.aborted) continue;
    const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
    rooms.push({
      id: roomId,
      roomId,
      name: room?.name || '',
      mode: 'cross_verify',
      status: 'running',
      source: 'dispatcher_active_abort',
      members: Array.isArray(room?.members) ? room.members : [],
    });
  }
  return rooms;
}

export function reconcileClusterRuntimeState({
  roomStore,
  dispatcher,
  broadcastRoom = null,
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const nowIso = now instanceof Date ? now.toISOString() : new Date(nowMs).toISOString();
  pruneClusterStartReservations(nowMs);
  const activeIds = new Set();
  const activeAbortByRoom = new Map();
  const activeAborts = dispatcher?.activeAborts;
  if (activeAborts && typeof activeAborts.entries === 'function') {
    for (const [roomId, aborter] of activeAborts.entries()) {
      const normalizedRoomId = String(roomId || '').trim();
      if (!normalizedRoomId) continue;
      if (aborter?.signal?.aborted) {
        try { activeAborts.delete(roomId); } catch {}
        continue;
      }
      activeIds.add(normalizedRoomId);
      activeAbortByRoom.set(normalizedRoomId, { roomId, aborter });
    }
  }
  const recoveredRooms = [];
  const stalledActiveRooms = [];
  const recoveryErrors = [];
  const stallTimeoutMs = clusterStallTimeoutMs();
  for (const room of listRoomsForConcurrency(roomStore)) {
    const roomId = String(room?.id || room?.roomId || '').trim();
    if (!roomId || room?.mode !== 'cross_verify' || room?.status !== 'running') continue;
    if (activeIds.has(roomId)) {
      const lastProgressMs = clusterHeartbeatProgressMs(room);
      const stalledForMs = lastProgressMs ? nowMs - lastProgressMs : 0;
      if (!lastProgressMs || stalledForMs <= stallTimeoutMs) continue;
      const event = {
        type: 'cluster_runtime_recovered',
        reason: 'active_running_without_progress_timeout',
        action: 'paused_for_resume',
        source: 'cluster_runtime_reconciler',
        at: nowIso,
        lastProgressAt: new Date(lastProgressMs).toISOString(),
        stalledForMs,
        stallTimeoutMs,
      };
      const recoveryEvents = [
        ...(Array.isArray(room.clusterRuntimeRecoveryEvents) ? room.clusterRuntimeRecoveryEvents : []),
        event,
      ].slice(-20);
      const resumePolicy = buildClusterRuntimeResumePolicy(room, recoveryEvents, nowMs, nowIso);
      try {
        if (typeof roomStore?.update === 'function') {
          roomStore.update(roomId, {
            status: 'paused',
            clusterRuntimeRecovery: event,
            clusterRuntimeRecoveryEvents: recoveryEvents,
            clusterRuntimeStallRecovery: event,
            clusterRuntimeResumePolicy: resumePolicy,
          });
        } else if (typeof roomStore?.setStatus === 'function') {
          roomStore.setStatus(roomId, 'paused');
          room.clusterRuntimeRecovery = event;
          room.clusterRuntimeRecoveryEvents = recoveryEvents;
          room.clusterRuntimeStallRecovery = event;
          room.clusterRuntimeResumePolicy = resumePolicy;
        } else {
          room.status = 'paused';
          room.clusterRuntimeRecovery = event;
          room.clusterRuntimeRecoveryEvents = recoveryEvents;
          room.clusterRuntimeStallRecovery = event;
          room.clusterRuntimeResumePolicy = resumePolicy;
        }
      } catch (e) {
        recoveryErrors.push({
          roomId,
          name: room.name || '',
          reason: event.reason,
          action: event.action,
          error: e?.message || String(e),
          at: nowIso,
        });
        continue;
      }
      const active = activeAbortByRoom.get(roomId);
      try { active?.aborter?.abort?.(); } catch {}
      try { if (active) activeAborts.delete(active.roomId); } catch {}
      stalledActiveRooms.push({
        roomId,
        name: room.name || '',
        previousStatus: 'running',
        nextStatus: 'paused',
        reason: event.reason,
        lastProgressAt: event.lastProgressAt,
        stalledForMs,
        stallTimeoutMs,
        resumePolicy,
        at: nowIso,
      });
      try {
        if (typeof broadcastRoom === 'function') {
          broadcastRoom(roomId, {
            ...event,
            roomId,
            previousStatus: 'running',
            nextStatus: 'paused',
          });
        }
      } catch {}
      continue;
    }
    if (clusterStartReservations.has(roomId)) continue;
    const event = {
      type: 'cluster_runtime_recovered',
      reason: 'stale_running_without_dispatcher',
      action: 'paused_for_resume',
      source: 'cluster_runtime_reconciler',
      at: nowIso,
    };
    const recoveryEvents = [
      ...(Array.isArray(room.clusterRuntimeRecoveryEvents) ? room.clusterRuntimeRecoveryEvents : []),
      event,
    ].slice(-20);
    let recovered = false;
    try {
      if (typeof roomStore?.update === 'function') {
        roomStore.update(roomId, {
          status: 'paused',
          clusterRuntimeRecovery: event,
          clusterRuntimeRecoveryEvents: recoveryEvents,
        });
      } else if (typeof roomStore?.setStatus === 'function') {
        roomStore.setStatus(roomId, 'paused');
      } else {
        room.status = 'paused';
        room.clusterRuntimeRecovery = event;
        room.clusterRuntimeRecoveryEvents = recoveryEvents;
      }
      recovered = true;
    } catch (e) {
      recoveryErrors.push({
        roomId,
        name: room.name || '',
        reason: event.reason,
        action: event.action,
        error: e?.message || String(e),
        at: nowIso,
      });
    }
    if (!recovered) continue;
    recoveredRooms.push({
      roomId,
      name: room.name || '',
      previousStatus: 'running',
      nextStatus: 'paused',
      reason: event.reason,
      at: nowIso,
    });
    try {
      if (typeof broadcastRoom === 'function') {
        broadcastRoom(roomId, {
          ...event,
          roomId,
          previousStatus: 'running',
          nextStatus: 'paused',
        });
      }
    } catch {}
  }
  const cleanedActiveAborts = [];
  if (activeAborts && typeof activeAborts.entries === 'function') {
    for (const [roomId, aborter] of activeAborts.entries()) {
      const normalizedRoomId = String(roomId || '').trim();
      if (!normalizedRoomId) continue;
      const room = typeof roomStore?.get === 'function' ? roomStore.get(normalizedRoomId) : null;
      const shouldClean = !room || room.mode !== 'cross_verify' || room.status !== 'running' || aborter?.signal?.aborted;
      if (!shouldClean) continue;
      const reason = !room
        ? 'stale_dispatcher_active_abort_room_missing'
        : aborter?.signal?.aborted
          ? 'stale_dispatcher_active_abort_already_aborted'
          : 'stale_dispatcher_active_abort_without_running_room';
      const event = {
        type: 'cluster_runtime_recovered',
        reason,
        action: 'cleared_dispatcher_active_abort',
        source: 'cluster_runtime_reconciler',
        at: nowIso,
      };
      if (room) {
        const recoveryEvents = [
          ...(Array.isArray(room.clusterRuntimeRecoveryEvents) ? room.clusterRuntimeRecoveryEvents : []),
          event,
        ].slice(-20);
        try {
          if (typeof roomStore?.update === 'function') {
            roomStore.update(normalizedRoomId, {
              clusterRuntimeRecovery: event,
              clusterRuntimeRecoveryEvents: recoveryEvents,
            });
          } else {
            room.clusterRuntimeRecovery = event;
            room.clusterRuntimeRecoveryEvents = recoveryEvents;
          }
        } catch (e) {
          recoveryErrors.push({
            roomId: normalizedRoomId,
            name: room.name || '',
            reason,
            action: event.action,
            error: e?.message || String(e),
            at: nowIso,
          });
          continue;
        }
      }
      try { if (!aborter?.signal?.aborted) aborter?.abort?.(); } catch {}
      try { activeAborts.delete(roomId); } catch {}
      cleanedActiveAborts.push({
        roomId: normalizedRoomId,
        name: room?.name || '',
        status: room?.status || 'missing',
        reason,
        at: nowIso,
      });
      try {
        if (typeof broadcastRoom === 'function' && room) {
          broadcastRoom(normalizedRoomId, {
            ...event,
            roomId: normalizedRoomId,
            previousStatus: room.status || '',
            nextStatus: room.status || '',
          });
        }
      } catch {}
    }
  }
  return {
    status: recoveryErrors.length
      ? 'recovery_failed'
      : recoveredRooms.length || cleanedActiveAborts.length || stalledActiveRooms.length
        ? 'recovered'
        : 'clean',
    recoveredRoomCount: recoveredRooms.length,
    recoveredRooms,
    stalledActiveRoomCount: stalledActiveRooms.length,
    stalledActiveRooms,
    cleanedActiveAbortCount: cleanedActiveAborts.length,
    cleanedActiveAborts,
    recoveryErrorCount: recoveryErrors.length,
    recoveryErrors,
  };
}

function runtimeRecoveryAffectedRoomIds(runtimeReconciliation = {}) {
  return [...new Set([
    ...(Array.isArray(runtimeReconciliation.recoveredRooms) ? runtimeReconciliation.recoveredRooms : [])
      .map((item) => item.roomId),
    ...(Array.isArray(runtimeReconciliation.cleanedActiveAborts) ? runtimeReconciliation.cleanedActiveAborts : [])
      .filter((item) => item.status && item.status !== 'missing')
      .map((item) => item.roomId),
  ].map((id) => String(id || '').trim()).filter(Boolean))];
}

function setRuntimeRecoveryPersistPending(roomStore, roomIds = [], {
  flushError = '',
  now = new Date(),
} = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const pending = {
    reason: 'runtime_recovery_flush_failed',
    flushError: String(flushError || 'unknown'),
    at: nowIso,
  };
  for (const roomId of roomIds) {
    try {
      const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
      if (!room) continue;
      if (typeof roomStore?.update === 'function') {
        roomStore.update(roomId, { clusterRuntimeRecoveryPersistPending: pending });
      } else {
        room.clusterRuntimeRecoveryPersistPending = pending;
      }
    } catch {}
  }
  return pending;
}

function clearRuntimeRecoveryPersistPending(roomStore, roomIds = []) {
  const clearErrors = [];
  for (const roomId of roomIds) {
    try {
      const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
      if (!room) continue;
      if (typeof roomStore?.update === 'function') {
        roomStore.update(roomId, { clusterRuntimeRecoveryPersistPending: undefined });
      } else {
        delete room.clusterRuntimeRecoveryPersistPending;
      }
    } catch (e) {
      clearErrors.push({
        roomId,
        error: e?.message || String(e),
      });
    }
  }
  return clearErrors;
}

function listRuntimeRecoveryPersistPendingRooms(roomStore) {
  return listRoomsForConcurrency(roomStore)
    .filter((room) => room?.mode === 'cross_verify' && room.clusterRuntimeRecoveryPersistPending)
    .map((room) => ({
      roomId: clusterRoomId(room),
      name: room.name || '',
      pending: room.clusterRuntimeRecoveryPersistPending,
    }))
    .filter((item) => item.roomId);
}

export function resolveRuntimeRecoveryPersistPending(roomStore) {
  const pendingRooms = listRuntimeRecoveryPersistPendingRooms(roomStore);
  if (!pendingRooms.length) return { ok: true, status: 'clean', pendingRooms: [] };
  const pendingSnapshot = new Map(pendingRooms.map((item) => [item.roomId, item.pending]));
  try {
    if (typeof roomStore?.flush === 'function') roomStore.flush();
  } catch (e) {
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_persist_failed',
      message: e?.message || String(e),
      pendingRooms,
    };
  }
  const clearErrors = clearRuntimeRecoveryPersistPending(roomStore, pendingRooms.map((item) => item.roomId));
  if (clearErrors.length) {
    for (const [roomId, pending] of pendingSnapshot.entries()) {
      try {
        const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
        if (!room) continue;
        if (typeof roomStore?.update === 'function') {
          roomStore.update(roomId, { clusterRuntimeRecoveryPersistPending: pending });
        } else {
          room.clusterRuntimeRecoveryPersistPending = pending;
        }
      } catch {}
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_pending_clear_failed',
      message: clearErrors[0].error,
      pendingRooms,
      clearErrors,
    };
  }
  try {
    if (typeof roomStore?.flush === 'function') roomStore.flush();
  } catch (e) {
    for (const [roomId, pending] of pendingSnapshot.entries()) {
      try {
        const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
        if (!room) continue;
        if (typeof roomStore?.update === 'function') {
          roomStore.update(roomId, { clusterRuntimeRecoveryPersistPending: pending });
        } else {
          room.clusterRuntimeRecoveryPersistPending = pending;
        }
      } catch {}
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_pending_clear_failed',
      message: e?.message || String(e),
      pendingRooms,
    };
  }
  return { ok: true, status: 'resolved', pendingRooms };
}

export function runClusterRuntimeWatchdogOnce({
  roomStore,
  dispatcher,
  broadcastRoom = null,
  broadcastGlobal = null,
  now = new Date(),
  flushOnRecovery = false,
} = {}) {
  const pendingRecovery = resolveRuntimeRecoveryPersistPending(roomStore);
  if (pendingRecovery.status === 'resolved' && typeof broadcastGlobal === 'function') {
    try {
      broadcastGlobal({
        type: 'cluster_runtime_watchdog_pending_resolved',
        pendingRooms: pendingRecovery.pendingRooms,
        at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      });
    } catch {}
  }
  if (!pendingRecovery.ok) {
    if (typeof broadcastGlobal === 'function') {
      try {
        broadcastGlobal({
          type: 'cluster_runtime_watchdog_pending_failed',
          error: pendingRecovery.error,
          message: pendingRecovery.message,
          pendingRooms: pendingRecovery.pendingRooms,
          clearErrors: pendingRecovery.clearErrors,
          at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
        });
      } catch {}
    }
    return {
      status: 'pending_failed',
      recoveredRoomCount: 0,
      recoveredRooms: [],
      cleanedActiveAbortCount: 0,
      cleanedActiveAborts: [],
      recoveryErrorCount: 0,
      recoveryErrors: [],
      flushed: false,
      flushError: null,
      runtimePersistPending: pendingRecovery,
    };
  }
  const runtimeReconciliation = reconcileClusterRuntimeState({
    roomStore,
    dispatcher,
    broadcastRoom,
    now,
  });
  const changed = runtimeReconciliation.recoveredRoomCount > 0 || runtimeReconciliation.cleanedActiveAbortCount > 0;
  let flushed = false;
  let flushError = null;
  if (changed && flushOnRecovery && typeof roomStore?.flush === 'function') {
    try {
      roomStore.flush();
      flushed = true;
    } catch (e) {
      flushError = e?.message || String(e);
      setRuntimeRecoveryPersistPending(roomStore, runtimeRecoveryAffectedRoomIds(runtimeReconciliation), {
        flushError,
        now,
      });
    }
  }
  const recoveryFailed = runtimeReconciliation.recoveryErrorCount > 0;
  if ((changed || recoveryFailed) && typeof broadcastGlobal === 'function') {
    try {
      const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      if (recoveryFailed) {
        broadcastGlobal({
          type: 'cluster_runtime_watchdog_recovery_failed',
          recoveryErrorCount: runtimeReconciliation.recoveryErrorCount,
          recoveryErrors: runtimeReconciliation.recoveryErrors,
          recoveredRoomCount: runtimeReconciliation.recoveredRoomCount,
          recoveredRooms: runtimeReconciliation.recoveredRooms,
          cleanedActiveAbortCount: runtimeReconciliation.cleanedActiveAbortCount,
          cleanedActiveAborts: runtimeReconciliation.cleanedActiveAborts,
          at,
        });
      } else {
        broadcastGlobal({
          type: 'cluster_runtime_watchdog_recovered',
          recoveredRoomCount: runtimeReconciliation.recoveredRoomCount,
          recoveredRooms: runtimeReconciliation.recoveredRooms,
          cleanedActiveAbortCount: runtimeReconciliation.cleanedActiveAbortCount,
          cleanedActiveAborts: runtimeReconciliation.cleanedActiveAborts,
          flushed,
          flushError,
          at,
        });
      }
    } catch {}
  }
  return { ...runtimeReconciliation, flushed, flushError, runtimePersistPending: pendingRecovery };
}

export function recoverClusterRuntimeAfterNonFatalError({
  roomStore,
  dispatcher,
  broadcastRoom = null,
  broadcastGlobal = null,
  now = new Date(),
  source = 'nonfatal_error',
} = {}) {
  let runtimeReconciliation = null;
  let recoveryError = null;
  try {
    runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher,
      broadcastRoom,
      broadcastGlobal,
      now,
      flushOnRecovery: true,
    });
  } catch (e) {
    recoveryError = e?.message || String(e);
  }

  const changed = (runtimeReconciliation?.recoveredRoomCount || 0) > 0
    || (runtimeReconciliation?.cleanedActiveAbortCount || 0) > 0;
  let snapshotFlushed = false;
  let snapshotFlushError = null;
  if (!changed && typeof roomStore?.flush === 'function') {
    try {
      roomStore.flush();
      snapshotFlushed = true;
    } catch (e) {
      snapshotFlushError = e?.message || String(e);
    }
  }
  const flushError = runtimeReconciliation?.flushError || snapshotFlushError || null;
  const status = recoveryError
    ? 'recovery_failed'
    : flushError
      ? 'flush_failed'
      : changed
        ? 'recovered'
        : 'clean';
  const result = {
    status,
    source,
    runtimeReconciliation,
    recoveryError,
    snapshotFlushed,
    snapshotFlushError,
    flushError,
  };
  if ((recoveryError || flushError) && typeof broadcastGlobal === 'function') {
    try {
      broadcastGlobal({
        type: 'cluster_runtime_nonfatal_recovery_failed',
        source,
        status,
        recoveryError,
        flushError,
        at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      });
    } catch {}
  }
  return result;
}

export function abortDispatcherActiveRooms(dispatcher) {
  const activeAborts = dispatcher?.activeAborts;
  if (!activeAborts || typeof activeAborts.keys !== 'function') {
    return { abortedCount: 0, roomIds: [] };
  }
  const roomIds = [...activeAborts.keys()].map((id) => String(id || '').trim()).filter(Boolean);
  const aborted = [];
  for (const roomId of roomIds) {
    try {
      if (typeof dispatcher.abort === 'function') dispatcher.abort(roomId);
      else {
        const aborter = activeAborts.get(roomId);
        try { aborter?.abort?.(); } catch {}
        try { activeAborts.delete(roomId); } catch {}
      }
      aborted.push(roomId);
    } catch {}
  }
  return { abortedCount: aborted.length, roomIds: aborted };
}

export function abortActiveRoomDispatchers(dispatchers = []) {
  const results = [];
  for (const item of Array.isArray(dispatchers) ? dispatchers : []) {
    const name = typeof item?.name === 'string' ? item.name : 'unknown';
    const dispatcher = item?.dispatcher || item;
    const result = abortDispatcherActiveRooms(dispatcher);
    results.push({ name, ...result });
  }
  return {
    abortedCount: results.reduce((sum, item) => sum + item.abortedCount, 0),
    results,
  };
}

export function abortAndFlushActiveRoomDispatchers({ dispatchers = [], roomStore = null } = {}) {
  const abortResult = abortActiveRoomDispatchers(dispatchers);
  let flushed = false;
  let flushError = null;
  try {
    if (roomStore && typeof roomStore.flush === 'function') {
      roomStore.flush();
      flushed = true;
    }
  } catch (e) {
    flushError = e?.message || String(e);
  }
  return {
    ...abortResult,
    flushed,
    flushError,
  };
}

export function buildClusterConcurrencyBudget(room, {
  roomStore,
  maxRunningRooms = positiveIntFromEnv('PANEL_CLUSTER_MAX_RUNNING_ROOMS', DEFAULT_CLUSTER_MAX_RUNNING_ROOMS),
  maxAdapterRunningRooms = positiveIntFromEnv('PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS', DEFAULT_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS),
  projectCurrentRoom = true,
  activeAbortRooms = [],
} = {}) {
  const currentRoomId = projectCurrentRoom ? clusterRoomId(room) : '';
  const currentAdapters = projectCurrentRoom ? enabledAdapterIds(room) : [];
  pruneClusterStartReservations();
  const runningRooms = listRoomsForConcurrency(roomStore)
    .filter((item) => item
      && clusterRoomId(item) !== currentRoomId
      && item.mode === 'cross_verify'
      && item.status === 'running');
  const runningRoomIds = new Set(runningRooms.map(clusterRoomId).filter(Boolean));
  const startingRooms = [...clusterStartReservations.values()]
    .filter((item) => item
      && clusterRoomId(item) !== currentRoomId
      && item.mode === 'cross_verify'
      && !runningRoomIds.has(clusterRoomId(item)));
  const occupiedRoomIds = new Set([
    ...runningRooms.map(clusterRoomId).filter(Boolean),
    ...startingRooms.map(clusterRoomId).filter(Boolean),
  ]);
  const activeRooms = (Array.isArray(activeAbortRooms) ? activeAbortRooms : [])
    .filter((item) => item
      && clusterRoomId(item) !== currentRoomId
      && !occupiedRoomIds.has(clusterRoomId(item))
      && item.mode === 'cross_verify');
  const adapterLoad = {};
  for (const activeRoom of [...runningRooms, ...startingRooms, ...activeRooms]) {
    for (const adapterId of enabledAdapterIds(activeRoom)) {
      adapterLoad[adapterId] = (adapterLoad[adapterId] || 0) + 1;
    }
  }
  const projectedAdapterLoad = {};
  for (const adapterId of currentAdapters) {
    projectedAdapterLoad[adapterId] = (adapterLoad[adapterId] || 0) + 1;
  }
  const projectedRunningRoomCount = runningRooms.length + startingRooms.length + activeRooms.length + (projectCurrentRoom ? 1 : 0);
  const effectiveAdapterLoad = projectCurrentRoom ? projectedAdapterLoad : adapterLoad;
  const overloadedAdapters = Object.entries(effectiveAdapterLoad)
    .filter(([, count]) => count > maxAdapterRunningRooms)
    .map(([adapterId, count]) => ({ adapterId, count, limit: maxAdapterRunningRooms }));
  const blockers = [
    projectedRunningRoomCount > maxRunningRooms
      ? `running_rooms_gt_${maxRunningRooms}`
      : '',
    ...overloadedAdapters.map((item) => `adapter_running_rooms_gt_${item.limit}:${item.adapterId}=${item.count}`),
  ].filter(Boolean);
  const warnings = [
    projectedRunningRoomCount >= Math.max(3, Math.floor(maxRunningRooms * 0.75))
      ? `running_rooms_high=${projectedRunningRoomCount}/${maxRunningRooms}`
      : '',
    ...Object.entries(effectiveAdapterLoad)
      .filter(([, count]) => count >= Math.max(2, maxAdapterRunningRooms))
      .map(([adapterId, count]) => `adapter_running_rooms_high:${adapterId}=${count}/${maxAdapterRunningRooms}`),
  ].filter(Boolean);
  return {
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    runningRoomCount: runningRooms.length,
    startingRoomCount: startingRooms.length,
    activeAbortRoomCount: activeRooms.length,
    projectedRunningRoomCount,
    projectionEnabled: projectCurrentRoom,
    maxRunningRooms,
    maxAdapterRunningRooms,
    currentAdapters,
    adapterLoad,
    projectedAdapterLoad,
    runningRooms: runningRooms.map((item) => ({
      roomId: item.id || '',
      name: item.name || '',
      adapterIds: enabledAdapterIds(item),
    })),
    startingRooms: startingRooms.map((item) => ({
      roomId: item.roomId || '',
      ageMs: Math.max(0, Date.now() - (Number(item.createdAt) || Date.now())),
      adapterIds: enabledAdapterIds(item),
    })),
    activeAbortRooms: activeRooms.map((item) => ({
      roomId: item.roomId || item.id || '',
      name: item.name || '',
      source: item.source || 'dispatcher_active_abort',
      adapterIds: enabledAdapterIds(item),
    })),
    blockers,
    warnings,
  };
}
