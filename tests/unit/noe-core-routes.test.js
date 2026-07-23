import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next(),
}));

vi.mock('../../src/server/routes/noeCommands.js', () => ({
  registerNoeCommandRoutes: vi.fn(),
}));

import { registerNoeCoreRoutes } from '../../src/server/routes/noeCoreRoutes.js';
import { registerNoeCommandRoutes } from '../../src/server/routes/noeCommands.js';

function createApp() {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'post', path, handlers }),
    delete: (path, ...handlers) => routes.push({ method: 'delete', path, handlers }),
  };
  return { app, routes };
}

function createRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function getHandler(routes, method, path) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  return route.handlers[route.handlers.length - 1];
}

function makeReq({ params = {}, query = {}, body = {} } = {}) {
  return { params, query, body };
}

describe('registerNoeCoreRoutes', () => {
  let app;
  let routes;
  let deps;
  let sendError;

  beforeEach(() => {
    const created = createApp();
    app = created.app;
    routes = created.routes;
    sendError = vi.fn((res, err) => {
      res.status(500).json({ ok: false, error: err.message });
    });
    deps = {
      loop: {
        status: vi.fn(() => ({ state: 'idle' })),
        start: vi.fn(() => ({ state: 'running' })),
        stop: vi.fn(() => ({ state: 'stopped' })),
        pause: vi.fn(() => ({ state: 'paused' })),
        resume: vi.fn(() => ({ state: 'running' })),
        tick: vi.fn(async () => ({ ok: true, iterations: 1 })),
      },
      memory: {
        recall: vi.fn(() => [{ id: 'm1' }]),
        write: vi.fn(() => ({ id: 'm1', content: 'hi' })),
        hide: vi.fn(() => true),
        merge: vi.fn(() => ({ id: 'm1' })),
      },
      focus: {
        list: vi.fn(() => [{ id: 'f1' }]),
        push: vi.fn(() => ({ id: 'f1' })),
        pop: vi.fn(() => ({ id: 'f1' })),
      },
      toolRegistry: {
        list: vi.fn(() => [{ id: 't1' }]),
        register: vi.fn(() => ({ id: 't1' })),
        setEnabled: vi.fn(() => ({ id: 't1', enabled: true })),
      },
      approvalStore: {},
      actStore: {},
      actPipeline: {},
      sendError,
    };
    registerNoeCommandRoutes.mockClear();
  });

  it('forwards to registerNoeCommandRoutes with toolRegistry and sendError', () => {
    registerNoeCoreRoutes(app, deps);
    expect(registerNoeCommandRoutes).toHaveBeenCalledTimes(1);
    expect(registerNoeCommandRoutes).toHaveBeenCalledWith(app, {
      toolRegistry: deps.toolRegistry,
      sendError,
    });
  });

  describe('GET /api/noe/loop/status', () => {
    it('returns loop.status() wrapped in { ok, status }', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/loop/status');
      const res = createRes();
      handler(makeReq(), res);
      expect(deps.loop.status).toHaveBeenCalledTimes(1);
      expect(res.body).toEqual({ ok: true, status: { state: 'idle' } });
    });
  });

  describe('POST /api/noe/loop/{start,stop,pause,resume}', () => {
    it('start calls loop.start with body', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/start');
      const res = createRes();
      handler(makeReq({ body: { foo: 'bar' } }), res);
      expect(deps.loop.start).toHaveBeenCalledWith({ foo: 'bar' });
      expect(res.body).toEqual({ ok: true, status: { state: 'running' } });
    });

    it('stop passes reason from body or defaults to "api"', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/stop');
      const res = createRes();
      handler(makeReq({ body: { reason: 'manual' } }), res);
      expect(deps.loop.stop).toHaveBeenLastCalledWith({ reason: 'manual' });
      handler(makeReq({}), res);
      expect(deps.loop.stop).toHaveBeenLastCalledWith({ reason: 'api' });
    });

    it('pause passes reason from body or defaults to "api"', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/pause');
      const res = createRes();
      handler(makeReq({ body: { reason: 'wait' } }), res);
      expect(deps.loop.pause).toHaveBeenLastCalledWith('wait');
      handler(makeReq({}), res);
      expect(deps.loop.pause).toHaveBeenLastCalledWith('api');
    });

    it('resume calls loop.resume with body', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/resume');
      const res = createRes();
      handler(makeReq({ body: { mode: 'fast' } }), res);
      expect(deps.loop.resume).toHaveBeenCalledWith({ mode: 'fast' });
    });

    it('routes thrown errors through sendError', () => {
      deps.loop.start.mockImplementation(() => { throw new Error('boom'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/start');
      const res = createRes();
      handler(makeReq(), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/noe/loop/tick', () => {
    it('defaults force to true when not provided in body', async () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/tick');
      const res = createRes();
      await handler(makeReq({ body: {} }), res);
      expect(deps.loop.tick).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });

    it('honours force: false in body', async () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/tick');
      const res = createRes();
      await handler(makeReq({ body: { force: false } }), res);
      expect(deps.loop.tick).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    });

    it('forwards tick result as JSON', async () => {
      deps.loop.tick.mockResolvedValue({ ok: true, iterations: 7 });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/tick');
      const res = createRes();
      await handler(makeReq(), res);
      expect(res.body).toEqual({ ok: true, iterations: 7 });
    });

    it('routes async errors through sendError', async () => {
      deps.loop.tick.mockRejectedValue(new Error('tick fail'));
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/loop/tick');
      const res = createRes();
      await handler(makeReq(), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/noe/memory', () => {
    it('passes bumpHits: false to memory.recall (P4 fix)', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      handler(makeReq(), createRes());
      expect(deps.memory.recall).toHaveBeenCalledWith(expect.objectContaining({ bumpHits: false }));
    });

    it('normalises query params (q, project, scope, limit, includeExpired)', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      handler(makeReq({
        query: { q: 'hello', project: 'p1', scope: 'global', limit: '50', includeExpired: 'true' },
      }), createRes());
      expect(deps.memory.recall).toHaveBeenCalledWith({
        q: 'hello',
        projectId: 'p1',
        scope: 'global',
        limit: 50,
        includeExpired: true,
        bumpHits: false,
      });
    });

    it('falls back q -> query and project -> projectId', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      handler(makeReq({ query: { query: 'hi', projectId: 'p2' } }), createRes());
      expect(deps.memory.recall).toHaveBeenCalledWith(expect.objectContaining({
        q: 'hi',
        projectId: 'p2',
      }));
    });

    it('clamps limit to [1,100] and falls back to 20 when invalid', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      handler(makeReq({ query: { limit: '999' } }), createRes());
      expect(deps.memory.recall.mock.calls[0][0].limit).toBe(100);
      handler(makeReq({ query: { limit: '0' } }), createRes());
      expect(deps.memory.recall.mock.calls[1][0].limit).toBe(1);
      handler(makeReq({ query: { limit: 'abc' } }), createRes());
      expect(deps.memory.recall.mock.calls[2][0].limit).toBe(20);
    });

    it('returns { ok, count, items } envelope', () => {
      deps.memory.recall.mockReturnValue([{ id: 'a' }, { id: 'b' }]);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      const res = createRes();
      handler(makeReq(), res);
      expect(res.body).toEqual({ ok: true, count: 2, items: [{ id: 'a' }, { id: 'b' }] });
    });

    it('routes errors through sendError', () => {
      deps.memory.recall.mockImplementation(() => { throw new Error('recall fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/memory');
      const res = createRes();
      handler(makeReq(), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/noe/memory', () => {
    it('writes memory and responds 201', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory');
      const res = createRes();
      handler(makeReq({ body: { content: 'note' } }), res);
      expect(deps.memory.write).toHaveBeenCalledWith({ content: 'note' });
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ ok: true, item: { id: 'm1', content: 'hi' } });
    });

    it('routes errors through sendError', () => {
      deps.memory.write.mockImplementation(() => { throw new Error('write fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory');
      const res = createRes();
      handler(makeReq({ body: {} }), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /api/noe/memory/:id', () => {
    it('hides memory using query reason and projectId', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'delete', '/api/noe/memory/:id');
      const res = createRes();
      handler(makeReq({
        params: { id: 'm1' },
        query: { project: 'p1', reason: 'cleanup' },
      }), res);
      expect(deps.memory.hide).toHaveBeenCalledWith('m1', { projectId: 'p1', reason: 'cleanup' });
      expect(res.body).toEqual({ ok: true });
    });

    it('falls back to body reason when query reason missing', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'delete', '/api/noe/memory/:id');
      const res = createRes();
      handler(makeReq({ params: { id: 'm1' }, body: { reason: 'fromBody' } }), res);
      expect(deps.memory.hide).toHaveBeenCalledWith('m1', expect.objectContaining({ reason: 'fromBody' }));
    });

    it('defaults reason to "api_delete"', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'delete', '/api/noe/memory/:id');
      const res = createRes();
      handler(makeReq({ params: { id: 'm1' } }), res);
      expect(deps.memory.hide).toHaveBeenCalledWith('m1', expect.objectContaining({ reason: 'api_delete' }));
    });

    it('responds 404 when hide returns false', () => {
      deps.memory.hide.mockReturnValue(false);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'delete', '/api/noe/memory/:id');
      const res = createRes();
      handler(makeReq({ params: { id: 'missing' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'memory not found' });
    });
  });

  describe('POST /api/noe/memory/:id/merge', () => {
    it('calls memory.merge with target/source/project/reason', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory/:id/merge');
      const res = createRes();
      handler(makeReq({
        params: { id: 'm1' },
        body: { sourceIds: ['s1', 's2'], projectId: 'p1', reason: 'dup' },
      }), res);
      expect(deps.memory.merge).toHaveBeenCalledWith({
        targetId: 'm1',
        sourceIds: ['s1', 's2'],
        projectId: 'p1',
        reason: 'dup',
      });
      expect(res.body).toEqual({ ok: true, item: { id: 'm1' } });
    });

    it('accepts source_ids / project_id aliases', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory/:id/merge');
      const res = createRes();
      handler(makeReq({
        params: { id: 'm1' },
        body: { source_ids: ['s1'], project_id: 'p1' },
      }), res);
      expect(deps.memory.merge).toHaveBeenCalledWith(expect.objectContaining({
        sourceIds: ['s1'],
        projectId: 'p1',
      }));
    });

    it('responds 501 when memory.merge is not configured', () => {
      deps.memory.merge = undefined;
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory/:id/merge');
      const res = createRes();
      handler(makeReq({ params: { id: 'm1' } }), res);
      expect(res.statusCode).toBe(501);
      expect(res.body).toEqual({ ok: false, error: 'memory merge not configured' });
    });

    it('routes errors through sendError', () => {
      deps.memory.merge.mockImplementation(() => { throw new Error('merge fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/memory/:id/merge');
      const res = createRes();
      handler(makeReq({ params: { id: 'm1' } }), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/noe/focus', () => {
    it('defaults state to "active" and limit to 100', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/focus');
      handler(makeReq(), createRes());
      expect(deps.focus.list).toHaveBeenCalledWith({
        projectId: undefined,
        state: 'active',
        limit: 100,
      });
    });

    it('maps project -> projectId and respects provided state/limit', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/focus');
      handler(makeReq({ query: { project: 'p1', state: 'archived', limit: '5' } }), createRes());
      expect(deps.focus.list).toHaveBeenCalledWith({
        projectId: 'p1',
        state: 'archived',
        limit: 5,
      });
    });

    it('returns { ok, count, items } envelope', () => {
      deps.focus.list.mockReturnValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/focus');
      const res = createRes();
      handler(makeReq(), res);
      expect(res.body).toEqual({ ok: true, count: 3, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    });

    it('routes errors through sendError', () => {
      deps.focus.list.mockImplementation(() => { throw new Error('list fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/focus');
      const res = createRes();
      handler(makeReq(), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/noe/focus', () => {
    it('pushes focus item and responds 201', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/focus');
      const res = createRes();
      handler(makeReq({ body: { text: 'task' } }), res);
      expect(deps.focus.push).toHaveBeenCalledWith({ text: 'task' });
      expect(res.statusCode).toBe(201);
    });

    it('routes errors through sendError', () => {
      deps.focus.push.mockImplementation(() => { throw new Error('push fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/focus');
      const res = createRes();
      handler(makeReq({ body: {} }), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/noe/focus/:id/pop', () => {
    it('pops focus item and returns it', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/focus/:id/pop');
      const res = createRes();
      handler(makeReq({ params: { id: 'f1' }, body: {} }), res);
      expect(deps.focus.pop).toHaveBeenCalledWith('f1', {});
      expect(res.body).toEqual({ ok: true, item: { id: 'f1' } });
    });

    it('responds 404 when pop returns falsy', () => {
      deps.focus.pop.mockReturnValue(null);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/focus/:id/pop');
      const res = createRes();
      handler(makeReq({ params: { id: 'missing' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'focus item not found' });
    });

    it('routes errors through sendError', () => {
      deps.focus.pop.mockImplementation(() => { throw new Error('pop fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/focus/:id/pop');
      const res = createRes();
      handler(makeReq({ params: { id: 'f1' } }), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/noe/tools', () => {
    it('passes enabled: undefined when no enabled query', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/tools');
      handler(makeReq(), createRes());
      expect(deps.toolRegistry.list).toHaveBeenCalledWith({ enabled: undefined });
    });

    it('passes enabled: true when query.enabled === "true"', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/tools');
      handler(makeReq({ query: { enabled: 'true' } }), createRes());
      expect(deps.toolRegistry.list).toHaveBeenCalledWith({ enabled: true });
    });

    it('passes enabled: false when query.enabled === "false"', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/tools');
      handler(makeReq({ query: { enabled: 'false' } }), createRes());
      expect(deps.toolRegistry.list).toHaveBeenCalledWith({ enabled: false });
    });

    it('returns { ok, count, tools } envelope', () => {
      deps.toolRegistry.list.mockReturnValue([{ id: 'a' }]);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'get', '/api/noe/tools');
      const res = createRes();
      handler(makeReq(), res);
      expect(res.body).toEqual({ ok: true, count: 1, tools: [{ id: 'a' }] });
    });
  });

  describe('POST /api/noe/tools', () => {
    it('registers a tool and responds 201', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/tools');
      const res = createRes();
      handler(makeReq({ body: { name: 'new' } }), res);
      expect(deps.toolRegistry.register).toHaveBeenCalledWith({ name: 'new' });
      expect(res.statusCode).toBe(201);
    });

    it('routes errors through sendError', () => {
      deps.toolRegistry.register.mockImplementation(() => { throw new Error('reg fail'); });
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/tools');
      const res = createRes();
      handler(makeReq({ body: {} }), res);
      expect(sendError).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/noe/tools/:id/enable', () => {
    it('enables tool by default (body.enabled !== false)', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/tools/:id/enable');
      const res = createRes();
      handler(makeReq({ params: { id: 't1' }, body: {} }), res);
      expect(deps.toolRegistry.setEnabled).toHaveBeenCalledWith('t1', true);
      expect(res.body).toEqual({ ok: true, tool: { id: 't1', enabled: true } });
    });

    it('passes enabled: false when body.enabled === false', () => {
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/tools/:id/enable');
      const res = createRes();
      handler(makeReq({ params: { id: 't1' }, body: { enabled: false } }), res);
      expect(deps.toolRegistry.setEnabled).toHaveBeenCalledWith('t1', false);
    });

    it('responds 404 when tool not found', () => {
      deps.toolRegistry.setEnabled.mockReturnValue(null);
      registerNoeCoreRoutes(app, deps);
      const handler = getHandler(routes, 'post', '/api/noe/tools/:id/enable');
      const res = createRes();
      handler(makeReq({ params: { id: 'missing' } }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ ok: false, error: 'tool not found' });
    });
  });
});
