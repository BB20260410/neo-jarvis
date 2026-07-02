import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clearClusterStartReservationsForTest,
  registerRoomStartRoutes,
} from '../../../src/server/routes/roomStart.js';

function makeApp() {
  const routes = [];
  const app = {
    post(path, ...handlers) {
      routes.push({ method: 'post', path, handlers });
    },
    get(path, ...handlers) {
      routes.push({ method: 'get', path, handlers });
    },
  };
  return { app, routes };
}

function makeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function registerRepairRoute({ roomStore, crossVerifyDispatcher, broadcastRoom = () => {} }) {
  const { app, routes } = makeApp();
  registerRoomStartRoutes(app, {
    roomStore,
    requireOwnerToken: (_req, _res, next) => next(),
    debateDispatcher: crossVerifyDispatcher,
    squadDispatcher: crossVerifyDispatcher,
    arenaDispatcher: crossVerifyDispatcher,
    crossVerifyDispatcher,
    broadcastRoom,
    roomAdapterPool: new Map(),
  });
  return routes.find((route) => route.method === 'post' && route.path === '/api/cluster/repair');
}

describe('cluster repair route', () => {
  afterEach(() => {
    clearClusterStartReservationsForTest();
  });

  it('repairs stale active abort controllers and returns a refreshed diagnostics report', async () => {
    const staleAbort = new AbortController();
    const rooms = new Map([[
      'stale-active-abort',
      {
        id: 'stale-active-abort',
        mode: 'cross_verify',
        status: 'paused',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      },
    ]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };
    const crossVerifyDispatcher = { activeAborts: new Map([['stale-active-abort', staleAbort]]) };
    const route = registerRepairRoute({ roomStore, crossVerifyDispatcher });

    const res = makeResponse();
    await route.handlers[1]({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      repair: {
        ok: true,
        status: 'repaired',
        appliedActions: ['cleaned_active_abort_controllers'],
      },
      diagnostics: {
        status: 'passed',
      },
      assurance: {
        status: 'passed',
      },
    });
    expect(staleAbort.signal.aborted).toBe(true);
    expect(crossVerifyDispatcher.activeAborts.has('stale-active-abort')).toBe(false);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('keeps repair blocked when runtime recovery cannot update room state', async () => {
    const rooms = new Map([[
      'stale-running',
      {
        id: 'stale-running',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      },
    ]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn(() => {
        throw new Error('store update failed');
      }),
      flush: vi.fn(),
    };
    const crossVerifyDispatcher = { activeAborts: new Map() };
    const route = registerRepairRoute({ roomStore, crossVerifyDispatcher });

    const res = makeResponse();
    await route.handlers[1]({}, res);

    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({
      ok: false,
      repair: {
        ok: false,
        status: 'blocked',
        blockers: expect.arrayContaining(['runtime_recovery_errors']),
      },
      runtimeReconciliation: {
        status: 'recovery_failed',
        recoveryErrorCount: 1,
      },
    });
    expect(roomStore.flush).not.toHaveBeenCalled();
  });
});
