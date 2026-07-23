// A1 防回归：敏感读端点必须挂 owner-token。
// 背景：Origin 白名单只防浏览器跨域，不防本机其他进程 curl；conversation/任务 prompt/会话痕迹
// 这类内容"读"与"写"同样敏感。曾经 GET /api/rooms 等 7 个读端点裸奔，本测试钉死不许回潮。
import { describe, expect, it } from 'vitest';
import { registerRoomsRoutes } from '../../../src/server/routes/rooms.js';
import { registerAutopilotRoutes } from '../../../src/server/routes/autopilot.js';
import { registerSessionsReadonlyRoutes } from '../../../src/server/routes/sessions-readonly.js';

function captureRoutes(register, deps) {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'post', path, handlers }),
    put: (path, ...handlers) => routes.push({ method: 'put', path, handlers }),
    patch: (path, ...handlers) => routes.push({ method: 'patch', path, handlers }),
    delete: (path, ...handlers) => routes.push({ method: 'delete', path, handlers }),
  };
  register(app, deps);
  return routes;
}

const roomsDeps = {
  roomStore: { list: () => [], listArchived: () => [], get: () => null, update: () => {}, create: () => ({ id: 'x' }), delete: () => true },
  safeResolveFsPath: (p) => p,
  safeSlice: (s) => s,
  roomAdapterPool: new Map(),
  debateDispatcher: { abort: () => {} },
  squadDispatcher: { abort: () => {} },
  arenaDispatcher: { abort: () => {} },
  soloChatDispatcher: { abort: () => {} },
  roomWsClients: new Map(),
};

const autopilotDeps = {
  autopilotStore: { getConfig: () => ({}), isEnabled: () => false, setEnabled: () => {}, setMaxHops: () => {}, upsertRule: () => ({}), deleteRule: () => true, recentLogs: () => [] },
  scheduleStore: { listSchedules: () => [], createSchedule: () => ({}), updateSchedule: () => ({}), deleteSchedule: () => true, getSchedule: () => null, enqueueJob: () => ({}), listJobs: () => [], cancelJob: () => ({}), listRuns: () => [] },
};

function runWithoutToken(route) {
  let statusCode = 200;
  let payload;
  const req = { query: {}, params: { id: 'nope' }, body: {}, get: () => undefined, headers: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  route.handlers[0](req, res); // 第一个 handler 应是 requireOwnerToken，无 token 必须 401 短路
  return { statusCode, payload };
}

describe('敏感读端点鉴权防回归（A1）', () => {
  it('rooms：所有 GET 都挂了中间件（handlers≥2），无 token 读 list/:id 得 401', () => {
    const routes = captureRoutes(registerRoomsRoutes, roomsDeps);
    const gets = routes.filter((r) => r.method === 'get');
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) {
      expect(r.handlers.length, `${r.path} 缺鉴权中间件`).toBeGreaterThanOrEqual(2);
    }
    for (const path of ['/api/rooms', '/api/rooms/:id']) {
      const route = gets.find((r) => r.path === path);
      const { statusCode, payload } = runWithoutToken(route);
      expect(statusCode, `${path} 无 token 应 401`).toBe(401);
      expect(JSON.stringify(payload)).toContain('owner token');
    }
  });

  it('autopilot：所有 GET（config/log/schedules/jobs/runs）无 token 得 401', () => {
    const routes = captureRoutes(registerAutopilotRoutes, autopilotDeps);
    const gets = routes.filter((r) => r.method === 'get');
    expect(gets.map((r) => r.path).sort()).toEqual([
      '/api/autopilot/config',
      '/api/autopilot/jobs',
      '/api/autopilot/log',
      '/api/autopilot/runs',
      '/api/autopilot/schedules',
    ]);
    for (const r of gets) {
      const { statusCode } = runWithoutToken(r);
      expect(statusCode, `${r.path} 无 token 应 401`).toBe(401);
    }
  });

  it('sessions-readonly：cost-series / safety-history 无 token 得 401', () => {
    const routes = captureRoutes(registerSessionsReadonlyRoutes, { sessions: new Map() });
    const gets = routes.filter((r) => r.method === 'get');
    expect(gets.length).toBe(2);
    for (const r of gets) {
      const { statusCode } = runWithoutToken(r);
      expect(statusCode, `${r.path} 无 token 应 401`).toBe(401);
    }
  });
});
