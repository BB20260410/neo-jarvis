function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addFinding(findings, severity, code, message, evidence = []) {
  findings.push({
    severity,
    code,
    message,
    evidence: asArray(evidence),
  });
}

function statusFromFindings(findings) {
  if (findings.some((item) => item.severity === 'blocker')) return 'blocked';
  if (findings.some((item) => item.severity === 'warn')) return 'warn';
  return 'passed';
}

function recommendationForFinding(finding) {
  const code = finding?.code || '';
  if (code === 'runtime_recovery_not_clean') return '先运行 repair/check 面板服务,确认 runtime recovery 重新落盘成功后再启动新任务。';
  if (code === 'runtime_recovery_persist_failed') return '检查磁盘空间/文件权限后运行 npm run repair:panel;修复失败前不要继续启动新集群任务。';
  if (code === 'runtime_persist_pending') return '检查磁盘/权限/rooms.json 写入能力,待 pending 清除后再恢复任务。';
  if (code === 'config_audit_blocked') return '调整 PANEL_CLUSTER_* 环境变量,使 configAudit 全部通过。';
  if (code === 'config_audit_warn') return '复核 PANEL_CLUSTER_* 警告项;若是容量策略变更,同步更新运维说明后再放量。';
  if (code === 'concurrency_budget_blocked') return '等待现有房间完成/暂停,或调高经过审计的并发预算。';
  if (code === 'readiness_blocked') return '查看 readiness.blockers,逐项修复后再运行集群协同。';
  if (code === 'readiness_warn') return '保留当前任务可运行,但先查看 readiness.warnings 并记录观察窗口。';
  if (code === 'health_blocked') return '运行 npm run check:panel 获取健康报告;必要时执行 npm run restart:panel 或 npm run repair:panel。';
  if (code === 'resource_guard_blocked') return '资源压力已触发保护阈值;暂停新任务,运行 repair/check,必要时重启面板释放资源。';
  if (code === 'resource_guard_warn') return '资源压力接近阈值;保持可运行,但避免继续扩大并发并观察趋势。';
  if (code === 'ops_guard_blocked') return '集群出现连续失败、修复循环或房间积压;暂停新任务并先执行 repair/check。';
  if (code === 'ops_guard_warn') return '集群出现早期异常风暴或积压信号;建议降低并发并清理异常房间。';
  if (code === 'capability_guard_blocked') return '成员能力配置存在硬冲突;先修复 adapterId、共享插件桥或原生能力边界后再启动。';
  if (code === 'capability_guard_warn') return '成员能力配置存在漂移风险;复核重复适配器、未知适配器或插件绑定后再放量。';
  if (code === 'stalled_recovered') return '确认房间摘要中的续跑策略;若自动续跑已限流,人工复核后再续跑。';
  return finding?.message || '查看诊断 evidence 后处理。';
}

function recoveryPlanForFinding(finding) {
  const code = finding?.code || 'unknown';
  const action = recommendationForFinding(finding);
  const base = {
    code,
    severity: finding?.severity || 'info',
    blocksStart: finding?.severity === 'blocker',
    action,
    command: null,
    endpoint: null,
    ui: null,
  };
  if (code === 'runtime_recovery_not_clean') {
    return {
      ...base,
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/readiness',
      ui: '集群协同房间 -> 集群诊断',
    };
  }
  if (code === 'runtime_recovery_persist_failed' || code === 'runtime_persist_pending') {
    return {
      ...base,
      command: 'npm run repair:panel',
      endpoint: '/api/cluster/diagnostics',
      ui: '集群协同房间 -> 集群诊断 -> 恢复计划',
    };
  }
  if (code === 'config_audit_blocked' || code === 'config_audit_warn') {
    return {
      ...base,
      command: 'npm run check:panel',
      endpoint: '/api/cluster/readiness',
      ui: '集群协同房间 -> 并发预算/集群诊断',
    };
  }
  if (code === 'concurrency_budget_blocked') {
    return {
      ...base,
      endpoint: '/api/cluster/concurrency-budget',
      ui: '集群协同房间 -> 并发预算',
    };
  }
  if (code === 'readiness_blocked' || code === 'readiness_warn' || code === 'health_blocked') {
    return {
      ...base,
      command: code === 'health_blocked' ? 'npm run check:panel && npm run restart:panel' : 'npm run check:panel',
      endpoint: code === 'health_blocked' ? '/api/cluster/health' : '/api/cluster/readiness',
      ui: '集群协同房间 -> 集群诊断',
    };
  }
  if (code === 'stalled_recovered') {
    return {
      ...base,
      endpoint: '/api/cluster/diagnostics',
      ui: '房间摘要 -> 运行心跳/续跑策略',
    };
  }
  if (code === 'resource_guard_blocked' || code === 'resource_guard_warn') {
    return {
      ...base,
      command: code === 'resource_guard_blocked' ? 'npm run repair:panel && npm run check:panel' : 'npm run check:panel',
      endpoint: '/api/cluster/resource-guard',
      ui: '集群协同房间 -> 集群诊断 -> 资源守卫',
    };
  }
  if (code === 'ops_guard_blocked' || code === 'ops_guard_warn') {
    return {
      ...base,
      command: code === 'ops_guard_blocked' ? 'npm run repair:panel && npm run check:panel' : 'npm run check:panel',
      endpoint: '/api/cluster/ops-guard',
      ui: '集群协同房间 -> 集群诊断 -> 运维风暴守卫',
    };
  }
  if (code === 'capability_guard_blocked' || code === 'capability_guard_warn') {
    return {
      ...base,
      command: code === 'capability_guard_blocked' ? 'npm run repair:panel && npm run check:panel' : 'npm run check:panel',
      endpoint: '/api/cluster/capability-guard',
      ui: '集群协同房间 -> 集群诊断 -> 能力漂移守卫',
    };
  }
  return base;
}

