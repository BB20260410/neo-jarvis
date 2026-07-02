#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { assessPanelClusterHealth, buildPanelClusterReadiness } from '../src/server/services/panel-health.js';
import { buildClusterDiagnostics } from '../src/server/services/cluster-diagnostics.js';
import { buildClusterDiagnosticsDrillReport } from '../src/server/services/cluster-diagnostics-drill.js';
import { buildClusterResilienceDrillReport } from '../src/server/services/cluster-resilience-drill.js';
import { buildClusterRuntimeDrillReport } from '../src/server/services/cluster-runtime-drill.js';
import { buildClusterAssuranceReport } from '../src/server/services/cluster-assurance.js';
import { buildClusterHealthTrendReport } from '../src/server/services/cluster-health-trend.js';
import { writePanelHealthReport } from '../src/server/services/panel-health-report.js';
import {
  collectNoePanelRuntimePreflight,
  evaluateNoePanelRestartPreflight,
} from '../src/runtime/NoePanelRuntimePreflight.js';
import { resolveNode22OrFail } from './ensure-node22.mjs';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 51835);
const LOG_PATH = process.env.PANEL_RESTART_LOG || `/tmp/noe-panel-${PORT}.log`;
const CHECK_ONLY = process.argv.includes('--check-only');
const REPAIR_IF_UNHEALTHY = process.argv.includes('--repair');
const EXPLICIT_ACK_READ_OWNER_TOKEN = process.argv.includes('--ack-read-owner-token') || process.env.NOE_ACK_READ_OWNER_TOKEN === '1';
const OWNER_TOKEN_AUTHORIZATION = resolveOwnerTokenAuthorization({
  explicitAck: EXPLICIT_ACK_READ_OWNER_TOKEN,
  scope: 'restart-51835:repair',
});
const ACK_READ_OWNER_TOKEN = OWNER_TOKEN_AUTHORIZATION.authorized;
const START_TIMEOUT_MS = Number(process.env.PANEL_RESTART_TIMEOUT_MS || 45000);
const LAUNCHD_LABEL = process.env.PANEL_LAUNCHD_LABEL || 'com.noe.noe.panel51835';
const FORCE_DIRECT = process.env.PANEL_RESTART_FORCE_DIRECT === '1';
const HEALTH_REPORT_PATH = process.env.PANEL_HEALTH_REPORT_PATH || join(ROOT, 'logs', `cluster-health-${PORT}.latest.json`);
const HEALTH_HISTORY_PATH = process.env.PANEL_HEALTH_HISTORY_PATH || join(ROOT, 'logs', `cluster-health-${PORT}.history.jsonl`);
const WRITE_HEALTH_REPORT = process.env.PANEL_HEALTH_REPORT !== '0';
const HEALTH_HISTORY_MAX_LINES = Number(process.env.PANEL_HEALTH_HISTORY_MAX_LINES || 1000);

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function listenerPids() {
  const res = run('lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN']);
  if (res.status !== 0 && !res.stdout) return [];
  return res.stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function launchdServiceTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : run('id', ['-u']).stdout.trim();
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

function launchdLoaded() {
  if (FORCE_DIRECT) return false;
  const res = run('launchctl', ['list']);
  if (res.status !== 0) return false;
  return res.stdout.split('\n').some((line) => line.trim().endsWith(LAUNCHD_LABEL));
}

function restartLaunchd() {
  const target = launchdServiceTarget();
  const res = run('launchctl', ['kickstart', '-k', target]);
  return {
    target,
    status: res.status,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

function pidCwd(pid) {
  const res = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (res.status !== 0) return null;
  const line = res.stdout.split('\n').find((item) => item.startsWith('n'));
  return line ? line.slice(1) : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForListeners() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const pids = listenerPids();
    if (pids.length) return pids;
    await sleep(250);
  }
  return [];
}

async function releasePort() {
  let pids = listenerPids();
  if (!pids.length) return { killed: [] };
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    pids = listenerPids();
    if (!pids.length) return { killed: [] };
  }
  const forceKilled = pids.slice();
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  }
  await sleep(500);
  return { killed: forceKilled };
}

