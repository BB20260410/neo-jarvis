import { parseClusterHealthHistoryJsonl } from './cluster-health-trend.js';

const DEFAULT_MAX_ENTRIES = 30;
const DEFAULT_BLOCKED_FAILURE_STREAK = 2;
const DEFAULT_WARN_RESTART_RISK_COUNT = 3;
const DEFAULT_MAX_RESTART_RISK_COUNT = 5;
const DEFAULT_WARN_REPAIR_ACTION_COUNT = 2;
const DEFAULT_MAX_REPAIR_ACTION_COUNT = 4;
const DEFAULT_WARN_INFLIGHT_ROOMS = 4;
const DEFAULT_MAX_INFLIGHT_ROOMS = 6;
const DEFAULT_WARN_PAUSED_ROOMS = 5;
const DEFAULT_MAX_PAUSED_ROOMS = 8;
const DEFAULT_WARN_ERROR_ROOMS = 1;
const DEFAULT_MAX_ERROR_ROOMS = 3;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function externalWarnings(entry = {}) {
  return asArray(entry.warnings).filter((warning) => (
    typeof warning !== 'string'
    || (
      !warning.startsWith('cluster_health_trend_')
      && !warning.startsWith('cluster_ops_guard_')
      && warning !== 'cluster_repair_warn'
      && warning !== 'cluster_repair_api_warn'
      && warning !== 'cluster_diagnostics_warn'
      && warning !== 'cluster_assurance_warn'
      && warning !== 'cluster_diagnostics=health_trend_warn'
      && warning !== 'cluster_diagnostics=ops_guard_warn'
    )
  ));
}

function nestedStatus(entry = {}, key) {
  return firstString(
    entry[key]?.status,
    entry[`${key}Status`],
    entry[`${key}Api`]?.json?.[key]?.status,
  );
}

function repairPayload(entry = {}) {
  return entry.repairApi?.json?.repair || entry.repair?.repair || entry.repair || {};
}

export function classifyClusterOpsEntry(entry = {}) {
  const repair = repairPayload(entry);
  const healthStatus = nestedStatus(entry, 'health');
  const readinessStatus = nestedStatus(entry, 'readiness');
  const diagnosticsStatus = nestedStatus(entry, 'diagnostics');
  const assuranceStatus = nestedStatus(entry, 'assurance');
  const healthTrendStatus = nestedStatus(entry, 'healthTrend');
  const resourceGuardStatus = nestedStatus(entry, 'resourceGuard');
  const repairStatus = firstString(repair.status, entry.repairStatus);
  const warningCount = externalWarnings(entry).length
    + (readinessStatus === 'warn' ? 1 : 0)
    + (diagnosticsStatus === 'warn' ? 1 : 0)
    + (assuranceStatus === 'warn' ? 1 : 0)
    + (healthTrendStatus === 'warn' ? 1 : 0)
    + (resourceGuardStatus === 'warn' ? 1 : 0)
    + (repairStatus === 'warn' ? 1 : 0);
  const restartRiskWarningCount = externalWarnings(entry).length
    + (readinessStatus === 'warn' ? 1 : 0)
    + (resourceGuardStatus === 'warn' ? 1 : 0)
    + (repairStatus === 'warn' ? 1 : 0);
  const failed = entry.ok === false
    || healthStatus === 'blocked'
    || readinessStatus === 'blocked'
    || diagnosticsStatus === 'blocked'
    || assuranceStatus === 'blocked'
    || healthTrendStatus === 'blocked'
    || resourceGuardStatus === 'blocked'
    || repairStatus === 'blocked'
    || repair.ok === false;
  const restartMethod = firstString(entry.restartMethod);
  const restartAction = Boolean(restartMethod && restartMethod !== 'check' && restartMethod !== 'repair-check');
  const repairAction = repairStatus === 'repaired'
    || asArray(repair.appliedActions).length > 0
    || entry.repair?.action === 'restart';
  const riskyRestart = restartAction && (failed || restartRiskWarningCount > 0 || repairAction);
  return {
    ok: !failed,
    failed,
    warningCount,
    restartRiskWarningCount,
    restartMethod,
    restartAction,
    riskyRestart,
    repairStatus,
    repairAction,
    generatedAt: firstString(entry.generatedAt, entry.report?.generatedAt, entry.report?.writtenAt, entry.ts),
  };
}

