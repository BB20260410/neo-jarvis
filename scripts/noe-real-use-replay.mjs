#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNode22OrFail } from './ensure-node22.mjs';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';
import { buildM3ColdReviewInput, runM3SuggestionTask } from '../src/room/MiniMaxSuggestionPipeline.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-real-use-replay');
const REPORT = join(OUT_DIR, `real-use-replay-${Date.now()}.json`);
const DEFAULT_BASE = 'http://127.0.0.1:51835';
const RESERVED_PANEL_PORTS = new Set([51735, 51835]);

export function parseArgs(argv) {
  const out = {
    baseUrl: process.env.NOE_PANEL_URL || DEFAULT_BASE,
    requestTimeoutMs: 15_000,
    managed: false,
    port: 0,
    keepManagedHome: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--request-timeout-ms') out.requestTimeoutMs = Number(argv[++i]) || out.requestTimeoutMs;
    else if (arg.startsWith('--request-timeout-ms=')) out.requestTimeoutMs = Number(arg.slice('--request-timeout-ms='.length)) || out.requestTimeoutMs;
    else if (arg === '--timeout-ms') out.requestTimeoutMs = Number(argv[++i]) || out.requestTimeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.requestTimeoutMs = Number(arg.slice('--timeout-ms='.length)) || out.requestTimeoutMs;
    else if (arg === '--managed') out.managed = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
    else if (arg === '--port') out.port = Number(argv[++i]) || 0;
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length)) || 0;
    else if (arg === '--keep-managed-home') out.keepManagedHome = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'real-use-replay-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return out;
}

