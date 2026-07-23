#!/usr/bin/env node
/**
 * Noe · xAI SuperGrok OAuth 可行性探针（B 方案）
 *
 * 只做：设备码登录 → 存 token → 单次推理探测。
 * 不接 server 主脑 / 心跳 / 反刍（全量接入等探针通过后再谈）。
 *
 * 用法：
 *   node scripts/noe-xai-oauth-probe.mjs status
 *   node scripts/noe-xai-oauth-probe.mjs login          # 设备码，打印 URL + 打开浏览器
 *   node scripts/noe-xai-oauth-probe.mjs probe          # 用已存 token 发 1 次 chat
 *   node scripts/noe-xai-oauth-probe.mjs all            # login + probe
 *   node scripts/noe-xai-oauth-probe.mjs refresh        # 刷新 access_token
 *
 * Token 落盘：~/.noe-panel/xai-oauth.json（0600）。绝不打印 token 明文。
 *
 * 协议对齐 Grok CLI / Hermes / OpenClaw 公开 client_id（公开 OAuth 客户端）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const XAI_API_BASE = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
const UA = 'Noe-xAI-OAuth-Probe/1.0 (+local; SuperGrok pool feasibility)';
const STORE_DIR = join(homedir(), '.noe-panel');
const STORE_PATH = join(STORE_DIR, 'xai-oauth.json');
const DEFAULT_MODELS = (
  process.env.NOE_XAI_OAUTH_PROBE_MODELS
  || process.env.NOE_XAI_MODEL
  || 'grok-4,grok-build-0.1,grok-3-mini'
).split(',').map((s) => s.trim()).filter(Boolean);

function log(msg) {
  console.log(msg);
}

function die(msg, code = 1) {
  console.error(`❌ ${msg}`);
  process.exit(code);
}

function isTrustedXaiUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'x.ai' || u.hostname.endsWith('.x.ai'));
  } catch {
    return false;
  }
}

function requireTrusted(url, label) {
  if (!isTrustedXaiUrl(url)) throw new Error(`untrusted ${label}: ${url}`);
  return url;
}

async function readJson(res, context) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body?.error_description || body?.error || body?.message || '';
    const detail = typeof err === 'string' ? err : JSON.stringify(err).slice(0, 200);
    throw new Error(`${context} failed HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return body || {};
}

function formBody(obj) {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== '')),
  ).toString();
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function maskToken(t) {
  const s = String(t || '');
  if (s.length < 12) return s ? '***' : '';
  return `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})`;
}

function loadStore() {
  if (!existsSync(STORE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 ${STORE_PATH}: ${e.message}`);
  }
}

function saveStore(data) {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(STORE_DIR, 0o700); } catch { /* ignore */ }
  const tmp = `${STORE_PATH}.tmp.${process.pid}`;
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    issuer: XAI_OAUTH_ISSUER,
    clientId: XAI_OAUTH_CLIENT_ID,
    apiBase: XAI_API_BASE,
    ...data,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, STORE_PATH);
  try { chmodSync(STORE_PATH, 0o600); } catch { /* ignore */ }
  return payload;
}

