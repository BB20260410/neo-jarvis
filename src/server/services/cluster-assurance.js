import { buildClusterDiagnosticsDrillReport } from './cluster-diagnostics-drill.js';
import { buildClusterResilienceDrillReport } from './cluster-resilience-drill.js';
import { buildClusterRuntimeDrillReport } from './cluster-runtime-drill.js';

function normalizeStatus(status, fallback = 'unknown') {
  const s = String(status || '').trim();
  return s || fallback;
}

function failedCaseIds(report = {}) {
  return (Array.isArray(report.results) ? report.results : [])
    .filter((item) => item?.ok === false)
    .map((item) => item.id || '')
    .filter(Boolean);
}

function drillGate(id, label, report = {}) {
  const failedCases = failedCaseIds(report);
  const ok = report?.ok === true;
  return {
    id,
    label,
    status: ok ? 'passed' : 'blocked',
    ok,
    caseCount: Number(report?.caseCount) || 0,
    failedCaseCount: Number(report?.failedCaseCount) || failedCases.length,
    failedCases,
    error: report?.error || null,
  };
}

function diagnosticsGate(diagnostics = {}) {
  const status = normalizeStatus(diagnostics?.status, 'unknown');
  const safeToStart = diagnostics?.invariants?.safeToStart === true;
  const blocked = status === 'blocked' || safeToStart === false;
  return {
    id: 'live_diagnostics',
    label: '实时集群诊断',
    status: blocked ? 'blocked' : status === 'warn' ? 'warn' : 'passed',
    ok: !blocked,
    diagnosticsStatus: status,
    safeToStart,
    findingCount: Array.isArray(diagnostics?.findings) ? diagnostics.findings.length : 0,
    recoveryActionCount: Array.isArray(diagnostics?.recoveryPlan) ? diagnostics.recoveryPlan.length : 0,
  };
}

function healthTrendGate(healthTrend = {}) {
  const status = normalizeStatus(healthTrend?.status, 'unknown');
  const blocked = status === 'blocked' || healthTrend?.ok === false;
  return {
    id: 'health_trend',
    label: '长期健康趋势',
    status: blocked ? 'blocked' : status === 'warn' ? 'warn' : 'passed',
    ok: !blocked,
    trendStatus: status,
    blockerCount: Array.isArray(healthTrend?.blockers) ? healthTrend.blockers.length : 0,
    warningCount: Array.isArray(healthTrend?.warnings) ? healthTrend.warnings.length : 0,
    failedCases: Array.isArray(healthTrend?.blockers) ? healthTrend.blockers : [],
  };
}

function resourceGuardGate(resourceGuard = {}) {
  const status = normalizeStatus(resourceGuard?.status, 'unknown');
  const blocked = status === 'blocked' || resourceGuard?.ok === false;
  return {
    id: 'resource_guard',
    label: '资源压力守卫',
    status: blocked ? 'blocked' : status === 'warn' ? 'warn' : 'passed',
    ok: !blocked,
    resourceStatus: status,
    blockerCount: Array.isArray(resourceGuard?.blockers) ? resourceGuard.blockers.length : 0,
    warningCount: Array.isArray(resourceGuard?.warnings) ? resourceGuard.warnings.length : 0,
    failedCases: Array.isArray(resourceGuard?.blockers) ? resourceGuard.blockers : [],
  };
}

function opsGuardGate(opsGuard = {}) {
  const status = normalizeStatus(opsGuard?.status, 'unknown');
  const blocked = status === 'blocked' || opsGuard?.ok === false;
  return {
    id: 'ops_guard',
    label: '异常风暴/积压守卫',
    status: blocked ? 'blocked' : status === 'warn' ? 'warn' : 'passed',
    ok: !blocked,
    opsStatus: status,
    blockerCount: Array.isArray(opsGuard?.blockers) ? opsGuard.blockers.length : 0,
    warningCount: Array.isArray(opsGuard?.warnings) ? opsGuard.warnings.length : 0,
    failedCases: Array.isArray(opsGuard?.blockers) ? opsGuard.blockers : [],
  };
}

function capabilityGuardGate(capabilityGuard = {}) {
  const status = normalizeStatus(capabilityGuard?.status, 'unknown');
  const blocked = status === 'blocked' || capabilityGuard?.ok === false;
  return {
    id: 'capability_guard',
    label: '成员能力/插件漂移守卫',
    status: blocked ? 'blocked' : status === 'warn' ? 'warn' : 'passed',
    ok: !blocked,
    capabilityStatus: status,
    blockerCount: Array.isArray(capabilityGuard?.blockers) ? capabilityGuard.blockers.length : 0,
    warningCount: Array.isArray(capabilityGuard?.warnings) ? capabilityGuard.warnings.length : 0,
    failedCases: Array.isArray(capabilityGuard?.blockers) ? capabilityGuard.blockers : [],
  };
}

function assuranceSummary(gates) {
  const blocked = gates.filter((gate) => gate.status === 'blocked');
  const warn = gates.filter((gate) => gate.status === 'warn');
  const failedCases = gates.flatMap((gate) => (gate.failedCases || []).map((caseId) => `${gate.id}:${caseId}`));
  return {
    gateCount: gates.length,
    passedGateCount: gates.filter((gate) => gate.status === 'passed').length,
    blockedGateCount: blocked.length,
    warningGateCount: warn.length,
    failedGateIds: blocked.map((gate) => gate.id),
    warningGateIds: warn.map((gate) => gate.id),
    failedCases,
  };
}

