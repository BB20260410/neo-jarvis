import { assessPanelClusterHealth, buildPanelClusterReadiness } from '../services/panel-health.js';
import { buildClusterConfigAudit } from '../services/cluster-config-audit.js';
import { buildClusterDiagnostics } from '../services/cluster-diagnostics.js';
import { buildClusterActiveAbortRooms, buildClusterCapabilityGuard, buildClusterConcurrencyBudget, buildClusterHealthTrend, buildClusterOpsGuard, buildClusterResourceGuard, listRoomsForConcurrency, resolveRuntimeRecoveryPersistPending, runClusterRuntimeWatchdogOnce } from '../services/cluster-runtime.js';

export function registerClusterStatusRoutes(app, {
  roomStore,
  requireOwnerToken,
  crossVerifyDispatcher,
  broadcastRoom,
  roomAdapterPool = null,
} = {}) {
  // L5 修复：Express(4.x) 下 async handler 的 reject（如动态 import 失败）会让请求永久挂起；包一层兜底。
  const safeAsync = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(() => {
    try { if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal error' }); } catch { /* 兜底失败不再抛 */ }
  });
  app.get('/api/cluster/concurrency-budget', requireOwnerToken, (req, res) => {
    const roomId = String(req.query?.roomId || '').trim();
    const room = roomId ? roomStore.get(roomId) : null;
    if (roomId && !room) return res.status(404).json({ ok: false, error: 'room not found' });
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const concurrencyBudget = buildClusterConcurrencyBudget(room || {}, {
      roomStore,
      projectCurrentRoom: Boolean(room),
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const configAudit = buildClusterConfigAudit();
    return res.json({
      ok: true,
      roomId: room?.id || null,
      mode: room?.mode || null,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    });
  });

  app.get('/api/cluster/health', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const configAudit = buildClusterConfigAudit();
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    return res.status(health.status === 'passed' ? 200 : 503).json({
      ...payload,
      health,
    });
  });

  app.get('/api/cluster/readiness', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const configAudit = buildClusterConfigAudit();
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    return res.status(readiness.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
    });
  });

  app.post('/api/cluster/repair', requireOwnerToken, safeAsync(async (req, res) => {
    const startedAt = new Date().toISOString();
    const runtimePersistPending = resolveRuntimeRecoveryPersistPending(roomStore);
    const runtimeRepair = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const runtimeReconciliation = runtimeRepair.recoveryErrorCount > 0 || runtimeRepair.flushError
      ? runtimeRepair
      : runClusterRuntimeWatchdogOnce({
        roomStore,
        dispatcher: crossVerifyDispatcher,
        broadcastRoom,
        flushOnRecovery: true,
      });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const rooms = listRoomsForConcurrency(roomStore);
    const resourceGuard = buildClusterResourceGuard();
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const baseDiagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      resourceGuard,
      capabilityGuard,
    });
    const healthTrend = buildClusterHealthTrend({
      health,
      readiness,
      diagnostics: baseDiagnostics,
    });
    const opsGuard = buildClusterOpsGuard({
      health,
      readiness,
      diagnostics: baseDiagnostics,
      healthTrend,
      resourceGuard,
      rooms,
    });
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      healthTrend,
      resourceGuard,
      opsGuard,
      capabilityGuard,
    });
    const { buildClusterAssuranceReport } = await import('../services/cluster-assurance.js');
    const assurance = await buildClusterAssuranceReport({
      diagnostics,
      healthTrend,
      resourceGuard,
      opsGuard,
      capabilityGuard,
    });
    const appliedActions = [
      runtimePersistPending?.status && runtimePersistPending.status !== 'clean' && runtimePersistPending.ok !== false
        ? 'resolved_runtime_persist_pending'
        : '',
      runtimeRepair.recoveredRoomCount > 0 ? 'recovered_stale_running_rooms' : '',
      runtimeRepair.cleanedActiveAbortCount > 0 ? 'cleaned_active_abort_controllers' : '',
      runtimeRepair.stalledActiveRoomCount > 0 ? 'paused_stalled_active_rooms' : '',
    ].filter(Boolean);
    const blockers = [
      runtimePersistPending?.ok === false ? (runtimePersistPending.error || 'runtime_persist_pending_unresolved') : '',
      runtimeRepair.recoveryErrorCount > 0 || runtimeReconciliation.recoveryErrorCount > 0 ? 'runtime_recovery_errors' : '',
      runtimeRepair.flushError || runtimeReconciliation.flushError ? 'runtime_recovery_flush_error' : '',
      diagnostics.status === 'blocked' ? 'diagnostics_blocked' : '',
      assurance.status === 'blocked' ? 'assurance_blocked' : '',
    ].filter(Boolean);
    const warnings = [
      diagnostics.status === 'warn' ? 'diagnostics_warn' : '',
      assurance.status === 'warn' ? 'assurance_warn' : '',
    ].filter(Boolean);
    const repair = {
      repairVersion: 'cluster-repair-v1',
      startedAt,
      completedAt: new Date().toISOString(),
      ok: blockers.length === 0,
      status: blockers.length > 0
        ? 'blocked'
        : warnings.length > 0
          ? 'warn'
          : appliedActions.length > 0 ? 'repaired' : 'passed',
      appliedActions,
      blockers,
      warnings,
      runtimePersistPending,
      runtimeRepair,
      runtimeVerification: runtimeReconciliation,
      recoveryActionCount: (diagnostics.recoveryPlan || []).length + (assurance.recoveryPlan || []).length,
    };
    return res.status(repair.ok ? 200 : 503).json({
      ...payload,
      ok: repair.ok,
      repair,
      health,
      readiness,
      diagnostics,
      healthTrend,
      resourceGuard,
      capabilityGuard,
      opsGuard,
      assurance,
    });
  }));

  app.get('/api/cluster/capability-guard', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const rooms = listRoomsForConcurrency(roomStore);
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      capabilityGuard,
    });
    return res.status(capabilityGuard.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
      diagnostics,
      capabilityGuard,
    });
  });

  app.get('/api/cluster/resource-guard', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const rooms = listRoomsForConcurrency(roomStore);
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const resourceGuard = buildClusterResourceGuard();
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      resourceGuard,
      capabilityGuard,
    });
    return res.status(resourceGuard.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
      diagnostics,
      capabilityGuard,
      resourceGuard,
    });
  });

  app.get('/api/cluster/health-trend', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const rooms = listRoomsForConcurrency(roomStore);
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const resourceGuard = buildClusterResourceGuard();
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      resourceGuard,
      capabilityGuard,
    });
    const healthTrend = buildClusterHealthTrend({ health, readiness, diagnostics });
    return res.status(healthTrend.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
      diagnostics,
      capabilityGuard,
      resourceGuard,
      healthTrend,
    });
  });

  app.get('/api/cluster/ops-guard', requireOwnerToken, (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const rooms = listRoomsForConcurrency(roomStore);
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const resourceGuard = buildClusterResourceGuard();
    const baseDiagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      resourceGuard,
      capabilityGuard,
    });
    const healthTrend = buildClusterHealthTrend({ health, readiness, diagnostics: baseDiagnostics });
    const opsGuard = buildClusterOpsGuard({
      health,
      readiness,
      diagnostics: baseDiagnostics,
      healthTrend,
      resourceGuard,
      rooms,
    });
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      healthTrend,
      resourceGuard,
      opsGuard,
      capabilityGuard,
    });
    return res.status(opsGuard.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
      diagnostics,
      healthTrend,
      capabilityGuard,
      resourceGuard,
      opsGuard,
    });
  });

  app.get('/api/cluster/diagnostics', requireOwnerToken, safeAsync(async (req, res) => {
    const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      flushOnRecovery: true,
    });
    const configAudit = buildClusterConfigAudit();
    const concurrencyBudget = buildClusterConcurrencyBudget({}, {
      roomStore,
      projectCurrentRoom: false,
      activeAbortRooms: buildClusterActiveAbortRooms(crossVerifyDispatcher, roomStore),
    });
    const payload = {
      ok: true,
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
    };
    const health = assessPanelClusterHealth({ statusCode: 200, json: payload });
    const readiness = buildPanelClusterReadiness(payload);
    const rooms = listRoomsForConcurrency(roomStore);
    const resourceGuard = buildClusterResourceGuard();
    const capabilityGuard = buildClusterCapabilityGuard({ rooms, roomAdapterPool });
    const baseDiagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      resourceGuard,
      capabilityGuard,
    });
    const healthTrend = buildClusterHealthTrend({
      health,
      readiness,
      diagnostics: baseDiagnostics,
    });
    const opsGuard = buildClusterOpsGuard({
      health,
      readiness,
      diagnostics: baseDiagnostics,
      healthTrend,
      resourceGuard,
      rooms,
    });
    const diagnostics = buildClusterDiagnostics({
      runtimeReconciliation,
      configAudit,
      concurrencyBudget,
      health,
      readiness,
      rooms,
      healthTrend,
      resourceGuard,
      opsGuard,
      capabilityGuard,
    });
    const { buildClusterAssuranceReport } = await import('../services/cluster-assurance.js');
    const assurance = await buildClusterAssuranceReport({
      diagnostics,
      healthTrend,
      resourceGuard,
      opsGuard,
      capabilityGuard,
    });
    return res.status(diagnostics.status === 'blocked' || assurance.status === 'blocked' ? 503 : 200).json({
      ...payload,
      health,
      readiness,
      diagnostics,
      healthTrend,
      capabilityGuard,
      resourceGuard,
      opsGuard,
      assurance,
    });
  }));
}
