import { describe, it, expect, beforeEach, vi } from 'vitest';

// P10（2026-07-02）：涉钱链路补测试——commercial-setup 此前零测试（暴露敏感文件存在性的端点）。
vi.mock('../../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => { if (typeof next === 'function') next(); },
}));

import { registerCommercialSetupRoutes, resetCommercialStatusCacheForTest } from '../../../src/server/routes/commercial-setup.js';

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

describe('src/server/routes/commercial-setup.js', () => {
  let app;
  beforeEach(() => {
    resetCommercialStatusCacheForTest();
    app = createApp();
    registerCommercialSetupRoutes(app);
  });

  it('注册 status/next-step 且带 owner-token 中间件（端点暴露敏感文件存在性）', () => {
    expect(app.routes['/api/commercial/status']?.get?.length).toBeGreaterThanOrEqual(2);
    expect(app.routes['/api/commercial/next-step']?.get?.length).toBeGreaterThanOrEqual(2);
  });

  it('status：返回稳定形状（total/done/percent/items/externalSteps）', async () => {
    const res = await runHandlers(app.routes['/api/commercial/status'].get, {});
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.percent).toBeGreaterThanOrEqual(0);
    expect(res.body.percent).toBeLessThanOrEqual(100);
    expect(res.body.items).toBeTypeOf('object');
    expect(Array.isArray(res.body.externalSteps.tasks)).toBe(true);
  });

  it('next-step：要么 allDone 要么给出下一步 key+hint', async () => {
    const res = await runHandlers(app.routes['/api/commercial/next-step'].get, {});
    expect(res.body.ok).toBe(true);
    if (res.body.allDone) {
      expect(res.body.nextAction).toBeTruthy();
    } else {
      expect(res.body.nextKey).toBeTruthy();
      expect(res.body.nextHint).toBeTruthy();
    }
  });
});
