import { describe, it, expect, vi } from 'vitest';
import { registerNoeOwnerGateRoutes } from '../../src/server/routes/noeOwnerGate.js';

function captureApp() {
  const routes = [];
  const app = {
    get: vi.fn((path, ...handlers) => routes.push({ method: 'get', path, handlers })),
    post: vi.fn((path, ...handlers) => routes.push({ method: 'post', path, handlers })),
  };
  return { app, routes };
}

function buildStore(overrides = {}) {
  return {
    publicConfig: vi.fn().mockReturnValue({ tokenRequired: true }),
    status: vi.fn().mockReturnValue({ locked: false, attempts: 0 }),
    update: vi.fn().mockReturnValue({ tokenRequired: false }),
    ...overrides,
  };
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

function lastHandler(route) {
  return route.handlers[route.handlers.length - 1];
}

function setup(overrides = {}) {
  const { app, routes } = captureApp();
  const ownerGateStore = buildStore(overrides.store || {});
  const sendError = overrides.sendError || vi.fn();
  registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError });
  return { app, routes, ownerGateStore, sendError };
}

describe('registerNoeOwnerGateRoutes', () => {
  it('registers a GET route at /api/noe/owner-gate with middleware + handler', () => {
    const { app, routes } = setup();
    expect(app.get).toHaveBeenCalledTimes(1);
    const route = findRoute(routes, 'get', '/api/noe/owner-gate');
    expect(route).toBeDefined();
    expect(route.handlers).toHaveLength(2);
    expect(typeof route.handlers[1]).toBe('function');
  });

  it('registers a POST route at /api/noe/owner-gate with middleware + handler', () => {
    const { app, routes } = setup();
    expect(app.post).toHaveBeenCalledTimes(1);
    const route = findRoute(routes, 'post', '/api/noe/owner-gate');
    expect(route).toBeDefined();
    expect(route.handlers).toHaveLength(2);
    expect(typeof route.handlers[1]).toBe('function');
  });

  it('GET handler responds with { ok: true, config: publicConfig(), status: status() }', () => {
    const { routes, ownerGateStore } = setup({
      store: {
        publicConfig: vi.fn().mockReturnValue({ tokenRequired: true, hint: 'h' }),
        status: vi.fn().mockReturnValue({ locked: false, attempts: 0 }),
      },
    });
    const route = findRoute(routes, 'get', '/api/noe/owner-gate');
    const handler = lastHandler(route);
    const json = vi.fn();

    handler({}, { json });

    expect(ownerGateStore.publicConfig).toHaveBeenCalledTimes(1);
    expect(ownerGateStore.status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      ok: true,
      config: { tokenRequired: true, hint: 'h' },
      status: { locked: false, attempts: 0 },
    });
  });

  it('GET handler forwards exceptions to sendError(res, err)', () => {
    const err = new Error('boom');
    const { routes, sendError } = setup({
      store: { publicConfig: vi.fn(() => { throw err; }) },
    });
    const route = findRoute(routes, 'get', '/api/noe/owner-gate');
    const handler = lastHandler(route);
    const res = { json: vi.fn() };

    handler({}, res);

    expect(res.json).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError).toHaveBeenCalledWith(res, err);
  });

  it('POST handler updates store with req.body and returns ok + new config + status', () => {
    const { routes, ownerGateStore } = setup({
      store: {
        update: vi.fn().mockReturnValue({ tokenRequired: false, attempts: 5 }),
        status: vi.fn().mockReturnValue({ locked: false, attempts: 5 }),
      },
    });
    const route = findRoute(routes, 'post', '/api/noe/owner-gate');
    const handler = lastHandler(route);
    const json = vi.fn();
    const body = { tokenRequired: false };

    handler({ body }, { json });

    expect(ownerGateStore.update).toHaveBeenCalledTimes(1);
    expect(ownerGateStore.update).toHaveBeenCalledWith(body);
    expect(ownerGateStore.status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      ok: true,
      config: { tokenRequired: false, attempts: 5 },
      status: { locked: false, attempts: 5 },
    });
  });

  it('POST handler falls back to an empty object when req.body is missing', () => {
    const { routes, ownerGateStore } = setup();
    const route = findRoute(routes, 'post', '/api/noe/owner-gate');
    const handler = lastHandler(route);

    handler({ body: undefined }, { json: vi.fn() });

    expect(ownerGateStore.update).toHaveBeenCalledWith({});
  });

  it('POST handler forwards exceptions to sendError(res, err)', () => {
    const err = new Error('update failed');
    const { routes, sendError } = setup({
      store: { update: vi.fn(() => { throw err; }) },
    });
    const route = findRoute(routes, 'post', '/api/noe/owner-gate');
    const handler = lastHandler(route);
    const res = { json: vi.fn() };

    handler({ body: {} }, res);

    expect(res.json).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});
