#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const NOE_PORT = Number(process.env.NOE_PHASE7_PORT || 51835);
const ORIG_PORT = Number(process.env.NOE_PHASE7_ORIG_PORT || 51735);
const projectId = `noe-it-${Date.now()}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'noe-phase7-'));
const tempHome = join(tempRoot, 'home');
const serverLog = join(tempRoot, 'server.log');
const checks = [];
let child = null;

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

function _pidCmd(pid) {
  if (!pid) return '(none)';
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || '(gone)';
  } catch {
    return '(gone)';
  }
}

async function request(method, path, {
  token,
  body,
  headers = {},
  expected,
  raw = false,
} = {}) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders['X-Panel-Owner-Token'] = token;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${NOE_PORT}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  const type = res.headers.get('content-type') || '';
  if (!raw && type.includes('application/json')) {
    try { data = JSON.parse(text); } catch {}
  }
  if (expected !== undefined && res.status !== expected) {
    throw new Error(`${method} ${path} expected ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, data, text, headers: res.headers };
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    if (child?.exitCode !== null) return false;
    const pid = listenPid(NOE_PORT);
    if (pid) {
      try {
        const res = await fetch(`http://127.0.0.1:${NOE_PORT}/`, { method: 'GET' });
        if (res.status >= 200 && res.status < 500) return true;
      } catch {}
    }
    await sleep(250);
  }
  return false;
}

async function cleanup() {
  if (!child?.pid) return;
  try { child.kill('SIGTERM'); } catch {}
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (!listenPid(NOE_PORT)) return;
  }
  try { child.kill('SIGKILL'); } catch {}
  await sleep(500);
}