export function liveOwnerToken({ ackReadOwnerToken = false } = {}) {
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

export function redact(value) {
  return String(value || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]')
    .replace(/(owner[-_ ]?token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]');
}

export function summarizeOwnerTokenSource({ source = '', managed = false } = {}) {
  if (managed) return 'managed_isolated_owner_credential';
  const text = String(source || '');
  if (text === 'env') return 'env';
  if (text === 'not_loaded_policy_requires_ack') return text;
  if (/^~\/\.noe-panel\/owner-token\.txt$/.test(text)) return 'live_owner_credential_file';
  if (/owner-token\.txt/.test(text)) return 'owner_credential_file_redacted';
  return text ? 'redacted_owner_credential_source' : '';
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function request(path, { method = 'GET', token = '', body, requestTimeoutMs = 15_000, noAbort = false } = {}) {
  const headers = token ? { 'X-Panel-Owner-Token': token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const opts = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  if (!noAbort) opts.signal = AbortSignal.timeout(requestTimeoutMs);
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  const raw = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: redact(raw).slice(0, 50_000) }; }
  return { status: res.status, ok: res.ok, data, raw: redact(raw) };
}

function add(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
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
  for (let i = 0; i < 10; i += 1) {
    const port = await findFreePort();
    if (!RESERVED_PANEL_PORTS.has(port)) return port;
  }
  throw new Error('could not allocate a non-reserved free port');
}

async function waitHttp(url, requestTimeoutMs) {
  const deadline = Date.now() + requestTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch { /* server is still booting */ }
    await sleep(300);
  }
  return false;
}

async function waitFile(filePath, requestTimeoutMs) {
  const deadline = Date.now() + requestTimeoutMs;
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
  const home = mkdtempSync(join(tmpdir(), 'noe-real-use-replay-'));
  const panelDir = join(home, '.noe-panel');
  const dbPath = join(panelDir, 'panel.db');
  const ownerTokenPath = join(panelDir, 'owner-token.txt');
  mkdirSync(panelDir, { recursive: true, mode: 0o700 });

  const node22 = resolveNode22OrFail({ root: ROOT });
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
      env: {
        ...process.env,
        HOME: home,
        PANEL_DB_PATH: dbPath,
        PORT: String(port),
        PANEL_HOST: '127.0.0.1',
        PANEL_NO_OPEN: '1',
        NODE_ENV: 'test',
        NOE_REAL_USE_REPLAY: '1',
        NOE_AI_SEARCH_MOCK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    managed.server.stdout.on('data', (chunk) => { managed.log += chunk.toString('utf8'); managed.log = managed.log.slice(-20_000); });
    managed.server.stderr.on('data', (chunk) => { managed.log += chunk.toString('utf8'); managed.log = managed.log.slice(-20_000); });

    const readyBudget = Math.max(args.requestTimeoutMs, 30_000);
    const ready = await waitHttp(`${baseUrl}/api/noe/health`, readyBudget);
    const tokenReady = await waitFile(ownerTokenPath, readyBudget);
    if (!ready || !tokenReady) {
      throw new Error(`managed server not ready: http=${ready} ownerToken=${tokenReady} logTail=${redact(managed.log.slice(-2000))}`);
    }
    managed.token = readFileSync(ownerTokenPath, 'utf8').trim();
    return managed;
  } catch (e) {
    await stopManaged(managed);
    throw e;
  }
}

function hasDirtySpeechText(reply) {
  return /<img|<\/?[a-z][^>]*>|https?:\/\/|\b(?:src|href)\s*=/i.test(String(reply || ''));
}

async function replayM3ColdReview() {
  const input = buildM3ColdReviewInput('search', [
    '搜索路径验收：先给结论，再给依据和不确定性。',
    '语音播报不应读 URL、HTML、img、src、href。',
    'M3 只允许返回建议，不允许读本地文件、运行命令或写 diff。',
  ].join('\n'));
  return runM3SuggestionTask(input, {
    runner: async () => JSON.stringify({
      actions: ['suggestions', 'risk_notes', 'evidence_gaps'],
      diffs: [],
      task_type: 'chinese_product_audit',
      suggestions: ['继续把搜索语音回复控制成先结论、后依据、再提醒复核。'],
      risk_notes: ['如果模型返回 URL 或 HTML，必须降级到规则兜底话术。'],
      product_gaps: [],
      evidence_gaps: ['真实麦克风链路仍需在有设备时单独补物理音频证据。'],
      patch_suggestions: [],
      do_not_block_reason: '本次只是建议员冷审查，不做最终验收。',
      final_authority: 'Claude/GPT-Codex',
    }),
  });
}

async function runChecks({ baseUrl, token, tokenSource, requestTimeoutMs, managed = false }) {
  const checks = [];
  const marker = `REAL_USE_${Date.now().toString(36)}`;

  const unauth = await request(`${baseUrl}/api/noe/health`, { requestTimeoutMs }).catch((e) => ({ error: e.message }));
  const health = token
    ? await request(`${baseUrl}/api/noe/health`, { token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  add(checks, 'owner_access_and_health_ok', Boolean(token) && unauth.status === 401 && health.status === 200 && health.data?.ok === true, {
    tokenSource,
    unauthStatus: unauth.status || null,
    healthStatus: health.status || null,
    error: unauth.error || health.error || null,
  });

  if (managed) {
    const researchStatus = token
      ? await request(`${baseUrl}/api/noe/research/status`, { token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
      : { error: 'missing owner token' };
    add(checks, 'managed_search_fixture_is_explicit', researchStatus.status === 200 && researchStatus.data?.mockSearch === true, {
      status: researchStatus.status || null,
      mockSearch: researchStatus.data?.mockSearch ?? null,
      providerOrder: researchStatus.data?.providerOrder || null,
      error: researchStatus.error || researchStatus.data?.error || null,
    });
  }

  const search = token
    ? await request(`${baseUrl}/api/noe/do`, {
      method: 'POST',
      token,
      noAbort: true,
      body: { text: '帮我查最新 AI 新闻', count: 2 },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  add(checks, 'noe_do_search_returns_results', search.status === 200 && search.data?.intent === 'research' && search.data?.mode === 'search' && Number(search.data?.count) > 0, {
    status: search.status || null,
    source: search.data?.source || null,
    viaModel: search.data?.viaModel || null,
    count: search.data?.count || 0,
    reply: String(search.data?.reply || '').slice(0, 220),
    error: search.error || search.data?.error || null,
  });

  const voice = token
    ? await request(`${baseUrl}/api/noe/voice/chat`, {
      method: 'POST',
      token,
      noAbort: true,
      body: { text: '帮我查最新 AI 新闻', voice: false },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const voiceReply = String(voice.data?.reply || '');
  add(checks, 'voice_text_search_returns_sanitized_reply', voice.status === 200 && voice.data?.ok === true && voice.data?.intent === 'research' && voice.data?.mode === 'search' && voiceReply && !hasDirtySpeechText(voiceReply), {
    status: voice.status || null,
    intent: voice.data?.intent || null,
    mode: voice.data?.mode || null,
    count: voice.data?.count || 0,
    reply: voiceReply.slice(0, 260),
    dirtySpeechText: hasDirtySpeechText(voiceReply),
    error: voice.error || voice.data?.error || null,
  });

  const wiki = token
    ? await request(`${baseUrl}/api/noe/do`, {
      method: 'POST',
      token,
      requestTimeoutMs,
      body: { text: '我们之前对 Karpathy 知识库的结论是什么', localWiki: true, topK: 1 },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  add(checks, 'noe_do_llm_wiki_returns_context', wiki.status === 200 && wiki.data?.intent === 'llm_wiki' && Number(wiki.data?.count) > 0, {
    status: wiki.status || null,
    intent: wiki.data?.intent || null,
    count: wiki.data?.count || 0,
    firstTitle: wiki.data?.hits?.[0]?.title || null,
    error: wiki.error || wiki.data?.error || null,
  });

  const memoryBody = `真实使用回放记忆 ${marker}`;
  const memoryWrite = token
    ? await request(`${baseUrl}/api/noe/memory`, {
      method: 'POST',
      token,
      requestTimeoutMs,
      body: { projectId: 'noe', scope: 'replay', body: memoryBody, sourceType: 'real_use_replay', tags: ['real-use-replay'] },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const memoryId = memoryWrite.data?.item?.id || '';
  const memoryRecall = token
    ? await request(`${baseUrl}/api/noe/memory?project=noe&q=${encodeURIComponent(marker)}&limit=5`, { token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const memoryDelete = token && memoryId
    ? await request(`${baseUrl}/api/noe/memory/${encodeURIComponent(memoryId)}?project=noe`, { method: 'DELETE', token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
    : { error: memoryId ? 'missing owner token' : 'missing memory id' };
  add(checks, 'memory_write_recall_delete_roundtrip', memoryWrite.status === 201 && memoryRecall.status === 200 && memoryRecall.data?.items?.some((item) => item.id === memoryId) && memoryDelete.status === 200, {
    writeStatus: memoryWrite.status || null,
    recallStatus: memoryRecall.status || null,
    deleteStatus: memoryDelete.status || null,
    memoryId: memoryId || null,
    recalled: memoryRecall.data?.count || 0,
    error: memoryWrite.error || memoryRecall.error || memoryDelete.error || memoryWrite.data?.error || memoryRecall.data?.error || memoryDelete.data?.error || null,
  });

  const face = Array.from({ length: 64 }, (_, i) => Math.sin((i + 5) / 11));
  const person = token
    ? await request(`${baseUrl}/api/noe/people`, {
      method: 'POST',
      token,
      requestTimeoutMs,
      body: { displayName: `回放人物 ${marker}`, relation: '验证', notes: '真实使用回放临时人物，结束后删除。' },
    }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const personId = person.data?.person?.id || '';
  if (token && personId) {
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(personId)}/face/enroll`, { method: 'POST', token, requestTimeoutMs, body: { embedding: face, name: 'a' } }).catch(() => ({}));
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(personId)}/face/enroll`, { method: 'POST', token, requestTimeoutMs, body: { embedding: face.map((v, i) => v + Math.sin(i) * 0.001), name: 'b' } }).catch(() => ({}));
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(personId)}/face/enroll`, { method: 'POST', token, requestTimeoutMs, body: { embedding: face.map((v, i) => v + Math.cos(i) * 0.001), name: 'c' } }).catch(() => ({}));
  }
  const identify = token && personId
    ? await request(`${baseUrl}/api/noe/people/identify/face`, { method: 'POST', token, requestTimeoutMs, body: { embedding: face, threshold: 0.5 } }).catch((e) => ({ error: e.message }))
    : { error: personId ? 'missing owner token' : 'missing person id' };
  const personDelete = token && personId
    ? await request(`${baseUrl}/api/noe/people/${encodeURIComponent(personId)}`, { method: 'DELETE', token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
    : { error: personId ? 'missing owner token' : 'missing person id' };
  add(checks, 'people_create_enroll_identify_delete', person.status === 201 && identify.status === 200 && identify.data?.match?.ok === true && identify.data?.match?.person?.id === personId && personDelete.status === 200, {
    createStatus: person.status || null,
    identifyStatus: identify.status || null,
    deleteStatus: personDelete.status || null,
    personId: personId || null,
    match: identify.data?.match ? { ok: identify.data.match.ok, score: identify.data.match.score, name: identify.data.match.person?.displayName } : null,
    error: person.error || identify.error || personDelete.error || person.data?.error || identify.data?.error || personDelete.data?.error || null,
  });

  const low = token
    ? await request(`${baseUrl}/api/noe/acts/propose`, { method: 'POST', token, requestTimeoutMs, body: { projectId: 'noe', action: 'noe.focus.review', title: `回放低风险 ${marker}`, riskLevel: 'low' } }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const high = token
    ? await request(`${baseUrl}/api/noe/acts/propose`, { method: 'POST', token, requestTimeoutMs, body: { projectId: 'noe', action: 'data.upload.external', title: `回放高风险 ${marker}`, riskLevel: 'high' } }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const danger = token
    ? await request(`${baseUrl}/api/noe/acts/propose`, { method: 'POST', token, requestTimeoutMs, body: { projectId: 'noe', action: 'file.delete', title: `回放危险删除 ${marker}` } }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const acts = token
    ? await request(`${baseUrl}/api/noe/acts?project=noe&limit=30`, { token, requestTimeoutMs }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const statuses = (acts.data?.items || []).map((item) => item.status);
  const dangerSafelyHeld = danger.status === 403 || danger.status === 202;
  const noRealExecution = !(acts.data?.items || []).some((item) => item.status === 'executed_real');
  const dangerStateHeld = statuses.includes('blocked_safety')
    || statuses.includes('failed')
    || ['awaiting_approval', 'failed', 'blocked_safety'].includes(danger.data?.act?.status);
  const safetyStatesOk = statuses.includes('completed')
    && statuses.includes('awaiting_approval')
    && dangerStateHeld;
  add(checks, 'acts_safety_three_states_no_real_execution', low.status === 201 && high.status === 202 && dangerSafelyHeld && safetyStatesOk && noRealExecution, {
    low: { status: low.status || null, actStatus: low.data?.act?.status || null },
    high: { status: high.status || null, actStatus: high.data?.act?.status || null, approvalId: high.data?.act?.approvalId || null },
    danger: { status: danger.status || null, actStatus: danger.data?.act?.status || null },
    statuses,
    dangerSafelyHeld,
    dangerStateHeld,
    noRealExecution,
    realExecActs: (acts.data?.items || []).filter((item) => item.status === 'executed_real').length,
    error: low.error || high.error || danger.error || acts.error || low.data?.error || high.data?.error || danger.data?.error || acts.data?.error || null,
  });

  const delegatePlan = token
    ? await request(`${baseUrl}/api/noe/do`, { method: 'POST', token, requestTimeoutMs, body: { text: '让 Codex 帮我修复登录页 bug' } }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  const delegateConfirm = token
    ? await request(`${baseUrl}/api/noe/delegate/confirm`, { method: 'POST', token, requestTimeoutMs, body: { text: '让 Codex 帮我修复登录页 bug', confirm: true } }).catch((e) => ({ error: e.message }))
    : { error: 'missing owner token' };
  add(checks, 'delegate_confirm_creates_idle_room_only', delegatePlan.status === 200 && delegatePlan.data?.dryRunOnly === true && delegateConfirm.status === 201 && delegateConfirm.data?.room?.status === 'idle' && delegateConfirm.data?.started === false && delegateConfirm.data?.queued === false, {
    planStatus: delegatePlan.status || null,
    confirmStatus: delegateConfirm.status || null,
    dryRunOnly: delegatePlan.data?.dryRunOnly ?? null,
    roomId: delegateConfirm.data?.room?.id || null,
    roomStatus: delegateConfirm.data?.room?.status || null,
    started: delegateConfirm.data?.started ?? null,
    queued: delegateConfirm.data?.queued ?? null,
    error: delegatePlan.error || delegateConfirm.error || delegatePlan.data?.error || delegateConfirm.data?.error || null,
  });

  const m3 = await replayM3ColdReview().catch((e) => ({ ok: false, error: e.message }));
  add(checks, 'm3_cold_review_suggestion_only_contract', m3.ok === true && m3.task?.route?.route === 'minimax_m3_suggestion_only' && m3.task?.route?.localTools === false && Array.isArray(m3.plan?.diffs) && m3.plan.diffs.length === 0 && m3.finalAuthority === 'Claude/GPT-Codex', {
    ok: m3.ok ?? null,
    status: m3.status || null,
    route: m3.task?.route?.route || null,
    localTools: m3.task?.route?.localTools ?? null,
    finalAuthority: m3.finalAuthority || null,
    error: m3.error || null,
  });

  const page = await request(`${baseUrl}/cognitive.html`, { requestTimeoutMs }).catch((e) => ({ error: e.message }));
  const peopleAsset = await request(`${baseUrl}/src/web/cognitive-people.js`, { requestTimeoutMs }).catch((e) => ({ error: e.message }));
  const raw = page.raw || page.data?.raw || '';
  const peopleRaw = peopleAsset.raw || peopleAsset.data?.raw || '';
  add(checks, 'cognitive_page_core_entrypoints_present', page.status === 200 && raw.includes('/src/web/cognitive-research.js') && raw.includes('chat-input') && peopleAsset.status === 200 && peopleRaw.includes('dPeopleKb') && peopleRaw.includes('peopleSheet'), {
    status: page.status || null,
    peopleAssetStatus: peopleAsset.status || null,
    hasResearchScript: raw.includes('/src/web/cognitive-research.js'),
    hasChatInput: raw.includes('chat-input'),
    hasPeopleKbEntrypoint: peopleRaw.includes('dPeopleKb'),
    hasPeopleSheet: peopleRaw.includes('peopleSheet'),
    error: page.error || peopleAsset.error || null,
  });

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  return { checks, passed, failed, marker };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let managed = null;
  let baseUrl = args.baseUrl;
  let tokenPolicy = liveOwnerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  let token = tokenPolicy.token;
  let tokenSource = tokenPolicy.source;

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
      add(checks, 'owner_token_loaded', false, {
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
        note: 'Live replay did not read owner-token or call the live panel because neither explicit ack nor standing autonomy grant authorized it. Use --managed for isolated no-secret verification.',
      }, null, 2));
      console.log(`report=${REPORT}`);
      process.exitCode = 2;
      return;
    }
    const evidenceTokenSource = summarizeOwnerTokenSource({ source: tokenSource, managed: args.managed });
    const result = await runChecks({ baseUrl, token, tokenSource: evidenceTokenSource, requestTimeoutMs: args.requestTimeoutMs, managed: args.managed });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT, JSON.stringify({
      ok: result.failed === 0,
      mode: args.managed ? 'managed' : 'live',
      baseUrl,
      marker: result.marker,
      tokenPolicy: {
        source: evidenceTokenSource,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: Boolean(tokenPolicy.policyBlocked),
        reason: tokenPolicy.reason || '',
        secretValueReturned: false,
      },
      managed: managed ? {
        port: managed.port,
        isolatedHomeUsed: true,
        isolatedHomeKept: managed.keepHome,
        dbLocation: 'managed_isolated_home',
        ownerCredentialLocation: 'managed_isolated_home',
        node: managed.node,
        logTail: redact(managed.log.slice(-4000)),
      } : null,
      checks: result.checks,
      passed: result.passed,
      failed: result.failed,
      note: args.managed
        ? 'Managed replay starts an isolated temporary Noe server on a non-reserved port. It does not touch 51735/51835, approve jobs, start delegate agents, or call MiniMax M3 API for cold review.'
        : 'Live replay does not restart the panel, approve jobs, or start delegate agents; it may create temporary memory/person/act/idle-room data in the target Noe instance. Reading live owner-token requires explicit ack or standing autonomy grant.',
    }, null, 2));
    console.log(`report=${REPORT}`);
    if (result.failed > 0) process.exitCode = tokenPolicy.policyBlocked ? 2 : 1;
  } finally {
    await stopManaged(managed);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    mkdirSync(OUT_DIR, { recursive: true });
    const message = redact(e?.message || String(e));
    writeFileSync(REPORT, JSON.stringify({ ok: false, error: message }, null, 2));
    console.error(redact(e?.stack || e?.message || e));
    console.error(`report=${REPORT}`);
    process.exit(1);
  });
}
