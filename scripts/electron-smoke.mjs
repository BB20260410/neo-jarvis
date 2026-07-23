#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { resolveNode22OrFail } from './ensure-node22.mjs';
import { computeSourceDigest } from '../src/runtime/NoeSourceDigest.js';
import { sha256DirectoryTree } from '../src/runtime/NoePackagingContract.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_NAME = PACKAGE_JSON.productName || PACKAGE_JSON.build?.productName || 'Neo 贾维斯';
const APP_BUNDLE_NAMES = [...new Set([`${PRODUCT_NAME}.app`, 'Neo 贾维斯.app', 'Noe.app'])];
const RUN_ID = Date.now();
const OUTPUT_DIR = process.env.NOE_ELECTRON_SMOKE_OUTPUT_DIR
  ? resolve(process.env.NOE_ELECTRON_SMOKE_OUTPUT_DIR)
  : join(ROOT, 'output', 'electron-smoke');
const LOG_FILE = join(OUTPUT_DIR, `electron-smoke-${RUN_ID}.jsonl`);
const STDOUT_FILE = join(OUTPUT_DIR, `electron-smoke-${RUN_ID}.log`);
const SUMMARY_FILE = join(OUTPUT_DIR, `electron-smoke-${RUN_ID}.summary.json`);

/** @returns {Promise<number>} */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close(() => reject(new Error('unable_to_resolve_smoke_port')));
        return;
      }
      srv.close(() => resolvePort(address.port));
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
  const arch = process.env.NOE_PACK_ARCH || process.arch;
  for (const appName of APP_BUNDLE_NAMES) {
    const exact = join(outDir, `mac-${arch}`, appName);
    if (existsSync(exact)) return exact;
  }
  const candidates = [];
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory() && APP_BUNDLE_NAMES.includes(name.name)) {
        candidates.push(full);
      } else if (name.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return candidates.sort((left, right) => {
    const leftRank = APP_BUNDLE_NAMES.indexOf(basename(left));
    const rightRank = APP_BUNDLE_NAMES.indexOf(basename(right));
    return leftRank - rightRank || left.localeCompare(right);
  })[0] || '';
}

