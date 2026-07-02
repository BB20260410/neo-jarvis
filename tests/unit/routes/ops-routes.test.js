// @ts-check
// S23：ops 域 4 条路由从 server.js 提取后的行为锁定测试（src/server/routes/ops.js）
// GET /api/metrics/health、DELETE /api/metrics、GET /api/health/processes、POST /api/login-claude
// 注意：login-claude handler 会真 spawn osascript 打开 Terminal，单测只验证注册不 invoke；
// DELETE /api/metrics 合法分支会真删 ~/.noe-panel 下文件，单测只打 400 校验分支。
import { describe, expect, it } from 'vitest';
import {
  registerOpsHealthProcessesRoutes,
  registerOpsLoginClaudeRoutes,
  registerOpsMetricsDeleteRoutes,
  registerOpsMetricsHealthRoutes,
} from '../../../src/server/routes/ops.js';

function mockApp(routes) {
  const collect = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { get: collect('get'), post: collect('post'), patch: collect('patch'), delete: collect('delete') };
}

function mockRes() {
  return {
    statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
  };
}

function mkDispatcher(activeCount = 0) {
  const m = new Map();
  for (let i = 0; i < activeCount; i++) m.set(`r${i}`, () => {});
  return { activeAborts: m };
}

function setup({ terminals = new Map(), dispatcherCounts = [0, 0, 0, 0, 0] } = {}) {
  const routes = [];
  const app = mockApp(routes);
  const [d, s, a, sc, cv] = dispatcherCounts;
  const deps = {
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
    metricsStore: { clearCache: () => {} },
    debateDispatcher: mkDispatcher(d),
    squadDispatcher: mkDispatcher(s),
    arenaDispatcher: mkDispatcher(a),
    soloChatDispatcher: mkDispatcher(sc),
    crossVerifyDispatcher: mkDispatcher(cv),
    getTerminals: () => terminals,
  };
  // 按 server.js 原注册顺序调用（metrics/health → DELETE metrics → health/processes → login-claude）
  registerOpsMetricsHealthRoutes(app, deps);
  registerOpsMetricsDeleteRoutes(app, deps);
  registerOpsHealthProcessesRoutes(app, deps);
  registerOpsLoginClaudeRoutes(app, deps);
  const invoke = async (method, path, req = {}) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    const res = mockRes();
    await r.handlers[r.handlers.length - 1]({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
    return res;
  };
  return { routes, invoke };
}

describe('ops routes (S23 提取) — register 烟测', () => {
  it('4 条 method+path 全部注册且顺序与拆前一致、每条挂 owner-token 中间件', () => {
    const { routes } = setup();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /api/metrics/health',
      'delete /api/metrics',
      'get /api/health/processes',
      'post /api/login-claude',
    ]);
    for (const r of routes) expect(r.handlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ops routes — 行为锁定抽测', () => {
  it('GET /api/metrics/health：返 ok + panel 指标 + activeRooms 为 5 个 dispatcher 聚合', async () => {
    const { invoke } = setup({ dispatcherCounts: [1, 2, 0, 1, 1] });
    const res = await invoke('get', '/api/metrics/health');
    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.activeRooms).toBe(5);
    expect(res.payload.panel.pid).toBe(process.pid);
    expect(res.payload.files).toHaveProperty('dataJsonMB');
    expect(Array.isArray(res.payload.warnings)).toBe(true);
  });

  it('DELETE /api/metrics：olderThan 缺失/非 YYYY-MM → 400（不触发真实删除分支）', async () => {
    const { invoke } = setup();
    expect((await invoke('delete', '/api/metrics', { query: {} })).statusCode).toBe(400);
    expect((await invoke('delete', '/api/metrics', { query: { olderThan: '2026/05' } })).statusCode).toBe(400);
    expect((await invoke('delete', '/api/metrics', { query: { olderThan: 'bad' } })).payload.ok).toBe(false);
  });

  it('GET /api/health/processes：terminals 经 getter 延迟求值（TDZ 回归）+ activeDispatchers 五键齐', async () => {
    // 复刻 server.js 现场：register 时 terminals 尚未赋值，handler 执行时才有值
    let terminals;
    const routes = [];
    const app = mockApp(routes);
    registerOpsHealthProcessesRoutes(app, {
      send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
      debateDispatcher: mkDispatcher(), squadDispatcher: mkDispatcher(),
      arenaDispatcher: mkDispatcher(), soloChatDispatcher: mkDispatcher(),
      crossVerifyDispatcher: mkDispatcher(),
      getTerminals: () => terminals,   // register 时 terminals === undefined，不许在此求值
    });
    terminals = new Map([['t1', { cwd: '/tmp', term: { pid: 42 }, clients: new Set(['c1']), shell: '/bin/zsh', createdAt: 'now' }]]);
    const r = routes.find((x) => x.method === 'get' && x.path === '/api/health/processes');
    const res = mockRes();
    await r.handlers[r.handlers.length - 1]({ params: {}, query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.terminals).toEqual([
      { id: 't1', cwd: '/tmp', pid: 42, clients: 1, shell: '/bin/zsh', createdAt: 'now' },
    ]);
    expect(Object.keys(res.payload.activeDispatchers)).toEqual(['debate', 'squad', 'arena', 'soloChat', 'crossVerify']);
  });
});
