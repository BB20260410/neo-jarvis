// Noe v2.0 — Lemon Squeezy API client
// Token 存在 ~/.noe-panel/lemonsqueezy-key.txt (0o600)，永不进 LLM 对话

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_PATH = path.join(os.homedir(), '.noe-panel', 'lemonsqueezy-key.txt');
const API_BASE = 'https://api.lemonsqueezy.com/v1';

// 出站 HTTP 请求统一超时（防止 LS 接口无响应导致 fetch 永久挂起）
const DEFAULT_TIMEOUT_MS = 15000;
let currentTimeoutMs = DEFAULT_TIMEOUT_MS;

export function setRequestTimeout(ms) {
  if (typeof ms !== 'number' || ms <= 0) {
    throw new Error('setRequestTimeout: ms 必须是正数');
  }
  currentTimeoutMs = ms;
}

export function getRequestTimeout() {
  return currentTimeoutMs;
}

export function resetRequestTimeout() {
  currentTimeoutMs = DEFAULT_TIMEOUT_MS;
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return fs.readFileSync(TOKEN_PATH, 'utf8').split('\n')[0].trim();
}

// 必填参数校验：缺失/为空/null 全部抛错，避免下游 fetch 出 4xx 才暴露问题
function assertRequired(args, fields, methodName) {
  for (const field of fields) {
    const value = args?.[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`${methodName}: 必填参数 "${field}" 缺失或为空`);
    }
  }
}

async function lsFetch(path, opts = {}) {
  const token = loadToken();
  if (!token) throw new Error('LS token 不存在，请把 token 复制到 ~/.noe-panel/lemonsqueezy-key.txt');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.api+json',
    ...(opts.body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
    ...(opts.headers || {}),
  };
  const r = await fetch(API_BASE + path, { ...opts, headers, signal: AbortSignal.timeout(currentTimeoutMs) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LS API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// === 用户 / store ===
export async function getMe() {
  return lsFetch('/users/me');
}

export async function listStores() {
  return lsFetch('/stores');
}

export async function getStore(storeId) {
  assertRequired({ storeId }, ['storeId'], 'getStore');
  return lsFetch(`/stores/${storeId}`);
}

// === Products / Variants ===
export async function listProducts({ storeId } = {}) {
  const url = storeId ? `/stores/${storeId}/products` : '/products';
  return lsFetch(url);
}

export async function listVariants({ productId } = {}) {
  const url = productId ? `/products/${productId}/variants` : '/variants';
  return lsFetch(url);
}

// === Orders / Subscriptions ===
export async function listOrders({ storeId, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  params.set('page[size]', String(limit));
  return lsFetch(`/orders?${params}`);
}

export async function getOrder(orderId) {
  assertRequired({ orderId }, ['orderId'], 'getOrder');
  return lsFetch(`/orders/${orderId}`);
}

// === Webhooks ===
export async function listWebhooks({ storeId } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  return lsFetch(`/webhooks?${params}`);
}

export async function createWebhook({ storeId, url, secret, events = ['order_created', 'subscription_created', 'subscription_payment_success'], testMode = false }) {
  assertRequired({ storeId, url, secret }, ['storeId', 'url', 'secret'], 'createWebhook');
  return lsFetch('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'webhooks',
        attributes: {
          url,
          events,
          secret,
          test_mode: testMode,
        },
        relationships: {
          store: { data: { type: 'stores', id: String(storeId) } },
        },
      },
    }),
  });
}

export async function deleteWebhook(webhookId) {
  assertRequired({ webhookId }, ['webhookId'], 'deleteWebhook');
  // L7 修复：原先忽略 HTTP 状态，删除失败（401/404/5xx）也返回 {ok:true}，调用方误以为已删。
  const resp = await fetch(`${API_BASE}/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${loadToken()}`,
      'Accept': 'application/vnd.api+json',
    },
    signal: AbortSignal.timeout(currentTimeoutMs),
  });
  if (!resp.ok) {
    return { ok: false, deleted: null, status: resp.status, error: `delete webhook failed: HTTP ${resp.status}` };
  }
  return { ok: true, deleted: webhookId };
}

// === License keys (LS 自己的 license 系统，可选用 ===
export async function listLicenseKeys({ storeId, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (storeId) params.set('filter[store_id]', storeId);
  params.set('page[size]', String(limit));
  return lsFetch(`/license-keys?${params}`);
}

// === Checkouts (创建临时 checkout link) ===
export async function createCheckout({ storeId, variantId, customData = {}, productOptions = {}, checkoutOptions = {} }) {
  assertRequired({ storeId, variantId }, ['storeId', 'variantId'], 'createCheckout');
  return lsFetch('/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          custom_price: null,
          product_options: productOptions,
          checkout_options: checkoutOptions,
          checkout_data: { custom: customData },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(storeId) } },
          variant: { data: { type: 'variants', id: String(variantId) } },
        },
      },
    }),
  });
}

// === 健康检查（仅元数据，不暴露 token）===
export async function healthCheck() {
  try {
    const me = await getMe();
    const stores = await listStores();
    return {
      ok: true,
      user: me.data?.attributes?.email || null,
      storesCount: stores.data?.length || 0,
      tokenStored: true,
    };
  } catch (e) {
    return { ok: false, error: e.message, tokenStored: fs.existsSync(TOKEN_PATH) };
  }
}