function findPackagedExecutable(appPath) {
  const macosDir = join(appPath, 'Contents', 'MacOS');
  const preferred = [...new Set([PRODUCT_NAME, 'Neo 贾维斯', 'Noe'])];
  for (const name of preferred) {
    const candidate = join(macosDir, name);
    if (existsSync(candidate)) return candidate;
  }
  if (!existsSync(macosDir)) return '';
  const fallback = readdirSync(macosDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()[0];
  return fallback ? join(macosDir, fallback) : '';
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
      resolveExit({ status: typeof code === 'number' ? code : 128, signal });
    });
  });
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  let node22;
  try {
    node22 = resolveNode22OrFail({ root: ROOT });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[electron-smoke] Node22 unavailable: ${message}`);
    process.exit(1);
  }
  console.log(`[electron-smoke] node22=${node22}`);

  const useExisting = process.env.NOE_ELECTRON_SMOKE_USE_EXISTING === '1';
  if (useExisting) {
    writeFileSync(STDOUT_FILE, '[package skipped: NOE_ELECTRON_SMOKE_USE_EXISTING=1]\n');
  } else {
    const packageResult = run(node22, ['scripts/release-build.mjs']);
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
  }

  const appPath = findPackagedApp();
  if (!appPath) {
    console.error(`[electron-smoke] packaged ${PRODUCT_NAME}.app not found under out-noe`);
    process.exit(1);
  }
  const executable = findPackagedExecutable(appPath);
  if (!executable || !existsSync(executable)) {
    console.error(`[electron-smoke] executable missing: ${executable}`);
    process.exit(1);
  }
  const currentDigest = await computeSourceDigest({ rootDir: ROOT });
  const expectedDigest = process.env.NOE_SOURCE_DIGEST || currentDigest.sourceDigest;
  if (expectedDigest !== currentDigest.sourceDigest) {
    throw new Error(
      `source_digest_changed_before_smoke:expected=${expectedDigest}:actual=${currentDigest.sourceDigest}`,
    );
  }
  const embeddedPackagePath = join(appPath, 'Contents', 'Resources', 'app', 'package.json');
  const embeddedPackage = JSON.parse(readFileSync(embeddedPackagePath, 'utf8'));
  if (embeddedPackage.noeSourceDigest !== expectedDigest) {
    throw new Error(
      `packaged_source_digest_mismatch:expected=${expectedDigest}:actual=${embeddedPackage.noeSourceDigest || 'missing'}`,
    );
  }
  const buildReceiptPath = join(ROOT, 'out-noe', 'build-receipt.json');
  const buildReceipt = JSON.parse(readFileSync(buildReceiptPath, 'utf8'));
  const appTreeSha256 = sha256DirectoryTree(appPath);
  if (
    !buildReceipt.buildId ||
    embeddedPackage.noeBuildId !== buildReceipt.buildId ||
    buildReceipt.sourceDigest !== expectedDigest ||
    buildReceipt.macApp?.relativePath !== relative(ROOT, appPath) ||
    buildReceipt.macApp?.directoryTreeSha256 !== appTreeSha256
  ) {
    throw new Error('packaged_app_does_not_match_build_receipt');
  }

  const port = await findFreePort();
  const smokeHome = join(tmpdir(), `noe-electron-smoke-${Date.now()}`);
  mkdirSync(smokeHome, { recursive: true });
  console.log(`[electron-smoke] app=${appPath}`);
  console.log(`[electron-smoke] port=${port}`);
  console.log(`[electron-smoke] log=${LOG_FILE}`);

  const childEnv = { ...process.env };
  delete childEnv.NOE_PACKAGED_EXTERNAL_NODE;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], {
    cwd: ROOT,
    env: {
      ...childEnv,
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
  const required = [
    'app_ready',
    'menu_registered',
    'server_node_selected',
    'server_ready',
    'window_loaded',
    'smoke_quit_requested',
  ];
  const missing = required.filter((event) => !names.has(event));
  const serverNodeEvent = events.find((event) => event.event === 'server_node_selected');
  const windowEvent = events.find((event) => event.event === 'window_loaded');
  const eventOrder = required.map((event) => events.findIndex((row) => row.event === event));
  const eventOrderVerified = eventOrder.every(
    (position, index) => position >= 0 && (index === 0 || position > eventOrder[index - 1]),
  );
  const packagedRuntimeVerified = Boolean(
    serverNodeEvent &&
      serverNodeEvent.isElectron === true &&
      serverNodeEvent.bin === executable &&
      String(serverNodeEvent.modules || '') !== '' &&
      String(serverNodeEvent.modules) !== String(process.versions.modules),
  );
  const panelPageVerified = Boolean(
    windowEvent &&
      /^http:\/\/127\.0\.0\.1:\d+\/?\?electron=1$/.test(String(windowEvent.url || '')) &&
      windowEvent.pageTitle === 'Neo 贾维斯' &&
      windowEvent.neoMarker === true,
  );
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDigest: expectedDigest,
    embeddedSourceDigest: embeddedPackage.noeSourceDigest,
    buildId: buildReceipt.buildId,
    appTreeSha256,
    runtime: 'packaged_electron',
    productName: PRODUCT_NAME,
    appPath,
    executable,
    port,
    exit,
    requiredEvents: required,
    missingEvents: missing,
    packagedRuntimeVerified,
    eventOrderVerified,
    panelPageVerified,
    serverNodeSelected: serverNodeEvent || null,
    events: events.map((event) => event.event),
    eventLog: LOG_FILE,
    stdoutLog: STDOUT_FILE,
    pass:
      exit.status === 0 &&
      exit.signal == null &&
      missing.length === 0 &&
      packagedRuntimeVerified &&
      eventOrderVerified &&
      panelPageVerified,
  };
  writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`[electron-smoke] exit=${exit.status} signal=${exit.signal || ''}`);
  console.log(`[electron-smoke] events=${events.map((event) => event.event).join(',')}`);
  console.log(`[electron-smoke] appPath=${appPath}`);
  console.log(`[electron-smoke] stdoutLog=${STDOUT_FILE}`);
  console.log(`[electron-smoke] summary=${SUMMARY_FILE}`);
  if (
    exit.status !== 0 ||
    exit.signal != null ||
    missing.length ||
    !packagedRuntimeVerified ||
    !eventOrderVerified ||
    !panelPageVerified
  ) {
    console.error(
      `[electron-smoke] failed missing=${missing.join(',') || '-'} packagedRuntime=${packagedRuntimeVerified} log=${LOG_FILE}`,
    );
    process.exit(exit.status || 1);
  }
  console.log('[electron-smoke] PASS');
}

main().catch((e) => {
  console.error(`[electron-smoke] ${e?.stack || e?.message || e}`);
  process.exit(1);
});
