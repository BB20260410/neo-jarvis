import { buildClusterPreflight, runClusterAdapterLiveChecks } from './rooms.js';
import { buildClusterConfigAudit } from '../services/cluster-config-audit.js';
import { registerClusterStatusRoutes } from './roomStartClusterRoutes.js';
import {
  buildClusterActiveAbortRooms,
  buildClusterConcurrencyBudget,
  clusterRoomId,
  parseGoalModeCommandTopic,
  reserveClusterStart,
  resolveRuntimeRecoveryPersistPending,
  runClusterRuntimeWatchdogOnce,
} from '../services/cluster-runtime.js';

export {
  abortActiveRoomDispatchers,
  abortAndFlushActiveRoomDispatchers,
  abortDispatcherActiveRooms,
  buildClusterActiveAbortRooms,
  buildClusterConcurrencyBudget,
  clearClusterStartReservationsForTest,
  parseGoalModeCommandTopic,
  reconcileClusterRuntimeState,
  recoverClusterRuntimeAfterNonFatalError,
  reserveClusterStart,
  runClusterRuntimeWatchdogOnce,
} from '../services/cluster-runtime.js';

export function pickRoomDispatcher(mode, dispatchers) {
  if (mode === 'squad') return dispatchers.squadDispatcher;
  if (mode === 'arena') return dispatchers.arenaDispatcher;
  if (mode === 'cross_verify') return dispatchers.crossVerifyDispatcher;
  return dispatchers.debateDispatcher;
}

export function roomErrorType(mode) {
  if (mode === 'squad') return 'squad_error';
  if (mode === 'arena') return 'arena_error';
  if (mode === 'cross_verify') return 'cross_verify_error';
  return 'debate_error';
}

export function isAlreadyRunningStartError(error) {
  return /room already running|房间已在运行|already_running/i.test(String(error?.message || error || ''));
}

function isStartupHardLiveCheckFailure(check = {}) {
  if (check?.passed === true) return false;
  const blockers = Array.isArray(check.blockers) ? check.blockers : [];
  if (blockers.length === 0) return true;
  return blockers.some((blocker) => blocker !== 'live_ping_timeout');
}

function cloneClusterStartValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function captureStartupDegradeState(room = {}) {
  return {
    members: cloneClusterStartValue(room.members),
    clusterStartupLiveCheck: cloneClusterStartValue(room.clusterStartupLiveCheck),
    clusterStartupDegradedMembers: cloneClusterStartValue(room.clusterStartupDegradedMembers),
    clusterDroppedMembers: cloneClusterStartValue(room.clusterDroppedMembers),
  };
}

function restoreStartupDegradeState(roomStore, roomId, snapshot = {}) {
  try {
    if (typeof roomStore?.update === 'function') {
      roomStore.update(roomId, {
        members: cloneClusterStartValue(snapshot.members),
        clusterStartupLiveCheck: cloneClusterStartValue(snapshot.clusterStartupLiveCheck),
        clusterStartupDegradedMembers: cloneClusterStartValue(snapshot.clusterStartupDegradedMembers),
        clusterDroppedMembers: cloneClusterStartValue(snapshot.clusterDroppedMembers),
      });
    }
  } catch (e) {
    // 强健（2026-06-10）：回滚 update 失败记日志，不静默吞——下面有第二步内存兜底，但磁盘可能已不一致，留痕便于排障
    console.error('[cluster-start] degrade 回滚 update 失败:', e?.message || e);
  }
  try {
    const room = typeof roomStore?.get === 'function' ? roomStore.get(roomId) : null;
    if (!room) return;
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete room[key];
      else room[key] = cloneClusterStartValue(snapshot[key]);
    }
  } catch (e) {
    // 强健（2026-06-10）：回滚内存兜底失败记日志——room 可能停在中间态，留痕便于排障
    console.error('[cluster-start] degrade 回滚内存兜底失败:', e?.message || e);
  }
}

