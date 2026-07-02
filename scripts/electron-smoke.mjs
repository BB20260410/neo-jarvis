#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { resolveNode22OrFail } from './ensure-node22.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'output', 'electron-smoke');
const LOG_FILE = join(OUTPUT_DIR, `electron-smoke-${Date.now()}.jsonl`);
const STDOUT_FILE = join(OUTPUT_DIR, `electron-smoke-${Date.now()}.log`);

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function findPackagedApp() {
  const outDir = join(ROOT, 'out-noe');
  if (!existsSync(outDir)) return '';
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory() && name.name === 'Noe.app') return full;
      if (name.isDirectory()) stack.push(full);
    }
  }
  return '';
}

function parseJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { event: 'parse_error', line }; }
    });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500).unref?.();
      resolveExit({ status: 124, signal: 'timeout' });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ status: typeof code === 'number' ? code : 0, signal });
    });
  });
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  let node22;
  try {
    node22 = resolveNode22OrFail({ root: ROOT });
  } catch (e) {
    console.error(`[electron-smoke] Node22 unavailable: ${e?.message || e}`);
    process.exit(1);
  }
  console.log(`[electron-smoke] node22=${node22}`);

  const packageResult = run(node22, ['scripts/package-electron.mjs', '--mac', '--dir']);
  writeFileSync(STDOUT_FILE, [
    '[package stdout]',
    packageResult.stdout,
    '[package stderr]',
    packageResult.stderr,
  ].join('\n'));
  if (packageResult.status !== 0) {
    console.error(`[electron-smoke] package failed status=${packageResult.status}; log=${STDOUT_FILE}`);
    process.exit(packageResult.status);
  }

  const appPath = findPackagedApp();
  if (!appPath) {
    console.error('[electron-smoke] packaged Noe.app not found under out-noe');
    process.exit(1);
  }
  const executable = join(appPath, 'Contents', 'MacOS', 'Noe');
  if (!existsSync(executable)) {
    console.error(`[electron-smoke] executable missing: ${executable}`);
    process.exit(1);
  }

  const port = await findFreePort();
  const smokeHome = join(tmpdir(), `noe-electron-smoke-${Date.now()}`);
  mkdirSync(smokeHome, { recursive: true });
  console.log(`[electron-smoke] app=${appPath}`);
  console.log(`[electron-smoke] port=${port}`);
  console.log(`[electron-smoke] log=${LOG_FILE}`);

  const child = spawn(executable, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: smokeHome,
      PORT: String(port),
      PANEL_HOST: '127.0.0.1',
      NOE_NODE_BIN: node22,
      NOE_ELECTRON_SMOKE: '1',
      NOE_ELECTRON_SMOKE_LOG: LOG_FILE,
      NOE_ELECTRON_SMOKE_QUIT_MS: '4500',
      PANEL_ELECTRON_START_TIMEOUT_MS: '12000',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d.toString(); });
  child.stderr.on('data', (d) => { childLog += d.toString(); });
  const exit = await waitForExit(child, 30_000);
  writeFileSync(STDOUT_FILE, readFileSync(STDOUT_FILE, 'utf8') + '\n[app stdout+stderr]\n' + childLog);
  rmSync(smokeHome, { recursive: true, force: true });

  const events = parseJsonl(LOG_FILE);
  const names = new Set(events.map((event) => event.event));
  const required = ['app_ready', 'menu_registered', 'server_ready', 'window_loaded'];
  const missing = required.filter((event) => !names.has(event));

  console.log(`[electron-smoke] exit=${exit.status} signal=${exit.signal || ''}`);
  console.log(`[electron-smoke] events=${events.map((event) => event.event).join(',')}`);
  console.log(`[electron-smoke] appPath=${appPath}`);
  console.log(`[electron-smoke] stdoutLog=${STDOUT_FILE}`);
  if (exit.status !== 0 || missing.length) {
    console.error(`[electron-smoke] failed missing=${missing.join(',') || '-'} log=${LOG_FILE}`);
    process.exit(exit.status || 1);
  }
  console.log('[electron-smoke] PASS');
}

main().catch((e) => {
  console.error(`[electron-smoke] ${e?.stack || e?.message || e}`);
  process.exit(1);
});