function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) return '';
  if (process.env.NOE_OWNER_TOKEN) return String(process.env.NOE_OWNER_TOKEN).trim();
  const tokenPath = join(homedir(), '.noe-panel', 'owner-token.txt');
  if (!existsSync(tokenPath)) return '';
  try { return readFileSync(tokenPath, 'utf8').trim(); } catch { return ''; }
}

function tokenPolicy() {
  return {
    ackReadOwnerToken: ACK_READ_OWNER_TOKEN,
    authorization: OWNER_TOKEN_AUTHORIZATION,
    policyBlocked: !ACK_READ_OWNER_TOKEN,
    reason: ACK_READ_OWNER_TOKEN
      ? ''
      : 'restart-panel protected API checks require --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    secretValueReturned: false,
  };
}

function collectRestartPreflight() {
  const report = collectNoePanelRuntimePreflight({
    root: ROOT,
    port: PORT,
    observeOnlyPort: 51735,
  });
  return {
    report,
    decision: evaluateNoePanelRestartPreflight(report),
  };
}

function preflightBlockedResult({ launchd, preflight, mode = 'restart' } = {}) {
  return {
    ok: false,
    checkOnly: false,
    host: HOST,
    port: PORT,
    root: ROOT,
    restartMethod: 'preflight-blocked',
    launchd,
    logPath: LOG_PATH,
    tokenPolicy: tokenPolicy(),
    preflight,
    warnings: preflight?.decision?.warnings || [],
    blockers: preflight?.decision?.blockers || ['panel_preflight_not_safe_to_restart_or_start'],
    noRestartPerformed: true,
    repair: mode === 'repair'
      ? { mode: 'repair', action: 'blocked', reason: 'runtime_preflight_failed' }
      : null,
  };
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]')
    .replace(/(owner[-_ ]?token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]');
}

function redactLogFile() {
  if (!existsSync(LOG_PATH)) return;
  const before = readFileSync(LOG_PATH, 'utf8');
  const after = redactSecrets(before);
  if (after !== before) writeFileSync(LOG_PATH, after);
}

function fetchPanelJson(path, { method = 'GET' } = {}) {
  const token = ownerToken({ ackReadOwnerToken: ACK_READ_OWNER_TOKEN });
  return new Promise((resolveBudget) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path,
      method,
      timeout: 3000,
      headers: token ? { 'X-Panel-Owner-Token': token } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolveBudget({ statusCode: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolveBudget({ statusCode: res.statusCode, body });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request_timeout'));
    });
    req.on('error', (err) => {
      resolveBudget({ error: err.message });
    });
    req.end();
  });
}

function fetchBudget() { return fetchPanelJson('/api/cluster/concurrency-budget'); }
function fetchClusterHealth() { return fetchPanelJson('/api/cluster/health'); }
function fetchClusterReadiness() { return fetchPanelJson('/api/cluster/readiness'); }
function fetchClusterDiagnostics() { return fetchPanelJson('/api/cluster/diagnostics'); }
function fetchClusterHealthTrend() { return fetchPanelJson('/api/cluster/health-trend'); }
function fetchClusterResourceGuard() { return fetchPanelJson('/api/cluster/resource-guard'); }
function fetchClusterOpsGuard() { return fetchPanelJson('/api/cluster/ops-guard'); }
function fetchClusterCapabilityGuard() { return fetchPanelJson('/api/cluster/capability-guard'); }
function fetchClusterRepair() { return fetchPanelJson('/api/cluster/repair', { method: 'POST' }); }

