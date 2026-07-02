import { describe, expect, it } from 'vitest';
import { registerNoeRoutes } from '../../../src/server/routes/noe.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
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

function makeReq({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query, get: () => undefined };
}

function baseDeps(overrides = {}) {
  return {
    loop: { status: () => ({ state: 'stopped' }) },
    memory: {
      recall: () => [],
      stats: () => ({ total: 0, visible: 0, hidden: 0, fts: true }),
    },
    focus: { list: () => [], depth: () => 0 },
    toolRegistry: { list: () => [] },
    approvalStore: { listApprovals: () => [] },
    actStore: {
      list: () => [],
      summary: () => ({ byStatus: {}, pending: 0, current: null }),
      cancel: () => null,
    },
    ...overrides,
  };
}

function routeHandler(routes, method, path) {
  const route = routes.find((item) => item.method === method && item.path === path);
  expect(route).toBeTruthy();
  return route.handlers[1];
}

describe('Noe act route status mapping', () => {
  it('returns 501 when the act pipeline is not configured', async () => {
    const { app, routes } = makeApp();
    registerNoeRoutes(app, baseDeps());

    const res = makeRes();
    await routeHandler(routes, 'post', '/api/noe/acts/propose')(makeReq({ body: { action: 'noe.focus.review' } }), res);

    expect(res.statusCode).toBe(501);
    expect(res.payload).toMatchObject({ ok: false, error: 'act pipeline not configured' });
  });

  it('maps act proposal outcomes to 201, 202, and 403', async () => {
    const outcomes = [
      [{ ok: true, act: { id: 'act-ok', status: 'completed' } }, 201],
      [{ ok: true, approvalRequired: true, act: { id: 'act-ask', status: 'awaiting_approval' } }, 202],
      [{ ok: false, error: 'blocked_safety', act: { id: 'act-blocked', status: 'blocked_safety' } }, 403],
    ];

    for (const [proposalResult, expectedStatus] of outcomes) {
      const { app, routes } = makeApp();
      registerNoeRoutes(app, baseDeps({
        actPipeline: { propose: async () => proposalResult },
      }));

      const res = makeRes();
      await routeHandler(routes, 'post', '/api/noe/acts/propose')(makeReq({ body: { action: 'noe.focus.review' } }), res);

      expect(res.statusCode).toBe(expectedStatus);
      expect(res.payload).toMatchObject(proposalResult);
    }
  });

  it('returns 404 when cancelling a missing act', async () => {
    const { app, routes } = makeApp();
    registerNoeRoutes(app, baseDeps());

    const res = makeRes();
    routeHandler(routes, 'post', '/api/noe/acts/:id/cancel')(makeReq({ params: { id: 'missing-act' } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toMatchObject({ ok: false, error: 'act not found' });
  });
});
