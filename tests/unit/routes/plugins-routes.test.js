// @ts-check
// S23：plugins 路由从 server.js 提取后的行为锁定测试
import { describe, expect, it } from 'vitest';
import { registerPluginsRoutes } from '../../../src/server/routes/plugins.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete', 'patch', 'put']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

const allowAllGovernance = {
  evaluatePermission() { return { decision: 'allow' }; },
};

function makeFakeRegistry(overrides = {}) {
  return {
    list: () => [{ id: 'demo', displayName: 'Demo' }],
    get: () => null,
    install: () => ({ ok: false, error: 'not implemented' }),
    uninstall: () => ({ ok: false, error: 'not implemented' }),
    reload: () => [],
    ...overrides,
  };
}

function setup({ registry = makeFakeRegistry(), governance = allowAllGovernance } = {}) {
  const { app, routes } = makeApp();
  const recorded = [];
  registerPluginsRoutes(app, {
    pluginRegistry: registry,
    permissionGovernance: governance,
    safeResolveFsPath: (p) => (p.startsWith('/safe') ? p : null),
    metricsStore: { record: (m) => recorded.push(m) },
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
  });
  const find = (method, path) => routes.find((r) => r.method === method && r.path === path);
  // handlers[0] 是 requireOwnerToken 中间件，业务逻辑在最后一个 handler
  const invoke = async (method, path, req) => {
    const r = find(method, path);
    const res = makeRes();
    await r.handlers[r.handlers.length - 1](req, res);
    return res;
  };
  return { routes, invoke, recorded };
}

describe('plugins routes (S23 提取)', () => {
  it('注册全部 6 条路由且都挂 owner-token 中间件', () => {
    const { routes } = setup();
    const got = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(got).toEqual([
      'delete /api/plugins/:id',
      'get /api/plugins',
      'get /api/plugins/:id',
      'post /api/plugins/:id/exec',
      'post /api/plugins/install',
      'post /api/plugins/reload',
    ]);
    for (const r of routes) expect(r.handlers.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/plugins 返回 registry.list()', async () => {
    const { invoke } = setup();
    const res = await invoke('get', '/api/plugins', {});
    expect(res.payload).toEqual({ ok: true, plugins: [{ id: 'demo', displayName: 'Demo' }] });
  });

  it('GET /api/plugins/:id 非法 id → 400，不存在 → 404', async () => {
    const { invoke } = setup();
    expect((await invoke('get', '/api/plugins/:id', { params: { id: 'BAD ID!' } })).statusCode).toBe(400);
    expect((await invoke('get', '/api/plugins/:id', { params: { id: 'missing' } })).statusCode).toBe(404);
  });

  it('POST /api/plugins/install 剥掉 approvalId 字段后入 registry', async () => {
    let installed;
    const registry = makeFakeRegistry({
      install: (m) => { installed = m; return { ok: true, entry: { valid: true } }; },
    });
    const { invoke } = setup({ registry });
    const res = await invoke('post', '/api/plugins/install', {
      body: { id: 'demo', approvalId: 'a-1', permissionApprovalId: 'a-2', resumeApprovalId: 'a-3' },
    });
    expect(res.payload.ok).toBe(true);
    expect(installed).toEqual({ id: 'demo' });
  });

  it('DELETE /api/plugins/:id 内置插件 → 403', async () => {
    const registry = makeFakeRegistry({ uninstall: () => ({ ok: false, error: '内置 plugin 禁删' }) });
    const { invoke } = setup({ registry });
    const res = await invoke('delete', '/api/plugins/:id', { params: { id: 'builtin' } });
    expect(res.statusCode).toBe(403);
  });

  it('权限被拒时返回治理层 status/body，不触达 registry', async () => {
    let touched = false;
    const registry = makeFakeRegistry({ reload: () => { touched = true; return []; } });
    const governance = {
      evaluatePermission: () => ({ decision: 'ask', approval: { id: 'approval-x' } }),
    };
    const { invoke } = setup({ registry, governance });
    const res = await invoke('post', '/api/plugins/reload', { body: {}, get: () => '' });
    expect(res.statusCode).not.toBe(200);
    expect(touched).toBe(false);
  });

  it('POST /api/plugins/:id/exec — plugin 不可用 → 424；cwd 越权 → 403', async () => {
    const entry = { valid: false, error: 'bin 探测失败', manifest: { id: 'demo' }, source: 'user' };
    const registry = makeFakeRegistry({ get: () => entry });
    const { invoke } = setup({ registry });
    expect((await invoke('post', '/api/plugins/:id/exec', { params: { id: 'demo' }, body: {} })).statusCode).toBe(424);

    entry.valid = true;
    const res = await invoke('post', '/api/plugins/:id/exec', {
      params: { id: 'demo' },
      body: { commandId: 'run', cwd: '/etc/passwd' },
      get: () => '',
    });
    expect(res.statusCode).toBe(403);
  });
});
