// @ts-check
// NoeXaiAuth — xAI 凭证解析（SuperGrok OAuth 优先，API Key 兜底）
//
// Token 文件：~/.noe-panel/xai-oauth.json（由 scripts/noe-xai-oauth-probe.mjs login 写入）
// 本模块只读/刷新，不负责浏览器登录；绝不把 token 打进日志。

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration';
const STORE_DIR = join(homedir(), '.noe-panel');
const STORE_PATH = join(STORE_DIR, 'xai-oauth.json');
const REFRESH_SKEW_MS = 120_000;
const UA = 'Noe-xAI-Auth/1.0';

/** @type {{ accessToken: string, expiresAt: number|null, source: string } | null} */
let memCache = null;
/** @type {Promise<string> | null} */
let inflightRefresh = null;

function isTrustedXaiUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'x.ai' || u.hostname.endsWith('.x.ai'));
  } catch {
    return false;
  }
}

function loadStore() {
  if (!existsSync(STORE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveStore(store) {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(STORE_DIR, 0o700); } catch { /* ignore */ }
  const tmp = `${STORE_PATH}.tmp.${process.pid}`;
  const payload = { ...store, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, STORE_PATH);
  try { chmodSync(STORE_PATH, 0o600); } catch { /* ignore */ }
  return payload;
}

/**
 * 是否具备任意 xAI 凭证（OAuth 文件或 API Key）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hasXaiCredentials(env = process.env) {
  if (String(env.XAI_API_KEY || env.NOE_XAI_API_KEY || '').trim()) return true;
  const s = loadStore();
  return Boolean(s?.accessToken || s?.refreshToken);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, mode: 'oauth'|'api_key'|'off', model: string, reasoningEffort: string, baseUrl: string }}
 */
export function resolveXaiBrainConfig(env = process.env) {
  const flag = env.NOE_USE_XAI_BRAIN === '1';
  const has = hasXaiCredentials(env);
  const oauth = Boolean(loadStore()?.accessToken || loadStore()?.refreshToken);
  const apiKey = Boolean(String(env.XAI_API_KEY || env.NOE_XAI_API_KEY || '').trim());
  const mode = !flag || !has ? 'off' : (oauth ? 'oauth' : (apiKey ? 'api_key' : 'off'));
  return {
    enabled: mode !== 'off',
    mode,
    model: String(env.NOE_XAI_MODEL || env.NOE_LMSTUDIO_MODEL || 'grok-4.5').trim() || 'grok-4.5',
    reasoningEffort: String(env.NOE_XAI_REASONING_EFFORT || env.NOE_REASONING_EFFORT || 'high').trim().toLowerCase() || 'high',
    baseUrl: String(env.XAI_BASE_URL || env.NOE_XAI_BASE_URL || 'https://api.x.ai/v1').trim() || 'https://api.x.ai/v1',
  };
}

async function fetchTokenEndpoint() {
  const res = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`xAI OAuth discovery HTTP ${res.status}`);
  const json = await res.json();
  const tokenEndpoint = json?.token_endpoint;
  if (typeof tokenEndpoint !== 'string' || !isTrustedXaiUrl(tokenEndpoint)) {
    throw new Error('xAI OAuth discovery missing trusted token_endpoint');
  }
  return tokenEndpoint;
}

function decodeJwtExpMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshOAuthStore(store) {
  if (!store?.refreshToken) throw new Error('xAI OAuth 无 refresh_token，请重新 npm run noe:xai-oauth:login');
  const tokenEndpoint = store.tokenEndpoint && isTrustedXaiUrl(store.tokenEndpoint)
    ? store.tokenEndpoint
    : await fetchTokenEndpoint();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: store.refreshToken,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error_description || json?.error || res.status;
    throw new Error(`xAI OAuth refresh failed: ${err}`);
  }
  const accessToken = json.access_token;
  if (!accessToken) throw new Error('xAI OAuth refresh 未返回 access_token');
  const expiresIn = Number(json.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : (decodeJwtExpMs(accessToken) || null);
  const next = saveStore({
    ...store,
    accessToken,
    refreshToken: json.refresh_token || store.refreshToken,
    idToken: json.id_token || store.idToken || null,
    expiresAt,
    tokenType: json.token_type || 'Bearer',
    tokenEndpoint,
  });
  memCache = { accessToken, expiresAt, source: 'oauth' };
  return next.accessToken;
}

/**
 * 解析当前可用的 Bearer token（自动 refresh）。
 * 优先 OAuth 文件，其次 XAI_API_KEY。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function resolveXaiAccessToken(env = process.env) {
  const apiKey = String(env.XAI_API_KEY || env.NOE_XAI_API_KEY || '').trim();
  const store = loadStore();

  // OAuth 优先（会员池）
  if (store?.accessToken || store?.refreshToken) {
    const expiresAt = store.expiresAt || decodeJwtExpMs(store.accessToken);
    const stillValid = store.accessToken && (!expiresAt || Date.now() < expiresAt - REFRESH_SKEW_MS);
    if (stillValid) {
      memCache = { accessToken: store.accessToken, expiresAt: expiresAt || null, source: 'oauth' };
      return store.accessToken;
    }
    if (store.refreshToken) {
      if (!inflightRefresh) {
        inflightRefresh = refreshOAuthStore(store)
          .catch((e) => {
            // refresh 失败时若还有 api key 可兜底
            if (apiKey) {
              console.warn(`[noe-xai-auth] OAuth refresh 失败，回退 API key：${e?.message || e}`);
              return apiKey;
            }
            throw e;
          })
          .finally(() => { inflightRefresh = null; });
      }
      return inflightRefresh;
    }
  }

  if (apiKey) {
    memCache = { accessToken: apiKey, expiresAt: null, source: 'api_key' };
    return apiKey;
  }
  throw new Error('无 xAI 凭证：请 npm run noe:xai-oauth:login 或配置 XAI_API_KEY');
}

/**
 * 同步窥视（不 refresh；仅供诊断）。
 */
export function peekXaiAuthStatus(env = process.env) {
  const store = loadStore();
  const apiKey = Boolean(String(env.XAI_API_KEY || env.NOE_XAI_API_KEY || '').trim());
  return {
    storePath: STORE_PATH,
    hasOAuthAccess: Boolean(store?.accessToken),
    hasOAuthRefresh: Boolean(store?.refreshToken),
    oauthExpiresAt: store?.expiresAt || null,
    oauthExpired: store?.expiresAt ? Date.now() > store.expiresAt : null,
    hasApiKey: apiKey,
    identity: store?.identity || null,
    memSource: memCache?.source || null,
  };
}
