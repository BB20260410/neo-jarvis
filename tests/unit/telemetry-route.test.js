import { describe, it, expect, beforeEach, vi } from 'vitest';

const telemetryMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  acceptTelemetry: vi.fn(),
  declineTelemetry: vi.fn(),
  isEnabled: vi.fn(),
  captureException: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  isAnalyticsEnabled: vi.fn(),
}));

vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (_req, _res, next) => next(),
}));

vi.mock('../../src/telemetry/ErrorReporter.js', () => telemetryMocks);
vi.mock('../../src/telemetry/Analytics.js', () => analyticsMocks);

import { registerTelemetryRoutes } from '../../src/server/routes/telemetry.js';

function makeApp() {
  const routes = {};
  const app = {
    get: (path, ...handlers) => { routes['GET ' + path] = handlers; },
    post: (path, ...handlers) => { routes['POST ' + path] = handlers; },
  };
  registerTelemetryRoutes(app);
  return routes;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

function lastHandler(routes, method, path) {
  const arr = routes[method + ' ' + path];
  return arr[arr.length - 1];
}

describe('registerTelemetryRoutes', () => {
  let routes;

  beforeEach(() => {
    vi.clearAllMocks();
    telemetryMocks.loadConfig.mockReturnValue({ enabled: false, dsn: '', acceptedAt: null });
    telemetryMocks.isEnabled.mockReturnValue(false);
    analyticsMocks.isAnalyticsEnabled.mockReturnValue(true);
    routes = makeApp();
  });

  it('registers all six expected routes', () => {
    expect(routes['GET /api/telemetry/config']).toBeDefined();
    expect(routes['POST /api/telemetry/accept']).toBeDefined();
    expect(routes['POST /api/telemetry/decline']).toBeDefined();
    expect(routes['POST /api/analytics/config']).toBeDefined();
    expect(routes['POST /api/analytics/capture']).toBeDefined();
    expect(routes['POST /api/telemetry/test']).toBeDefined();
  });

  describe('GET /api/telemetry/config', () => {
    it('reports disabled with no DSN when not configured', async () => {
      telemetryMocks.loadConfig.mockReturnValue({ enabled: false, dsn: '', acceptedAt: null });
      const res = makeRes();
      await lastHandler(routes, 'GET', '/api/telemetry/config')({}, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        enabled: false,
        hasDsn: false,
        dsnPreview: '',
        acceptedAt: null,
      });
    });

    it('sanitizes dsnPreview to hide secret when DSN is present', async () => {
      telemetryMocks.loadConfig.mockReturnValue({
        enabled: true,
        dsn: 'https://publickey:secret@sentry.io/12345',
        acceptedAt: 1700000000000,
      });
      const res = makeRes();
      await lastHandler(routes, 'GET', '/api/telemetry/config')({}, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.hasDsn).toBe(true);
      expect(res.body.dsnPreview).not.toContain('publickey:secret');
      expect(res.body.dsnPreview).toContain('****');
      expect(res.body.acceptedAt).toBe(1700000000000);
    });

    it('returns 500 when loadConfig throws', async () => {
      telemetryMocks.loadConfig.mockImplementation(() => { throw new Error('config corrupt'); });
      const res = makeRes();
      await lastHandler(routes, 'GET', '/api/telemetry/config')({}, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('config corrupt');
    });
  });

  describe('POST /api/telemetry/accept', () => {
    it('accepts a valid HTTPS DSN and forwards it to acceptTelemetry', async () => {
      const dsn = 'https://abc@sentry.io/12345';
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/accept')(
        { body: { dsn } },
        res,
      );
      expect(telemetryMocks.acceptTelemetry).toHaveBeenCalledWith({ dsn });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, enabled: true, hasDsn: true });
    });

    it('rejects non-HTTPS DSN with 400', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/accept')(
        { body: { dsn: 'http://abc@sentry.io/12345' } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/https:\/\//);
      expect(telemetryMocks.acceptTelemetry).not.toHaveBeenCalled();
    });

    it('rejects overlong DSN with 400', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/accept')(
        { body: { dsn: 'https://' + 'a'.repeat(500) } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/500/);
      expect(telemetryMocks.acceptTelemetry).not.toHaveBeenCalled();
    });

    it('treats missing dsn as accept-without-DSN', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/accept')({ body: {} }, res);
      expect(telemetryMocks.acceptTelemetry).toHaveBeenCalledWith({ dsn: '' });
      expect(res.body.hasDsn).toBe(false);
    });
  });

  describe('POST /api/telemetry/decline', () => {
    it('calls declineTelemetry and reports disabled', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/decline')({}, res);
      expect(telemetryMocks.declineTelemetry).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, enabled: false });
    });
  });

  describe('POST /api/analytics/config', () => {
    it('rejects host that does not start with http', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/analytics/config')(
        { body: { host: 'us.i.posthog.com', key: 'phc_abc' } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/http/);
    });
  });

  describe('POST /api/analytics/capture', () => {
    it('captures the event with provided properties', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/analytics/capture')(
        { body: { event: 'panel_open', properties: { src: 'cli' } } },
        res,
      );
      expect(analyticsMocks.capture).toHaveBeenCalledWith('panel_open', { src: 'cli' });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.queued).toBe(true);
    });

    it('returns 400 when event is missing', async () => {
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/analytics/capture')(
        { body: { properties: {} } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(analyticsMocks.capture).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/telemetry/test', () => {
    it('returns 400 when telemetry is not enabled', async () => {
      telemetryMocks.isEnabled.mockReturnValue(false);
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/test')({}, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/\u672a\u5f00\u542f/);
      expect(telemetryMocks.captureException).not.toHaveBeenCalled();
    });

    it('captures a synthetic error when telemetry is enabled', async () => {
      telemetryMocks.isEnabled.mockReturnValue(true);
      telemetryMocks.captureException.mockResolvedValue({ id: 'sent-1' });
      const res = makeRes();
      await lastHandler(routes, 'POST', '/api/telemetry/test')({}, res);
      expect(telemetryMocks.captureException).toHaveBeenCalledTimes(1);
      const [err, ctx] = telemetryMocks.captureException.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/telemetry test event/);
      expect(ctx.tags.kind).toBe('manual-test');
      expect(res.statusCode).toBe(200);
      expect(res.body.result).toEqual({ id: 'sent-1' });
    });
  });
});
