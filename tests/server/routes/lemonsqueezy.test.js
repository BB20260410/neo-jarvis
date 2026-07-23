import { describe, it, expect, beforeEach, vi } from 'vitest';

// P10（2026-07-02）：涉钱链路补测试——lemonsqueezy 路由此前零测试（95% 覆盖率里最危险的 5%）。
vi.mock('../../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => { if (typeof next === 'function') next(); },
}));
vi.mock('../../../src/integrations/LemonSqueezyClient.js', () => ({
  healthCheck: vi.fn(async () => ({ ok: true, configured: false })),
  listStores: vi.fn(async () => ({ data: [{ id: 's1', attributes: { name: 'Neo Store', domain: 'neo.lemonsqueezy.com', url: 'https://x', country: 'US', plan: 'fresh' } }] })),
  listProducts: vi.fn(async () => ({ data: [] })),
  listOrders: vi.fn(async () => ({ data: [] })),
  listWebhooks: vi.fn(async () => ({ data: [] })),
}));

import * as LS from '../../../src/integrations/LemonSqueezyClient.js';
import { registerLemonSqueezyRoutes } from '../../../src/server/routes/lemonsqueezy.js';

function createApp() {
  const routes = {};
  return {
    routes,
    get(path, ...handlers) { routes[path] = { ...(routes[path] || {}), get: handlers }; },
    post(path, ...handlers) { routes[path] = { ...(routes[path] || {}), post: handlers }; },
  };
}
function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
async function runHandlers(handlers, req) {
  const res = createRes();
  for (const h of handlers) {
    let advanced = false;
    const result = h(req, res, () => { advanced = true; });
    if (result && typeof result.then === 'function') await result;
    if (!advanced && res.body !== undefined) break;
  }
  return res;
}

describe('src/server/routes/lemonsqueezy.js', () => {
  let app;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    registerLemonSqueezyRoutes(app);
  });

  it('注册全部 LS 端点且全部带 owner-token 中间件（配额+买家邮箱保护）', () => {
    for (const p of ['/api/lemonsqueezy/health', '/api/lemonsqueezy/stores', '/api/lemonsqueezy/products', '/api/lemonsqueezy/orders', '/api/lemonsqueezy/webhooks']) {
      expect(app.routes[p]?.get?.length).toBeGreaterThanOrEqual(2);
    }
    expect(app.routes['/api/lemonsqueezy/webhook-auto-register']?.post?.length).toBeGreaterThanOrEqual(2);
  });

  it('stores：把 LS API 原始形状映射为 UI 精简形状', async () => {
    const res = await runHandlers(app.routes['/api/lemonsqueezy/stores'].get, { query: {} });
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.stores[0]).toMatchObject({ id: 's1', name: 'Neo Store', country: 'US' });
  });

  it('client 抛错 → 500 {ok:false}（不泄内部栈）', async () => {
    LS.listStores.mockRejectedValueOnce(new Error('ls down'));
    const res = await runHandlers(app.routes['/api/lemonsqueezy/stores'].get, { query: {} });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'ls down' });
  });
});