export async function prepareClusterRunGate(room, {
  roomStore,
  dispatcher,
  roomAdapterPool = null,
  runClusterLiveChecks = runClusterAdapterLiveChecks,
  broadcastRoom = null,
  broadcastGlobal = null,
  topic = '',
} = {}) {
  const pendingRecovery = resolveRuntimeRecoveryPersistPending(roomStore);
  if (!pendingRecovery.ok) {
    return { ok: false, preflight: null, runtimePersistPending: pendingRecovery, ...pendingRecovery };
  }
  const preflight = buildClusterPreflight(room, { topic, roomAdapterPool });
  if (preflight.status === 'blocked') {
    return { ok: false, statusCode: 409, error: 'cluster_preflight_blocked', preflight };
  }
  const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
    roomStore,
    dispatcher,
    broadcastRoom,
    broadcastGlobal,
    flushOnRecovery: true,
  });
  if (runtimeReconciliation.recoveryErrorCount > 0) {
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_failed',
      message: runtimeReconciliation.recoveryErrors?.[0]?.error || 'cluster runtime recovery failed',
      preflight,
      runtimeReconciliation,
    };
  }
  const runtimeRecovered = runtimeReconciliation.recoveredRoomCount > 0
    || runtimeReconciliation.cleanedActiveAbortCount > 0;
  if (runtimeRecovered && runtimeReconciliation.flushError) {
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_persist_failed',
      message: runtimeReconciliation.flushError,
      preflight,
      runtimeReconciliation,
    };
  }
  const configAudit = buildClusterConfigAudit();
  if (configAudit.status === 'blocked') {
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_config_blocked',
      message: configAudit.blockers?.[0] || 'cluster config blocked',
      preflight,
      runtimeReconciliation,
      configAudit,
    };
  }
  const concurrencyBudget = buildClusterConcurrencyBudget(room, {
    roomStore,
    activeAbortRooms: buildClusterActiveAbortRooms(dispatcher, roomStore),
  });
  if (concurrencyBudget.status === 'blocked') {
    return { ok: false, statusCode: 409, error: 'cluster_concurrency_blocked', preflight, runtimeReconciliation, configAudit, concurrencyBudget };
  }
  const reservation = reserveClusterStart(room);
  if (!reservation.ok) {
    return { ok: false, statusCode: 409, error: 'room_start_in_progress', reason: reservation.reason, roomId: clusterRoomId(room) };
  }
  try {
    const liveCheck = await runClusterLiveChecks(room, { topic, roomAdapterPool, timeoutMs: 30000 });
    const failedChecks = (liveCheck.checks || []).filter((check) => check?.passed !== true);
    const hardFailedChecks = failedChecks.filter(isStartupHardLiveCheckFailure);
    const softTimedOutChecks = failedChecks.filter((check) => !isStartupHardLiveCheckFailure(check));
    const effectiveAvailableCount = (liveCheck.passedCount || 0) + softTimedOutChecks.length;
    if (liveCheck.status === 'blocked' && effectiveAvailableCount <= 0) {
      reservation.release();
      return { ok: false, statusCode: 409, error: 'cluster_live_check_blocked', preflight, runtimeReconciliation, liveCheck };
    }
    let degradedMembers = [];
    if (hardFailedChecks.length > 0) {
      const failedIds = new Set(hardFailedChecks
        .map((check) => String(check.adapterId || '').trim())
        .filter(Boolean));
      if (failedIds.size > 0 && typeof roomStore?.update === 'function') {
        const now = new Date().toISOString();
        degradedMembers = (room.members || [])
          .map((member, index) => ({ member, index }))
          .filter(({ member }) => failedIds.has(String(member?.adapterId || '').trim()))
          .map(({ member, index }) => ({
            memberKey: `${String(member?.adapterId || '').trim()}#${index}`,
            adapterId: String(member?.adapterId || '').trim(),
            displayName: member?.displayName || member?.adapterId || '',
            memberIndex: index + 1,
            model: member?.model || '',
            reason: 'startup_live_check_hard_failed',
            recoverable: false,
            at: now,
          }));
        const members = (room.members || []).map((member) => (
          failedIds.has(String(member?.adapterId || '').trim())
            ? { ...member, enabled: false, failoverDisabled: true, failoverReason: 'startup_live_check_hard_failed' }
            : member
        ));
        const roomId = clusterRoomId(room);
        const degradeRollbackSnapshot = captureStartupDegradeState(room);
        try {
          roomStore.update(roomId, {
            members,
            clusterStartupLiveCheck: liveCheck,
            clusterStartupDegradedMembers: degradedMembers,
            clusterDroppedMembers: [
              ...(Array.isArray(room.clusterDroppedMembers) ? room.clusterDroppedMembers : []),
              ...degradedMembers,
            ],
          });
          if (typeof roomStore.flush === 'function') roomStore.flush();
        } catch (e) {
          restoreStartupDegradeState(roomStore, roomId, degradeRollbackSnapshot);
          reservation.release();
          return {
            ok: false,
            statusCode: 503,
            error: 'cluster_startup_degrade_persist_failed',
            message: e?.message || String(e),
            preflight,
            runtimeReconciliation,
            concurrencyBudget,
            liveCheck,
            degradedMembers,
          };
        }
      }
    }
    return {
      ok: true,
      preflight,
      runtimeReconciliation,
      concurrencyBudget,
      liveCheck,
      degradedMembers,
      reservation,
    };
  } catch (e) {
    reservation.release();
    return {
      ok: false,
      statusCode: 503,
      error: 'cluster_live_check_failed',
      message: e?.message || String(e),
      preflight,
      runtimeReconciliation,
      concurrencyBudget,
    };
  }
}

