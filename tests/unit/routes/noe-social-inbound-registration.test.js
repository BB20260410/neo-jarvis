import { describe, expect, it } from 'vitest';
import { registerNoeRoutes } from '../../../src/server/routes/noe.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function minimalDeps() {
  return {
    loop: { status: () => ({ state: 'stopped' }) },
    memory: {
      recall: () => [],
      write: (item) => item,
      stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }),
    },
    focus: { list: () => [], depth: () => 0 },
    toolRegistry: { list: () => [] },
    approvalStore: { listApprovals: () => [] },
    actStore: { list: () => [], summary: () => ({ pending: 0, current: null }) },
  };
}

describe('Noe social inbound route registration', () => {
  it('mounts BaiLongma-inspired social inbound endpoints through registerNoeRoutes', () => {
    const { app, routes } = makeApp();
    registerNoeRoutes(app, minimalDeps());
    expect(routes.find((r) => r.method === 'get' && r.path === '/api/noe/social-inbound/status')).toBeTruthy();
    expect(routes.find((r) => r.method === 'get' && r.path === '/api/noe/social-inbound/wechat-official')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/wechat-official')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/wecom')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/feishu')).toBeTruthy();
    expect(routes.find((r) => r.method === 'get' && r.path === '/api/noe/social-inbound/wechat-personal/status')).toBeTruthy();
    expect(routes.find((r) => r.method === 'get' && r.path === '/api/noe/social-inbound/wechat-personal/qr')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/wechat-personal/inbound-test')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/wechat-personal/outbound-dry-run')).toBeTruthy();
    expect(routes.find((r) => r.method === 'get' && r.path === '/api/noe/social-inbound/qq/research-gate')).toBeTruthy();
    expect(routes.find((r) => r.method === 'post' && r.path === '/api/noe/social-inbound/qq/dry-run')).toBeTruthy();
  });
});
