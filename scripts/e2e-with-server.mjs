#!/usr/bin/env node
// e2e-with-server.mjs（计划阶段 B1）
// 一条命令封装 e2e：随机空闲端口 + 隔离 HOME 起 server → 轮询就绪 → 跑 walkthrough
// → finally 必杀 server + 确认端口无监听 → 透传退出码。
//
// 解决「每次手动起服务 + kill + 查端口、易残留监听」的摩擦。
//   - 默认隔离 HOME（mkdtemp），server DATA_DIR 与 e2e owner-token 都走 os.homedir()，
//     设 HOME 后二者一致，且不污染真实 ~/.noe-panel。
//   - E2E_REAL_HOME=1 可改用真实 HOME（需要复用真实数据时）。
//   - NOE_E2E_PORT / E2E_PORT 可显式指定，否则取系统分配的空闲端口。
//   - 不再信任继承来的 PORT：集群监督面板通过 launchd 注入 PORT=51735，
//     若 e2e 误用该端口，finally 的端口清理会杀掉监督面板，导致 CE05 无限重启。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { resolveNode22OrFail } from './ensure-node22.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED_PANEL_PORTS = new Set([51735, 51835]);

function parsePort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${source} must be a valid TCP port, got ${value}`);
  }
  return port;
}

async function resolveE2ePort() {
  const explicit = process.env.NOE_E2E_PORT || process.env.E2E_PORT;
  if (explicit) {
    const source = process.env.NOE_E2E_PORT ? 'NOE_E2E_PORT' : 'E2E_PORT';
    const port = parsePort(explicit, source);
    if (RESERVED_PANEL_PORTS.has(port) && process.env.NOE_E2E_ALLOW_RESERVED_PORT !== '1') {
      throw new Error(`${source}=${port} is reserved for local panels; set NOE_E2E_ALLOW_RESERVED_PORT=1 only when you intentionally own that port.`);
    }
    return port;
  }
  if (process.env.PORT) {
    console.warn(`⚠️ 忽略继承的 PORT=${process.env.PORT}；managed e2e 默认使用随机空闲端口。若要指定端口，请使用 NOE_E2E_PORT 或 E2E_PORT。`);
  }
  return findFreePort();
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function portListening(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitFileExists(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    spawnSync('sleep', ['0.1'], { stdio: 'ignore' }); // Wait 100ms
  }
  return false;
}

// 隔离 HOME 后 Playwright 会在隔离目录找不到浏览器缓存（默认存真实 HOME）。
// 给 e2e 子进程指回真实缓存目录，server 仍用隔离 HOME 做数据隔离。
function playwrightCachePath(home) {
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

const LEGACY_E2E_TARGETS = new Set([
  'tests/e2e/panel-ui-walkthrough.mjs',
]);

// 选哪个 e2e 文件跑：默认仍是 CE12 P0 证据测试（向后兼容）。
// 可用 NOE_E2E_TARGET 或第一个 CLI 参数切换。默认只允许 tests/e2e 下的 *.e2e.mjs；
// 历史主 walkthrough 不是 .e2e.mjs，按显式 allowlist 纳入 managed wrapper，继续防路径逃逸。
function resolveE2eTarget() {
  const requested = process.env.NOE_E2E_TARGET || process.argv[2] || 'tests/e2e/noe-brain-ui-p0.e2e.mjs';
  const rel = String(requested).replace(/^\.\//, '');
  const safeE2eTarget = /^tests\/e2e\/[\w.-]+\.e2e\.mjs$/.test(rel) || LEGACY_E2E_TARGETS.has(rel);
  if (!safeE2eTarget) {
    throw new Error(`非法 e2e 目标：${requested}（必须形如 tests/e2e/<name>.e2e.mjs，或在 LEGACY_E2E_TARGETS 白名单内）`);
  }
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`e2e 目标不存在：${rel}`);
  return rel;
}

async function main() {
  const e2eTarget = resolveE2eTarget(); // fail-fast：非法/不存在目标在分配端口、mkdtemp、起 server 之前就报错
  const useRealHome = process.env.E2E_REAL_HOME === '1';
  const realHome = process.env.HOME || homedir();
  const isolatedHome = useRealHome ? null : mkdtempSync(join(tmpdir(), 'noe-e2e-'));
  const port = await resolveE2ePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let node22 = '';
  try {
    node22 = resolveNode22OrFail({ root: ROOT });
  } catch (e) {
    console.error(`❌ Noe e2e requires Node 22.x runtime for reproducible CE12 evidence.`);
    console.error(`   current=${process.version}; ${e?.message || e}`);
    process.exit(1);
  }

  const childEnv = { ...process.env, PORT: String(port) };
  if (isolatedHome) childEnv.HOME = isolatedHome;

  let server = null;
  let exitCode = 1;
  try {
    let serverLog = '';
    server = spawn(node22, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });
    server.on('exit', (code) => {
      if (code && code !== 0) console.error(`⚠️ server 进程提前退出 code=${code}`);
    });

    const ready = await waitReady(`${baseUrl}/`, 30000);
    if (!ready) {
      console.error('❌ server 30s 内未就绪，日志尾部：\n' + serverLog.slice(-2000));
      throw new Error('server not ready');
    }
    console.log(`🚀 e2e server @ ${baseUrl}${isolatedHome ? `  (隔离 HOME=${isolatedHome})` : '  (真实 HOME)'}  node=${node22}`);

    const e2eEnv = { ...childEnv, PANEL_URL: baseUrl };
    if (isolatedHome && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
      e2eEnv.PLAYWRIGHT_BROWSERS_PATH = playwrightCachePath(realHome);
    }

    // Read the owner token from the isolated HOME directory
    const ownerTokenPath = join(e2eEnv.HOME || realHome, '.noe-panel', 'owner-token.txt');
    if (!waitFileExists(ownerTokenPath, 15000)) { // Wait up to 15 seconds for the token file
      console.error(`❌ Timeout waiting for owner-token.txt at ${ownerTokenPath.replace(realHome, '~')}`);
      throw new Error('owner-token.txt not created in time');
    }
    if (existsSync(ownerTokenPath)) {
      e2eEnv.OWNER_TOKEN = readFileSync(ownerTokenPath, 'utf8').trim();
      console.log(`✅ Loaded owner token from ${ownerTokenPath.replace(realHome, '~')}`);
    } else {
      console.warn(`⚠️ owner-token.txt not found at ${ownerTokenPath.replace(realHome, '~')}`);
    }
    console.log(`🎯 e2e target: ${e2eTarget}`);
    const e2e = spawnSync(node22, [e2eTarget], {
      cwd: ROOT,
      env: e2eEnv,
      stdio: 'inherit',
    });
    exitCode = e2e.status ?? 1;
  } finally {
    if (server && server.pid) {
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* 已退出 */ }
      await sleep(800);
      try { process.kill(server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
    // 兜底：杀掉仍占用该端口的任何进程。保留端口永不兜底 kill，避免误杀监督面板/真实 Noe 面板。
    if (RESERVED_PANEL_PORTS.has(port)) {
      console.warn(`⚠️ 跳过保留端口 ${port} 的 lsof/xargs kill 兜底清理。`);
    } else {
      spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`]);
    }
    await sleep(300);
    if (portListening(port)) {
      console.error(`⚠️ 端口 ${port} 仍在监听，清理失败`);
      exitCode = exitCode || 1;
    } else {
      console.log(`✅ 端口 ${port} 已清理，无残留监听`);
    }
    if (isolatedHome) {
      try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('e2e-with-server 失败：', e?.message || e);
  process.exit(1);
});
