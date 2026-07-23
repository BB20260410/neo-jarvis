// @ts-check
// 第三波手术 第33批：autopilot 房间操作（forwardRoomFromAutopilot/startRoomFromAutopilot，~116 行）
// 从 server.js 原文迁出（真业务逻辑非接线；controller/scheduler 装配仍留组合根）。
// 注入约定：
//   - roomStore/broadcastRoom/broadcastGlobal：组合根稳定 const，直接传值。
//   - getRoomAdapterPool/getDispatchers：roomAdapterPool 与四 dispatcher 在 server.js 组合根
//     后文才构造（本工厂创建点早于它们），且仅在 job 运行时才求值 → getter bag 注入按调用时解析
//     （先例：registerOpsHealthProcessesRoutes 的 getTerminals 同款 TDZ 解法）。
//   - getOrCreateOwnerToken / prepareClusterRunGate / runClusterRuntimeWatchdogOnce 是无状态模块
//     函数（ESM 单例），模块内直接 import，与 server.js 留守使用点共享同一实例。
import { getOrCreateOwnerToken } from '../auth/owner-token.js';
import { prepareClusterRunGate, runClusterRuntimeWatchdogOnce } from '../routes/roomStart.js';

/**
 * @param {{
 *   roomStore: any,
 *   broadcastRoom: (roomId: string, msg: any) => void,
 *   broadcastGlobal: (msg: any) => void,
 *   getRoomAdapterPool: () => Map<string, any>,
 *   getDispatchers: () => { debateDispatcher: any, squadDispatcher: any, arenaDispatcher: any, crossVerifyDispatcher: any },
 * }} deps
 */
export function createAutopilotRoomOps({ roomStore, broadcastRoom, broadcastGlobal, getRoomAdapterPool, getDispatchers }) {
  // v0.56 Sprint 15-R4：Autopilot Controller（依赖 forwardRoom = self-call POST /api/rooms/forward）
  async function forwardRoomFromAutopilot({ sourceRoomId, targetMode, autoStart, name, autopilotHops, claimedBy }) {
    const PORT_LOCAL = process.env.PORT || 51835;
    const ownerToken = getOrCreateOwnerToken();
    const resp = await fetch(`http://127.0.0.1:${PORT_LOCAL}/api/rooms/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ownerToken ? { 'X-Panel-Owner-Token': ownerToken } : {}) },
      body: JSON.stringify({ sourceRoomId, targetMode, autoStart, name }),
    });
    const r = await resp.json();
    if (!resp.ok || !r.ok || !r.newRoomId) throw new Error(r.error || `HTTP ${resp.status}`);
    // 标记 autopilot 链路 + claim
    try { roomStore.update(r.newRoomId, { autopilotHops, claimedBy }); } catch {}
    return { newRoomId: r.newRoomId };
  }

  async function startRoomFromAutopilot({ room, delegation, job }) {
    if (!room?.id) throw new Error('startRoomFromAutopilot requires room');
    const { debateDispatcher, squadDispatcher, arenaDispatcher, crossVerifyDispatcher } = getDispatchers();
    if ((room.mode || 'debate') === 'cross_verify') {
      const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
        roomStore,
        dispatcher: crossVerifyDispatcher,
        broadcastRoom,
        flushOnRecovery: true,
      });
      if (runtimeReconciliation.recoveryErrorCount > 0 || runtimeReconciliation.flushError || runtimeReconciliation.runtimePersistPending?.ok === false) {
        return {
          started: false,
          reason: runtimeReconciliation.flushError
            ? 'cluster_runtime_recovery_flush_failed'
            : runtimeReconciliation.runtimePersistPending?.error || 'cluster_runtime_recovery_failed',
          message: runtimeReconciliation.flushError
            || runtimeReconciliation.runtimePersistPending?.message
            || runtimeReconciliation.recoveryErrors?.[0]?.error
            || 'cluster runtime recovery failed',
          roomId: room.id,
          mode: room.mode || 'cross_verify',
          runtimeReconciliation,
        };
      }
      if (runtimeReconciliation.recoveredRooms.some((item) => item.roomId === room.id)) {
        room = roomStore.get(room.id) || { ...room, status: 'paused' };
      }
    }
    if (room.status === 'running') return { started: false, reason: 'already_running', roomId: room.id };
    const mode = room.mode || 'debate';
    const topic = room.topic || delegation?.instructions || delegation?.title || '';
    if (!topic) throw new Error('delegation target room has empty topic');
    let startGate = null;
    if (mode === 'cross_verify') {
      startGate = await prepareClusterRunGate(room, {
        roomStore,
        dispatcher: crossVerifyDispatcher,
        roomAdapterPool: getRoomAdapterPool(),
        broadcastRoom,
        topic,
      });
      if (!startGate.ok) {
        return {
          started: false,
          reason: startGate.error || 'cluster_run_gate_blocked',
          roomId: room.id,
          mode,
          ...(startGate.concurrencyBudget ? { concurrencyBudget: startGate.concurrencyBudget } : {}),
          ...(startGate.preflight ? { preflight: startGate.preflight } : {}),
          ...(startGate.runtimeReconciliation ? { runtimeReconciliation: startGate.runtimeReconciliation } : {}),
          ...(startGate.liveCheck ? { liveCheck: startGate.liveCheck } : {}),
        };
      }
    }
    let dispatcher;
    let errorType;
    if (mode === 'squad') {
      dispatcher = squadDispatcher;
      errorType = 'squad_error';
    } else if (mode === 'arena') {
      dispatcher = arenaDispatcher;
      errorType = 'arena_error';
    } else if (mode === 'debate') {
      dispatcher = debateDispatcher;
      errorType = 'debate_error';
    } else if (mode === 'cross_verify') {
      dispatcher = crossVerifyDispatcher;
      errorType = 'cross_verify_error';
    } else {
      return { started: false, reason: `${mode}_room`, roomId: room.id };
    }
    let runPromise;
    try {
      runPromise = dispatcher.start(room.id, topic);
    } catch (e) {
      runPromise = Promise.reject(e);
    } finally {
      startGate?.reservation?.release?.();
    }
    Promise.resolve(runPromise).catch(e => {
      console.warn(`delegation autostart ${mode} failed:`, e.message);
      try {
        broadcastRoom(room.id, { type: errorType, error: e.message || 'delegation autostart failed', jobId: job?.id });
        roomStore.setStatus(room.id, 'error');
      } catch {}
    });
    roomStore.update(room.id, {
      claimedBy: `autopilot:${job?.id || 'delegation'}`,
      autostartedBy: job?.id || null,
    });
    broadcastGlobal({
      type: 'delegation_autostart',
      jobId: job?.id,
      delegationId: delegation?.id,
      targetRoomId: room.id,
      targetMode: mode,
      message: `Autopilot 已启动委派房：${room.name || room.id}`,
    });
    return { started: true, roomId: room.id, mode };
  }

  return { forwardRoomFromAutopilot, startRoomFromAutopilot };
}