function recoveryActionForGate(gate = {}) {
  const base = {
    gateId: gate.id || 'unknown',
    gateLabel: gate.label || '',
    severity: gate.status === 'blocked' ? 'blocker' : 'warn',
    blocksStart: gate.status === 'blocked',
    failedCases: Array.isArray(gate.failedCases) ? gate.failedCases : [],
    error: gate.error || null,
  };
  if (gate.id === 'live_diagnostics') {
    return {
      ...base,
      action: '修复实时诊断阻断项并重新检查',
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/diagnostics',
      ui: '集群协同房间 -> 集群诊断 -> 恢复计划',
    };
  }
  if (gate.id === 'diagnostics_drill') {
    return {
      ...base,
      action: '修复诊断/恢复计划演练失败项',
      command: 'npm run cluster:drill && npm run check:panel',
      endpoint: '/api/cluster/diagnostics',
      ui: '集群协同房间 -> 集群诊断 -> 保证体系门禁',
    };
  }
  if (gate.id === 'resilience_drill') {
    return {
      ...base,
      action: '修复多房间容量或掉线接管契约失败项',
      command: 'npm run cluster:stress && npm run check:panel',
      endpoint: '/api/cluster/concurrency-budget',
      ui: '集群协同房间 -> 并发预算/集群诊断',
    };
  }
  if (gate.id === 'runtime_drill') {
    return {
      ...base,
      action: '修复真实 dispatcher 启动、接管或收尾链路失败项',
      command: 'npm run cluster:runtime && npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/diagnostics',
      ui: '集群协同房间 -> 集群诊断 -> 保证体系门禁',
    };
  }
  if (gate.id === 'health_trend') {
    return {
      ...base,
      action: '修复长期健康趋势阻断项或连续退化',
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/health-trend',
      ui: '集群协同房间 -> 集群诊断 -> 长期健康趋势',
    };
  }
  if (gate.id === 'resource_guard') {
    return {
      ...base,
      action: '释放或降低集群协同资源压力',
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/resource-guard',
      ui: '集群协同房间 -> 集群诊断 -> 资源守卫',
    };
  }
  if (gate.id === 'ops_guard') {
    return {
      ...base,
      action: '治理连续失败、修复循环或房间积压',
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/ops-guard',
      ui: '集群协同房间 -> 集群诊断 -> 异常风暴/积压守卫',
    };
  }
  if (gate.id === 'capability_guard') {
    return {
      ...base,
      action: '修复成员能力边界或共享插件桥漂移',
      command: 'npm run repair:panel && npm run check:panel',
      endpoint: '/api/cluster/capability-guard',
      ui: '集群协同房间 -> 集群诊断 -> 能力漂移守卫',
    };
  }
  return {
    ...base,
    action: '查看失败门禁并重新运行完整面板检查',
    command: 'npm run check:panel',
    endpoint: '/api/cluster/diagnostics',
    ui: '集群协同房间 -> 集群诊断',
  };
}

function buildAssuranceRecoveryPlan(gates) {
  return gates
    .filter((gate) => gate.status === 'blocked' || gate.status === 'warn')
    .map(recoveryActionForGate);
}

function errorDrillReport(version, error) {
  return {
    drillVersion: version,
    generatedAt: new Date().toISOString(),
    ok: false,
    caseCount: 0,
    failedCaseCount: 1,
    error: error?.message || String(error),
    results: [],
  };
}

async function safeBuild(version, fn) {
  try {
    return await fn();
  } catch (e) {
    return errorDrillReport(version, e);
  }
}

export async function buildClusterAssuranceReport({
  diagnostics = {},
  diagnosticsDrill = null,
  resilienceDrill = null,
  runtimeDrill = null,
  healthTrend = null,
  resourceGuard = null,
  opsGuard = null,
  capabilityGuard = null,
  now = new Date(),
} = {}) {
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const finalDiagnosticsDrill = diagnosticsDrill || await safeBuild(
    'cluster-diagnostics-drill-v1',
    () => buildClusterDiagnosticsDrillReport({ now }),
  );
  const finalResilienceDrill = resilienceDrill || await safeBuild(
    'cluster-resilience-drill-v1',
    () => buildClusterResilienceDrillReport({ now }),
  );
  const finalRuntimeDrill = runtimeDrill || await safeBuild(
    'cluster-runtime-drill-v1',
    () => buildClusterRuntimeDrillReport({ now }),
  );
  const gates = [
    diagnosticsGate(diagnostics),
    ...(healthTrend ? [healthTrendGate(healthTrend)] : []),
    ...(resourceGuard ? [resourceGuardGate(resourceGuard)] : []),
    ...(opsGuard ? [opsGuardGate(opsGuard)] : []),
    ...(capabilityGuard ? [capabilityGuardGate(capabilityGuard)] : []),
    drillGate('diagnostics_drill', '诊断/恢复计划离线演练', finalDiagnosticsDrill),
    drillGate('resilience_drill', '多房间/接管压力演练', finalResilienceDrill),
    drillGate('runtime_drill', '真实 dispatcher 运行链路演练', finalRuntimeDrill),
  ];
  const summary = assuranceSummary(gates);
  const status = summary.blockedGateCount > 0 ? 'blocked' : summary.warningGateCount > 0 ? 'warn' : 'passed';
  const recoveryPlan = buildAssuranceRecoveryPlan(gates);
  return {
    assuranceVersion: 'cluster-assurance-v1',
    generatedAt,
    status,
    ok: status !== 'blocked',
    summary,
    gates,
    recoveryPlan,
    diagnosticsDrill: finalDiagnosticsDrill,
    resilienceDrill: finalResilienceDrill,
    runtimeDrill: finalRuntimeDrill,
    recommendations: status === 'blocked'
      ? recoveryPlan.map((item) => `${item.action}: ${item.command}`)
      : [],
  };
}
