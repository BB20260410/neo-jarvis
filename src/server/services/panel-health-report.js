import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function runtimeReconciliationFromResult(result = {}) {
  return result.healthApi?.json?.runtimeReconciliation
    || result.readinessApi?.json?.runtimeReconciliation
    || result.budget?.json?.runtimeReconciliation
    || null;
}

function runtimePendingRooms(runtimeReconciliation = {}) {
  runtimeReconciliation = runtimeReconciliation || {};
  const pending = runtimeReconciliation.runtimePersistPending;
  if (Array.isArray(pending)) return pending;
  if (Array.isArray(pending?.pendingRooms)) return pending.pendingRooms;
  return [];
}

function latestRuntimeRecovery(runtimeReconciliation = {}) {
  runtimeReconciliation = runtimeReconciliation || {};
  const stalled = Array.isArray(runtimeReconciliation.stalledActiveRooms) ? runtimeReconciliation.stalledActiveRooms : [];
  const recovered = Array.isArray(runtimeReconciliation.recoveredRooms) ? runtimeReconciliation.recoveredRooms : [];
  const cleaned = Array.isArray(runtimeReconciliation.cleanedActiveAborts) ? runtimeReconciliation.cleanedActiveAborts : [];
  return stalled[0] || recovered[0] || cleaned[0] || null;
}

