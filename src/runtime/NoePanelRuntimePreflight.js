// @ts-check
// NoePanelRuntimePreflight — Claw Panel/OpenClaw-style safe restart preflight for Noe.
//
// Adapted from OpenClaw gateway.restart.preflight/log control-surface ideas (MIT):
// collect listener PID/cwd/command evidence first, then decide whether a panel restart
// would target the intended local Noe process. This module is read-only and never
// reads owner tokens or secret-bearing config files.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const NOE_PANEL_PREFLIGHT_SCHEMA_VERSION = 1;

function clean(value = '', max = 4000) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, max);
}

function defaultCommandRunner(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(commandRunner, cmd, args, opts = {}) {
  try {
    return { ok: true, status: 0, stdout: String(commandRunner(cmd, args, opts) || ''), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      status: Number.isFinite(error?.status) ? Number(error.status) : null,
      stdout: String(error?.stdout || ''),
      stderr: clean(error?.stderr || '', 600),
      error: clean(error?.message || error, 600),
    };
  }
}

function isLsofNoMatch(result = {}) {
  return result.ok === false
    && result.status === 1
    && clean(result.stdout, 20) === ''
    && clean(result.stderr, 20) === '';
}

export function parseLsofListenOutput(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((line) => line.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      command: parts[0] || '',
      pid,
      user: parts[2] || '',
      name: parts.slice(8).join(' '),
      raw: clean(line, 1000),
    });
  }
  return rows;
}

export function parsePsOutput(text = '') {
  const line = String(text || '').replace(/\r/g, '').split('\n').map((item) => item.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(/\s+/);
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  if (!Number.isFinite(pid)) return null;
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : null,
    etime: parts[2] || '',
    command: clean(parts.slice(3).join(' '), 2000),
  };
}

export function parseLsofCwdOutput(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const pathLine = lines.find((line) => line.startsWith('n/'));
  return pathLine ? clean(pathLine.slice(1), 2000) : '';
}

function uniqueByPid(rows = []) {
  const byPid = new Map();
  for (const row of rows) {
    if (!byPid.has(row.pid)) byPid.set(row.pid, row);
  }
  return [...byPid.values()];
}

function inspectProcess({ pid, root, commandRunner }) {
  const ps = run(commandRunner, 'ps', ['-p', String(pid), '-o', 'pid=,ppid=,etime=,command='], { cwd: root });
  const cwd = run(commandRunner, 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: root });
  return {
    pid,
    ps: ps.ok ? parsePsOutput(ps.stdout) : null,
    cwd: cwd.ok ? parseLsofCwdOutput(cwd.stdout) : '',
    errors: [
      ...(ps.ok ? [] : [`ps_unavailable:${ps.error}`]),
      ...(cwd.ok ? [] : [`cwd_unavailable:${cwd.error}`]),
    ],
  };
}

