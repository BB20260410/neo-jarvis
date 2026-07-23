#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = process.cwd();
const NODE_PORT = Number(process.env.NOE_PHASE8_PORT || 51835);
const ORIG_PORT = Number(process.env.NOE_PHASE8_ORIG_PORT || 51735);
const runId = `phase8-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'noe-phase8-'));
const tempHome = join(tempRoot, 'home');
const outputDir = join(root, 'output', 'playwright');
const serverLog = join(outputDir, `${runId}-server.log`);
const resultFile = join(outputDir, `${runId}-result.txt`);
const desktopShot = join(outputDir, `${runId}-desktop.png`);
const mobileShot = join(outputDir, `${runId}-mobile.png`);
const checks = [];
let child = null;
let browser = null;

function log(line = '') {
  console.log(line);
}

function redact(text = '') {
  return String(text)
    .replace(/([?&]t=)[A-Fa-f0-9]{32,}/g, '$1<REDACTED>')
    .replace(/([?&]token=)[A-Fa-f0-9]{32,}/g, '$1<REDACTED>')
    .replace(/(X-Panel-Owner-Token["':\s]+)[A-Fa-f0-9]{32,}/gi, '$1<REDACTED>');
}

function record(ok, label, detail = '') {
  checks.push({ ok, label, detail });
  log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}`);
}

function listenPid(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    if (child?.exitCode !== null) return false;
    const pid = listenPid(NODE_PORT);
    if (pid) {
      try {
        const res = await fetch(`http://127.0.0.1:${NODE_PORT}/`, { method: 'GET' });
        if (res.status >= 200 && res.status < 500) return true;
      } catch {}
    }
    await sleep(250);
  }
  return false;
}

async function cleanup() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
  if (child?.pid) {
    try { child.kill('SIGTERM'); } catch {}
    for (let i = 0; i < 20; i += 1) {
      await sleep(200);
      if (!listenPid(NODE_PORT)) break;
    }
    if (listenPid(NODE_PORT)) {
      try { child.kill('SIGKILL'); } catch {}
      await sleep(400);
    }
  }
}

async function request(method, path, { token, body, expected, raw = false } = {}) {
  const headers = {};
  if (token) headers['X-Panel-Owner-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${NODE_PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (expected !== undefined && res.status !== expected) {
    throw new Error(`${method} ${path} expected ${expected}, got ${res.status}: ${text.slice(0, 240)}`);
  }
  if (raw) return { status: res.status, text };
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, text, data };
}

async function textIncludes(locator, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await locator.textContent().catch(() => '');
    if (String(text || '').includes(needle)) return true;
    await sleep(150);
  }
  return false;
}

