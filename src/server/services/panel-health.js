import { buildClusterConfigAudit } from './cluster-config-audit.js';

function runtimePendingRooms(runtimePersistPending) {
  const pendingRooms = Array.isArray(runtimePersistPending)
    ? runtimePersistPending
    : Array.isArray(runtimePersistPending?.pendingRooms)
      ? runtimePersistPending.pendingRooms
      : [];
  return pendingRooms;
}

export function assessPanelClusterHealth(budget) {
  const checks = [];
  const blockers = [];
  const json = budget?.json;
  if (budget?.statusCode !== 200) {
    blockers.push(`budget_status_code=${budget?.statusCode || 'missing'}`);
  }
  if (!json?.ok) {
    blockers.push('budget_ok_not_true');
  }
  const runtimeStatus = json?.runtimeReconciliation?.status || null;
  if (runtimeStatus !== 'clean') {
    blockers.push(`runtime_status=${runtimeStatus || 'missing'}`);
  }
  if ((json?.runtimeReconciliation?.recoveryErrorCount || 0) > 0) {
    blockers.push('runtime_recovery_errors_present');
  }
  if (json?.runtimeReconciliation?.flushError) {
    blockers.push('runtime_flush_error_present');
  }
  const runtimePersistPending = json?.runtimeReconciliation?.runtimePersistPending;
  const pendingRooms = runtimePendingRooms(runtimePersistPending);
  if (pendingRooms.length > 0 || (runtimePersistPending?.ok === false)) {
    blockers.push('runtime_persist_pending_present');
  }
  const budgetStatus = json?.concurrencyBudget?.status || null;
  const configAudit = json?.configAudit || buildClusterConfigAudit();
  if (budgetStatus !== 'passed') {
    blockers.push(`concurrency_status=${budgetStatus || 'missing'}`);
  }
  if ((json?.concurrencyBudget?.blockers || []).length > 0) {
    blockers.push('concurrency_blockers_present');
  }
  if (configAudit.status === 'blocked') {
    blockers.push('cluster_config_blocked');
  }
  for (const blocker of configAudit.blockers || []) {
    blockers.push(`cluster_config=${blocker}`);
  }
  checks.push({
    name: 'budget_api',
    status: budget?.statusCode === 200 && json?.ok === true ? 'passed' : 'blocked',
  });
  checks.push({
    name: 'runtime_reconciliation',
    status: runtimeStatus === 'clean' ? 'passed' : 'blocked',
    value: runtimeStatus,
  });
  checks.push({
    name: 'concurrency_budget',
    status: budgetStatus === 'passed' ? 'passed' : 'blocked',
    value: budgetStatus,
  });
  checks.push({
    name: 'cluster_config',
    status: configAudit.status === 'blocked' ? 'blocked' : 'passed',
    value: configAudit.status,
  });
  return {
    status: blockers.length ? 'blocked' : 'passed',
    blockers,
    checks,
  };
}

function readinessCheck(id, label, passed, {
  status = passed ? 'passed' : 'blocked',
  value = null,
  evidence = [],
  blockers = [],
  warnings = [],
} = {}) {
  return {
    id,
    label,
    status: passed ? status : 'blocked',
    value,
    evidence,
    blockers: passed ? [] : blockers,
    warnings,
  };
}

export function buildPanelClusterReadiness(payload = {}) {
  const runtimeReconciliation = payload?.runtimeReconciliation || {};
  const concurrencyBudget = payload?.concurrencyBudget || {};
  const runtimePersistPending = runtimeReconciliation.runtimePersistPending;
  const configAudit = payload?.configAudit || buildClusterConfigAudit();
  const pendingRooms = runtimePendingRooms(runtimePersistPending);
  const maxRunningRooms = Number(concurrencyBudget.maxRunningRooms) || 0;
  const maxAdapterRunningRooms = Number(concurrencyBudget.maxAdapterRunningRooms) || 0;
  const checks = [
    readinessCheck(
      'runtime_recovery_clean',
      '运行时恢复状态干净',
      runtimeReconciliation.status === 'clean',
      {
        value: runtimeReconciliation.status || 'missing',
        blockers: [`runtime_status=${runtimeReconciliation.status || 'missing'}`],
      },
    ),
    readinessCheck(
      'persist_recovery_clean',
      '无待持久化恢复标记',
      pendingRooms.length === 0 && runtimePersistPending?.ok !== false && !runtimeReconciliation.flushError,
      {
        value: pendingRooms.length,
        blockers: [
          ...(pendingRooms.length ? [`pending_rooms=${pendingRooms.length}`] : []),
          ...(runtimeReconciliation.flushError ? ['runtime_flush_error_present'] : []),
          ...(runtimePersistPending?.ok === false ? ['runtime_persist_pending_failed'] : []),
        ],
      },
    ),
    readinessCheck(
      'concurrency_budget_available',
      '并发预算可用',
      concurrencyBudget.status === 'passed' && (concurrencyBudget.blockers || []).length === 0,
      {
        value: concurrencyBudget.status || 'missing',
        blockers: [
          `concurrency_status=${concurrencyBudget.status || 'missing'}`,
          ...((concurrencyBudget.blockers || []).map((item) => `concurrency_blocker=${item}`)),
        ],
        warnings: concurrencyBudget.warnings || [],
      },
    ),
    readinessCheck(
      'multi_room_capacity',
      '支持多房间并行',
      maxRunningRooms >= 2,
      {
        value: maxRunningRooms,
        evidence: [`maxRunningRooms=${maxRunningRooms}`],
        blockers: [`maxRunningRooms_lt_2=${maxRunningRooms}`],
      },
    ),
    readinessCheck(
      'adapter_room_capacity',
      '单适配器并发容量可控',
      maxAdapterRunningRooms >= 1,
      {
        value: maxAdapterRunningRooms,
        evidence: [`maxAdapterRunningRooms=${maxAdapterRunningRooms}`],
        blockers: [`maxAdapterRunningRooms_lt_1=${maxAdapterRunningRooms}`],
      },
    ),
    readinessCheck(
      'cluster_config_safe',
      '集群配置组合安全',
      configAudit.status !== 'blocked',
      {
        value: configAudit.status || 'missing',
        evidence: configAudit.checks?.map((check) => `${check.id}:${check.status}`) || [],
        blockers: (configAudit.blockers || []).map((item) => `cluster_config=${item}`),
        warnings: configAudit.warnings || [],
      },
    ),
  ];
  const blockers = checks.flatMap((check) => check.blockers || []);
  const warnings = checks.flatMap((check) => check.warnings || []);
  return {
    readinessVersion: 'cluster-readiness-v1',
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    checks,
    capabilities: {
      mode: 'cross_verify',
      multiRoom: maxRunningRooms >= 2,
      maxRunningRooms,
      maxAdapterRunningRooms,
      runtimeWatchdog: true,
      persistRecoveryMarker: true,
      degradedTakeover: true,
      goalMode: true,
      configAudit,
    },
  };
}