export function buildPanelHealthHistoryEntry(result = {}, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const readiness = result.readiness || result.readinessApi?.json?.readiness || null;
  const readinessChecks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  const readinessCapabilities = readiness?.capabilities || {};
  const runtimeReconciliation = runtimeReconciliationFromResult(result);
  const latestRecovery = latestRuntimeRecovery(runtimeReconciliation);
  const latestResumePolicy = latestRecovery?.resumePolicy || result.readinessApi?.json?.clusterRuntimeResumePolicy || null;
  const configAudit = result.healthApi?.json?.configAudit
    || result.readinessApi?.json?.configAudit
    || result.diagnosticsApi?.json?.configAudit
    || result.budget?.json?.configAudit
    || result.configAudit
    || null;
  const diagnostics = result.diagnostics || result.diagnosticsApi?.json?.diagnostics || null;
  const diagnosticFindings = Array.isArray(diagnostics?.findings) ? diagnostics.findings : [];
  const diagnosticRecommendations = Array.isArray(diagnostics?.recommendations) ? diagnostics.recommendations : [];
  const diagnosticRecoveryPlan = Array.isArray(diagnostics?.recoveryPlan) ? diagnostics.recoveryPlan : [];
  const diagnosticRecoveryCommands = [
    ...new Set(diagnosticRecoveryPlan.map((item) => item?.command).filter(Boolean)),
  ].slice(0, 5);
  const diagnosticRecoveryEndpoints = [
    ...new Set(diagnosticRecoveryPlan.map((item) => item?.endpoint).filter(Boolean)),
  ].slice(0, 5);
  const diagnosticRecoveryUiEntries = [
    ...new Set(diagnosticRecoveryPlan.map((item) => item?.ui).filter(Boolean)),
  ].slice(0, 5);
  const diagnosticsDrill = result.diagnosticsDrill || null;
  const diagnosticsDrillResults = Array.isArray(diagnosticsDrill?.results) ? diagnosticsDrill.results : [];
  const resilienceDrill = result.resilienceDrill || null;
  const resilienceDrillResults = Array.isArray(resilienceDrill?.results) ? resilienceDrill.results : [];
  const runtimeDrill = result.runtimeDrill || null;
  const runtimeDrillResults = Array.isArray(runtimeDrill?.results) ? runtimeDrill.results : [];
  const assurance = result.assurance || null;
  const assuranceGates = Array.isArray(assurance?.gates) ? assurance.gates : [];
  const assuranceRecoveryPlan = Array.isArray(assurance?.recoveryPlan) ? assurance.recoveryPlan : [];
  return {
    at,
    ok: Boolean(result.ok),
    checkOnly: Boolean(result.checkOnly),
    restartMethod: result.restartMethod || '',
    repairMode: result.repair?.mode || null,
    repairAction: result.repair?.action || null,
    repairReason: result.repair?.reason || null,
    port: result.port || null,
    healthSource: result.healthSource || '',
    healthStatus: result.health?.status || 'unknown',
    blockers: Array.isArray(result.health?.blockers) ? result.health.blockers : [],
    readinessSource: result.readinessSource || '',
    readinessStatus: readiness?.status || 'unknown',
    readinessBlockers: Array.isArray(readiness?.blockers) ? readiness.blockers : [],
    readinessWarnings: Array.isArray(readiness?.warnings) ? readiness.warnings : [],
    readinessCheckCount: readinessChecks.length,
    readinessPassedCheckCount: readinessChecks.filter((check) => check?.status === 'passed').length,
    readinessMultiRoom: readinessCapabilities.multiRoom === true,
    readinessMaxRunningRooms: Number(readinessCapabilities.maxRunningRooms) || null,
    readinessMaxAdapterRunningRooms: Number(readinessCapabilities.maxAdapterRunningRooms) || null,
    configAuditStatus: configAudit?.status || 'unknown',
    configAuditBlockers: Array.isArray(configAudit?.blockers) ? configAudit.blockers : [],
    configAuditWarnings: Array.isArray(configAudit?.warnings) ? configAudit.warnings : [],
    diagnosticsSource: result.diagnosticsSource || '',
    diagnosticsStatus: diagnostics?.status || 'unknown',
    diagnosticsSafeToStart: typeof diagnostics?.invariants?.safeToStart === 'boolean'
      ? diagnostics.invariants.safeToStart
      : null,
    diagnosticsFindingCount: diagnosticFindings.length,
    diagnosticsBlockerCount: diagnosticFindings.filter((finding) => finding?.severity === 'blocker').length,
    diagnosticsWarningCount: diagnosticFindings.filter((finding) => finding?.severity === 'warn').length,
    diagnosticsRecommendationCount: diagnosticRecommendations.length,
    diagnosticsRecoveryActionCount: diagnosticRecoveryPlan.length,
    diagnosticsBlockingRecoveryActionCount: diagnosticRecoveryPlan.filter((item) => item?.blocksStart === true).length,
    diagnosticsRecoveryCommands: diagnosticRecoveryCommands,
    diagnosticsRecoveryEndpoints: diagnosticRecoveryEndpoints,
    diagnosticsRecoveryUiEntries: diagnosticRecoveryUiEntries,
    diagnosticsDrillSource: result.diagnosticsDrillSource || '',
    diagnosticsDrillOk: typeof diagnosticsDrill?.ok === 'boolean' ? diagnosticsDrill.ok : null,
    diagnosticsDrillCaseCount: Number.isFinite(Number(diagnosticsDrill?.caseCount)) ? Number(diagnosticsDrill.caseCount) : null,
    diagnosticsDrillFailedCaseCount: Number.isFinite(Number(diagnosticsDrill?.failedCaseCount)) ? Number(diagnosticsDrill.failedCaseCount) : null,
    diagnosticsDrillFailedCases: diagnosticsDrillResults
      .filter((item) => item?.ok === false)
      .map((item) => item.id || '')
      .filter(Boolean)
      .slice(0, 5),
    diagnosticsDrillError: diagnosticsDrill?.error || null,
    resilienceDrillSource: result.resilienceDrillSource || '',
    resilienceDrillOk: typeof resilienceDrill?.ok === 'boolean' ? resilienceDrill.ok : null,
    resilienceDrillCaseCount: Number.isFinite(Number(resilienceDrill?.caseCount)) ? Number(resilienceDrill.caseCount) : null,
    resilienceDrillFailedCaseCount: Number.isFinite(Number(resilienceDrill?.failedCaseCount)) ? Number(resilienceDrill.failedCaseCount) : null,
    resilienceDrillFailedCases: resilienceDrillResults
      .filter((item) => item?.ok === false)
      .map((item) => item.id || '')
      .filter(Boolean)
      .slice(0, 5),
    resilienceDrillError: resilienceDrill?.error || null,
    runtimeDrillSource: result.runtimeDrillSource || '',
    runtimeDrillOk: typeof runtimeDrill?.ok === 'boolean' ? runtimeDrill.ok : null,
    runtimeDrillCaseCount: Number.isFinite(Number(runtimeDrill?.caseCount)) ? Number(runtimeDrill.caseCount) : null,
    runtimeDrillFailedCaseCount: Number.isFinite(Number(runtimeDrill?.failedCaseCount)) ? Number(runtimeDrill.failedCaseCount) : null,
    runtimeDrillFailedCases: runtimeDrillResults
      .filter((item) => item?.ok === false)
      .map((item) => item.id || '')
      .filter(Boolean)
      .slice(0, 5),
    runtimeDrillError: runtimeDrill?.error || null,
    assuranceSource: result.assuranceSource || '',
    assuranceStatus: assurance?.status || 'unknown',
    assuranceOk: typeof assurance?.ok === 'boolean' ? assurance.ok : null,
    assuranceGateCount: Number.isFinite(Number(assurance?.summary?.gateCount)) ? Number(assurance.summary.gateCount) : null,
    assuranceBlockedGateCount: Number.isFinite(Number(assurance?.summary?.blockedGateCount)) ? Number(assurance.summary.blockedGateCount) : null,
    assuranceWarningGateCount: Number.isFinite(Number(assurance?.summary?.warningGateCount)) ? Number(assurance.summary.warningGateCount) : null,
    assuranceFailedGates: Array.isArray(assurance?.summary?.failedGateIds)
      ? assurance.summary.failedGateIds.slice(0, 5)
      : assuranceGates.filter((gate) => gate?.status === 'blocked').map((gate) => gate.id || '').filter(Boolean).slice(0, 5),
    assuranceFailedCases: Array.isArray(assurance?.summary?.failedCases) ? assurance.summary.failedCases.slice(0, 8) : [],
    assuranceRecoveryActionCount: assuranceRecoveryPlan.length,
    assuranceBlockingRecoveryActionCount: assuranceRecoveryPlan.filter((item) => item?.blocksStart === true).length,
    assuranceRecoveryCommands: [
      ...new Set(assuranceRecoveryPlan.map((item) => item?.command).filter(Boolean)),
    ].slice(0, 5),
    assuranceRecoveryEndpoints: [
      ...new Set(assuranceRecoveryPlan.map((item) => item?.endpoint).filter(Boolean)),
    ].slice(0, 5),
    assuranceRecoveryUiEntries: [
      ...new Set(assuranceRecoveryPlan.map((item) => item?.ui).filter(Boolean)),
    ].slice(0, 5),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    listeners: Array.isArray(result.listeners) ? result.listeners : [],
    runtimeStatus: runtimeReconciliation?.status || null,
    runtimeRecoveredRoomCount: Number(runtimeReconciliation?.recoveredRoomCount) || 0,
    runtimeStalledActiveRoomCount: Number(runtimeReconciliation?.stalledActiveRoomCount) || 0,
    runtimeCleanedActiveAbortCount: Number(runtimeReconciliation?.cleanedActiveAbortCount) || 0,
    runtimeRecoveryErrorCount: Number(runtimeReconciliation?.recoveryErrorCount) || 0,
    runtimePendingPersistCount: runtimePendingRooms(runtimeReconciliation).length,
    runtimeFlushError: runtimeReconciliation?.flushError || null,
    latestRuntimeRecoveryReason: latestRecovery?.reason || null,
    latestRuntimeRecoveryRoomId: latestRecovery?.roomId || null,
    latestRuntimeRecoveryAt: latestRecovery?.at || null,
    latestRuntimeAutoResumeAllowed: typeof latestResumePolicy?.autoResumeAllowed === 'boolean'
      ? latestResumePolicy.autoResumeAllowed
      : null,
    latestRuntimeResumeNextAction: latestResumePolicy?.nextAction || null,
    concurrencyStatus: result.healthApi?.json?.concurrencyBudget?.status
      || result.budget?.json?.concurrencyBudget?.status
      || null,
  };
}

