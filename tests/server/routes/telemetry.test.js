import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/telemetry/ErrorReporter.js', () => ({
  loadConfig: vi.fn(),
  acceptTelemetry: vi.fn(),
  declineTelemetry: vi.fn(),
  isEnabled: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../../../src/telemetry/Analytics.js', () => ({
  capture: vi.fn(),
  isAnalyticsEnabled: vi.fn(() => false),
}));

vi.mock('../../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => {
    // no-op pass-through; route handlers are invoked next in the test loop
  },
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
}));

import * as ErrorReporter from '../../../src/telemetry/ErrorReporter.js';
import * as Analytics from '../../../src/telemetry/Analytics.js';
import { registerTelemetryRoutes } from '../../../src/server/routes/telemetry.js';

function createApp() {
  const routes = {};
  return {
    routes,
    get(path, ...handlers) {
      routes[path] = { ...(routes[path] || {}), get: handlers };
    },
    post(path, ...handlers) {
      routes[path] = { ...(routes[path] || {}), post: handlers };
    },
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runHandlers(handlers, req) {
  const res = createRes();
  for (const h of handlers) {
    const result = h(req, res);
    if (result && typeof result.then === 'function') {
      await result;
    }
  }
  return res;
}

describe('src/server/routes/telemetry.js', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    registerTelemetryRoutes(app);
  });

  describe('route registration', () => {
    it('registers every expected telemetry/analytics route', () => {
      expect(app.routes['/api/telemetry/config']?.get).toBeDefined();
      expect(app.routes['/api/telemetry/accept']?.post).toBeDefined();
      expect(app.routes['/api/telemetry/decline']?.post).toBeDefined();
      expect(app.routes['/api/analytics/config']?.post).toBeDefined();
      expect(app.routes['/api/analytics/capture']?.post).toBeDefined();
      expect(app.routes['/api/telemetry/test']?.post).toBeDefined();
    });

    it('attaches owner-token middleware to every POST route but not to GET', () => {
      const ownerTokenPaths = [
        '/api/telemetry/accept',
        '/api/telemetry/decline',
        '/api/analytics/config',
        '/api/analytics/capture',
        '/api/telemetry/test',
      ];
      for (const p of ownerTokenPaths) {
        expect(app.routes[p].post).toHaveLength(2);
      }
      // GET /api/telemetry/config is public and must have no middleware
      expect(app.routes['/api/telemetry/config'].get).toHaveLength(1);
    });
  });

  describe('GET /api/telemetry/config', () => {
    it('returns enabled + redacted dsnPreview when DSN is present', async () => {
      ErrorReporter.loadConfig.mockReturnValue({
        enabled: true,
        dsn: 'https://secretkey12345@o0.ingest.sentry.io/123',
        acceptedAt: '2024-01-01T00:00:00Z',
      });
      const res = await runHandlers(app.routes['/api/telemetry/config'].get, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.hasDsn).toBe(true);
      // secret segment must be redacted — only the ****@ marker survives
      expect(res.body.dsnPreview).not.toContain('secretkey12345');
      expect(res.body.dsnPreview).toContain('****@');
      expect(res.body.acceptedAt).toBe('2024-01-01T00:00:00Z');
    });

    it('returns empty dsnPreview when no DSN is configured', async () => {
      ErrorReporter.loadConfig.mockReturnValue({
        enabled: false,
        dsn: '',
        acceptedAt: null,
      });
      const res = await runHandlers(app.routes['/api/telemetry/config'].get, {});
      expect(res.statusCode).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.hasDsn).toBe(false);
      expect(res.body.dsnPreview).toBe('');
    });

    it('returns 500 with error message when loadConfig throws', async () => {
      ErrorReporter.loadConfig.mockImplementation(() => {
        throw new Error('boom');
      });
      const res = await runHandlers(app.routes['/api/telemetry/config'].get, {});
      expect(res.statusCode).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('boom');
    });
  });

  describe('POST /api/telemetry/accept', () => {
    it('forwards a valid DSN to acceptTelemetry and reports hasDsn=true', async () => {
      const res = await runHandlers(app.routes['/api/telemetry/accept'].post, {
        body: { dsn: 'https://abc@sentry.io/123' },
      });
      expect(ErrorReporter.acceptTelemetry).toHaveBeenCalledWith({
        dsn: 'https://abc@sentry.io/123',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.hasDsn).toBe(true);
    });

    it('treats empty body as no DSN (hasDsn=false, acceptTelemetry called with empty string)', async () => {
      const res = await runHandlers(app.routes['/api/telemetry/accept'].post, { body: {} });
      expect(ErrorReporter.acceptTelemetry).toHaveBeenCalledWith({ dsn: '' });
      expect(res.body.hasDsn).toBe(false);
    });

    it('rejects DSN that does not start with https://', async () => {
      const res = await runHandlers(app.routes['/api/telemetry/accept'].post, {
        body: { dsn: 'http://insecure@sentry.io/123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/https:\/\//);
      expect(ErrorReporter.acceptTelemetry).not.toHaveBeenCalled();
    });

    it('rejects DSN longer than 500 chars', async () => {
      const res = await runHandlers(app.routes['/api/telemetry/accept'].post, {
        body: { dsn: 'https://' + 'a'.repeat(600) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/500/);
      expect(ErrorReporter.acceptTelemetry).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/telemetry/decline', () => {
    it('calls declineTelemetry and reports enabled=false', async () => {
      const res = await runHandlers(app.routes['/api/telemetry/decline'].post, {});
      expect(ErrorReporter.declineTelemetry).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(false);
    });
  });

  describe('POST /api/analytics/config', () => {
    it('persists host+key into telemetry.json via writeFileSync (mode 0600)', async () => {
      const fs = await import('node:fs');
      const initial = {
        enabled: true,
        dsn: 'https://x@sentry.io/1',
        acceptedAt: '2024-01-01',
      };
      ErrorReporter.loadConfig.mockReturnValue(initial);
      const res = await runHandlers(app.routes['/api/analytics/config'].post, {
        body: { host: 'https://us.i.posthog.com', key: 'phc_abc' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.hasHost).toBe(true);
      expect(res.body.hasKey).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [, body, opts] = fs.writeFileSync.mock.calls[0];
      const parsed = JSON.parse(body);
      expect(parsed.analyticsHost).toBe('https://us.i.posthog.com');
      expect(parsed.analyticsKey).toBe('phc_abc');
      expect(parsed.dsn).toBe('https://x@sentry.io/1');
      expect(opts.mode).toBe(0o600);
      // acceptTelemetry must have been called to keep dsn persisted
      expect(ErrorReporter.acceptTelemetry).toHaveBeenCalledWith({
        dsn: 'https://x@sentry.io/1',
      });
    });

    it('rejects host without http(s):// scheme', async () => {
      const fs = await import('node:fs');
      const res = await runHandlers(app.routes['/api/analytics/config'].post, {
        body: { host: 'us.i.posthog.com' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/http/);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects host longer than 500 chars', async () => {
      const res = await runHandlers(app.routes['/api/analytics/config'].post, {
        body: { host: 'https://' + 'a'.repeat(600) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/host/);
    });

    it('rejects key longer than 200 chars', async () => {
      const res = await runHandlers(app.routes['/api/analytics/config'].post, {
        body: { key: 'k'.repeat(300) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/key/);
    });
  });

  describe('POST /api/analytics/capture', () => {
    it('returns 400 when event field is missing', async () => {
      const res = await runHandlers(app.routes['/api/analytics/capture'].post, { body: {} });
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/event/);
      expect(Analytics.capture).not.toHaveBeenCalled();
    });

    it('forwards event + properties to Analytics.capture', async () => {
      Analytics.isAnalyticsEnabled.mockReturnValue(true);
      const res = await runHandlers(app.routes['/api/analytics/capture'].post, {
        body: { event: 'page_view', properties: { path: '/foo' } },
      });
      expect(Analytics.capture).toHaveBeenCalledWith('page_view', { path: '/foo' });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.queued).toBe(true);
    });

    it('defaults missing properties to an empty object', async () => {
      const res = await runHandlers(app.routes['/api/analytics/capture'].post, {
        body: { event: 'page_view' },
      });
      expect(Analytics.capture).toHaveBeenCalledWith('page_view', {});
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/telemetry/test', () => {
    it('returns 400 when telemetry is not yet enabled', async () => {
      ErrorReporter.isEnabled.mockReturnValue(false);
      const res = await runHandlers(app.routes['/api/telemetry/test'].post, {});
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/未开启/);
      expect(ErrorReporter.captureException).not.toHaveBeenCalled();
    });

    it('sends a synthetic Error with manual-test tag when enabled', async () => {
      ErrorReporter.isEnabled.mockReturnValue(true);
      ErrorReporter.captureException.mockResolvedValue({ id: 'fake-evt-id' });
      const res = await runHandlers(app.routes['/api/telemetry/test'].post, {});
      expect(ErrorReporter.captureException).toHaveBeenCalledTimes(1);
      const [errArg, opts] = ErrorReporter.captureException.mock.calls[0];
      expect(errArg).toBeInstanceOf(Error);
      expect(errArg.message).toMatch(/Panel telemetry test event/);
      expect(opts.tags.kind).toBe('manual-test');
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.result).toEqual({ id: 'fake-evt-id' });
    });
  });
});
