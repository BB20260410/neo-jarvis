// panel v1.5 — unit tests for src/server/routes/license.js
//
// registerLicenseRoutes(app) wires 6 routes; we exercise them with a
// fake app that captures (method, path, handlers) and a fake res that
// captures status/json. requireOwnerToken and LicenseManager are mocked
// so the test is hermetic.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { lmMock } = vi.hoisted(() => ({
  lmMock: {
    getStatus: vi.fn(),
    saveLicense: vi.fn(),
    clearLicense: vi.fn(),
    loadLicense: vi.fn(),
    hasFeature: vi.fn(),
    getCurrentTier: vi.fn(),
    verifyLicense: vi.fn()
  }
}));

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next()
}));

vi.mock('../../src/license/LicenseManager.js', () => lmMock);

import { registerLicenseRoutes } from '../../src/server/routes/license.js';

function makeApp() {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers; },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers; }
  };
  return { app, routes };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return res;
}

function routeHandler(routes, key) {
  const arr = routes[key];
  return arr[arr.length - 1];
}

describe('registerLicenseRoutes', () => {
  let routes;

  beforeEach(() => {
    vi.clearAllMocks();
    const fresh = makeApp();
    registerLicenseRoutes(fresh.app);
    routes = fresh.routes;
  });

  it('registers the expected set of routes', () => {
    expect(Object.keys(routes).sort()).toEqual([
      'GET /api/license/check/:feature',
      'GET /api/license/features',
      'GET /api/license/status',
      'POST /api/license/activate',
      'POST /api/license/deactivate',
      'POST /api/license/verify'
    ]);
  });

  it('wires requireOwnerToken middleware in front of every route handler', () => {
    for (const key of Object.keys(routes)) {
      expect(typeof routes[key][0]).toBe('function');
      expect(routes[key].length).toBeGreaterThanOrEqual(2);
    }
  });

  describe('GET /api/license/status', () => {
    it('returns ok merged with getStatus() payload', async () => {
      lmMock.getStatus.mockReturnValue({ tier: 'pro', email: 'a@b.c', features: ['x'] });
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/status')({}, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, tier: 'pro', email: 'a@b.c', features: ['x'] });
    });

    it('returns 500 when getStatus throws', async () => {
      lmMock.getStatus.mockImplementation(() => { throw new Error('boom'); });
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/status')({}, res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'boom' });
    });
  });

  describe('POST /api/license/activate', () => {
    it('returns 400 when license body is missing', async () => {
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/activate')({ body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'license body required' });
      expect(lmMock.saveLicense).not.toHaveBeenCalled();
    });

    it('returns 400 when license body is whitespace only', async () => {
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/activate')({ body: { license: '   ' } }, res);
      expect(res.statusCode).toBe(400);
      expect(lmMock.saveLicense).not.toHaveBeenCalled();
    });

    it('trims input and returns tier+email on valid save', async () => {
      lmMock.saveLicense.mockReturnValue({ valid: true, payload: { tier: 'pro', email: 'a@b.c' } });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/activate')({ body: { license: '  abc  ' } }, res);
      expect(lmMock.saveLicense).toHaveBeenCalledWith('abc');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, tier: 'pro', email: 'a@b.c' });
    });

    it('returns 400 with payload when saveLicense reports invalid', async () => {
      lmMock.saveLicense.mockReturnValue({ valid: false, error: 'bad sig', payload: { tier: 'free' } });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/activate')({ body: { license: 'xyz' } }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'bad sig', payload: { tier: 'free' } });
    });

    it('returns 500 when saveLicense throws', async () => {
      lmMock.saveLicense.mockImplementation(() => { throw new Error('disk fail'); });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/activate')({ body: { license: 'x' } }, res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'disk fail' });
    });
  });

  describe('POST /api/license/deactivate', () => {
    it('calls clearLicense and returns ok', async () => {
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/deactivate')({}, res);
      expect(lmMock.clearLicense).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 500 when clearLicense throws', async () => {
      lmMock.clearLicense.mockImplementation(() => { throw new Error('e'); });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/deactivate')({}, res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'e' });
    });
  });

  describe('GET /api/license/features', () => {
    it('passes { force: true } and returns tier+features from loadLicense', async () => {
      lmMock.loadLicense.mockReturnValue({ tier: 'pro', features: { export: true } });
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/features')({}, res);
      expect(lmMock.loadLicense).toHaveBeenCalledWith({ force: true });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, tier: 'pro', features: { export: true } });
    });

    it('returns 500 when loadLicense throws', async () => {
      lmMock.loadLicense.mockImplementation(() => { throw new Error('e'); });
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/features')({}, res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /api/license/check/:feature', () => {
    it('returns feature name, has=true, and current tier', async () => {
      lmMock.hasFeature.mockReturnValue(true);
      lmMock.getCurrentTier.mockReturnValue('pro');
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/check/:feature')({ params: { feature: 'export' } }, res);
      expect(lmMock.hasFeature).toHaveBeenCalledWith('export');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, feature: 'export', has: true, tier: 'pro' });
    });

    it('returns has=false and tier=free for an unknown feature', async () => {
      lmMock.hasFeature.mockReturnValue(false);
      lmMock.getCurrentTier.mockReturnValue('free');
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/check/:feature')({ params: { feature: 'export' } }, res);
      expect(res.body).toEqual({ ok: true, feature: 'export', has: false, tier: 'free' });
    });

    it('returns 500 when hasFeature throws', async () => {
      lmMock.hasFeature.mockImplementation(() => { throw new Error('e'); });
      const res = makeRes();
      await routeHandler(routes, 'GET /api/license/check/:feature')({ params: { feature: 'x' } }, res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/license/verify', () => {
    it('returns 400 when license body is missing', async () => {
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/verify')({ body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'license body required' });
      expect(lmMock.verifyLicense).not.toHaveBeenCalled();
    });

    it('trims input and spreads verifyLicense result with ok=true', async () => {
      lmMock.verifyLicense.mockReturnValue({ valid: true, payload: { tier: 'pro', email: 'a@b.c' } });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/verify')({ body: { license: '  abc  ' } }, res);
      expect(lmMock.verifyLicense).toHaveBeenCalledWith('abc');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, valid: true, payload: { tier: 'pro', email: 'a@b.c' } });
    });

    it('returns 500 when verifyLicense throws', async () => {
      lmMock.verifyLicense.mockImplementation(() => { throw new Error('e'); });
      const res = makeRes();
      await routeHandler(routes, 'POST /api/license/verify')({ body: { license: 'x' } }, res);
      expect(res.statusCode).toBe(500);
    });
  });
});
