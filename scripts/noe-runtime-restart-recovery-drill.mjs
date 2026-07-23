#!/usr/bin/env node
// @ts-check
// Controlled live 51835 restart drill. Real mode requires --apply.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOE_MAIN_BRAIN_MODEL } from '../src/model/NoeLocalModelPolicy.js';
import { listLoadedLmStudioModels } from '../src/room/LmStudioLoader.js';
import { resolveNode22OrFail } from './ensure-node22.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_RUNTIME_RESTART_DRILL_OUT_DIR
  ? resolve(process.env.NOE_RUNTIME_RESTART_DRILL_OUT_DIR)
  : join(ROOT, 'output', 'noe-runtime-restart-recovery-drill');
const NOW = Date.now();
const RUN_ID = new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const RUN_DIR = join(OUT_DIR, RUN_ID);
const LOG_PATH = join(RUN_DIR, 'server.log');
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FAKE = process.env.NOE_RUNTIME_RESTART_DRILL_FAKE === '1';
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 51835);

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function run(cmd, cmdArgs, opts = {}) {
  const out = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  return {
    status: out.status,
    signal: out.signal || null,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    error: out.error?.message || '',
  };
}

function listenerPids(port) {
  const out = run('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  return String(out.stdout || '').split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function pidCwd(pid) {
  const out = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.stdout.split('\n').find((item) => item.startsWith('n'));
  return line ? line.slice(1) : '';
}

function pidCommand(pid) {
  const out = run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,command=']);
  return out.stdout.trim();
}

function portSnapshot(port) {
  const pids = listenerPids(port);
  return {
    port,
    listeners: pids.map((pid) => ({
      pid: Number(pid),
      cwd: pidCwd(pid),
      command: pidCommand(pid),
    })),
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(predicate, timeoutMs = 45_000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function requestJson(path, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, { signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, bodyPrefix: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e), json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPortFree() {
  return waitFor(() => listenerPids(PORT).length === 0 ? true : null, 10_000, 250);
}

async function waitForHealth() {
  return waitFor(async () => {
    const health = await requestJson('/health');
    return health.ok && health.json?.ok === true ? health : null;
  }, 45_000, 500);
}

async function loadedSnapshot(label) {
  const fake = process.env.NOE_RUNTIME_RESTART_DRILL_FAKE_LOADED_MODELS;
  if (fake) {
    try {
      const parsed = JSON.parse(fake);
      return {
        label,
        ok: Array.isArray(parsed),
        source: 'env:NOE_RUNTIME_RESTART_DRILL_FAKE_LOADED_MODELS',
        loadedModels: Array.isArray(parsed) ? parsed.map(String) : null,
      };
    } catch (e) {
      return { label, ok: false, source: 'env:NOE_RUNTIME_RESTART_DRILL_FAKE_LOADED_MODELS', loadedModels: null, error: e?.message || String(e) };
    }
  }
  const baseUrl = (process.env.LM_STUDIO_BASE_URL || process.env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  const loadedModels = await listLoadedLmStudioModels(baseUrl, { timeoutMs: 3000 });
  return { label, ok: Array.isArray(loadedModels), source: 'lmstudio:/api/v0/models', baseUrl, loadedModels };
}

function sameModels(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function startPanel() {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LOG_PATH, '');
  const fd = openSync(LOG_PATH, 'a');
  const nodeBin = resolveNode22OrFail({ root: ROOT });
  const child = spawn(nodeBin, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PANEL_HOST: HOST },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  return { pid: child.pid, nodeBin };
}

async function terminatePort(snapshot) {
  const pids = snapshot.listeners.map((item) => item.pid).filter(Boolean);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const freeAfterTerm = await waitForPortFree();
  if (freeAfterTerm) return { terminatedPids: pids, forceKilledPids: [], freeAfterTerm: true };
  const remaining = listenerPids(PORT).map(Number).filter(Boolean);
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  const freeAfterKill = await waitForPortFree();
  return { terminatedPids: pids, forceKilledPids: remaining, freeAfterTerm: false, freeAfterKill: Boolean(freeAfterKill) };
}

async function runFreedomLive() {
  const out = run('npm', ['run', 'verify:noe:freedom-live'], { cwd: ROOT, timeout: 60_000 });
  let parsed = null;
  const start = out.stdout.indexOf('{');
  const end = out.stdout.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(out.stdout.slice(start, end + 1)); } catch {}
  }
  return {
    ok: out.status === 0 && parsed?.ok === true,
    status: out.status,
    signal: out.signal,
    parsed,
    stdoutSha256: sha256(out.stdout),
    stderrPrefix: out.stderr.slice(0, 1000),
    error: out.error,
  };
}

function fakeReport() {
  const before51835 = { port: 51835, listeners: [{ pid: 100, cwd: ROOT, command: '100 1 node server.js' }] };
  const after51835 = { port: 51835, listeners: [{ pid: 101, cwd: ROOT, command: '101 1 node server.js' }] };
  const before51735 = { port: 51735, listeners: [{ pid: 200, cwd: '/tmp/xike', command: '200 1 node server.js' }] };
  const after51735 = { ...before51735 };
  return {
    schemaVersion: 1,
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    mode: 'fake',
    applied: false,
    realRestartAttempted: false,
    host: HOST,
    port: PORT,
    before: { port51835: before51835, port51735: before51735, lmStudio: { loadedModels: [NOE_MAIN_BRAIN_MODEL], source: 'fake' } },
    restart: { terminatedPids: [100], forceKilledPids: [], startedPid: 101, nodeBin: '/fake/node22' },
    after: { port51835: after51835, port51735: after51735, lmStudio: { loadedModels: [NOE_MAIN_BRAIN_MODEL], source: 'fake' } },
    checks: {
      pidChanged: true,
      oldPidAbsent: true,
      newPidCwdIsRoot: true,
      port51735Untouched: true,
      lmStudioLoadedModelsUnchanged: true,
      healthOk: true,
      readinessPassed: true,
      freedomLiveOk: true,
    },
    health: { ok: true, status: 200, json: { ok: true } },
    readiness: { ok: true, status: 200, json: { readiness: { status: 'passed' } } },
    freedomLive: { ok: true, parsed: { ok: true, checked: 4, failed: 0 } },
    source: { policy: 'fake unit-test mode; no process control' },
  };
}

mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

let report;
if (FAKE) {
  report = fakeReport();
} else {
  const before51835 = portSnapshot(51835);
  const before51735 = portSnapshot(51735);
  const beforeLm = await loadedSnapshot('before');
  const preHealth = await requestJson('/health');
  const preReadiness = await requestJson('/api/noe/readiness');
  let restart = { terminatedPids: [], forceKilledPids: [], startedPid: null, nodeBin: '', skipped: true };
  let health = preHealth;
  let readiness = preReadiness;
  let freedomLive = { ok: false, skipped: true };
  if (APPLY) {
    const termination = await terminatePort(before51835);
    const started = startPanel();
    await waitForHealth();
    const afterStart = portSnapshot(51835);
    health = await requestJson('/health');
    readiness = await requestJson('/api/noe/readiness');
    freedomLive = await runFreedomLive();
    restart = { ...termination, startedPid: started.pid, nodeBin: started.nodeBin, afterStart };
  }
  const after51835 = portSnapshot(51835);
  const after51735 = portSnapshot(51735);
  const afterLm = await loadedSnapshot('after');
  const beforePidSet = new Set(before51835.listeners.map((item) => item.pid));
  const afterPidSet = new Set(after51835.listeners.map((item) => item.pid));
  const pidChanged = before51835.listeners.length > 0
    && after51835.listeners.length > 0
    && [...beforePidSet].some((pid) => !afterPidSet.has(pid));
  const oldPidAbsent = [...beforePidSet].every((pid) => !afterPidSet.has(pid));
  const port51735Untouched = JSON.stringify(before51735.listeners) === JSON.stringify(after51735.listeners);
  const lmStudioLoadedModelsUnchanged = sameModels(beforeLm.loadedModels, afterLm.loadedModels);
  const newPidCwdIsRoot = after51835.listeners.some((item) => item.cwd === ROOT);
  const healthOk = health.ok === true && health.json?.ok === true;
  const readinessPassed = readiness.ok === true
    && (readiness.json?.readiness?.status === 'passed' || readiness.json?.health?.status === 'passed');
  const checks = {
    pidChanged,
    oldPidAbsent,
    newPidCwdIsRoot,
    port51735Untouched,
    lmStudioLoadedModelsUnchanged,
    healthOk,
    readinessPassed,
    freedomLiveOk: freedomLive.ok === true,
  };
  report = {
    schemaVersion: 1,
    ok: Boolean(APPLY && Object.values(checks).every(Boolean)),
    generatedAt: new Date(NOW).toISOString(),
    mode: 'real',
    applied: APPLY,
    realRestartAttempted: APPLY,
    host: HOST,
    port: PORT,
    before: { port51835: before51835, port51735: before51735, lmStudio: beforeLm, health: preHealth, readiness: preReadiness },
    restart,
    after: { port51835: after51835, port51735: after51735, lmStudio: afterLm },
    checks,
    health,
    readiness,
    freedomLive,
    logPath: rel(LOG_PATH),
    source: {
      policy: APPLY
        ? 'real 51835 SIGTERM + direct node22 restart; 51735 observed only; LM Studio read-only'
        : 'dry run; no process control; rerun with --apply for live restart evidence',
    },
  };
}

const reportPath = join(RUN_DIR, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath: rel(reportPath) }, null, 2));
if (!report.ok) process.exitCode = 1;