function failFast(message) {
  record(false, 'fatal', message);
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

log('=== NOE Phase 7 Integration Test ===');
log(`cwd=${root}`);
log(`node=${process.version}; modules=${process.versions.modules}`);
log(`tempHome=${tempHome}`);
log(`serverLog=${serverLog}`);

try {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  record(nodeMajor >= 22, 'Node runtime is compatible', process.version);

  const noeBefore = listenPid(NOE_PORT);
  const origBefore = listenPid(ORIG_PORT);
  record(!noeBefore, `${NOE_PORT} is free before test`, noeBefore ? `occupied by ${noeBefore}` : 'free');
  if (noeBefore) throw new Error(`${NOE_PORT} is occupied; refusing to disturb an existing process`);

  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: tempHome,
      PORT: String(NOE_PORT),
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
  const noeDuring = listenPid(NOE_PORT);
  record(ready && String(noeDuring) === String(child.pid), `server listens on ${NOE_PORT}`, `pid=${noeDuring}; child=${child.pid}`);
  if (!ready) throw new Error(`server did not become ready on ${NOE_PORT}`);

  const tokenPath = join(tempHome, '.noe-panel', 'owner-token.txt');
  const token = readFileSync(tokenPath, 'utf8').trim();
  record(token.length >= 32, 'owner token generated in isolated HOME', `${token.length} chars`);

  const unauth = await request('GET', '/api/noe/health', { expected: 401 });
  record(/owner token required/i.test(unauth.text), 'Noe API rejects missing owner token', `HTTP ${unauth.status}`);

  const health0 = await request('GET', `/api/noe/health?projectId=${encodeURIComponent(projectId)}`, { token, expected: 200 });
  record(health0.data?.ok && health0.data?.health?.status === 'ok', 'Noe health API works with owner token', `loop=${health0.data?.loop?.state}`);

  const memoryBody = `phase7 integration memory ${projectId} alpha recall`;
  const memoryWrite = await request('POST', '/api/noe/memory', {
    token,
    expected: 201,
    body: {
      projectId,
      title: 'Phase7 integration memory',
      body: memoryBody,
      tags: ['phase7', 'integration'],
      sourceType: 'phase7_test',
    },
  });
  const memoryId = memoryWrite.data?.item?.id;
  record(Boolean(memoryId), 'Memory API writes through HTTP into SQLite', memoryId);

  const memoryRecall = await request('GET', `/api/noe/memory?projectId=${encodeURIComponent(projectId)}&q=alpha&limit=5`, {
    token,
    expected: 200,
  });
  record(memoryRecall.data?.items?.some((item) => item.id === memoryId), 'Memory recall returns the written item', `count=${memoryRecall.data?.count}`);

  const focusWrite = await request('POST', '/api/noe/focus', {
    token,
    expected: 201,
    body: {
      projectId,
      title: `Phase7 focus ${projectId}`,
      summary: 'Focus stack item for integration test',
      sourceType: 'phase7_test',
    },
  });
  const focusId = focusWrite.data?.item?.id;
  record(Boolean(focusId), 'Focus API pushes into SQLite', focusId);

  const focusList = await request('GET', `/api/noe/focus?projectId=${encodeURIComponent(projectId)}&limit=5`, {
    token,
    expected: 200,
  });
  record(focusList.data?.items?.some((item) => item.id === focusId), 'Focus list returns the pushed item', `count=${focusList.data?.count}`);

  const focusPop = await request('POST', `/api/noe/focus/${encodeURIComponent(focusId)}/pop`, {
    token,
    expected: 200,
    body: {
      compressedSummary: `absorbed phase7 memory ${projectId}`,
      absorb: true,
    },
  });
  const absorbedId = focusPop.data?.item?.absorbedMemoryId;
  record(Boolean(absorbedId) && focusPop.data?.item?.state === 'popped', 'Focus pop absorbs into Memory', absorbedId);

  const absorbedRecall = await request('GET', `/api/noe/memory?projectId=${encodeURIComponent(projectId)}&q=absorbed&limit=10`, {
    token,
    expected: 200,
  });
  record(absorbedRecall.data?.items?.some((item) => item.id === absorbedId), 'Absorbed focus memory is recallable', `count=${absorbedRecall.data?.count}`);

  const tick = await request('POST', '/api/noe/loop/tick', {
    token,
    expected: 200,
    body: { force: true, timeoutMs: 5000 },
  });
  record(tick.data?.ok && tick.data?.event?.tag === 'noe.loop.tick', 'NoeLoop tick runs through HTTP and appends an event', `eventId=${tick.data?.eventId}`);

  const toolId = `phase7-tool-${Date.now()}`;
  const toolCreate = await request('POST', '/api/noe/tools', {
    token,
    expected: 201,
    body: {
      id: toolId,
      name: 'Phase7 Disabled Tool',
      description: 'Manifest-only integration test tool',
      version: '0.0.1',
      category: 'phase7',
      riskLevel: 'low',
      operation: 'phase7.noop',
    },
  });
  record(toolCreate.data?.tool?.id === toolId && toolCreate.data?.tool?.enabled === false, 'Tool manifest registers disabled by default', toolId);

  const toolInvoke = await request('POST', `/api/noe/tools/${encodeURIComponent(toolId)}/invoke`, {
    token,
    expected: 403,
    body: { args: { command: 'echo should-not-run' } },
  });
  record(toolInvoke.data?.error === 'tool disabled', 'Disabled tool cannot invoke external action', `HTTP ${toolInvoke.status}`);

  const html = await request('GET', `/?t=${encodeURIComponent(token)}`, { expected: 200, raw: true });
  record(/Noe Brain/.test(html.text) && /noeBrainArea/.test(html.text), 'Frontend shell serves Brain UI markup', `bytes=${html.text.length}`);

  const mainJs = await request('GET', '/main.js?v=phase7', { expected: 200, raw: true });
  record(/brain-ui\.js/.test(mainJs.text), 'Frontend main module loads Brain UI module', `bytes=${mainJs.text.length}`);

  const brainJs = await request('GET', '/src/web/brain-ui.js', { expected: 200, raw: true });
  record(/\/api\/noe\/health/.test(brainJs.text) && /btnNoeLoopTick/.test(brainJs.text), 'Brain UI module is wired to Noe APIs', `bytes=${brainJs.text.length}`);

  const origDuring = listenPid(ORIG_PORT);
  record(String(origDuring) === String(origBefore), `${ORIG_PORT} unchanged while Noe test server runs`, `before=${origBefore || 'free'} during=${origDuring || 'free'}`);

  await cleanup();
  const noeAfter = listenPid(NOE_PORT);
  const origAfter = listenPid(ORIG_PORT);
  record(!noeAfter, `${NOE_PORT} is free after cleanup`, noeAfter ? `still ${noeAfter}` : 'free');
  record(String(origAfter) === String(origBefore), `${ORIG_PORT} unchanged after cleanup`, `before=${origBefore || 'free'} after=${origAfter || 'free'}`);
} catch (e) {
  failFast(e?.message || String(e));
  try {
    const tail = readFileSync(serverLog, 'utf8').split('\n').slice(-30).join('\n');
    if (tail.trim()) log(`\n--- redacted server log tail ---\n${redact(tail)}`);
  } catch {}
  await cleanup();
} finally {
  await cleanup();
}

const failed = checks.filter((check) => !check.ok);
log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  log('Failed checks:');
  for (const check of failed) log(`- ${check.label}${check.detail ? `: ${check.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