function summarizeRooms(rooms = []) {
  const list = asArray(rooms);
  const byStatus = {};
  const crossVerifyRooms = list.filter((room) => room?.mode === 'cross_verify');
  for (const room of crossVerifyRooms) {
    const key = room?.status || 'unknown';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return {
    total: crossVerifyRooms.length,
    byStatus,
    running: byStatus.running || 0,
    paused: byStatus.paused || 0,
    done: byStatus.done || 0,
    error: byStatus.error || 0,
  };
}

export function buildClusterDiagnostics({
  runtimeReconciliation = {},
  configAudit = {},
  concurrencyBudget = {},
  health = {},
  healthTrend = null,
  resourceGuard = null,
  opsGuard = null,
  capabilityGuard = null,
  readiness = {},
  rooms = [],
} = {}) {
  const findings = [];
  const runtimeStatus = runtimeReconciliation?.status || 'missing';
  if (runtimeStatus !== 'clean') {
    addFinding(findings, runtimeStatus === 'recovered' ? 'warn' : 'blocker', 'runtime_recovery_not_clean', `runtime status is ${runtimeStatus}`, [
      `runtime_status=${runtimeStatus}`,
      `recovered=${runtimeReconciliation?.recoveredRoomCount || 0}`,
      `stalled=${runtimeReconciliation?.stalledActiveRoomCount || 0}`,
      `cleaned_active_aborts=${runtimeReconciliation?.cleanedActiveAbortCount || 0}`,
    ]);
  }
  if ((runtimeReconciliation?.recoveryErrorCount || 0) > 0 || runtimeReconciliation?.flushError) {
    addFinding(findings, 'blocker', 'runtime_recovery_persist_failed', 'runtime recovery could not be persisted', [
      `recovery_errors=${runtimeReconciliation?.recoveryErrorCount || 0}`,
      `flush_error=${runtimeReconciliation?.flushError || ''}`,
    ]);
  }
  const pendingRooms = asArray(runtimeReconciliation?.runtimePersistPending?.pendingRooms);
  if (pendingRooms.length > 0 || runtimeReconciliation?.runtimePersistPending?.ok === false) {
    addFinding(findings, 'blocker', 'runtime_persist_pending', 'runtime persistence still has pending recovery markers', [
      `pending_rooms=${pendingRooms.length}`,
      `pending_status=${runtimeReconciliation?.runtimePersistPending?.status || ''}`,
    ]);
  }
  if ((runtimeReconciliation?.stalledActiveRoomCount || 0) > 0) {
    addFinding(findings, 'warn', 'stalled_recovered', 'watchdog recovered stalled active cluster rooms', [
      `stalled_active_rooms=${runtimeReconciliation.stalledActiveRoomCount}`,
    ]);
  }
  if (configAudit?.status === 'blocked') {
    addFinding(findings, 'blocker', 'config_audit_blocked', 'cluster configuration is unsafe', configAudit.blockers || []);
  } else if (configAudit?.status === 'warn') {
    addFinding(findings, 'warn', 'config_audit_warn', 'cluster configuration has warnings', configAudit.warnings || []);
  }
  if (concurrencyBudget?.status !== 'passed') {
    addFinding(findings, 'blocker', 'concurrency_budget_blocked', 'cluster concurrency budget is blocked', concurrencyBudget?.blockers || []);
  }
  if (readiness?.status === 'blocked') {
    addFinding(findings, 'blocker', 'readiness_blocked', 'cluster readiness is blocked', readiness.blockers || []);
  } else if (readiness?.status === 'warn') {
    addFinding(findings, 'warn', 'readiness_warn', 'cluster readiness has warnings', readiness.warnings || []);
  }
  if (health?.status === 'blocked') {
    addFinding(findings, 'blocker', 'health_blocked', 'cluster health is blocked', health.blockers || []);
  }
  if (healthTrend?.status === 'blocked') {
    addFinding(findings, 'blocker', 'health_trend_blocked', 'cluster health trend is blocked', healthTrend.blockers || []);
  } else if (healthTrend?.status === 'warn') {
    addFinding(findings, 'warn', 'health_trend_warn', 'cluster health trend has warnings', healthTrend.warnings || []);
  }
  if (resourceGuard?.status === 'blocked') {
    addFinding(findings, 'blocker', 'resource_guard_blocked', 'cluster resource guard is blocked', resourceGuard.blockers || []);
  } else if (resourceGuard?.status === 'warn') {
    addFinding(findings, 'warn', 'resource_guard_warn', 'cluster resource guard has warnings', resourceGuard.warnings || []);
  }
  if (opsGuard?.status === 'blocked') {
    addFinding(findings, 'blocker', 'ops_guard_blocked', 'cluster ops guard is blocked', opsGuard.blockers || []);
  } else if (opsGuard?.status === 'warn') {
    addFinding(findings, 'warn', 'ops_guard_warn', 'cluster ops guard has warnings', opsGuard.warnings || []);
  }
  if (capabilityGuard?.status === 'blocked') {
    addFinding(findings, 'blocker', 'capability_guard_blocked', 'cluster member capability guard is blocked', capabilityGuard.blockers || []);
  } else if (capabilityGuard?.status === 'warn') {
    addFinding(findings, 'warn', 'capability_guard_warn', 'cluster member capability guard has warnings', capabilityGuard.warnings || []);
  }

  const status = statusFromFindings(findings);
  const roomSummary = summarizeRooms(rooms);
  const recoveryPlan = findings.map(recoveryPlanForFinding);
  return {
    diagnosticsVersion: 'cluster-diagnostics-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      healthStatus: health?.status || 'unknown',
      healthTrendStatus: healthTrend?.status || 'unknown',
      resourceGuardStatus: resourceGuard?.status || 'unknown',
      opsGuardStatus: opsGuard?.status || 'unknown',
      capabilityGuardStatus: capabilityGuard?.status || 'unknown',
      readinessStatus: readiness?.status || 'unknown',
      runtimeStatus,
      configStatus: configAudit?.status || 'unknown',
      concurrencyStatus: concurrencyBudget?.status || 'unknown',
      blockerCount: findings.filter((item) => item.severity === 'blocker').length,
      warningCount: findings.filter((item) => item.severity === 'warn').length,
      recoveryActionCount: recoveryPlan.length,
      roomSummary,
    },
    invariants: {
      safeToStart: status !== 'blocked',
      multiRoomEnabled: readiness?.capabilities?.multiRoom === true || Number(concurrencyBudget?.maxRunningRooms) >= 2,
      runtimeRecoveryClean: runtimeStatus === 'clean',
      configSafe: configAudit?.status !== 'blocked',
      concurrencyAvailable: concurrencyBudget?.status === 'passed',
      noPendingPersistence: pendingRooms.length === 0 && runtimeReconciliation?.runtimePersistPending?.ok !== false,
      healthTrendHealthy: !healthTrend || healthTrend.status !== 'blocked',
      resourceGuardHealthy: !resourceGuard || resourceGuard.status !== 'blocked',
      opsGuardHealthy: !opsGuard || opsGuard.status !== 'blocked',
      capabilityGuardHealthy: !capabilityGuard || (capabilityGuard.status !== 'blocked' && capabilityGuard.ok !== false),
    },
    findings,
    recommendations: findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      action: recommendationForFinding(finding),
    })),
    recoveryPlan,
  };
}
