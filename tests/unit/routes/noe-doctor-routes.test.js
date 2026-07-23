import { describe, expect, it } from 'vitest';
import { registerNoeDoctorRoutes } from '../../../src/server/routes/noeDoctor.js';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';

function makeApp() {
  const routes = [];
  return {
    routes,
    app: { get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }) },
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

describe('Noe doctor routes', () => {
  it('registers an owner-token protected doctor endpoint', async () => {
    const { app, routes } = makeApp();
    let seen = null;
    registerNoeDoctorRoutes(app, {
      sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
      doctor: async (input) => {
        seen = input;
        return { ok: true, status: 'ok', findings: [] };
      },
      root: '/tmp/noe',
    });
    const route = routes[0];
    const res = makeRes();
    await route.handlers[1]({ query: { network: 'true' } }, res);

    expect(route.path).toBe('/api/noe/doctor');
    expect(route.handlers[0]).toBe(requireOwnerToken);
    expect(seen).toMatchObject({ root: '/tmp/noe', skipNetwork: false });
    expect(res.payload).toEqual({ ok: true, status: 'ok', findings: [] });
  });
});

