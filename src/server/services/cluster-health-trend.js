const DEFAULT_MAX_ENTRIES = 30;
const DEFAULT_BLOCKED_FAILURE_STREAK = 2;
const DEFAULT_WARN_FAILURE_COUNT = 2;
const DEFAULT_WARN_WARNING_COUNT = 3;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numericValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function countExternalWarnings(warnings) {
  return safeArray(warnings).filter((warning) => (
    typeof warning !== 'string'
    || !warning.startsWith('cluster_health_trend_')
  )).length;
}

export function parseClusterHealthHistoryJsonl(text = '') {
  const entries = [];
  let parseErrorCount = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      parseErrorCount += 1;
    }
  }
  return { entries, parseErrorCount };
}

export function classifyClusterHealthEntry(entry = {}) {
  const repair = entry.repairApi?.json?.repair || entry.repair?.repair || entry.repair || {};
  const healthStatus = firstString(entry.health?.status, entry.healthStatus);
  const readinessStatus = firstString(entry.readiness?.status, entry.readinessStatus);
  const diagnosticsStatus = firstString(entry.diagnostics?.status, entry.diagnosticsStatus);
  const assuranceStatus = firstString(entry.assurance?.status, entry.assuranceStatus);
  const repairStatus = firstString(repair.status, entry.repairStatus);
  const repairKnown = Boolean(entry.repairApi || entry.repair || entry.repairStatus);
  const repairUnavailable = Boolean(entry.repairApi)
    && (!entry.repairApi?.json?.repair || Number(entry.repairApi?.statusCode || 0) >= 400);
  const warningCount = countExternalWarnings(entry.warnings)
    + numericValue(entry.warningCount, entry.healthWarningCount)
    + (readinessStatus === 'warn' ? 1 : 0)
    + (diagnosticsStatus === 'warn' ? 1 : 0)
    + (assuranceStatus === 'warn' ? 1 : 0)
    + (repairStatus === 'warn' ? 1 : 0);
  const blocked = entry.ok === false
    || healthStatus === 'blocked'
    || readinessStatus === 'blocked'
    || diagnosticsStatus === 'blocked'
    || assuranceStatus === 'blocked'
    || repairStatus === 'blocked'
    || repair.ok === false
    || repairUnavailable;
  const warn = !blocked && warningCount > 0;
  return {
    ok: !blocked,
    status: blocked ? 'blocked' : warn ? 'warn' : 'passed',
    blocked,
    warn,
    warningCount,
    healthStatus,
    readinessStatus,
    diagnosticsStatus,
    assuranceStatus,
    repairStatus: repairKnown ? repairStatus || 'unknown' : '',
    repairUnavailable,
    generatedAt: firstString(entry.generatedAt, entry.ts, entry.completedAt, entry.startedAt),
  };
}

export function buildClusterHealthTrendReport({
  historyText = '',
  historyEntries = null,
  currentReport = null,
  maxEntries = DEFAULT_MAX_ENTRIES,
  blockedFailureStreak = DEFAULT_BLOCKED_FAILURE_STREAK,
  warnFailureCount = DEFAULT_WARN_FAILURE_COUNT,
  warnWarningCount = DEFAULT_WARN_WARNING_COUNT,
  now = new Date(),
} = {}) {
  const parsed = Array.isArray(historyEntries)
    ? { entries: historyEntries, parseErrorCount: 0 }
    : parseClusterHealthHistoryJsonl(historyText);
  const entries = parsed.entries.slice(-Math.max(1, maxEntries));
  if (currentReport) entries.push(currentReport);
  const classified = entries.map(classifyClusterHealthEntry);
  let consecutiveFailureCount = 0;
  for (let i = classified.length - 1; i >= 0; i -= 1) {
    if (!classified[i]?.blocked) break;
    consecutiveFailureCount += 1;
  }
  let consecutiveRepairUnavailableCount = 0;
  for (let i = classified.length - 1; i >= 0; i -= 1) {
    if (!classified[i]?.repairUnavailable) break;
    consecutiveRepairUnavailableCount += 1;
  }
  let consecutiveWarningSignalCount = 0;
  for (let i = classified.length - 1; i >= 0; i -= 1) {
    if (!classified[i]?.warn) break;
    consecutiveWarningSignalCount += classified[i].warningCount || 0;
  }
  const current = classified[classified.length - 1] || {};
  const blockedCount = classified.filter((item) => item.blocked).length;
  const warnCount = classified.filter((item) => item.warn).length;
  const repairUnavailableCount = classified.filter((item) => item.repairUnavailable).length;
  const warningSignalCount = classified.reduce((sum, item) => sum + (item.warningCount || 0), 0);
  const blockers = [
    consecutiveFailureCount >= blockedFailureStreak ? `consecutive_cluster_health_failures=${consecutiveFailureCount}` : '',
    current.repairUnavailable ? 'current_cluster_repair_unavailable' : '',
    !current.repairUnavailable && consecutiveRepairUnavailableCount >= blockedFailureStreak ? `consecutive_cluster_repair_unavailable=${consecutiveRepairUnavailableCount}` : '',
  ].filter(Boolean);
  const warnings = [
    current.blocked && blockers.length === 0 ? 'current_cluster_health_failed' : '',
    blockedCount >= warnFailureCount && blockers.length === 0 ? `recent_cluster_health_failures=${blockedCount}` : '',
    !current.repairUnavailable && consecutiveRepairUnavailableCount === 0 && repairUnavailableCount >= warnFailureCount ? `recent_cluster_repair_unavailable=${repairUnavailableCount}` : '',
    consecutiveWarningSignalCount >= warnWarningCount ? `recent_cluster_health_warnings=${consecutiveWarningSignalCount}` : '',
    parsed.parseErrorCount > 0 ? `cluster_health_history_parse_errors=${parsed.parseErrorCount}` : '',
  ].filter(Boolean);
  return {
    trendVersion: 'cluster-health-trend-v1',
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warn' : 'passed',
    ok: blockers.length === 0,
    window: {
      maxEntries,
      entryCount: entries.length,
      historyEntryCount: parsed.entries.length,
      parseErrorCount: parsed.parseErrorCount,
    },
    summary: {
      blockedCount,
      warnCount,
      warningSignalCount,
      repairUnavailableCount,
      consecutiveFailureCount,
      consecutiveRepairUnavailableCount,
      consecutiveWarningSignalCount,
    },
    blockers,
    warnings,
    recent: classified.slice(-Math.min(10, classified.length)),
  };
}
