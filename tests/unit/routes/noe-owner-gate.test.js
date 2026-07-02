// @ts-check
// Noe owner-gate 路由防回归：配置读写端点必须挂 owner-token，测试全程使用隔离 HOME。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

const find = (routes, method, path) => routes.find((route) => route.method === method && route.path === path);
const handlerOf = (route) => route.handlers[route.handlers.length - 1];

async function withIsolatedHome(callback) {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'noe-owner-gate-home-'));
  try {
    process.env.HOME = home;
    vi.resetModules();
    const [{ requireOwnerToken }, { registerNoeOwnerGateRoutes }, { OwnerGateStore }] = await Promise.all([
      import('../../../src/server/auth/owner-token.js'),
      import('../../../src/server/routes/noeOwnerGate.js'),
      import('../../../src/voice/OwnerGateStore.js'),
    ]);
    return await callback({ home, requireOwnerToken, registerNoeOwnerGateRoutes, OwnerGateStore });
  } finally {
    process.env.HOME = oldHome;
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Noe owner-gate routes', () => {
  it('GET/POST /api/noe/owner-gate 都挂 owner-token 中间件', async () => withIsolatedHome(async ({ requireOwnerToken, registerNoeOwnerGateRoutes }) => {
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, {
      ownerGateStore: { publicConfig: () => ({}), status: () => ({}) },
      sendError: vi.fn(),
    });

    expect(find(routes, 'get', '/api/noe/owner-gate').handlers[0]).toBe(requireOwnerToken);
    expect(find(routes, 'post', '/api/noe/owner-gate').handlers[0]).toBe(requireOwnerToken);
  }));

  it('owner-token 中间件在隔离 HOME 下无 token 实际返回 401', async () => withIsolatedHome(async ({ home, registerNoeOwnerGateRoutes }) => {
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, {
      ownerGateStore: { publicConfig: () => ({}), status: () => ({}) },
      sendError: vi.fn(),
    });

    const res = makeRes();
    find(routes, 'get', '/api/noe/owner-gate').handlers[0]({ get: () => undefined }, res, () => {
      throw new Error('owner token guard should short-circuit without token');
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.payload)).toContain('owner token');
    expect(existsSync(join(home, '.noe-panel', 'owner-token.txt'))).toBe(true);
  }));

  it('GET 返回 publicConfig 和 status，不调用 update', async () => withIsolatedHome(async ({ registerNoeOwnerGateRoutes }) => {
    const ownerGateStore = {
      publicConfig: vi.fn(() => ({ mode: 'owner_supervised', enabled: true })),
      status: vi.fn(() => ({ ready: true, policy: 'strict' })),
      update: vi.fn(),
    };
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError: vi.fn() });

    const res = makeRes();
    handlerOf(find(routes, 'get', '/api/noe/owner-gate'))({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      ok: true,
      config: { mode: 'owner_supervised', enabled: true },
      status: { ready: true, policy: 'strict' },
    });
    expect(ownerGateStore.update).not.toHaveBeenCalled();
  }));

  it('POST 使用真实 OwnerGateStore 白名单化请求 body，并以 0600 保存', async () => withIsolatedHome(async ({ home, registerNoeOwnerGateRoutes, OwnerGateStore }) => {
    const file = join(home, 'owner-gate.json');
    const ownerGateStore = new OwnerGateStore({ file, env: {} });
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError: vi.fn() });

    const res = makeRes();
    handlerOf(find(routes, 'post', '/api/noe/owner-gate'))({
      body: {
        enabled: true,
        wakeWords: '宝贝,贾维斯',
        passphrases: '主人口令',
        ignoredSecret: 'must-not-echo',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      ok: true,
      config: {
        enabled: true,
        wakeWords: ['宝贝', '贾维斯'],
        passphrases: [],
        passphrasesConfigured: true,
        passphraseCount: 1,
        secretValuesReturned: false,
      },
      status: { enabled: true, wakeWords: 2, passphrases: 1 },
    });
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('must-not-echo');
    expect(JSON.stringify(res.payload)).not.toContain('主人口令');
    expect(JSON.stringify(res.payload)).not.toContain('must-not-echo');
  }));

  it('POST 省略 passphrases 时保留既有口令但不回显原值', async () => withIsolatedHome(async ({ home, registerNoeOwnerGateRoutes, OwnerGateStore }) => {
    const file = join(home, 'owner-gate.json');
    const ownerGateStore = new OwnerGateStore({ file, env: {} });
    ownerGateStore.update({ enabled: true, wakeWords: '宝贝', passphrases: '主人口令' });
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError: vi.fn() });

    const res = makeRes();
    handlerOf(find(routes, 'post', '/api/noe/owner-gate'))({
      body: {
        enabled: true,
        wakeWords: '宝贝,贾维斯',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.config).toMatchObject({
      enabled: true,
      wakeWords: ['宝贝', '贾维斯'],
      passphrases: [],
      passphrasesConfigured: true,
      passphraseCount: 1,
      secretValuesReturned: false,
    });
    expect(ownerGateStore.check('主人口令 帮我看一下').ok).toBe(true);
    expect(JSON.stringify(res.payload)).not.toContain('主人口令');
  }));

  it('POST 显式传 passphrases 为空字符串时清空旧口令', async () => withIsolatedHome(async ({ home, registerNoeOwnerGateRoutes, OwnerGateStore }) => {
    const file = join(home, 'owner-gate.json');
    const ownerGateStore = new OwnerGateStore({ file, env: {} });
    ownerGateStore.update({ enabled: true, wakeWords: '宝贝', passphrases: '主人口令' });
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError: vi.fn() });

    const res = makeRes();
    handlerOf(find(routes, 'post', '/api/noe/owner-gate'))({
      body: {
        enabled: true,
        wakeWords: '宝贝',
        passphrases: '',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.config).toMatchObject({
      enabled: true,
      wakeWords: ['宝贝'],
      passphrases: [],
      passphrasesConfigured: false,
      passphraseCount: 0,
      secretValuesReturned: false,
    });
    expect(ownerGateStore.check('主人口令 帮我看一下').ok).toBe(false);
  }));

  it('store 抛错时走 sendError，避免路由吞错或输出堆栈', async () => withIsolatedHome(async ({ registerNoeOwnerGateRoutes }) => {
    const error = new Error('store failed');
    const sendError = vi.fn((res, err) => res.status(500).json({ ok: false, error: err.message }));
    const { app, routes } = makeApp();
    registerNoeOwnerGateRoutes(app, {
      ownerGateStore: {
        publicConfig: vi.fn(() => { throw error; }),
        status: vi.fn(),
      },
      sendError,
    });

    const res = makeRes();
    handlerOf(find(routes, 'get', '/api/noe/owner-gate'))({}, res);

    expect(sendError).toHaveBeenCalledWith(res, error);
    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({ ok: false, error: 'store failed' });
  }));
});