export function registerRoomStartRoutes(app, {
  roomStore,
  requireOwnerToken,
  debateDispatcher,
  squadDispatcher,
  arenaDispatcher,
  crossVerifyDispatcher,
  broadcastRoom,
  roomAdapterPool = null,
  runClusterLiveChecks = runClusterAdapterLiveChecks,
}) {
  registerClusterStatusRoutes(app, {
    roomStore,
    requireOwnerToken,
    crossVerifyDispatcher,
    broadcastRoom,
    roomAdapterPool,
  });

  app.post('/api/rooms/:id/debate', requireOwnerToken, async (req, res) => {
    let r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if ((r.mode || 'debate') === 'cross_verify') {
      const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
        roomStore,
        dispatcher: crossVerifyDispatcher,
        broadcastRoom,
        flushOnRecovery: true,
      });
      if (runtimeReconciliation.recoveryErrorCount > 0 || runtimeReconciliation.flushError || runtimeReconciliation.runtimePersistPending?.ok === false) {
        return res.status(503).json({
          ok: false,
          error: runtimeReconciliation.flushError
            ? 'cluster_runtime_recovery_flush_failed'
            : runtimeReconciliation.runtimePersistPending?.error || 'cluster_runtime_recovery_failed',
          message: runtimeReconciliation.flushError
            || runtimeReconciliation.runtimePersistPending?.message
            || runtimeReconciliation.recoveryErrors?.[0]?.error
            || 'cluster runtime recovery failed',
          runtimeReconciliation,
        });
      }
      if (runtimeReconciliation.recoveredRooms.some((item) => item.roomId === r.id)) {
        r = roomStore.get(req.params.id) || { ...r, status: 'paused' };
      }
    }
    if (r.status === 'running') return res.status(409).json({ ok: false, error: 'room_already_running', roomId: r.id });
    let topic = (req.body || {}).topic;
    if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'topic required' });
    if (topic.length > 1048576) return res.status(413).json({ error: 'topic 过长（>1MB 字符）' });
    const mode = r.mode || 'debate';
    const parsedGoalCommand = mode === 'cross_verify'
      ? parseGoalModeCommandTopic(topic)
      : { topic, goalModeCommand: false };
    topic = parsedGoalCommand.topic;
    if (!topic) return res.status(400).json({ error: '目标模式需要任务内容' });
    const startOptions = {};
    if (req.body?.debateRounds !== undefined) {
      const n = Number(req.body.debateRounds);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(422).json({ error: 'debateRounds 必须是 1-10 的整数' });
      }
      startOptions.debateRounds = n;
    }
    if (req.body?.goalMode !== undefined) {
      if (![true, false, 'true', 'false', 1, 0].includes(req.body.goalMode)) {
        return res.status(422).json({ error: 'goalMode 必须是 boolean' });
      }
      startOptions.goalMode = req.body.goalMode === true || req.body.goalMode === 'true' || req.body.goalMode === 1;
    }
    if (parsedGoalCommand.goalModeCommand) startOptions.goalMode = true;

    let startGate = null;
    if (mode === 'cross_verify') {
      startGate = await prepareClusterRunGate(r, {
        roomStore,
        dispatcher: crossVerifyDispatcher,
        roomAdapterPool,
        runClusterLiveChecks,
        broadcastRoom,
        topic,
      });
      if (!startGate.ok) {
        return res.status(startGate.statusCode || 409).json({
          ok: false,
          error: startGate.error,
          ...(startGate.reason ? { reason: startGate.reason } : {}),
          ...(startGate.message ? { message: startGate.message } : {}),
          ...(startGate.preflight ? { preflight: startGate.preflight } : {}),
          ...(startGate.runtimeReconciliation ? { runtimeReconciliation: startGate.runtimeReconciliation } : {}),
          ...(startGate.concurrencyBudget ? { concurrencyBudget: startGate.concurrencyBudget } : {}),
          ...(startGate.liveCheck ? { liveCheck: startGate.liveCheck } : {}),
        });
      }
    }

    res.json({
      ok: true,
      started: true,
      mode,
      ...(startGate?.concurrencyBudget ? { concurrencyBudget: startGate.concurrencyBudget } : {}),
      ...(startGate?.runtimeReconciliation ? { runtimeReconciliation: startGate.runtimeReconciliation } : {}),
      ...(startGate?.degradedMembers?.length ? { liveCheckDegraded: true, degradedMembers: startGate.degradedMembers, liveCheck: startGate.liveCheck } : {}),
    });
    const dispatcher = pickRoomDispatcher(mode, {
      debateDispatcher,
      squadDispatcher,
      arenaDispatcher,
      crossVerifyDispatcher,
    });
    let runPromise;
    try {
      runPromise = dispatcher.start(req.params.id, topic, startOptions);
    } catch (e) {
      runPromise = Promise.reject(e);
    } finally {
      startGate?.reservation?.release?.();
    }
    Promise.resolve(runPromise).catch(e => {
      if (isAlreadyRunningStartError(e)) {
        try {
          broadcastRoom(req.params.id, {
            type: 'room_start_ignored',
            mode,
            reason: 'already_running',
          });
        } catch {}
        return;
      }
      console.warn(`${mode} failed:`, e.message);
      try {
        broadcastRoom(req.params.id, {
          type: roomErrorType(mode),
          error: e.message || 'unknown dispatcher error',
        });
        roomStore.setStatus(req.params.id, 'error');
      } catch {}
    });
  });
}
