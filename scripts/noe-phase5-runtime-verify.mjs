#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNode22OrFail } from './ensure-node22.mjs';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-phase5-runtime');
const REPORT = join(OUT_DIR, `phase5-runtime-${Date.now()}.json`);
const DEFAULT_BASE = 'http://127.0.0.1:51835';
const REQUIRED_ORDER = ['minimax', 'codex', 'claude', 'searxng', 'brave'];
const RESERVED_PANEL_PORTS = new Set([51735, 51835]);

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.NOE_PANEL_URL || DEFAULT_BASE,
    timeoutMs: 15_000,
    managed: false,
    port: 0,
    keepManagedHome: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || out.timeoutMs;
    else if (arg === '--managed') out.managed = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
    else if (arg === '--port') out.port = Number(argv[++i]) || 0;
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length)) || 0;
    else if (arg === '--keep-managed-home') out.keepManagedHome = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'phase5-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return out;
}

function liveOwnerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant; use --managed for isolated no-secret verification',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: process.env.NOE_OWNER_TOKEN.trim(), source: 'env', policyBlocked: false, reason: '' };
  try {
    return { token: readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  }
}

async function request(path, { method = 'GET', token = '', body = null, timeoutMs = 15_000 } = {}) {
  const headers = token ? { 'X-Panel-Owner-Token': token } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  const text = await res.text();
  const raw = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: raw.slice(0, 50_000) }; }
  return { status: res.status, ok: res.ok, data, raw };
}

