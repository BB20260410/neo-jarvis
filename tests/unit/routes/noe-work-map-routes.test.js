import { describe, expect, it } from 'vitest';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeWorkMapRoutes } from '../../../src/server/routes/noeWorkMap.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
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

function call(routes, method, path, req = {}) {
  const route = routes.find((item) => item.method === method && item.path === path);
  expect(route).toBeTruthy();
  const res = makeRes();
  route.handlers[route.handlers.length - 1]({ body: {}, query: {}, params: {}, ...req }, res);
  return res;
}

describe('Noe work map routes', () => {
  it('registers one owner-token protected read-only endpoint', () => {
    const { app, routes } = makeApp();
    registerNoeWorkMapRoutes(app, { dbProvider: () => null });

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(['get /api/noe/work-map']);
    expect(routes[0].handlers[0]).toBe(requireOwnerToken);
  });

  it('returns partial file-backed work map when sqlite is unavailable', () => {
    const { app, routes } = makeApp();
    registerNoeWorkMapRoutes(app, {
      rootDir: '/tmp/noe-work-map-missing-root',
      dataDir: '/tmp/noe-work-map-missing-data',
      dbProvider: () => { throw new Error('sqlite unavailable'); },
      now: () => Date.parse('2026-06-13T02:30:00.000Z'),
    });

    const res = call(routes, 'get', '/api/noe/work-map', { query: { limit: 10 } });

    expect(res.payload.ok).toBe(true);
    expect(res.payload.generatedAt).toBe('2026-06-13T02:30:00.000Z');
    expect(res.payload.sources.sqlite).toMatchObject({ available: false, error: 'sqlite unavailable' });
    expect(res.payload.policy.noMessageBodiesIncluded).toBe(true);
  });
});
