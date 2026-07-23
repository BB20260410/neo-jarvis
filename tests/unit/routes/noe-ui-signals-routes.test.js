import { describe, expect, it } from 'vitest';
import { NoeUiSignalStore } from '../../../src/runtime/NoeUiSignalStore.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeUiSignalRoutes } from '../../../src/server/routes/noeUiSignals.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ body = {}, query = {}, headers = {} } = {}) {
  return {
    body,
    query,
    get(name) {
      const lower = String(name || '').toLowerCase();
      return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('Noe UI signal routes', () => {
  it('registers UI signal endpoints behind owner-token middleware', () => {
    const { app, routes } = makeApp();
    registerNoeUiSignalRoutes(app, { sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'post /api/noe/ui-signals',
      'get /api/noe/ui-signals',
      'post /api/noe/ui-signals/consume',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('records, lists, and consumes context-only UI signals', () => {
    const { app, routes } = makeApp();
    const store = new NoeUiSignalStore();
    registerNoeUiSignalRoutes(app, { store, sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });
    const post = routes.find((route) => route.method === 'post' && route.path === '/api/noe/ui-signals');
    const list = routes.find((route) => route.method === 'get' && route.path === '/api/noe/ui-signals');
    const consume = routes.find((route) => route.method === 'post' && route.path === '/api/noe/ui-signals/consume');

    const postRes = makeRes();
    post.handlers[1](makeReq({ body: { event: 'card.action', component: 'LocalCouncilPanel', action: 'run' } }), postRes);
    expect(postRes.statusCode).toBe(201);
    expect(postRes.payload.snapshot.unconsumed).toBe(1);

    const listRes = makeRes();
    list.handlers[1](makeReq(), listRes);
    expect(listRes.payload.signals).toHaveLength(1);
    expect(listRes.payload.signals[0].signal.action).toBe('run');

    const consumeRes = makeRes();
    consume.handlers[1](makeReq({ body: { limit: 10 } }), consumeRes);
    expect(consumeRes.payload.count).toBe(1);
    expect(consumeRes.payload.contextBlock).toContain('context-only');
  });

  it('rejects invalid signal events with a client error', () => {
    const { app, routes } = makeApp();
    registerNoeUiSignalRoutes(app, { store: new NoeUiSignalStore(), sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });
    const post = routes.find((route) => route.path === '/api/noe/ui-signals');
    const res = makeRes();
    post.handlers[1](makeReq({ body: { event: 'card.delete' } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload.error).toBe('invalid_ui_signal_event:card.delete');
  });
});