async function fetchDiscovery() {
  const res = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readJson(res, 'OAuth discovery');
  return {
    authorizationEndpoint: requireTrusted(json.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: requireTrusted(json.token_endpoint, 'token_endpoint'),
    deviceAuthorizationEndpoint: json.device_authorization_endpoint
      ? requireTrusted(json.device_authorization_endpoint, 'device_authorization_endpoint')
      : null,
  };
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

function parseTokens(json) {
  const accessToken = json.access_token;
  if (!accessToken) throw new Error('token 响应缺少 access_token');
  const refreshToken = json.refresh_token || null;
  const idToken = json.id_token || null;
  const expiresIn = Number(json.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : (decodeJwtPayload(accessToken).exp ? decodeJwtPayload(accessToken).exp * 1000 : null);
  const claims = decodeJwtPayload(idToken || accessToken);
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    tokenType: json.token_type || 'Bearer',
    scope: json.scope || XAI_OAUTH_SCOPE,
    identity: {
      sub: claims.sub || null,
      email: claims.email || null,
      name: claims.name || claims.preferred_username || null,
    },
  };
}

async function deviceCodeLogin({ noBrowser = false } = {}) {
  log('—— xAI SuperGrok OAuth 探针：设备码登录 ——');
  const disc = await fetchDiscovery();
  if (!disc.deviceAuthorizationEndpoint) {
    die('discovery 未提供 device_authorization_endpoint，无法走设备码。可改用 hermes auth add xai-oauth（loopback PKCE）');
  }

  const res = await fetch(disc.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: formBody({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readJson(res, 'device code request');
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = requireTrusted(json.verification_uri, 'verification_uri');
  const verificationUriComplete = json.verification_uri_complete && isTrustedXaiUrl(json.verification_uri_complete)
    ? json.verification_uri_complete
    : null;
  const expiresInMs = (Number(json.expires_in) || 600) * 1000;
  let intervalMs = Math.max(1000, (Number(json.interval) || 5) * 1000);

  log('');
  log('请在浏览器完成授权（用你的 SuperGrok / Premium+ 账号）：');
  log(`  验证 URL : ${verificationUriComplete || verificationUri}`);
  log(`  用户代码 : ${userCode}`);
  log(`  有效期约 : ${Math.round(expiresInMs / 1000)}s`);
  log('');
  if (!noBrowser) {
    openBrowser(verificationUriComplete || verificationUri);
    log('已尝试打开浏览器。若未弹出，请手动打开上面的 URL。');
  }
  log('等待你在浏览器点 Allow…（本进程轮询中）');

  const deadline = Date.now() + expiresInMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tres = await fetch(disc.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: formBody({
        grant_type: XAI_DEVICE_CODE_GRANT,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    let body = null;
    try {
      body = await tres.json();
    } catch {
      body = null;
    }
    if (tres.ok) {
      const tokens = parseTokens(body);
      if (!tokens.refreshToken) {
        log('⚠️ 未拿到 refresh_token（可能 offline_access 被拒）；access 过期后需重新 login');
      }
      saveStore({
        authMethod: 'device_code',
        tokenEndpoint: disc.tokenEndpoint,
        ...tokens,
      });
      log('');
      log('✅ 登录成功，token 已写入 ~/.noe-panel/xai-oauth.json（0600）');
      log(`   access  : ${maskToken(tokens.accessToken)}`);
      log(`   refresh : ${tokens.refreshToken ? maskToken(tokens.refreshToken) : '(none)'}`);
      log(`   expires : ${tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'unknown'}`);
      log(`   identity: ${JSON.stringify(tokens.identity)}`);
      return tokens;
    }
    const err = body?.error;
    if (err === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }
    if (err === 'slow_down') {
      intervalMs += 5000;
      process.stdout.write('s');
      continue;
    }
    if (err === 'access_denied' || err === 'authorization_denied') {
      die('你在浏览器拒绝了授权');
    }
    if (err === 'expired_token') die('设备码已过期，请重新 login');
    const desc = body?.error_description || err || tres.status;
    die(`token 交换失败: ${desc}`);
  }
  die('等待授权超时，请重新 login');
}

async function refreshAccessToken(store = loadStore()) {
  if (!store?.refreshToken) throw new Error('无 refresh_token，请重新 login');
  const disc = await fetchDiscovery();
  const res = await fetch(disc.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: formBody({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: store.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readJson(res, 'refresh_token');
  const tokens = parseTokens(json);
  // 有的 IdP 轮换 refresh；没有则沿用旧的
  if (!tokens.refreshToken) tokens.refreshToken = store.refreshToken;
  const next = saveStore({
    ...store,
    authMethod: store.authMethod || 'device_code',
    tokenEndpoint: disc.tokenEndpoint,
    ...tokens,
  });
  log(`✅ access_token 已刷新 → ${maskToken(tokens.accessToken)}`);
  return next;
}

async function ensureAccessToken() {
  let store = loadStore();
  if (!store?.accessToken) throw new Error('尚未登录。请先: node scripts/noe-xai-oauth-probe.mjs login');
  const skew = 120_000;
  if (store.expiresAt && Date.now() > store.expiresAt - skew) {
    if (store.refreshToken) {
      log('access 将过期，尝试 refresh…');
      store = await refreshAccessToken(store);
    } else {
      throw new Error('access 已过期且无 refresh_token，请重新 login');
    }
  }
  return store;
}

async function probeOnce(model, accessToken) {
  const url = `${XAI_API_BASE.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  const ms = Date.now() - started;
  const reply = body?.choices?.[0]?.message?.content
    || body?.choices?.[0]?.text
    || body?.output_text
    || null;
  return {
    model,
    status: res.status,
    ok: res.ok,
    ms,
    reply: reply ? String(reply).slice(0, 120) : null,
    error: body?.error || body?.message || (!res.ok ? text.slice(0, 280) : null),
  };
}

async function probeInference() {
  log('—— xAI SuperGrok OAuth 探针：单次推理 ——');
  const store = await ensureAccessToken();
  const results = [];
  for (const model of DEFAULT_MODELS) {
    log(`→ 试模型 ${model} …`);
    try {
      const r = await probeOnce(model, store.accessToken);
      results.push(r);
      if (r.ok) {
        log(`  ✅ HTTP ${r.status} ${r.ms}ms reply=${JSON.stringify(r.reply)}`);
        break; // 有一个成功即可
      }
      log(`  ❌ HTTP ${r.status} ${r.ms}ms err=${JSON.stringify(r.error).slice(0, 240)}`);
    } catch (e) {
      const r = { model, status: 0, ok: false, ms: 0, reply: null, error: String(e?.message || e) };
      results.push(r);
      log(`  ❌ ${r.error}`);
    }
  }

  const anyOk = results.some((r) => r.ok);
  const only403 = results.length > 0 && results.every((r) => r.status === 403);
  log('');
  log('======== 探针结论 ========');
  if (anyOk) {
    log('VERDICT: PASS — OAuth 登录有效，且至少 1 个模型推理成功（扣会员池/订阅面的可能性高）。');
    log('下一步：可讨论 Neo 全量接入（主脑槽位 + 强节流；禁止 5s 反刍直烧池）。');
  } else if (only403) {
    log('VERDICT: LOGIN_OK_INFER_403 — 登录成功但推理被拒。');
    log('常见原因：会员档不在 OAuth API 白名单（如仅 Heavy 放开）、周额度用尽、team entitlement 不对。');
    log('建议：仍走 console API credits；或升级档位后再探。');
  } else {
    log('VERDICT: FAIL — 登录或推理未通过，见上方 HTTP 详情。');
  }
  log(JSON.stringify({
    store: STORE_PATH,
    identity: store.identity,
    results: results.map((r) => ({
      model: r.model,
      status: r.status,
      ok: r.ok,
      ms: r.ms,
      reply: r.reply,
      error: typeof r.error === 'string' ? r.error.slice(0, 200) : r.error,
    })),
  }, null, 2));
  process.exit(anyOk ? 0 : 2);
}

function cmdStatus() {
  const store = loadStore();
  if (!store) {
    log('status: NOT_LOGGED_IN');
    log(`store : ${STORE_PATH} (missing)`);
    return;
  }
  const exp = store.expiresAt ? new Date(store.expiresAt).toISOString() : null;
  const expired = store.expiresAt ? Date.now() > store.expiresAt : null;
  log('status: LOGGED_IN');
  log(`store   : ${STORE_PATH}`);
  log(`method  : ${store.authMethod || '?'}`);
  log(`access  : ${maskToken(store.accessToken)}`);
  log(`refresh : ${store.refreshToken ? maskToken(store.refreshToken) : '(none)'}`);
  log(`expires : ${exp || '?'} ${expired === true ? '(EXPIRED)' : expired === false ? '(valid)' : ''}`);
  log(`identity: ${JSON.stringify(store.identity || {})}`);
  log(`updated : ${store.updatedAt || '?'}`);
}

async function main() {
  const cmd = (process.argv[2] || 'help').toLowerCase();
  const noBrowser = process.argv.includes('--no-browser');
  try {
    if (cmd === 'status') {
      cmdStatus();
      return;
    }
    if (cmd === 'login') {
      await deviceCodeLogin({ noBrowser });
      return;
    }
    if (cmd === 'refresh') {
      await refreshAccessToken();
      return;
    }
    if (cmd === 'probe') {
      await probeInference();
      return;
    }
    if (cmd === 'all') {
      await deviceCodeLogin({ noBrowser });
      await probeInference();
      return;
    }
    log(`用法:
  node scripts/noe-xai-oauth-probe.mjs status
  node scripts/noe-xai-oauth-probe.mjs login [--no-browser]
  node scripts/noe-xai-oauth-probe.mjs probe
  node scripts/noe-xai-oauth-probe.mjs all [--no-browser]
  node scripts/noe-xai-oauth-probe.mjs refresh`);
  } catch (e) {
    die(e?.message || String(e));
  }
}

main();
