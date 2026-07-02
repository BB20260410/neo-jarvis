import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the rate-limiter toggle so vi.mock factories can close over it.
const mockTryAcquire = vi.hoisted(() => vi.fn(() => true));

// Pass-through auth middleware: lets us exercise GET /api/hooks handler.
vi.mock('../../src/server/auth/owner-token.js', () => ({
  requireOwnerToken: (req, res, next) => next(),
}));

// Deterministic rate limiter: tests opt-in/out of the dropped branch.
vi.mock('../../src/safety/RateLimiter.js', () => ({
  rateLimiters: {
    get: () => ({ tryAcquire: mockTryAcquire }),
  },
}));

import { registerHooksRoutes } from '../../src/server/routes/hooks.js';

// Capture registered route handlers so tests can dispatch synthetic req/res.
function makeApp() {
  const handlers = {};
  const app = {
    handlers,
    post: (path, ...fns) => { (handlers[path] = handlers[path] || []).push(fns); },
    get: (path, ...fns) => { (handlers[path] = handlers[path] || []).push(fns); },
  };
  return app;
}

function makeRes() {
  const res = { statusCode: 200, jsonData: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (d) => { res.jsonData = d; return res; };
  return res;
}

// Walk an Express-style middleware chain ending at the final handler.
function callRoute(app, path, req, res) {
  const entries = app.handlers[path];
  if (!entries || entries.length === 0) throw new Error('no handler: ' + path);
  const fns = entries[entries.length - 1];
  let i = 0;
  const next = () => {
    if (i >= fns.length) return;
    const fn = fns[i++];
    fn(req, res, next);
  };
  next();
}

function lastEvent(listRes) {
  const arr = listRes.jsonData.events;
  return arr[arr.length - 1];
}

describe('registerHooksRoutes', () => {
  let app, sessions, broadcastSession, safeSlice;

  beforeEach(() => {
    mockTryAcquire.mockReturnValue(true);
    app = makeApp();
    sessions = new Map();
    broadcastSession = vi.fn();
    safeSlice = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
    registerHooksRoutes(app, { sessions, broadcastSession, safeSlice });
  });

  it('rejects unknown hook event with 400', () => {
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', { params: { event: 'MadeUpEvent' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonData.error).toMatch(/unknown hook event/);
  });

  it('accepts a valid event with no session and returns ok', () => {
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PreToolUse' },
      body: { tool_name: 'Bash', cwd: '/home' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonData).toEqual({ ok: true });
  });

  it('stores per-session records and broadcasts when session_id is present', () => {
    const sid = 'sess-broadcast';
    sessions.set(sid, {});
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PostToolUse' },
      body: { session_id: sid, tool_name: 'Bash' },
    }, res);
    const s = sessions.get(sid);
    expect(s.hookEvents).toHaveLength(1);
    expect(s.hookEvents[0]).toMatchObject({ event: 'PostToolUse', sessionId: sid, tool: 'Bash' });
    expect(broadcastSession).toHaveBeenCalledWith(s, expect.objectContaining({ type: 'hook_event' }));
  });

  it('returns ok with dropped=rate when limiter rejects and does not broadcast', () => {
    mockTryAcquire.mockReturnValue(false);
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PreToolUse' },
      body: { session_id: 'sess-X', tool_name: 'X' },
    }, res);
    expect(res.jsonData).toEqual({ ok: true, dropped: 'rate' });
    expect(broadcastSession).not.toHaveBeenCalled();
  });

  it('flags payload as _truncated when oversized and keeps small fields intact', () => {
    const huge = 'x'.repeat(60 * 1024);
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PreToolUse' },
      body: { tool_name: 'tool', extra: huge },
    }, res);

    const listRes = makeRes();
    callRoute(app, '/api/hooks', { query: {} }, listRes);
    const last = lastEvent(listRes);
    expect(last.payload._truncated).toBe(true);
    expect(last.payload.tool_name).toBe('tool');
  });

  it('marks circular JSON bodies with _error: circular', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PreToolUse' },
      body: obj,
    }, res);

    const listRes = makeRes();
    callRoute(app, '/api/hooks', { query: {} }, listRes);
    const last = lastEvent(listRes);
    expect(last.payload._error).toBe('circular');
  });

  it('applies safeSlice to long sessionId, tool, and cwd', () => {
    const long = 'a'.repeat(2000);
    const res = makeRes();
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'PreToolUse' },
      body: { session_id: long, tool_name: long, cwd: long },
    }, res);

    const listRes = makeRes();
    callRoute(app, '/api/hooks', { query: {} }, listRes);
    const last = lastEvent(listRes);
    expect(last.sessionId.length).toBe(100);
    expect(last.tool.length).toBe(200);
    expect(last.cwd.length).toBe(1024);
  });

  it('caps per-session hookEvents at HOOK_MAX_PER_SESSION (200)', () => {
    const sid = 'sess-cap';
    sessions.set(sid, {});
    for (let i = 0; i < 250; i++) {
      callRoute(app, '/api/hooks/:event', {
        params: { event: 'Notification' },
        body: { session_id: sid },
      }, makeRes());
    }
    expect(sessions.get(sid).hookEvents.length).toBe(200);
  });

  it('GET /api/hooks?sessionId=... filters events to that session', () => {
    const sid = 'sess-filter';
    sessions.set(sid, {});
    callRoute(app, '/api/hooks/:event', {
      params: { event: 'Notification' },
      body: { session_id: sid },
    }, makeRes());

    const listRes = makeRes();
    callRoute(app, '/api/hooks', { query: { sessionId: sid } }, listRes);
    expect(listRes.jsonData.count).toBe(1);
    expect(listRes.jsonData.events).toHaveLength(1);
  });

  it('GET /api/hooks clamps an oversized limit to 500', () => {
    const listRes = makeRes();
    callRoute(app, '/api/hooks', { query: { limit: '99999' } }, listRes);
    expect(listRes.jsonData.events.length).toBeLessThanOrEqual(500);
  });
});
