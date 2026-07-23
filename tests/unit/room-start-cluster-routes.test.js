import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/services/panel-health.js', () => ({
  assessPanelClusterHealth: vi.fn(),
  buildPanelClusterReadiness: vi.fn(),
}));

vi.mock('../../src/server/services/cluster-config-audit.js', () => ({
  buildClusterConfigAudit: vi.fn(),
}));

vi.mock('../../src/server/services/cluster-diagnostics.js', () => ({
  buildClusterDiagnostics: vi.fn(),
}));

vi.mock('../../src/server/services/cluster-runtime.js', () => ({
  buildClusterActiveAbortRooms: vi.fn(),
  buildClusterCapabilityGuard: vi.fn(),
  buildClusterConcurrencyBudget: vi.fn(),
  buildClusterHealthTrend: vi.fn(),
  buildClusterOpsGuard: vi.fn(),
  buildClusterResourceGuard: vi.fn(),
  listRoomsForConcurrency: vi.fn(),
  resolveRuntimeRecoveryPersistPending: vi.fn(),
  runClusterRuntimeWatchdogOnce: vi.fn(),
}));

import { registerClusterStatusRoutes } from '../../src/server/routes/roomStartClusterRoutes.js';
import { assessPanelClusterHealth, buildPanelClusterReadiness } from '../../src/server/services/panel-health.js';
import { buildClusterConfigAudit } from '../../src/server/services/cluster-config-audit.js';
import { buildClusterDiagnostics } from '../../src/server/services/cluster-diagnostics.js';
import {
  buildClusterActiveAbortRooms,
  buildClusterCapabilityGuard,
  buildClusterConcurrencyBudget,
  buildClusterHealthTrend,
  buildClusterOpsGuard,
  buildClusterResourceGuard,
  listRoomsForConcurrency,
  resolveRuntimeRecoveryPersistPending,
  runClusterRuntimeWatchdogOnce,
} from '../../src/server/services/cluster-runtime.js';

function makeApp() {
  const routes = {};
  const app = {
    get: vi.fn((path, ...handlers) => {
      routes[path] = { method: 'get', handlers };
      return app;
    }),
    post: vi.fn((path, ...handlers) => {
      routes[path] = { method: 'post', handlers };
      return app;
    }),
    routes,
  };
  return app;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    status: vi.fn(function (code) { this.statusCode = code; return this; }),
    json: vi.fn(function (b) { this.body = b; return this; }),
  };
  return res;
}

function makeReq({ query = {} } = {}) {
  return { query };
}