async function run() {
  mkdirSync(outputDir, { recursive: true });
  try {

  log('=== NOE Phase 8 Functional Walkthrough ===');
  log(`cwd=${root}`);
  log(`node=${process.version}; modules=${process.versions.modules}`);
  log(`runId=${runId}`);
  log('Browser path: in-app Browser unavailable in this runtime; using Playwright fallback.');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  record(nodeMajor >= 22, 'Node runtime is compatible for Noe', process.version);

  const noeBefore = listenPid(NODE_PORT);
  const origBefore = listenPid(ORIG_PORT);
  record(!noeBefore, `${NODE_PORT} is free before functional test`, noeBefore ? `occupied by ${noeBefore}` : 'free');
  if (noeBefore) throw new Error(`${NODE_PORT} is occupied; refusing to disturb an existing process`);

  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: tempHome,
      PORT: String(NODE_PORT),
      PANEL_NO_OPEN: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let captured = '';
  const capture = (chunk) => {
    captured += chunk.toString();
    writeFileSync(serverLog, redact(captured), 'utf8');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const ready = await waitForServer();
  const noeDuring = listenPid(NODE_PORT);
  record(ready && String(noeDuring) === String(child.pid), `server listens on ${NODE_PORT}`, `pid=${noeDuring}; child=${child.pid}`);
  if (!ready) throw new Error(`server did not become ready on ${NODE_PORT}`);

  const tokenPath = join(tempHome, '.noe-panel', 'owner-token.txt');
  const token = readFileSync(tokenPath, 'utf8').trim();
  record(token.length >= 32, 'owner token generated in isolated HOME', `${token.length} chars`);

  const unauth = await request('GET', '/api/noe/health', { expected: 401 });
  record(/owner token required/i.test(unauth.text), 'Noe API rejects missing owner token', `HTTP ${unauth.status}`);

  const authed = await request('GET', '/api/noe/health', { token, expected: 200 });
  record(authed.data?.ok && authed.data?.health?.status === 'ok', 'Noe health API is reachable with owner token', `loop=${authed.data?.loop?.state}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('panel:onboarding:v1', '1');
    localStorage.setItem('panel:telemetry:asked', '1');
  });
  const page = await context.newPage();
  const consoleIssues = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleIssues.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleIssues.push(`pageerror: ${err.message}`));

  await page.goto(`http://127.0.0.1:${NODE_PORT}/?t=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  record(await page.title() === 'Noe', 'page identity is Noe', await page.title());
  record(await page.evaluate(() => window.PanelOwnerAuth?.hasToken?.() === true), 'page captured owner token from URL', 'PanelOwnerAuth.hasToken=true');

  await page.locator('#btnNoeBrain').click();
  await page.locator('#noeBrainArea').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#noeHealthStatus').waitFor({ state: 'visible', timeout: 10_000 });
  record(await textIncludes(page.locator('#noeHealthStatus'), 'ok'), 'Brain UI health shows ok');
  record(await page.locator('[data-noe-panel="loop"]').isVisible(), 'Brain UI loop panel is visible');
  record(await page.locator('[data-noe-panel="memory"]').isVisible(), 'Brain UI memory panel is visible');
  record(await page.locator('[data-noe-panel="focus"]').isVisible(), 'Brain UI focus panel is visible');

  const memoryText = `phase8 user memory ${runId} recall-signal`;
  await page.locator('#noeMemoryBody').fill(memoryText);
  await page.locator('#btnNoeMemoryWrite').click();
  record(await textIncludes(page.locator('#noeMemoryList'), memoryText), 'user can write a memory and see it in Brain UI');

  await page.locator('#noeMemoryQuery').fill('recall-signal');
  await page.locator('#btnNoeMemorySearch').click();
  record(await textIncludes(page.locator('#noeMemoryList'), memoryText), 'user can search and recall the written memory');

  const focusTitle = `phase8 focus ${runId}`;
  await page.locator('#noeFocusTitle').fill(focusTitle);
  await page.locator('#btnNoeFocusPush').click();
  record(await textIncludes(page.locator('#noeFocusList'), focusTitle), 'user can push a focus item and see it in Focus Stack');

  await page.locator('#btnNoeLoopTick').click();
  record(await textIncludes(page.locator('#noeThoughtStream'), 'manual_tick'), 'user can trigger a loop tick and see Thought Stream update');

  const toolId = `phase8-disabled-${Date.now()}`;
  await request('POST', '/api/noe/tools', {
    token,
    expected: 201,
    body: {
      id: toolId,
      name: 'Phase8 Disabled Tool',
      description: 'Functional verification disabled manifest',
      version: '0.0.1',
      category: 'phase8',
      riskLevel: 'low',
      operation: 'phase8.noop',
    },
  });
  await page.locator('#btnNoeBrainRefresh').click();
  record(await textIncludes(page.locator('#noeToolsList'), 'Phase8 Disabled Tool'), 'tools area shows manifest-only disabled tool');
  record(await textIncludes(page.locator('#noeToolsList'), 'disabled'), 'tools stay disabled by default');

  await page.screenshot({ path: desktopShot, fullPage: false });
  record(existsSync(desktopShot), 'desktop screenshot captured', desktopShot);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.locator('#btnNoeBrain').click();
  await page.locator('#noeBrainArea').waitFor({ state: 'visible', timeout: 10_000 });
  record(await page.locator('#noeBrainArea').isVisible(), 'mobile viewport can open Brain UI');
  record(await page.locator('#btnNoeLoopTick').isVisible(), 'mobile viewport keeps primary Tick control visible');
  await page.screenshot({ path: mobileShot, fullPage: false });
  record(existsSync(mobileShot), 'mobile screenshot captured', mobileShot);

  const relevantConsoleIssues = consoleIssues.filter((line) => !/favicon|Failed to load resource.*404/i.test(line));
  record(relevantConsoleIssues.length === 0, 'no relevant browser console errors or warnings', relevantConsoleIssues.slice(0, 5).join(' | '));

  const origDuring = listenPid(ORIG_PORT);
  record(String(origDuring) === String(origBefore), `${ORIG_PORT} unchanged while Noe functional server runs`, `before=${origBefore || 'free'} during=${origDuring || 'free'}`);

  await cleanup();
  const noeAfter = listenPid(NODE_PORT);
  const origAfter = listenPid(ORIG_PORT);
  record(!noeAfter, `${NODE_PORT} is free after cleanup`, noeAfter ? `still ${noeAfter}` : 'free');
  record(String(origAfter) === String(origBefore), `${ORIG_PORT} unchanged after cleanup`, `before=${origBefore || 'free'} after=${origAfter || 'free'}`);
} catch (e) {
  record(false, 'fatal', e?.message || String(e));
  try {
    const tail = readFileSync(serverLog, 'utf8').split('\n').slice(-40).join('\n');
    if (tail.trim()) log(`\n--- redacted server log tail ---\n${redact(tail)}`);
  } catch {}
  await cleanup();
} finally {
  await cleanup();
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
}

await run();

const failed = checks.filter((check) => !check.ok);
const summary = [
  `runId=${runId}`,
  `desktop=${desktopShot}`,
  `mobile=${mobileShot}`,
  `serverLog=${serverLog}`,
  `checks=${checks.length - failed.length}/${checks.length}`,
  `failed=${failed.length}`,
];
writeFileSync(resultFile, `${summary.join('\n')}\n`, 'utf8');
log(`\nArtifacts:`);
for (const line of summary) log(`- ${line}`);
log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  log('Failed checks:');
  for (const check of failed) log(`- ${check.label}${check.detail ? `: ${check.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
