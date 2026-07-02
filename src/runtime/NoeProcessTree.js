// @ts-check
// Graceful process-tree termination for local CLI/plugin subprocesses.

import { spawnSync } from 'node:child_process';

function asPid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
function parsePsRows(stdout = '') {
  return String(stdout || '').split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid > 0)
    .map(([pid, ppid]) => ({ pid, ppid }));
}

export function collectNoeProcessTreePids(rootPid, {
  spawnSyncImpl = spawnSync,
  platform = process.platform,
} = {}) {
  const root = asPid(rootPid);
  if (!root) return [];
  if (platform === 'win32') return [root];
  let rows = [];
  try {
    const out = spawnSyncImpl('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    rows = parsePsRows(out?.stdout || '');
  } catch {
    return [root];
  }
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) || [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const ordered = [];
  const seen = new Set();
  function visit(pid) {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of children.get(pid) || []) visit(child);
    ordered.push(pid);
  }
  visit(root);
  return ordered;
}

export async function terminateNoeProcessTree(rootPid, {
  graceMs = 1000,
  spawnSyncImpl = spawnSync,
  killImpl = process.kill,
  setTimeoutImpl = setTimeout,
  platform = process.platform,
} = {}) {
  const pids = collectNoeProcessTreePids(rootPid, { spawnSyncImpl, platform });
  const signals = [];
  const send = (signal) => {
    for (const pid of pids) {
      try {
        killImpl(pid, signal);
        signals.push({ pid, signal, ok: true });
      } catch (error) {
        signals.push({ pid, signal, ok: false, error: String(error?.code || error?.message || error).slice(0, 120) });
      }
    }
  };
  if (!pids.length) return { ok: false, reason: 'invalid_pid', pids, signals };
  send('SIGTERM');
  const waitMs = Math.max(0, Number(graceMs) || 0);
  if (waitMs > 0) await new Promise((resolve) => setTimeoutImpl(resolve, waitMs));
  send('SIGKILL');
  return { ok: true, reason: 'terminated', pids, signals };
}
