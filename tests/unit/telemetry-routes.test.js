// tests/unit/telemetry-routes.test.js
// Unit tests for src/server/routes/telemetry.js
//   GET  /api/telemetry/config          (no auth)
//   POST /api/telemetry/accept          (owner token)
//   POST /api/telemetry/decline         (owner token)
//   POST /api/analytics/config          (owner token)
//   POST /api/analytics/capture         (owner token)
//   POST /api/telemetry/test            (owner token)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

// ---- Shared mock state (hoisted before vi.mock factories) ----
const mockState = vi.hoisted(() => ({
  config: { enabled: false, dsn: '', acceptedAt: null, analyticsHost: '', analyticsKey: '' },
  captureResult: { eventId: 'evt-123' },
  writeFileCalls: [],
  captureSpy: vi.fn(),
}));

// ---- Mocks (hoisted by Vitest) ----

// owner-token middleware: accept "good-token", reject otherwise
vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => {
    if (req.headers['x-owner-token'] === 'good-token') return next();
    return res.status(401).json({ ok: false, error: 'owner token required' });
  },
}));

// ErrorReporter (loaded dynamically inside route handlers)
vi.mock('../../src/telemetry/ErrorReporter.js', () => ({
  loadConfig: () => mockState.config,
  acceptTelemetry: ({ dsn } = {}) => {
    mockState.config.enabled = true;
    if (dsn !== undefined) mockState.config.dsn = dsn;
    if (!mockState.config.acceptedAt) mockState.config.acceptedAt = '2024-01-01T00:00:00.000Z';
  },
  declineTelemetry: () => {
    mockState.config.enabled = false;
  },
  isEnabled: () => !!(mockState.config.enabled && mockState.config.dsn),
  captureException: async () => mockState.captureResult,
}));

// Analytics (loaded dynamically inside /analytics/capture)
vi.mock('../../src/telemetry/Analytics.js', () => ({
  capture: (...args) => mockState.captureSpy(...args),
  isAnalyticsEnabled: () => true,
}));

// node:fs — intercept writeFileSync so the route does not actually touch
// ~/.noe-panel/telemetry.json during tests
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  const writeFileSync = (...args) => mockState.writeFileCalls.push(args);
  return {
    ...actual,
    writeFileSync,
    default: { ...actual, writeFileSync },
  };
});

// ---- Subject under test ----
const { registerTelemetryRoutes } = await import('../../src/server/routes/telemetry.js');