function pass(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]')
    .replace(/(owner[-_ ]?token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parsePort(value, source = 'port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${source} must be a valid TCP port, got ${value}`);
  if (RESERVED_PANEL_PORTS.has(port)) throw new Error(`${source}=${port} is reserved for live panels`);
  return port;
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function resolveManagedPort(requestedPort) {
  if (requestedPort) return parsePort(requestedPort, '--port');
  let port = 0;
  for (let i = 0; i < 10; i += 1) {
    port = await findFreePort();
    if (!RESERVED_PANEL_PORTS.has(port)) return port;
  }
  throw new Error('could not allocate a non-reserved free port');
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  return false;
}

async function waitFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await sleep(200);
  }
  return false;
}

async function stopManaged(managed) {
  if (!managed) return;
  if (managed.server?.pid && managed.server.exitCode === null) {
    try { process.kill(-managed.server.pid, 'SIGTERM'); } catch { try { process.kill(managed.server.pid, 'SIGTERM'); } catch {} }
    await sleep(800);
    try { process.kill(-managed.server.pid, 'SIGKILL'); } catch { try { process.kill(managed.server.pid, 'SIGKILL'); } catch {} }
  }
  if (managed.home && !managed.keepHome) {
    try { rmSync(managed.home, { recursive: true, force: true }); } catch {}
  }
}

async function startManaged(args) {
  const port = await resolveManagedPort(args.port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'noe-phase5-runtime-'));
  const panelDir = join(home, '.noe-panel');
  const dbPath = join(panelDir, 'panel.db');
  const ownerTokenPath = join(panelDir, 'owner-token.txt');
  mkdirSync(panelDir, { recursive: true, mode: 0o700 });

  const node22 = resolveNode22OrFail({ root: ROOT });
  const env = {
    ...process.env,
    HOME: home,
    PANEL_DB_PATH: dbPath,
    PORT: String(port),
    PANEL_HOST: '127.0.0.1',
    PANEL_NO_OPEN: '1',
    NODE_ENV: 'test',
    NOE_PHASE5_RUNTIME_VERIFY: '1',
    NOE_AI_SEARCH_MOCK: '1',
  };
  const managed = {
    mode: 'managed',
    baseUrl,
    port,
    home,
    dbPath,
    ownerTokenPath,
    node: node22,
    keepHome: args.keepManagedHome,
    server: null,
    log: '',
  };
  try {
    managed.server = spawn(node22, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    managed.server.stdout.on('data', (chunk) => { managed.log += chunk.toString('utf8'); managed.log = managed.log.slice(-20_000); });
    managed.server.stderr.on('data', (chunk) => { managed.log += chunk.toString('utf8'); managed.log = managed.log.slice(-20_000); });

    const ready = await waitHttp(`${baseUrl}/api/noe/health`, Math.max(args.timeoutMs, 30_000));
    const tokenReady = await waitFile(ownerTokenPath, Math.max(args.timeoutMs, 30_000));
    if (!ready || !tokenReady) {
      throw new Error(`managed server not ready: http=${ready} ownerToken=${tokenReady} logTail=${redactSecrets(managed.log.slice(-2000))}`);
    }
    managed.token = readFileSync(ownerTokenPath, 'utf8').trim();
    return managed;
  } catch (e) {
    await stopManaged(managed);
    throw e;
  }
}

async function runChecks({ baseUrl, token, tokenSource, timeoutMs, allowDelegateConfirm = false }) {
  const checks = [];

  pass(checks, 'owner_token_loaded', Boolean(token), { source: tokenSource });

  const unauth = await request(`${baseUrl}/api/noe/health`, { timeoutMs }).catch((e) => ({ error: e.message }));
  pass(checks, 'unauthorized_health_is_401', unauth.status === 401, { status: unauth.status || null, error: unauth.error || null });

  const health = token
    ? await request(`${baseUrl}/api/noe/health`, { token, timeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  pass(checks, 'authorized_health_ok', health.status === 200 && health.data?.ok === true, { status: health.status || null, error: health.error || null });

  const status = token
    ? await request(`${baseUrl}/api/noe/research/status`, { token, timeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const order = status.data?.providerOrder || [];
  pass(checks, 'research_status_ai_provider_order', status.status === 200 && REQUIRED_ORDER.every((item, idx) => order[idx] === item), {
    status: status.status || null,
    providerOrder: order,
    mockSearch: status.data?.mockSearch ?? null,
    cliFallbacks: status.data?.cliFallbacks || null,
  });
  if (allowDelegateConfirm) {
    pass(checks, 'managed_search_fixture_is_explicit', status.status === 200 && status.data?.mockSearch === true, {
      status: status.status || null,
      mockSearch: status.data?.mockSearch ?? null,
    });
  }

  const search = token
    ? await request(`${baseUrl}/api/noe/do`, {
      method: 'POST',
      token,
      timeoutMs,
      body: { text: '帮我查最新 AI 新闻', count: 2 },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  pass(checks, 'noe_do_search_intent_returns_results', search.status === 200 && search.data?.intent === 'research' && search.data?.mode === 'search' && Number(search.data?.count) > 0, {
    status: search.status || null,
    intent: search.data?.intent || null,
    source: search.data?.source || null,
    viaModel: search.data?.viaModel || null,
    count: search.data?.count || 0,
    error: search.error || search.data?.error || null,
  });

  const delegate = token
    ? await request(`${baseUrl}/api/noe/do`, {
      method: 'POST',
      token,
      timeoutMs,
      body: { text: '让 Codex 帮我修复登录页 bug' },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  pass(checks, 'noe_do_delegate_is_confirm_only', delegate.status === 200 && delegate.data?.intent === 'delegate_task' && delegate.data?.confirmEndpoint === '/api/noe/delegate/confirm' && delegate.data?.dryRunOnly === true, {
    status: delegate.status || null,
    intent: delegate.data?.intent || null,
    confirmEndpoint: delegate.data?.confirmEndpoint || null,
    dryRunOnly: delegate.data?.dryRunOnly || null,
    error: delegate.error || delegate.data?.error || null,
  });

  if (allowDelegateConfirm) {
    const confirm = token
      ? await request(`${baseUrl}/api/noe/delegate/confirm`, {
        method: 'POST',
        token,
        timeoutMs,
        body: { text: '让 Codex 帮我修复登录页 bug', confirm: true },
      }).catch((e) => ({ error: e.message }))
      : { error: 'missing owner token' };
    pass(checks, 'managed_delegate_confirm_creates_idle_room_only', confirm.status === 201 && confirm.data?.intent === 'delegate_task' && confirm.data?.started === false && confirm.data?.queued === false && confirm.data?.room?.status === 'idle', {
      status: confirm.status || null,
      intent: confirm.data?.intent || null,
      roomId: confirm.data?.room?.id || null,
      roomStatus: confirm.data?.room?.status || null,
      started: confirm.data?.started ?? null,
      queued: confirm.data?.queued ?? null,
      error: confirm.error || confirm.data?.error || null,
    });
  }

  const page = await request(`${baseUrl}/cognitive.html`, { timeoutMs }).catch((e) => ({ error: e.message }));
  const raw = page.raw || page.data?.raw || '';
  pass(checks, 'cognitive_page_has_research_entrypoint', page.status === 200 && raw.includes('/src/web/cognitive-research.js') && raw.includes('chat-input'), {
    status: page.status || null,
    error: page.error || null,
  });

  const wiki = token
    ? await request(`${baseUrl}/api/knowledge/llm-wiki/search?q=${encodeURIComponent('Karpathy wiki')}&topK=1`, { token, timeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  pass(checks, 'llm_wiki_search_returns_context', wiki.status === 200 && wiki.data?.ok === true && Array.isArray(wiki.data?.hits) && wiki.data.hits.length > 0, {
    status: wiki.status || null,
    count: wiki.data?.hits?.length || 0,
    firstTitle: wiki.data?.hits?.[0]?.title || null,
    error: wiki.error || wiki.data?.error || null,
  });

  const wikiDo = token
    ? await request(`${baseUrl}/api/noe/do`, {
      method: 'POST',
      token,
      timeoutMs,
      body: { text: '我们之前对 Karpathy 知识库的结论是什么', localWiki: true, topK: 1 },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  pass(checks, 'noe_do_llm_wiki_intent_returns_context', wikiDo.status === 200 && wikiDo.data?.intent === 'llm_wiki' && Number(wikiDo.data?.count) > 0, {
    status: wikiDo.status || null,
    intent: wikiDo.data?.intent || null,
    count: wikiDo.data?.count || 0,
    firstTitle: wikiDo.data?.hits?.[0]?.title || null,
    error: wikiDo.error || wikiDo.data?.error || null,
  });

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  return { checks, passed, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let managed = null;
  let baseUrl = args.baseUrl;
  let token = '';
  let tokenSource = '';
  let tokenPolicy = liveOwnerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  token = tokenPolicy.token;
  tokenSource = tokenPolicy.source;

  try {
    if (args.managed) {
      managed = await startManaged(args);
      baseUrl = managed.baseUrl;
      token = managed.token;
      tokenSource = managed.ownerTokenPath;
      tokenPolicy = { token, source: tokenSource, policyBlocked: false, reason: 'managed isolated token generated under temporary HOME' };
    }
    if (!args.managed && tokenPolicy.policyBlocked) {
      const checks = [];
      pass(checks, 'owner_token_loaded', false, {
        source: tokenSource,
        policyBlocked: true,
        reason: tokenPolicy.reason,
      });
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(REPORT, JSON.stringify({
        ok: false,
        mode: 'live',
        baseUrl,
        tokenPolicy: {
          source: tokenSource,
          ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
          authorization: args.ownerTokenAuthorization,
          policyBlocked: true,
          reason: tokenPolicy.reason,
          secretValueReturned: false,
        },
        managed: null,
        checks,
        passed: 0,
        failed: checks.length,
        note: 'Live phase5 verification did not read owner-token or call the live panel because neither explicit ack nor standing autonomy grant authorized it. Use --managed for isolated no-secret verification.',
      }, null, 2));
      console.log('FAIL owner_token_loaded');
      console.log(`report=${REPORT}`);
      process.exitCode = 2;
      return;
    }
    const { checks, passed, failed } = await runChecks({ baseUrl, token, tokenSource, timeoutMs: args.timeoutMs, allowDelegateConfirm: args.managed });

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT, JSON.stringify({
      ok: failed === 0,
      mode: args.managed ? 'managed' : 'live',
      baseUrl,
      tokenPolicy: {
        source: tokenSource,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: Boolean(tokenPolicy.policyBlocked),
        reason: tokenPolicy.reason || '',
        secretValueReturned: false,
      },
      managed: managed ? {
        port: managed.port,
        home: managed.home,
        dbPath: managed.dbPath,
        ownerTokenPath: managed.ownerTokenPath,
        node: managed.node,
        keptHome: managed.keepHome,
        logTail: redactSecrets(managed.log.slice(-4000)),
      } : null,
      checks,
      passed,
      failed,
      note: args.managed
        ? 'Managed mode starts an isolated temporary Noe server on a non-reserved port; it does not touch 51735/51835, approve jobs, or spawn Codex/Claude CLI. It may create a temporary idle delegate room inside the isolated HOME.'
        : 'Live mode does not restart the panel, create rooms, approve jobs, or spawn Codex/Claude CLI. Reading the live owner token requires explicit ack or standing autonomy grant.',
    }, null, 2));

    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
    }
    console.log(`report=${REPORT}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await stopManaged(managed);
  }
}

main().catch((e) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const message = redactSecrets(e?.message || String(e));
  writeFileSync(REPORT, JSON.stringify({ ok: false, error: message }, null, 2));
  console.error(redactSecrets(e?.stack || e?.message || e));
  console.error(`report=${REPORT}`);
  process.exit(1);
});