function startPanel() {
  writeFileSync(LOG_PATH, '');
  const logFd = openSync(LOG_PATH, 'a');
  const nodeBin = resolveNode22OrFail({ root: ROOT });
  const child = spawn(nodeBin, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PANEL_HOST: HOST,
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  return child.pid;
}

function runLocalDiagnosticsDrill() {
  try {
    return buildClusterDiagnosticsDrillReport();
  } catch (e) {
    return { generatedAt: new Date().toISOString(), ok: false, caseCount: 0, failedCaseCount: 1, error: e?.message || String(e), results: [] };
  }
}

function runLocalResilienceDrill() {
  try {
    return buildClusterResilienceDrillReport();
  } catch (e) {
    return { drillVersion: 'cluster-resilience-drill-v1', generatedAt: new Date().toISOString(), ok: false, caseCount: 0, failedCaseCount: 1, error: e?.message || String(e), results: [] };
  }
}

async function runLocalRuntimeDrill() {
  try {
    return await buildClusterRuntimeDrillReport();
  } catch (e) {
    return { drillVersion: 'cluster-runtime-drill-v1', generatedAt: new Date().toISOString(), ok: false, caseCount: 0, failedCaseCount: 1, error: e?.message || String(e), results: [] };
  }
}

async function collectPanelStatus({
  launchd,
  restartMethod,
  release = { killed: [] },
  startedPid = null,
  checkOnly = false,
  repair = null,
  preflight = null,
} = {}) {
  const pids = await waitForListeners();
  const healthApi = pids.length ? await fetchClusterHealth() : { error: 'port_not_listening' };
  const readinessApi = pids.length ? await fetchClusterReadiness() : { error: 'port_not_listening' };
  const diagnosticsApi = pids.length ? await fetchClusterDiagnostics() : { error: 'port_not_listening' };
  const healthTrendApi = pids.length ? await fetchClusterHealthTrend() : { error: 'port_not_listening' };
  const resourceGuardApi = pids.length ? await fetchClusterResourceGuard() : { error: 'port_not_listening' };
  const opsGuardApi = pids.length ? await fetchClusterOpsGuard() : { error: 'port_not_listening' };
  const capabilityGuardApi = pids.length ? await fetchClusterCapabilityGuard() : { error: 'port_not_listening' };
  const repairApi = pids.length ? await fetchClusterRepair() : { error: 'port_not_listening' };
  const budget = pids.length ? await fetchBudget() : { error: 'port_not_listening' };
  const health = healthApi?.json?.health || assessPanelClusterHealth(budget);
  const healthSource = healthApi?.json?.health ? 'cluster_health_api' : 'concurrency_budget_api_assessment';
  const readiness = readinessApi?.json?.readiness
    || (budget?.json ? buildPanelClusterReadiness(budget.json) : {
      status: 'blocked',
      blockers: ['readiness_api_unavailable'],
      warnings: [],
      checks: [],
      capabilities: {},
    });
  const readinessSource = readinessApi?.json?.readiness ? 'cluster_readiness_api' : 'concurrency_budget_api_assessment';
  const diagnostics = diagnosticsApi?.json?.diagnostics || buildClusterDiagnostics({
    runtimeReconciliation: diagnosticsApi?.json?.runtimeReconciliation
      || readinessApi?.json?.runtimeReconciliation
      || healthApi?.json?.runtimeReconciliation
      || budget?.json?.runtimeReconciliation
      || {},
    configAudit: diagnosticsApi?.json?.configAudit
      || readinessApi?.json?.configAudit
      || healthApi?.json?.configAudit
      || budget?.json?.configAudit
      || {},
    concurrencyBudget: diagnosticsApi?.json?.concurrencyBudget
      || readinessApi?.json?.concurrencyBudget
      || healthApi?.json?.concurrencyBudget
      || budget?.json?.concurrencyBudget
      || {},
    health,
    readiness,
    capabilityGuard: capabilityGuardApi?.json?.capabilityGuard || null,
    rooms: [],
  });
  const diagnosticsSource = diagnosticsApi?.json?.diagnostics ? 'cluster_diagnostics_api' : 'local_diagnostics_assessment';
  const diagnosticsDrill = runLocalDiagnosticsDrill();
  const diagnosticsDrillSource = 'local_cluster_diagnostics_drill';
  const resilienceDrill = runLocalResilienceDrill();
  const resilienceDrillSource = 'local_cluster_resilience_drill';
  const runtimeDrill = await runLocalRuntimeDrill();
  const runtimeDrillSource = 'local_cluster_runtime_drill';
  const assurance = await buildClusterAssuranceReport({
    diagnostics,
    diagnosticsDrill,
    resilienceDrill,
    runtimeDrill,
    healthTrend: healthTrendApi?.json?.healthTrend || null,
    resourceGuard: resourceGuardApi?.json?.resourceGuard || null,
    opsGuard: opsGuardApi?.json?.opsGuard || null,
    capabilityGuard: capabilityGuardApi?.json?.capabilityGuard || null,
  });
  const assuranceSource = 'local_cluster_assurance';
  const listeners = pids.map((pid) => ({ pid: Number(pid), cwd: pidCwd(pid) }));
  const foreignListeners = listeners.filter((item) => item.cwd && resolve(item.cwd) !== ROOT);
  const spawnedAlive = startedPid ? pidAlive(startedPid) : null;
  const listenerPidSet = new Set(listeners.map((item) => item.pid));
  const warnings = [];
  if (launchd?.kickstart && launchd.kickstart.status !== 0) warnings.push('launchd_kickstart_failed');
  if (!healthApi?.json?.health && healthApi?.statusCode && healthApi.statusCode !== 404) warnings.push(`cluster_health_api_unavailable=${healthApi.statusCode}`);
  if (!readinessApi?.json?.readiness && readinessApi?.statusCode && readinessApi.statusCode !== 404) warnings.push(`cluster_readiness_api_unavailable=${readinessApi.statusCode}`);
  if (!diagnosticsApi?.json?.diagnostics && diagnosticsApi?.statusCode && diagnosticsApi.statusCode !== 404) warnings.push(`cluster_diagnostics_api_unavailable=${diagnosticsApi.statusCode}`);
  if (!healthTrendApi?.json?.healthTrend) warnings.push(`cluster_health_trend_api_unavailable=${healthTrendApi?.statusCode || healthTrendApi?.error || 'unknown'}`);
  if (healthTrendApi?.json?.healthTrend?.status === 'blocked') warnings.push('cluster_health_trend_api_blocked');
  if (healthTrendApi?.json?.healthTrend?.status === 'warn') warnings.push('cluster_health_trend_api_warn');
  if (!resourceGuardApi?.json?.resourceGuard) warnings.push(`cluster_resource_guard_api_unavailable=${resourceGuardApi?.statusCode || resourceGuardApi?.error || 'unknown'}`);
  if (resourceGuardApi?.json?.resourceGuard?.status === 'blocked') warnings.push('cluster_resource_guard_blocked');
  if (resourceGuardApi?.json?.resourceGuard?.status === 'warn') warnings.push('cluster_resource_guard_warn');
  if (!opsGuardApi?.json?.opsGuard) warnings.push(`cluster_ops_guard_api_unavailable=${opsGuardApi?.statusCode || opsGuardApi?.error || 'unknown'}`);
  if (opsGuardApi?.json?.opsGuard?.status === 'blocked') warnings.push('cluster_ops_guard_blocked');
  if (opsGuardApi?.json?.opsGuard?.status === 'warn') warnings.push('cluster_ops_guard_warn');
  if (!capabilityGuardApi?.json?.capabilityGuard) warnings.push(`cluster_capability_guard_api_unavailable=${capabilityGuardApi?.statusCode || capabilityGuardApi?.error || 'unknown'}`);
  if (capabilityGuardApi?.json?.capabilityGuard?.status === 'blocked') warnings.push('cluster_capability_guard_blocked');
  if (capabilityGuardApi?.json?.capabilityGuard?.status === 'warn') warnings.push('cluster_capability_guard_warn');
  if (!repairApi?.json?.repair) warnings.push(`cluster_repair_api_unavailable=${repairApi?.statusCode || repairApi?.error || 'unknown'}`);
  if (repairApi?.json?.repair?.status === 'blocked') warnings.push('cluster_repair_blocked');
  if (repairApi?.json?.repair?.status === 'warn') warnings.push('cluster_repair_warn');
  if (readiness?.status === 'warn') warnings.push('cluster_readiness_warn');
  if (diagnostics?.status === 'warn') warnings.push('cluster_diagnostics_warn');
  if (diagnosticsDrill.ok !== true) warnings.push('cluster_diagnostics_drill_failed');
  if (resilienceDrill.ok !== true) warnings.push('cluster_resilience_drill_failed');
  if (runtimeDrill.ok !== true) warnings.push('cluster_runtime_drill_failed');
  if (assurance.status === 'warn') warnings.push('cluster_assurance_warn');
  if (assurance.status === 'blocked') warnings.push('cluster_assurance_blocked');
  for (const warning of readiness?.warnings || []) warnings.push(`cluster_readiness=${warning}`);
  for (const finding of diagnostics?.findings || []) {
    if (finding?.severity === 'warn') warnings.push(`cluster_diagnostics=${finding.code || 'warn'}`);
  }
  if (startedPid && !listenerPidSet.has(startedPid)) warnings.push('started_pid_is_not_listener');
  if (startedPid && spawnedAlive === false) warnings.push('started_pid_exited_after_launch');
  if (foreignListeners.length) warnings.push('foreign_listener_on_panel_port');
  const baseOk = Boolean(
    pids.length
    && budget?.statusCode === 200
    && budget?.json?.ok === true
    && health.status === 'passed'
    && readiness?.status !== 'blocked'
    && diagnostics?.status !== 'blocked'
    && diagnostics?.invariants?.safeToStart !== false
    && healthTrendApi?.statusCode === 200
    && healthTrendApi?.json?.healthTrend?.ok === true
    && healthTrendApi?.json?.healthTrend?.status !== 'blocked'
    && resourceGuardApi?.statusCode === 200
    && resourceGuardApi?.json?.resourceGuard?.ok === true
    && resourceGuardApi?.json?.resourceGuard?.status !== 'blocked'
    && opsGuardApi?.statusCode === 200
    && opsGuardApi?.json?.opsGuard?.ok === true
    && opsGuardApi?.json?.opsGuard?.status !== 'blocked'
    && capabilityGuardApi?.statusCode === 200
    && capabilityGuardApi?.json?.capabilityGuard?.ok === true
    && capabilityGuardApi?.json?.capabilityGuard?.status !== 'blocked'
    && repairApi?.statusCode === 200
    && repairApi?.json?.ok === true
    && repairApi?.json?.repair?.ok === true
    && repairApi?.json?.repair?.status !== 'blocked'
    && diagnosticsDrill.ok === true
    && resilienceDrill.ok === true
    && runtimeDrill.ok === true
    && assurance.ok === true
    && foreignListeners.length === 0
    && (!launchd?.kickstart || launchd.kickstart.status === 0)
  );
  const preliminaryReport = {
    ok: baseOk,
    checkOnly,
    host: HOST,
    port: PORT,
    root: ROOT,
    restartMethod,
    launchd,
    logPath: LOG_PATH,
    startedPid,
    spawnedAlive,
    preflight,
    warnings,
    killedAfterTermTimeout: release.killed,
    listeners,
    healthSource,
    health,
    healthApi,
    readinessSource,
    readiness,
    readinessApi,
    diagnosticsSource,
    diagnostics,
    diagnosticsApi,
    healthTrendApi,
    resourceGuardApi,
    opsGuardApi,
    capabilityGuardApi,
    repairApi,
    diagnosticsDrillSource,
    diagnosticsDrill,
    resilienceDrillSource,
    resilienceDrill,
    runtimeDrillSource,
    runtimeDrill,
    assuranceSource,
    assurance,
    budget,
    ...(repair ? { repair } : {}),
  };
  const historyText = existsSync(HEALTH_HISTORY_PATH) ? readFileSync(HEALTH_HISTORY_PATH, 'utf8') : '';
  const healthTrend = buildClusterHealthTrendReport({ historyText, currentReport: preliminaryReport });
  if (healthTrend.status === 'warn') warnings.push('cluster_health_trend_warn');
  if (healthTrend.status === 'blocked') warnings.push('cluster_health_trend_blocked');
  return {
    ...preliminaryReport,
    ok: baseOk && healthTrend.status !== 'blocked',
    warnings,
    healthTrend,
  };
}

function restartPanel(launchd, preflight) {
  const decision = preflight?.decision || {};
  if (decision.ok !== true) {
    return Promise.resolve({
      restartMethod: 'preflight-blocked',
      release: { killed: [] },
      startedPid: null,
      blocked: true,
      preflight,
    });
  }
  if (launchd.loaded) {
    launchd.kickstart = restartLaunchd();
    return { restartMethod: 'launchd', release: { killed: [] }, startedPid: null };
  }
  return releasePort().then((release) => ({
    restartMethod: 'direct',
    release,
    startedPid: startPanel(),
  }));
}

const launchd = { label: LAUNCHD_LABEL, loaded: launchdLoaded(), kickstart: null };
let result;
const startupPreflight = collectRestartPreflight();
if (!ACK_READ_OWNER_TOKEN) {
  result = {
    ok: false,
    checkOnly: CHECK_ONLY,
    host: HOST,
    port: PORT,
    root: ROOT,
    restartMethod: 'policy-blocked',
    launchd,
    logPath: LOG_PATH,
    tokenPolicy: tokenPolicy(),
    preflight: startupPreflight,
    note: 'No live owner-token was read and no restart/check protected API calls were made. Re-run with explicit ack or install a standing autonomy grant when owner authorizes this local live operation.',
  };
} else if (REPAIR_IF_UNHEALTHY) {
  const precheck = await collectPanelStatus({
    launchd: { ...launchd },
    restartMethod: 'repair-check',
    checkOnly: true,
    repair: { mode: 'repair', action: 'precheck' },
    preflight: startupPreflight,
  });
  if (precheck.ok) {
    result = {
      ...precheck,
      checkOnly: false,
      restartMethod: 'repair',
      repair: { mode: 'repair', action: 'none', reason: 'already_healthy', precheck },
    };
  } else {
    const preflight = collectRestartPreflight();
    const restart = await restartPanel(launchd, preflight);
    result = restart.blocked
      ? preflightBlockedResult({ launchd, preflight, mode: 'repair' })
      : await collectPanelStatus({
        launchd,
        restartMethod: `repair-${restart.restartMethod}`,
        release: restart.release,
        startedPid: restart.startedPid,
        checkOnly: false,
        repair: { mode: 'repair', action: 'restart', reason: 'precheck_failed', precheck },
        preflight,
      });
  }
} else {
  let restartMethod = CHECK_ONLY ? 'check' : 'direct';
  let release = { killed: [] };
  let startedPid = null;
  let preflight = startupPreflight;
  if (!CHECK_ONLY) {
    preflight = collectRestartPreflight();
    const restart = await restartPanel(launchd, preflight);
    if (restart.blocked) {
      result = preflightBlockedResult({ launchd, preflight, mode: 'restart' });
    } else {
      restartMethod = restart.restartMethod;
      release = restart.release;
      startedPid = restart.startedPid;
    }
  }
  if (!result) {
    result = await collectPanelStatus({
      launchd,
      restartMethod,
      release,
      startedPid,
      checkOnly: CHECK_ONLY,
      preflight,
    });
  }
}

const report = WRITE_HEALTH_REPORT
  ? writePanelHealthReport(result, {
    latestPath: HEALTH_REPORT_PATH,
    historyPath: HEALTH_HISTORY_PATH,
    maxHistoryLines: HEALTH_HISTORY_MAX_LINES,
  })
  : { written: false, disabled: true };

redactLogFile();
console.log(JSON.stringify({ ...result, report }, null, 2));
process.exit(result?.tokenPolicy?.policyBlocked ? 2 : result.ok ? 0 : 1);
