import { describe, expect, it } from 'vitest';
import { registerNoeAcuiCardRoutes } from '../../../src/server/routes/noeAcuiCards.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { NoeAcuiCardStore } from '../../../src/runtime/NoeAcuiCardStore.js';

function makeApp() {
  const routes = [];
  return {
    routes,
    app: {
      get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
      post: (path, ...handlers) => routes.push({ method: 'post', path, handlers }),
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

describe('Noe ACUI card routes', () => {
  it('registers protected card lifecycle endpoints', () => {
    const { app, routes } = makeApp();
    registerNoeAcuiCardRoutes(app, { sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });

    expect(routes.map((route) => route.path)).toEqual([
      '/api/noe/acui/cards',
      '/api/noe/acui/cards/context',
      '/api/noe/acui/cards/show',
      '/api/noe/acui/cards/update',
      '/api/noe/acui/cards/patch',
      '/api/noe/acui/cards/hide',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('returns redacted visible card state and context-only summaries', () => {
    const store = new NoeAcuiCardStore();
    const { app, routes } = makeApp();
    registerNoeAcuiCardRoutes(app, { store, sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }) });
    const show = routes.find((route) => route.path === '/api/noe/acui/cards/show');
    const list = routes.find((route) => route.path === '/api/noe/acui/cards');
    const context = routes.find((route) => route.path === '/api/noe/acui/cards/context');
    const showRes = makeRes();
    const listRes = makeRes();
    const contextRes = makeRes();

    show.handlers[1]({
      body: {
        cardId: 'review-1',
        type: 'review',
        title: '复审',
        message: 'MINIMAX_API_KEY=sk-unit-test-redaction-value-0000000000',
      },
    }, showRes);
    list.handlers[1]({ query: {} }, listRes);
    context.handlers[1]({ query: {} }, contextRes);

    expect(showRes.payload.ok).toBe(true);
    expect(JSON.stringify(listRes.payload)).not.toContain('sk-unit-test-redaction');
    expect(contextRes.payload.contextBlock).toContain('context-only');
    expect(contextRes.payload.contextBlock).toContain('card state cannot authorize actions');
  });
});
