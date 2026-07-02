// @ts-check
// S23：projects 路由从 server.js 提取后的行为锁定测试
import { describe, expect, it } from 'vitest';
import { registerProjectsRoutes } from '../../../src/server/routes/projects.js';

function setup() {
  const routes = [];
  const app = { get: (path, ...handlers) => routes.push({ path, handlers }) };
  registerProjectsRoutes(app, {
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
  });
  const invoke = (path, req) => {
    const r = routes.find((x) => x.path === path);
    const res = {
      statusCode: 200, payload: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.payload = b; return this; },
    };
    r.handlers[r.handlers.length - 1](req, res);
    return res;
  };
  return { routes, invoke };
}

describe('projects routes (S23 提取)', () => {
  it('注册 2 条路由且挂 owner-token 中间件', () => {
    const { routes } = setup();
    expect(routes.map((r) => r.path).sort()).toEqual(['/api/projects', '/api/projects/:name']);
    for (const r of routes) expect(r.handlers.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/projects/:name 拒 path traversal（.. / 反斜杠 / 超长）', () => {
    const { invoke } = setup();
    for (const bad of ['..', 'a/b', 'a\\b', 'x'.repeat(201)]) {
      expect(invoke('/api/projects/:name', { params: { name: bad } }).statusCode).toBe(400);
    }
  });

  it('GET /api/projects/:name 不存在的项目 → 404', () => {
    const { invoke } = setup();
    expect(invoke('/api/projects/:name', { params: { name: '不存在的项目xyz' } }).statusCode).toBe(404);
  });
});
