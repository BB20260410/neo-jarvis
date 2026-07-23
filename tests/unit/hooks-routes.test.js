// Unit tests for src/server/routes/hooks.js — covers registerHooksRoutes wiring
// and behavior of POST /api/hooks/:event + GET /api/hooks.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist shared mock state so vi.mock factories can close over it.
const mocks = vi.hoisted(() => ({
  rateLimiter: { tryAcquire: () => true },
}));

// Auth: always allow — route logic only; owner-token has its own tests.
vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => next(),
}));

// RateLimiter: controllable per test via mocks.rateLimiter.tryAcquire.
vi.mock('../../src/safety/RateLimiter.js', () => ({
  rateLimiters: { get: () => mocks.rateLimiter },
}));

const { registerHooksRoutes } = await import('../../src/server/routes/hooks.js');

// --- minimal express stub -------------------------------------------------
function makeApp() {
  const routes = [];
  const app = {
    post(pattern, handler) { routes.push({ method: 'post', pattern, handler }); return app; },
    get(pattern, ...handlers) { routes.push({ method: 'get', pattern, handlers }); return app; },
  };
  return { app, routes };
}

function findRoute(routes, method, pattern) {
  return routes.find(r => r.method === method && r.pattern === pattern);
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

// --- tests ----------------------------------------------------------------
describe('registerHooksRoutes', () => {
  let app, routes, sessions, broadcastSession, safeSlice;

  beforeEach(() => {
    mocks.rateLimiter.tryAcquire = () => true; // reset to allow-by-default
    const f = makeApp();
    app = f.app;
    routes = f.routes;
    sessions = new Map();
    broadcastSession = vi.fn();
    safeSlice = (s, n) => String(s).slice(0, n);
    registerHooksRoutes(app, { sessions, broadcastSession, safeSlice });
  });

  it('registers POST /api/hooks/:event and GET /api/hooks', () => {
    expect(findRoute(routes, 'post', '/api/hooks/:event')).toBeDefined();
    expect(findRoute(routes, 'get', '/api/hooks')).toBeDefined();
  });

  it('mounts requireOwnerToken middleware on GET /api/hooks', () => {
    const r = findRoute(routes, 'get', '/api/hooks');
    expect(r.handlers).toHaveLength(2); // [middleware, final handler]
  });

  describe('POST /api/hooks/:event', () => {
    const post = () => findRoute(routes, 'post', '/api/hooks/:event').handler;

    it('returns 400 for unknown event name', () => {
      const res = makeRes();
      post()({ params: { event: 'NotARealEvent' }, body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/unknown hook event/);
    });

    it('returns { ok: true } for valid event with no session', () => {
      const res = makeRes();
      post()({ params: { event: 'PreToolUse' }, body: { tool_name: 'Read' } }, res);
      expect(res.body).toEqual({ ok: true });
    });

    it('silently drops with { ok: true, dropped: "rate" } when rate-limited', () => {
      mocks.rateLimiter.tryAcquire = () => false;
      const res = makeRes();
      post()({ params: { event: 'Stop' }, body: {} }, res);
      expect(res.body).toEqual({ ok: true, dropped: 'rate' });
    });

    it('appends record to existing session and broadcasts it', () => {
      const sess = { id: 's1' };
      sessions.set('s1', sess);
      const res = makeRes();
      post()({
        params: { event: 'PostToolUse' },
        body: { session_id: 's1', tool_name: 'Bash', cwd: '/tmp' },
      }, res);
      expect(sess.hookEvents).toHaveLength(1);
      expect(sess.hookEvents[0]).toMatchObject({
        event: 'PostToolUse',
        sessionId: 's1',
        tool: 'Bash',
        cwd: '/tmp',
      });
      expect(broadcastSession).toHaveBeenCalledTimes(1);
      expect(broadcastSession).toHaveBeenCalledWith(sess, {
        type: 'hook_event',
        record: sess.hookEvents[0],
      });
    });

    it('does not broadcast when sessionId is unknown', () => {
      const res = makeRes();
      post()({ params: { event: 'Stop' }, body: { session_id: 'ghost' } }, res);
      expect(broadcastSession).not.toHaveBeenCalled();
    });

    it('also accepts sessionId (camelCase) as session identifier', () => {
      const sess = { id: 'cam' };
      sessions.set('cam', sess);
      post()({ params: { event: 'Stop' }, body: { sessionId: 'cam' } }, makeRes());
      expect(sessions.get('cam').hookEvents[0].sessionId).toBe('cam');
    });

    it('truncates payload when serialized body exceeds 50KB', () => {
      const huge = 'x'.repeat(100 * 1024); // 100KB string field
      post()({ params: { event: 'Notification' }, body: { message: huge } }, makeRes());
      // Pull the most recent event back via GET to inspect payload.
      const get = findRoute(routes, 'get', '/api/hooks').handlers[1];
      const res = makeRes();
      get({ query: {} }, res);
      const last = res.body.events[res.body.events.length - 1];
      expect(last.payload._truncated).toBe(true);
      expect(last.payload.message.endsWith('…<截断>')).toBe(true);
    });
  });

  describe('GET /api/hooks', () => {
    const post = () => findRoute(routes, 'post', '/api/hooks/:event').handler;
    const get = () => findRoute(routes, 'get', '/api/hooks').handlers[1];

    it('returns the last `limit` events from the global stream', () => {
      for (let i = 0; i < 3; i++) {
        post()({ params: { event: 'Stop' }, body: { tool_name: 'T' + i } }, makeRes());
      }
      const res = makeRes();
      get()({ query: { limit: '2' } }, res);
      expect(res.body.ok).toBe(true);
      const last2 = res.body.events.slice(-2);
      expect(last2.map(e => e.tool)).toEqual(['T1', 'T2']);
    });

    it('filters by query.sessionId when provided', () => {
      sessions.set('a', { hookEvents: [] });
      sessions.set('b', { hookEvents: [] });
      post()({ params: { event: 'Stop' }, body: { session_id: 'a' } }, makeRes());
      post()({ params: { event: 'Stop' }, body: { session_id: 'b' } }, makeRes());
      post()({ params: { event: 'Stop' }, body: { session_id: 'a' } }, makeRes());
      const res = makeRes();
      get()({ query: { sessionId: 'a' } }, res);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.events.every(e => e.sessionId === 'a')).toBe(true);
    });

    it('caps limit at 500 even when a larger value is provided', () => {
      const res = makeRes();
      get()({ query: { limit: '99999' } }, res);
      expect(res.body.events.length).toBeLessThanOrEqual(500);
    });

    it('falls back to default limit 100 when limit is missing or invalid', () => {
      const res1 = makeRes();
      get()({ query: {} }, res1);
      expect(res1.body.events.length).toBeLessThanOrEqual(100);
      const res2 = makeRes();
      get()({ query: { limit: 'abc' } }, res2);
      expect(res2.body.events.length).toBeLessThanOrEqual(100);
    });

    it('count reflects total events while events array is sliced to limit', () => {
      const beforeRes = makeRes();
      get()({ query: {} }, beforeRes);
      const baseline = beforeRes.body.count;
      for (let i = 0; i < 5; i++) {
        post()({ params: { event: 'Stop' }, body: {} }, makeRes());
      }
      const res = makeRes();
      get()({ query: { limit: '3' } }, res);
      expect(res.body.count).toBe(baseline + 5);
      expect(res.body.events).toHaveLength(3);
    });
  });
});