function summarizeRooms(rooms = []) {
  const crossVerifyRooms = asArray(rooms).filter((room) => room?.mode === 'cross_verify');
  const byStatus = {};
  for (const room of crossVerifyRooms) {
    const status = String(room?.status || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const inFlight = (byStatus.running || 0) + (byStatus.starting || 0) + (byStatus.queued || 0);
  return {
    total: crossVerifyRooms.length,
    byStatus,
    inFlight,
    running: byStatus.running || 0,
    starting: byStatus.starting || 0,
    queued: byStatus.queued || 0,
    paused: byStatus.paused || 0,
    error: byStatus.error || 0,
  };
}

function statusFromIssues(blockers, warnings) {
  if (blockers.length > 0) return 'blocked';
  if (warnings.length > 0) return 'warn';
  return 'passed';
}

export function buildClusterOpsGuardReport({
  historyText = '',
  historyEntries = null,
  currentReport = null,
  rooms = [],
  maxEntries = DEFAULT_MAX_ENTRIES,
  blockedFailureStreak = DEFAULT_BLOCKED_FAILURE_STREAK,
  warnRestartRiskCount = DEFAULT_WARN_RESTART_RISK_COUNT,
  maxRestartRiskCount = DEFAULT_MAX_RESTART_RISK_COUNT,
  warnRepairActionCount = DEFAULT_WARN_REPAIR_ACTION_COUNT,
  maxRepairActionCount = DEFAULT_MAX_REPAIR_ACTION_COUNT,
  warnInFlightRooms = DEFAULT_WARN_INFLIGHT_ROOMS,
  maxInFlightRooms = DEFAULT_MAX_INFLIGHT_ROOMS,
  warnPausedRooms = DEFAULT_WARN_PAUSED_ROOMS,
  maxPausedRooms = DEFAULT_MAX_PAUSED_ROOMS,
  warnErrorRooms = DEFAULT_WARN_ERROR_ROOMS,
  maxErrorRooms = DEFAULT_MAX_ERROR_ROOMS,
  now = new Date(),
} = {}) {
  const parsed = Array.isArray(historyEntries)
    ? { entries: historyEntries, parseErrorCount: 0 }
    : parseClusterHealthHistoryJsonl(historyText);
  const entries = parsed.entries.slice(-Math.max(1, maxEntries));
  if (currentReport) entries.push(currentReport);
  const classified = entries.map(classifyClusterOpsEntry);
  let consecutiveFailureCount = 0;
  for (let i = classified.length - 1; i >= 0; i -= 1) {
    if (!classified[i]?.failed) break;
    consecutiveFailureCount += 1;
  }
  const roomSummary = summarizeRooms(rooms);
  const recentFailureCount = classified.filter((entry) => entry.failed).length;
  const riskyRestartCount = classified.filter((entry) => entry.riskyRestart).length;
  const repairActionCount = classified.filter((entry) => entry.repairAction).length;
  const current = classified[classified.length - 1] || {};
  const blockers = [
    consecutiveFailureCount >= blockedFailureStreak ? `consecutive_ops_failures=${consecutiveFailureCount}` : '',
    riskyRestartCount >= maxRestartRiskCount ? `risky_restarts_gte_${maxRestartRiskCount}` : '',
    repairActionCount >= maxRepairActionCount ? `repair_actions_gte_${maxRepairActionCount}` : '',
    roomSummary.inFlight >= maxInFlightRooms ? `inflight_rooms_gte_${maxInFlightRooms}` : '',
    roomSummary.paused >= maxPausedRooms ? `paused_rooms_gte_${maxPausedRooms}` : '',
    roomSummary.error >= maxErrorRooms ? `error_rooms_gte_${maxErrorRooms}` : '',
  ].filter(Boolean);
  const warnings = [
    current.failed && blockers.length === 0 ? 'current_ops_guard_failed' : '',
    riskyRestartCount >= warnRestartRiskCount && riskyRestartCount < maxRestartRiskCount ? `risky_restarts_gte_${warnRestartRiskCount}` : '',
    repairActionCount >= warnRepairActionCount && repairActionCount < maxRepairActionCount ? `repair_actions_gte_${warnRepairActionCount}` : '',
    roomSummary.inFlight >= warnInFlightRooms && roomSummary.inFlight < maxInFlightRooms ? `inflight_rooms_gte_${warnInFlightRooms}` : '',
    roomSummary.paused >= warnPausedRooms && roomSummary.paused < maxPausedRooms ? `paused_rooms_gte_${warnPausedRooms}` : '',
    roomSummary.error >= warnErrorRooms && roomSummary.error < maxErrorRooms ? `error_rooms_gte_${warnErrorRooms}` : '',
    parsed.parseErrorCount > 0 ? `ops_history_parse_errors=${parsed.parseErrorCount}` : '',
  ].filter(Boolean);
  const status = statusFromIssues(blockers, warnings);
  return {
    guardVersion: 'cluster-ops-guard-v1',
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    status,
    ok: status !== 'blocked',
    summary: {
      entryCount: entries.length,
      historyEntryCount: parsed.entries.length,
      parseErrorCount: parsed.parseErrorCount,
      recentFailureCount,
      consecutiveFailureCount,
      riskyRestartCount,
      repairActionCount,
      roomSummary,
    },
    thresholds: {
      blockedFailureStreak,
      warnRestartRiskCount,
      maxRestartRiskCount,
      warnRepairActionCount,
      maxRepairActionCount,
      warnInFlightRooms,
      maxInFlightRooms,
      warnPausedRooms,
      maxPausedRooms,
      warnErrorRooms,
      maxErrorRooms,
    },
    blockers,
    warnings,
    recent: classified.slice(-Math.min(10, classified.length)),
    recommendations: blockers.length > 0
      ? [
        '暂停新的集群协同启动,先处理连续失败、修复循环或房间积压。',
        '运行 npm run repair:panel && npm run check:panel;若仍阻断,重启面板并减少并发。',
      ]
      : warnings.length > 0
        ? ['允许运行但建议降低并发、清理异常房间并观察下一轮健康报告。']
        : [],
  };
}