// ---- Tiny HTTP client (no supertest dep) ----
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(server, { method, path, body, headers = {} }) {
  const { port } = server.address();
  const data = body !== undefined ? JSON.stringify(body) : null;
  const hdrs = { 'content-type': 'application/json', ...headers };
  if (data) hdrs['content-length'] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: hdrs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const OWNER = { 'x-owner-token': 'good-token' };

function buildApp() {
  const app = express();
  app.use(express.json());
  registerTelemetryRoutes(app);
  return app;
}

// ---- Tests ----
describe('src/server/routes/telemetry.js', () => {
  let server;

  beforeEach(async () => {
    mockState.config = { enabled: false, dsn: '', acceptedAt: null, analyticsHost: '', analyticsKey: '' };
    mockState.writeFileCalls.length = 0;
    mockState.captureSpy.mockClear();
    server = await listen(buildApp());
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('exports registerTelemetryRoutes as a function', () => {
    expect(typeof registerTelemetryRoutes).toBe('function');
  });

  // ---------- GET /api/telemetry/config ----------
  describe('GET /api/telemetry/config', () => {
    it('returns masked config snapshot when enabled', async () => {
      mockState.config = {
        enabled: true,
        dsn: 'https://secret123@sentry.io/42',
        acceptedAt: '2024-02-02T02:02:02.000Z',
      };
      const r = await call(server, { method: 'GET', path: '/api/telemetry/config' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.enabled).toBe(true);
      expect(r.body.hasDsn).toBe(true);
      expect(r.body.dsnPreview).not.toContain('secret123');
      expect(r.body.dsnPreview).toMatch(/\/\/\*{4}@/);
      expect(r.body.acceptedAt).toBe('2024-02-02T02:02:02.000Z');
    });

    it('reports empty config when nothing accepted', async () => {
      const r = await call(server, { method: 'GET', path: '/api/telemetry/config' });
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(false);
      expect(r.body.hasDsn).toBe(false);
      expect(r.body.dsnPreview).toBe('');
    });

    it('returns 500 when loadConfig throws', async () => {
      const mod = await import('../../src/telemetry/ErrorReporter.js');
      const orig = mod.loadConfig;
      mod.loadConfig = () => { throw new Error('disk fail'); };
      try {
        const r = await call(server, { method: 'GET', path: '/api/telemetry/config' });
        expect(r.status).toBe(500);
        expect(r.body.ok).toBe(false);
        expect(r.body.error).toBe('disk fail');
      } finally {
        mod.loadConfig = orig;
      }
    });
  });

  // ---------- POST /api/telemetry/accept ----------
  describe('POST /api/telemetry/accept', () => {
    it('requires owner token', async () => {
      const r = await call(server, { method: 'POST', path: '/api/telemetry/accept', body: {} });
      expect(r.status).toBe(401);
    });

    it('accepts without DSN (only flips enabled)', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/accept',
        body: {}, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, enabled: true, hasDsn: false });
      expect(mockState.config.enabled).toBe(true);
    });

    it('accepts a valid https DSN', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/accept',
        body: { dsn: 'https://k@sentry.io/1' }, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body.hasDsn).toBe(true);
      expect(mockState.config.dsn).toBe('https://k@sentry.io/1');
    });

    it('rejects non-https DSN with 400', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/accept',
        body: { dsn: 'http://insecure.example/1' }, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/https/);
    });

    it('rejects oversized DSN with 400', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/accept',
        body: { dsn: 'https://' + 'a'.repeat(600) }, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/500/);
    });

    it('returns 500 when acceptTelemetry throws', async () => {
      const mod = await import('../../src/telemetry/ErrorReporter.js');
      const orig = mod.acceptTelemetry;
      mod.acceptTelemetry = () => { throw new Error('disk full'); };
      try {
        const r = await call(server, {
          method: 'POST', path: '/api/telemetry/accept',
          body: { dsn: 'https://x@y.io/1' }, headers: OWNER,
        });
        expect(r.status).toBe(500);
        expect(r.body.error).toBe('disk full');
      } finally {
        mod.acceptTelemetry = orig;
      }
    });
  });

  // ---------- POST /api/telemetry/decline ----------
  describe('POST /api/telemetry/decline', () => {
    it('requires owner token', async () => {
      const r = await call(server, { method: 'POST', path: '/api/telemetry/decline', body: {} });
      expect(r.status).toBe(401);
    });

    it('disables telemetry', async () => {
      mockState.config.enabled = true;
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/decline',
        body: {}, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, enabled: false });
      expect(mockState.config.enabled).toBe(false);
    });
  });

  // ---------- POST /api/analytics/config ----------
  describe('POST /api/analytics/config', () => {
    it('requires owner token', async () => {
      const r = await call(server, { method: 'POST', path: '/api/analytics/config', body: {} });
      expect(r.status).toBe(401);
    });

    it('rejects host without http(s) scheme', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/config',
        body: { host: 'posthog.example', key: 'phc_x' }, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/http/);
    });

    it('persists host+key to telemetry.json with mode 0o600', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/config',
        body: { host: 'https://posthog.example', key: 'phc_abc' }, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, hasHost: true, hasKey: true });
      expect(mockState.writeFileCalls.length).toBe(1);
      const [p, body, opts] = mockState.writeFileCalls[0];
      expect(p).toMatch(/telemetry\.json$/);
      const parsed = JSON.parse(body);
      expect(parsed.analyticsHost).toBe('https://posthog.example');
      expect(parsed.analyticsKey).toBe('phc_abc');
      expect(opts.mode).toBe(0o600);
    });

    it('rejects oversized host', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/config',
        body: { host: 'https://' + 'h'.repeat(600) }, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/host/);
    });

    it('rejects oversized key', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/config',
        body: { key: 'k'.repeat(300) }, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/key/);
    });
  });

  // ---------- POST /api/analytics/capture ----------
  describe('POST /api/analytics/capture', () => {
    it('requires owner token', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/capture',
        body: { event: 'ping' },
      });
      expect(r.status).toBe(401);
    });

    it('rejects missing event', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/capture',
        body: {}, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/event/);
    });

    it('captures event and reports queued', async () => {
      const r = await call(server, {
        method: 'POST', path: '/api/analytics/capture',
        body: { event: 'panel_opened', properties: { a: 1 } }, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, queued: true, enabled: true });
      expect(mockState.captureSpy).toHaveBeenCalledWith('panel_opened', { a: 1 });
    });
  });

  // ---------- POST /api/telemetry/test ----------
  describe('POST /api/telemetry/test', () => {
    it('requires owner token', async () => {
      const r = await call(server, { method: 'POST', path: '/api/telemetry/test', body: {} });
      expect(r.status).toBe(401);
    });

    it('rejects with 400 when telemetry not enabled', async () => {
      mockState.config = { enabled: false, dsn: '' };
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/test',
        body: {}, headers: OWNER,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/未开启/);
    });

    it('returns captureException result when enabled', async () => {
      mockState.config = { enabled: true, dsn: 'https://k@s/1' };
      const r = await call(server, {
        method: 'POST', path: '/api/telemetry/test',
        body: {}, headers: OWNER,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, result: { eventId: 'evt-123' } });
    });
  });
});
