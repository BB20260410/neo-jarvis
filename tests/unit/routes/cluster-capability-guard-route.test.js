import { describe, expect, it, vi } from 'vitest';
import { registerRoomStartRoutes } from '../../../src/server/routes/roomStart.js';

function makeApp() {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'get', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'post', path, handlers }),
  };
  return { app, routes };
}

function makeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function registerForCapabilityGuard(rooms) {
  const roomStore = {
    get: (id) => rooms.get(id),
    list: () => [...rooms.values()],
  };
  const { app, routes } = makeApp();
  registerRoomStartRoutes(app, {
    roomStore,
    requireOwnerToken: (_req, _res, next) => next(),
    debateDispatcher: { start: vi.fn() },
    squadDispatcher: { start: vi.fn() },
    arenaDispatcher: { start: vi.fn() },
    crossVerifyDispatcher: {
      start: vi.fn(),
      activeAborts: new Map([...rooms.values()]
        .filter((room) => room?.mode === 'cross_verify' && room?.status === 'running')
        .map((room) => [room.id, new AbortController()])),
    },
    broadcastRoom: () => {},
    roomAdapterPool: { adapters: new Map([['claude', {}], ['codex', {}], ['gemini-cli', {}]]) },
  });
  return routes.find((item) => item.method === 'get' && item.path === '/api/cluster/capability-guard');
}

describe('cluster capability guard route', () => {
  it('exposes a passed capability guard for native Claude/Gemini and Codex plugin bridge separation', async () => {
    const rooms = new Map([
      ['ok-room', {
        id: 'ok-room',
        mode: 'cross_verify',
        status: 'running',
        members: [
          { adapterId: 'claude', enabled: true },
          { adapterId: 'codex', enabled: true, pluginBridge: { app: 'codex-app' } },
          { adapterId: 'gemini-cli', enabled: true },
        ],
      }],
    ]);
    const route = registerForCapabilityGuard(rooms);
    const res = makeResponse();

    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      capabilityGuard: {
        status: 'passed',
        ok: true,
        blockers: [],
        summary: {
          totalRoomCount: 1,
          enabledMemberCount: 3,
          nativeBridgeViolationCount: 0,
        },
      },
      diagnostics: {
        status: 'passed',
        summary: {
          capabilityGuardStatus: 'passed',
        },
      },
    });
  });

  it('returns 503 when a cross_verify room injects shared skills into native members', async () => {
    const rooms = new Map([
      ['bad-room', {
        id: 'bad-room',
        mode: 'cross_verify',
        status: 'running',
        skillIds: ['shared-room-skill'],
        members: [
          { adapterId: 'claude', enabled: true, skillBridge: { source: 'shared' } },
          { adapterId: 'codex', enabled: true, pluginBridge: { app: 'codex-app' } },
        ],
      }],
    ]);
    const route = registerForCapabilityGuard(rooms);
    const res = makeResponse();

    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.payload.capabilityGuard).toMatchObject({
      status: 'blocked',
      ok: false,
      blockers: expect.arrayContaining([
        'room_shared_capability_bridge:bad-room:skillIds',
        'native_member_shared_bridge:bad-room:claude#0',
      ]),
    });
    expect(res.payload.diagnostics).toMatchObject({
      status: 'blocked',
      summary: {
        capabilityGuardStatus: 'blocked',
      },
      invariants: {
        safeToStart: false,
        capabilityGuardHealthy: false,
      },
    });
  });
});