function normalizeMaxHistoryLines(value, fallback = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function trimHistoryFile(historyPath, maxHistoryLines) {
  const limit = normalizeMaxHistoryLines(maxHistoryLines);
  const raw = readFileSync(historyPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length <= limit) return { trimmed: false, lineCount: lines.length, maxHistoryLines: limit };
  const kept = lines.slice(-limit);
  writeFileSync(historyPath, `${kept.join('\n')}\n`, { mode: 0o600 });
  return { trimmed: true, lineCount: kept.length, previousLineCount: lines.length, maxHistoryLines: limit };
}

export function writePanelHealthReport(result = {}, {
  latestPath,
  historyPath,
  now = new Date(),
  maxHistoryLines = 1000,
} = {}) {
  if (!latestPath || !historyPath) {
    return { written: false, error: 'health_report_path_missing' };
  }
  try {
    ensureParentDir(latestPath);
    ensureParentDir(historyPath);
    const report = {
      generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      ...result,
    };
    const tmpPath = `${latestPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, latestPath);
    appendFileSync(historyPath, `${JSON.stringify(buildPanelHealthHistoryEntry(result, now))}\n`, { mode: 0o600 });
    const retention = trimHistoryFile(historyPath, maxHistoryLines);
    return { written: true, latestPath, historyPath, retention };
  } catch (e) {
    return { written: false, latestPath, historyPath, error: e?.message || String(e) };
  }
}
