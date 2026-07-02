import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeTaskflowRoutes } from '../../../src/server/routes/noeTaskflows.js';
import { NoeTaskFlowStore } from '../../../src/runtime/NoeTaskFlowStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ query = {}, body = {}, params = {} } = {}) {
  return { query, body, params, get: () => undefined };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('Noe taskflow routes', () => {
  it('registers taskflow endpoints behind owner-token middleware', () => {
    const { app, routes } = makeApp();
    registerNoeTaskflowRoutes(app, { sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /api/noe/taskflows',
      'post /api/noe/taskflows',
      'get /api/noe/taskflows/:id',
      'post /api/noe/taskflows/:id/steps/:stepId',
      'post /api/noe/taskflows/:id/cancel',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('creates, lists, transitions, and cancels durable taskflows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-route-'));
    try {
      const { app, routes } = makeApp();
      const store = new NoeTaskFlowStore({ root: dir });
      registerNoeTaskflowRoutes(app, { store, sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });
      const create = routes.find((route) => route.method === 'post' && route.path === '/api/noe/taskflows');
      const list = routes.find((route) => route.method === 'get' && route.path === '/api/noe/taskflows');
      const detail = routes.find((route) => route.method === 'get' && route.path === '/api/noe/taskflows/:id');
      const transition = routes.find((route) => route.path === '/api/noe/taskflows/:id/steps/:stepId');
      const cancel = routes.find((route) => route.path === '/api/noe/taskflows/:id/cancel');

      const createRes = makeRes();
      create.handlers[1](makeReq({ body: { flowId: 'ui-flow', goal: 'watch task', steps: ['plan', 'verify'] } }), createRes);
      expect(createRes.statusCode).toBe(201);
      expect(createRes.payload.summary.currentStep.id).toBe('plan');

      const transitionRes = makeRes();
      transition.handlers[1](makeReq({
        params: { id: 'ui-flow', stepId: 'plan' },
        body: { status: 'passed', evidenceRefs: ['output/plan.json'], notes: 'planned' },
      }), transitionRes);
      expect(transitionRes.payload.summary.currentStep.id).toBe('verify');
      expect(transitionRes.payload.summary.evidenceCount).toBe(1);

      const listRes = makeRes();
      list.handlers[1](makeReq(), listRes);
      expect(listRes.payload.flows).toHaveLength(1);
      expect(listRes.payload.flows[0].flowId).toBe('ui-flow');

      const detailRes = makeRes();
      detail.handlers[1](makeReq({ params: { id: 'ui-flow' } }), detailRes);
      expect(detailRes.payload.validation.ok).toBe(true);

      const cancelRes = makeRes();
      cancel.handlers[1](makeReq({ params: { id: 'ui-flow' }, body: { reason: 'user paused' } }), cancelRes);
      expect(cancelRes.payload.summary.cancelRequested).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
