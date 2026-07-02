// @ts-check
// Noe boot self-check, inspired by BaiLongma's L2 startup self-check but kept
// deterministic: Node verifies evidence directly; the model does not self-attest.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectNoePanelRuntimePreflight,
  evaluateNoePanelRestartPreflight,
} from './NoePanelRuntimePreflight.js';
import { collectNoeCompanionToolPreflight } from './NoeCompanionToolPreflight.js';
import {
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../security/NoePolicyFileGuard.js';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERSION = 'noe-boot-self-check-v1';
const REQUIRED_FILES = [
  'package.json',
  'server.js',
  'public/mind.html',
  'public/mind.js',
  'public/src/web/noe-world-earth.js',
];

function iso(now = Date.now) {
  return new Date(now()).toISOString();
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function portFromBaseUrl(baseUrl, fallback = 51835) {
  try {
    return Number(new URL(String(baseUrl)).port || fallback);
  } catch {
    return fallback;
  }
}

const SECRET_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function clean(value, max = 320) {
  return String(value ?? '')
    .replace(SECRET_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanDetail(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return clean(value, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanDetail(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) out[key] = cleanDetail(item, depth + 1);
    return out;
  }
  return clean(String(value), 200);
}

function check(id, title, status, detail = {}, actions = []) {
  return {
    id,
    title,
    status,
    ok: status === 'ok' || status === 'repaired',
    repairable: actions.some((item) => item.repairable === true),
    detail,
    actions,
  };
}

function repairRecord({
  id,
  title,
  status = 'skipped',
  operation = '',
  path = '',
  reason = '',
  verification = [],
} = {}) {
  return {
    id,
    title: title || id,
    status,
    operation,
    path,
    reason: clean(reason, 240),
    safeAutomatic: true,
    repairable: true,
    verification: Array.isArray(verification) ? verification.slice(0, 8).map((item) => clean(item, 160)) : [],
  };
}

function summarizeRepairJournal(actions = []) {
  return {
    attempted: actions.length,
    repaired: actions.filter((item) => item.status === 'repaired').length,
    failed: actions.filter((item) => item.status === 'failed').length,
    skipped: actions.filter((item) => item.status === 'skipped').length,
  };
}

function buildSelfRepairReport({ requested = false, actions = [], checks = [] } = {}) {
  const repairableOpen = [];
  const manualFollowups = [];
  for (const item of checks) {
    for (const action of Array.isArray(item.actions) ? item.actions : []) {
      const entry = {
        checkId: item.id,
        id: action.id,
        label: action.label,
        repairable: action.repairable === true,
      };
      if (action.repairable === true) repairableOpen.push(entry);
      else manualFollowups.push(entry);
    }
  }
  const summary = summarizeRepairJournal(actions);
  return {
    version: 'noe-boot-self-repair-v1',
    requested: requested === true,
    actionsPerformed: actions.some((item) => item.status === 'repaired' || item.status === 'failed'),
    summary,
    actions,
    repairableOpen: repairableOpen.slice(0, 12),
    manualFollowups: manualFollowups.slice(0, 12),
    policy: {
      safeAutomaticOnly: true,
      noSecretRead: true,
      noConfigRead: true,
      noPackageInstall: true,
      noPathMutation: true,
      noProcessRestart: true,
      noObserveOnlyPortTouch: true,
    },
  };
}

function summarize(checks = []) {
  const blocked = checks.filter((item) => item.status === 'blocked');
  const warned = checks.filter((item) => item.status === 'warn');
  const repaired = checks.filter((item) => item.status === 'repaired');
  const repairable = checks.flatMap((item) => item.actions || []).filter((item) => item.repairable === true);
  const status = blocked.length ? 'blocked' : warned.length || repaired.length ? 'degraded' : 'passed';
  return {
    ok: blocked.length === 0,
    status,
    counts: {
      total: checks.length,
      ok: checks.filter((item) => item.status === 'ok').length,
      repaired: repaired.length,
      warn: warned.length,
      blocked: blocked.length,
      repairable: repairable.length,
    },
    blockers: blocked.map((item) => item.id),
    warnings: warned.map((item) => item.id),
    repaired: repaired.map((item) => item.id),
  };
}

function listLatestReport(outDir) {
  try {
    const files = readdirSync(outDir)
      .filter((name) => /^boot-self-check-\d+\.json$/.test(name))
      .map((name) => {
        const file = join(outDir, name);
        return { file, mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.file || '';
  } catch {
    return '';
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function probeWritable(file, content) {
  try {
    writeFileSync(file, content, { mode: 0o600 });
    const ok = readFileSync(file, 'utf8') === content;
    unlinkSync(file);
    return { ok, reason: '' };
  } catch (error) {
    try { unlinkSync(file); } catch { /* ignore missing/partial probe */ }
    return { ok: false, reason: clean(error?.message || error) };
  }
}

function writeReport(rootDir, outDir, report, now = Date.now) {
  ensureDir(outDir);
  const file = join(outDir, `boot-self-check-${now()}.json`);
  const latestFile = join(outDir, 'latest.json');
  report.reportPath = rel(rootDir, file);
  report.latestPath = rel(rootDir, latestFile);
  const payload = JSON.stringify(report, null, 2);
  writeFileSync(file, `${payload}\n`, { mode: 0o600 });
  writeFileSync(latestFile, `${payload}\n`, { mode: 0o600 });
  return { reportPath: report.reportPath, latestPath: report.latestPath };
}

async function healthCheck({ baseUrl = 'http://127.0.0.1:51835', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    return check('live_panel_health', 'Live panel health', 'warn', {
      baseUrl,
      reason: 'fetch_unavailable',
    });
  }
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok === true) {
      return check('live_panel_health', 'Live panel health', 'ok', {
        status: res.status,
        service: clean(body.service, 80),
        port: Number(body.port) || null,
      });
    }
    return check('live_panel_health', 'Live panel health', 'blocked', {
      status: res.status,
      reason: clean(body?.error || body?.status || 'health_not_ok'),
    }, [{ id: 'restart_51835_with_restart_panel', label: 'Restart panel via scripts/restart-panel.mjs', repairable: false }]);
  } catch (error) {
    return check('live_panel_health', 'Live panel health', 'blocked', {
      reason: clean(error?.message || error),
    }, [{ id: 'restart_51835_with_restart_panel', label: 'Restart panel via scripts/restart-panel.mjs', repairable: false }]);
  }
}

function panelRuntimePreflightCheck({
  root,
  port = 51835,
  observeOnlyPort = 51735,
  collectPanelRuntimePreflight = collectNoePanelRuntimePreflight,
  evaluatePanelRestartPreflight = evaluateNoePanelRestartPreflight,
} = {}) {
  try {
    const report = collectPanelRuntimePreflight({ root, port, observeOnlyPort });
    const decision = evaluatePanelRestartPreflight(report);
    const status = decision.ok
      ? decision.safeToRestart ? 'ok' : 'warn'
      : 'blocked';
    const detail = {
      status: report.status,
      decision: decision.decision,
      port,
      pid: decision.pid,
      cwd: decision.cwd,
      command: decision.command,
      safeToRestart: decision.safeToRestart,
      safeToStart: decision.safeToStart,
      blockers: decision.blockers,
      warnings: decision.warnings,
      observeOnlyPort: decision.observeOnlyPort,
      observeOnlyListenerCount: decision.observeOnlyListenerCount,
      secretValuesReturned: false,
      actionsPerformed: false,
    };
    const actions = decision.safeToStart || !decision.ok
      ? [{ id: 'inspect_panel_runtime_preflight', label: 'Inspect panel runtime preflight before touching 51835', repairable: false }]
      : [];
    return check('panel_runtime_preflight', 'Panel runtime preflight', status, detail, actions);
  } catch (error) {
    return check('panel_runtime_preflight', 'Panel runtime preflight', 'blocked', {
      reason: clean(error?.message || error),
      secretValuesReturned: false,
      actionsPerformed: false,
    }, [{ id: 'inspect_panel_runtime_preflight', label: 'Inspect panel runtime preflight before touching 51835', repairable: false }]);
  }
}

function policyFileGuardCheck({ root, env = process.env } = {}) {
  try {
    const fileWrite = evaluateNoePolicyFileWrite({
      path: 'src/permissions/PermissionGovernance.js',
      operation: 'boot_self_check.file_write_probe',
      root,
      cwd: root,
      env,
    });
    const shellMutation = evaluateNoePolicyShellMutation({
      command: 'sed',
      args: ['-i', 's/x/y/', '~/.noe/config.yaml'],
      root,
      cwd: root,
      env,
    });
    const readOnly = evaluateNoePolicyShellMutation({
      command: 'git',
      args: ['diff', 'src/permissions/PermissionGovernance.js'],
      root,
      cwd: root,
      env,
    });
    const ok = fileWrite.blocked === true && shellMutation.blocked === true && readOnly.blocked !== true;
    return check('policy_file_guard', 'Policy file guard', ok ? 'ok' : 'blocked', {
      fileWrite: compactNoePolicyFileGuardReport(fileWrite),
      shellMutation: compactNoePolicyFileGuardReport(shellMutation),
      readOnly: compactNoePolicyFileGuardReport(readOnly),
      writeDenied: fileWrite.blocked === true,
      shellDenied: shellMutation.blocked === true,
      readOnlyAllowed: readOnly.blocked !== true,
      secretValuesReturned: false,
      actionsPerformed: false,
    }, ok ? [] : [{ id: 'inspect_policy_file_guard', label: 'Inspect Noe policy file guard wiring', repairable: false }]);
  } catch (error) {
    return check('policy_file_guard', 'Policy file guard', 'blocked', {
      reason: clean(error?.message || error),
      secretValuesReturned: false,
      actionsPerformed: false,
    }, [{ id: 'inspect_policy_file_guard', label: 'Inspect Noe policy file guard wiring', repairable: false }]);
  }
}

function companionToolsPreflightCheck({
  env = process.env,
  collectCompanionToolPreflight = collectNoeCompanionToolPreflight,
} = {}) {
  try {
    const report = collectCompanionToolPreflight({ env });
    const status = report.status === 'ok' ? 'ok' : report.status === 'blocked' ? 'blocked' : 'warn';
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const repairPlan = report.repairPlan || {};
    const repairActions = Array.isArray(repairPlan.actions) ? repairPlan.actions : [];
    const actions = warnings.length
      ? [
          { id: 'inspect_companion_tool_preflight', label: '检查开爪/赫尔墨斯/Claw Panel 伴随工具漂移', repairable: false },
          ...repairActions.slice(0, 6).map((item) => ({
            id: item.id,
            label: item.title || item.id,
            repairable: item.repairable === true,
          })),
        ]
      : [];
    return check('companion_tools_preflight', 'Companion tools preflight', status, {
      status: report.status,
      tools: report.tools,
      warnings,
      blockers: report.blockers || [],
      repairPlan,
      policy: {
        readOnly: report.policy?.readOnly === true,
        configFilesRead: report.policy?.configFilesRead === true,
        secretValuesReturned: report.policy?.secretValuesReturned === true,
        actionsPerformed: report.policy?.actionsPerformed === true,
      },
    }, actions);
  } catch (error) {
    return check('companion_tools_preflight', 'Companion tools preflight', 'warn', {
      reason: clean(error?.message || error),
      policy: {
        readOnly: true,
        configFilesRead: false,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    }, [{ id: 'inspect_companion_tool_preflight', label: 'Inspect OpenClaw/Hermes/Claw Panel companion tool drift', repairable: false }]);
  }
}

export async function runNoeBootSelfCheck({
  rootDir = DEFAULT_ROOT,
  baseUrl = 'http://127.0.0.1:51835',
  repair = false,
  writeReport: shouldWriteReport = true,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requiredFiles = REQUIRED_FILES,
  collectPanelRuntimePreflight = collectNoePanelRuntimePreflight,
  evaluatePanelRestartPreflight = evaluateNoePanelRestartPreflight,
  collectCompanionToolPreflight = collectNoeCompanionToolPreflight,
} = {}) {
  const root = resolve(rootDir);
  const outDir = join(root, 'output', 'noe-boot-self-check');
  const at = iso(now);
  const checks = [];
  const repairJournal = [];

  const missingFiles = requiredFiles.filter((file) => !existsSync(join(root, file)));
  checks.push(check('project_files', 'Project files', missingFiles.length ? 'blocked' : 'ok', {
    required: requiredFiles,
    missing: missingFiles,
  }));

  const dirExisted = existsSync(outDir);
  const dirActions = [];
  if (!dirExisted) {
    dirActions.push({ id: 'create_output_noe_boot_self_check', label: 'Create output/noe-boot-self-check', repairable: true });
    if (repair) {
      let created = false;
      let reason = '';
      try {
        ensureDir(outDir);
        created = existsSync(outDir);
      } catch (error) {
        reason = clean(error?.message || error);
      }
      repairJournal.push(repairRecord({
        id: 'create_output_noe_boot_self_check',
        title: '创建开机自检证据目录',
        status: created ? 'repaired' : 'failed',
        operation: 'mkdir',
        path: rel(root, outDir),
        reason,
        verification: ['目录存在', '后续写入探针通过'],
      }));
    }
  }
  let evidenceStatus = dirExisted ? 'ok' : repair ? 'repaired' : 'blocked';
  let probe = { ok: false, reason: '' };
  let permissionRepair = { attempted: false, repaired: false, reason: '' };
  if (existsSync(outDir)) {
    const probeFile = join(outDir, `.probe-${now()}-${process.pid}.txt`);
    probe = probeWritable(probeFile, at);
    if (!probe.ok && repair) {
      permissionRepair = { attempted: true, repaired: false, reason: '' };
      try {
        chmodSync(outDir, 0o700);
        const repairedProbeFile = join(outDir, `.probe-repair-${now()}-${process.pid}.txt`);
        probe = probeWritable(repairedProbeFile, at);
        permissionRepair.repaired = probe.ok;
        permissionRepair.reason = probe.ok ? '' : probe.reason;
      } catch (error) {
        permissionRepair.reason = clean(error?.message || error);
      }
      repairJournal.push(repairRecord({
        id: 'repair_output_noe_boot_self_check_permission',
        title: '修复开机自检证据目录权限',
        status: permissionRepair.repaired ? 'repaired' : 'failed',
        operation: 'chmod 700',
        path: rel(root, outDir),
        reason: permissionRepair.reason,
        verification: ['目录权限可写', '写入探针通过'],
      }));
    }
    if (!probe.ok) evidenceStatus = 'blocked';
    else if (permissionRepair.repaired) evidenceStatus = 'repaired';
  }
  checks.push(check('evidence_output_dir', 'Evidence output directory', evidenceStatus, {
    path: rel(root, outDir),
    existed: dirExisted,
    probe,
    permissionRepair,
  }, dirActions));

  const latest = listLatestReport(outDir);
  const willWriteReport = repair === true || shouldWriteReport === true;
  checks.push(check('latest_boot_report', 'Latest boot report', latest ? 'ok' : willWriteReport ? 'repaired' : 'warn', {
    path: latest ? rel(root, latest) : '',
    present: Boolean(latest),
  }, latest ? [] : [{ id: 'write_boot_self_check_report', label: 'Write latest boot self-check report', repairable: true }]));

  checks.push(await healthCheck({ baseUrl, fetchImpl }));
  checks.push(panelRuntimePreflightCheck({
    root,
    port: portFromBaseUrl(baseUrl),
    collectPanelRuntimePreflight,
    evaluatePanelRestartPreflight,
  }));
  checks.push(companionToolsPreflightCheck({
    collectCompanionToolPreflight,
  }));
  checks.push(policyFileGuardCheck({ root }));

  const report = {
    ok: false,
    version: VERSION,
    source: {
      adaptedFrom: 'BaiLongma L2 startup self-check',
      differences: ['deterministic Node checks', 'no model self-attestation', 'safe repairs only', 'no secret values'],
    },
    repairRequested: repair === true,
    at,
    rootDir: root,
    checks,
    summary: null,
    selfRepair: null,
    reportPath: '',
    latestPath: '',
  };
  report.summary = summarize(checks);
  report.ok = report.summary.ok;
  const reportWriteTimestamp = willWriteReport ? now() : null;
  if (repair === true && willWriteReport) {
    repairJournal.push(repairRecord({
      id: 'write_boot_self_check_report',
      title: '写入开机自检报告',
      status: 'repaired',
      operation: 'write_report',
      path: rel(root, join(outDir, `boot-self-check-${reportWriteTimestamp}.json`)),
      verification: ['报告文件写入', 'latest.json 同步更新'],
    }));
  }
  report.selfRepair = buildSelfRepairReport({ requested: repair === true, actions: repairJournal, checks });

  if (willWriteReport) {
    const written = writeReport(root, outDir, report, () => reportWriteTimestamp);
    report.reportPath = written.reportPath;
    report.latestPath = written.latestPath;
  } else {
    const latestJson = readJson(join(outDir, 'latest.json'));
    report.reportPath = latestJson?.reportPath || (latest ? rel(root, latest) : '');
    report.latestPath = existsSync(join(outDir, 'latest.json')) ? rel(root, join(outDir, 'latest.json')) : '';
  }
  return report;
}

export function compactBootSelfCheck(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  return {
    ok: report.ok === true,
    version: report.version || VERSION,
    status: report.summary?.status || 'unknown',
    counts: report.summary?.counts || { total: checks.length },
    blockers: report.summary?.blockers || [],
    warnings: report.summary?.warnings || [],
    repaired: report.summary?.repaired || [],
    checks: checks.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      repairable: item.repairable === true,
      detail: cleanDetail(item.detail || {}),
      actions: Array.isArray(item.actions) ? item.actions.map((action) => ({
        id: action.id,
        label: action.label,
        repairable: action.repairable === true,
      })) : [],
    })),
    reportPath: report.reportPath || '',
    latestPath: report.latestPath || '',
    at: report.at || '',
    source: report.source || {},
    repair: cleanDetail(report.selfRepair || {}, 0),
  };
}