describe('registerClusterStatusRoutes', () => {
  let app;
  let roomStore;
  let requireOwnerToken;
  let crossVerifyDispatcher;
  let broadcastRoom;
  let roomAdapterPool;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
    roomStore = { get: vi.fn() };
    requireOwnerToken = (req, res, next) => next();
    crossVerifyDispatcher = { abort: vi.fn() };
    broadcastRoom = vi.fn();
    roomAdapterPool = null;

    runClusterRuntimeWatchdogOnce.mockReturnValue({ recoveryErrorCount: 0, flushError: null });
    buildClusterConcurrencyBudget.mockReturnValue({ budget: 'mock' });
    buildClusterConfigAudit.mockReturnValue({ audit: 'mock' });
    buildClusterActiveAbortRooms.mockReturnValue([]);
    assessPanelClusterHealth.mockReturnValue({ status: 'passed' });
    buildPanelClusterReadiness.mockReturnValue({ status: 'ready' });
    listRoomsForConcurrency.mockReturnValue([]);
    buildClusterResourceGuard.mockReturnValue({ guard: 'resource' });
    buildClusterCapabilityGuard.mockReturnValue({ guard: 'capability' });
    buildClusterDiagnostics.mockReturnValue({ diag: 'mock' });
    buildClusterHealthTrend.mockReturnValue({ trend: 'mock' });
    buildClusterOpsGuard.mockReturnValue({ ops: 'mock' });
    resolveRuntimeRecoveryPersistPending.mockReturnValue({ pending: 'mock' });
  });

  it('registers the four cluster status routes', () => {
    registerClusterStatusRoutes(app, {
      roomStore,
      requireOwnerToken,
      crossVerifyDispatcher,
      broadcastRoom,
    });
    expect(app.get).toHaveBeenCalledWith('/api/cluster/concurrency-budget', expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/cluster/health', expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/cluster/readiness', expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/cluster/repair', expect.any(Function), expect.any(Function));
  });

  describe('GET /api/cluster/concurrency-budget', () => {
    it('returns null roomId when no roomId query is provided', () => {
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/concurrency-budget'].handlers[1];
      const req = makeReq({ query: {} });
      const res = makeRes();
      handler(req, res);
      expect(roomStore.get).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        roomId: null,
        mode: null,
      }));
    });

    it('returns room info when a valid roomId is provided', () => {
      const room = { id: 'r1', mode: 'classic' };
      roomStore.get.mockReturnValue(room);
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/concurrency-budget'].handlers[1];
      const req = makeReq({ query: { roomId: 'r1' } });
      const res = makeRes();
      handler(req, res);
      expect(roomStore.get).toHaveBeenCalledWith('r1');
      expect(buildClusterConcurrencyBudget).toHaveBeenCalledWith(room, expect.objectContaining({
        projectCurrentRoom: true,
      }));
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        roomId: 'r1',
        mode: 'classic',
      }));
    });

    it('returns 404 when the roomId does not exist', () => {
      roomStore.get.mockReturnValue(null);
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/concurrency-budget'].handlers[1];
      const req = makeReq({ query: { roomId: 'missing' } });
      const res = makeRes();
      handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'room not found' });
    });
  });

  describe('GET /api/cluster/health', () => {
    it('returns 200 when health status is "passed"', () => {
      assessPanelClusterHealth.mockReturnValue({ status: 'passed' });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/health'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        health: { status: 'passed' },
      }));
    });

    it('returns 503 when health status is not "passed"', () => {
      assessPanelClusterHealth.mockReturnValue({ status: 'failed' });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/health'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      handler(req, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        health: { status: 'failed' },
      }));
    });
  });

  describe('GET /api/cluster/readiness', () => {
    it('returns 200 when readiness status is not "blocked"', () => {
      buildPanelClusterReadiness.mockReturnValue({ status: 'ready' });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/readiness'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        readiness: { status: 'ready' },
      }));
    });

    it('returns 503 when readiness status is "blocked"', () => {
      buildPanelClusterReadiness.mockReturnValue({ status: 'blocked' });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
      });
      const handler = app.routes['/api/cluster/readiness'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      handler(req, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        readiness: { status: 'blocked' },
      }));
    });
  });

  describe('POST /api/cluster/repair', () => {
    it('runs the watchdog once when recovery errors occur on first run', async () => {
      runClusterRuntimeWatchdogOnce.mockReturnValueOnce({ recoveryErrorCount: 1, flushError: null });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
        roomAdapterPool,
      });
      const handler = app.routes['/api/cluster/repair'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      await handler(req, res);
      expect(runClusterRuntimeWatchdogOnce).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalled();
    });

    it('runs the watchdog twice when no recovery errors occur on first run', async () => {
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
        roomAdapterPool,
      });
      const handler = app.routes['/api/cluster/repair'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      await handler(req, res);
      expect(runClusterRuntimeWatchdogOnce).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalled();
    });

    it('returns 500 with internal error when the handler throws (safeAsync catch)', async () => {
      buildClusterConcurrencyBudget.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      registerClusterStatusRoutes(app, {
        roomStore,
        requireOwnerToken,
        crossVerifyDispatcher,
        broadcastRoom,
        roomAdapterPool,
      });
      const handler = app.routes['/api/cluster/repair'].handlers[1];
      const req = makeReq();
      const res = makeRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'internal error' });
    });
  });
});