export function collectNoePanelRuntimePreflight({
  root = process.cwd(),
  port = 51835,
  observeOnlyPort = 51735,
  commandRunner = defaultCommandRunner,
  now = new Date(),
} = {}) {
  const repoRoot = resolve(root);
  const listenerRun = run(commandRunner, 'lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN'], { cwd: repoRoot });
  const panelNoMatch = isLsofNoMatch(listenerRun);
  const listenerProbeFailed = !listenerRun.ok && !panelNoMatch;
  const listenerRows = listenerRun.ok ? uniqueByPid(parseLsofListenOutput(listenerRun.stdout)) : [];
  const listeners = listenerRows.map((row) => ({
    ...row,
    process: inspectProcess({ pid: row.pid, root: repoRoot, commandRunner }),
  }));
  const observeRun = run(commandRunner, 'lsof', ['-nP', `-iTCP:${Number(observeOnlyPort)}`, '-sTCP:LISTEN'], { cwd: repoRoot });
  const observeNoMatch = isLsofNoMatch(observeRun);
  const observeProbeFailed = !observeRun.ok && !observeNoMatch;
  const observeRows = observeRun.ok ? uniqueByPid(parseLsofListenOutput(observeRun.stdout)) : [];

  const ownedListeners = listeners.filter((item) => resolve(item.process.cwd || '') === repoRoot);
  const foreignListeners = listeners.filter((item) => item.process.cwd && resolve(item.process.cwd) !== repoRoot);
  const unknownCwdListeners = listeners.filter((item) => !item.process.cwd);
  const multiListener = listeners.length > 1;
  const noListener = listeners.length === 0 && !listenerProbeFailed;
  const owned = listeners.length === 1 && ownedListeners.length === 1;
  const safeToRestart = owned && !multiListener;
  const safeToStart = noListener;

  const blockers = [
    ...(listenerProbeFailed ? ['panel_listener_probe_failed'] : []),
    ...(multiListener ? ['multiple_panel_listeners'] : []),
    ...(foreignListeners.length ? ['panel_listener_cwd_mismatch'] : []),
    ...(unknownCwdListeners.length && !noListener ? ['panel_listener_cwd_unknown'] : []),
  ];
  const warnings = [
    ...(noListener ? ['panel_port_not_listening'] : []),
    ...(observeProbeFailed ? [`observe_only_port_${observeOnlyPort}_probe_failed`] : []),
    ...(observeRows.length ? [`observe_only_port_${observeOnlyPort}_has_listener`] : []),
  ];

  return {
    schemaVersion: NOE_PANEL_PREFLIGHT_SCHEMA_VERSION,
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked' : noListener ? 'not_running' : 'owned',
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    root: repoRoot,
    panel: {
      port: Number(port),
      listeners,
      owned,
      safeToStart,
      safeToRestart,
      restartRequiresOwnerIntent: true,
      actionsPerformed: false,
    },
    observeOnly: {
      port: Number(observeOnlyPort),
      touchPolicy: 'observe_only',
      listenerCount: observeRows.length,
      listeners: observeRows.map((row) => ({ pid: row.pid, command: row.command, name: row.name, raw: row.raw })),
    },
    blockers,
    warnings,
    policy: {
      secretValuesReturned: false,
      readsOwnerToken: false,
      touchesObserveOnlyPort: false,
      restartsProcess: false,
      writesRepo: false,
    },
    diagnostics: {
      lsofPanelOk: listenerRun.ok,
      lsofPanelError: listenerRun.ok ? '' : listenerRun.error,
      lsofObserveOnlyOk: observeRun.ok,
      lsofObserveOnlyError: observeRun.ok ? '' : observeRun.error,
    },
  };
}

export function compactPanelRuntimePreflight(report = {}) {
  const listener = Array.isArray(report.panel?.listeners) ? report.panel.listeners[0] : null;
  return {
    ok: report.ok === true,
    status: report.status || 'unknown',
    port: report.panel?.port || 51835,
    pid: listener?.pid || null,
    cwd: listener?.process?.cwd || '',
    command: listener?.process?.ps?.command || listener?.command || '',
    safeToStart: report.panel?.safeToStart === true,
    safeToRestart: report.panel?.safeToRestart === true,
    blockers: report.blockers || [],
    warnings: report.warnings || [],
    observeOnlyPort: report.observeOnly?.port || 51735,
    observeOnlyListenerCount: report.observeOnly?.listenerCount || 0,
    secretValuesReturned: false,
    actionsPerformed: false,
  };
}

export function evaluateNoePanelRestartPreflight(report = {}) {
  const compact = compactPanelRuntimePreflight(report);
  const allowed = compact.safeToRestart || compact.safeToStart;
  const blockers = [
    ...(Array.isArray(compact.blockers) ? compact.blockers : []),
    ...(!allowed ? ['panel_preflight_not_safe_to_restart_or_start'] : []),
  ];
  return {
    ok: allowed,
    decision: allowed
      ? compact.safeToRestart ? 'restart_owned_panel' : 'start_missing_panel'
      : 'blocked',
    safeToRestart: compact.safeToRestart,
    safeToStart: compact.safeToStart,
    pid: compact.pid,
    cwd: compact.cwd,
    command: compact.command,
    blockers: [...new Set(blockers)],
    warnings: Array.isArray(compact.warnings) ? compact.warnings : [],
    observeOnlyPort: compact.observeOnlyPort,
    observeOnlyListenerCount: compact.observeOnlyListenerCount,
    policy: {
      requiresOwnerIntent: true,
      secretValuesReturned: false,
      readsOwnerToken: false,
      touchesObserveOnlyPort: false,
      actionsPerformed: false,
    },
  };
}
