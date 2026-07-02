import { describe, expect, it } from 'vitest';
import { registerNoeDelegationRoutes } from '../../../src/server/routes/noeDelegation.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['post']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function route(routes, path) {
  return routes.find((r) => r.method === 'post' && r.path === path).handlers[1];
}

function makeRoomStore() {
  const rooms = new Map();
  const calls = { create: 0, update: 0 };
  return {
    calls,
    get: (id) => rooms.get(id),
    create(input) {
      calls.create += 1;
      const room = { id: `room-${calls.create}`, status: 'idle', ...input };
      rooms.set(room.id, room);
      return room;
    },
    update(id, patch) {
      calls.update += 1;
      const room = { ...rooms.get(id), ...patch };
      rooms.set(id, room);
      return room;
    },
  };
}

describe('Noe delegation routes', () => {
  it('plans a delegation without creating a room', () => {
    const roomStore = makeRoomStore();
    const { app, routes } = makeApp();
    registerNoeDelegationRoutes(app, {
      roomStore,
      getRoomAdapterPool: () => new Map([['codex', { displayName: 'Codex' }]]),
    });

    const res = makeRes();
    route(routes, '/api/noe/delegate/plan')({ body: { text: '让 Codex 帮我修复登录页 bug' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      matched: true,
      intent: 'delegate_task',
      dryRunOnly: true,
      confirmEndpoint: '/api/noe/delegate/confirm',
      plan: { targetAdapter: 'codex', targetMode: 'chat' },
    });
    expect(roomStore.calls.create).toBe(0);
  });

  it('requires confirm:true before creating a room', () => {
    const roomStore = makeRoomStore();
    const { app, routes } = makeApp();
    registerNoeDelegationRoutes(app, {
      roomStore,
      getRoomAdapterPool: () => new Map([['codex', { displayName: 'Codex' }]]),
    });

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({ body: { text: '让 Codex 帮我写单测' } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload.error).toBe('confirm:true required');
    expect(roomStore.calls.create).toBe(0);
  });

  it('creates an idle delegated room and does not start or queue execution', () => {
    const roomStore = makeRoomStore();
    const { app, routes } = makeApp();
    registerNoeDelegationRoutes(app, {
      roomStore,
      getRoomAdapterPool: () => new Map([['codex', { displayName: 'Codex' }]]),
      safeResolveFsPath: (p) => `/safe${p}`,
    });

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({
      body: { text: '让 Codex 帮我写单测', cwd: '/tmp/noe', confirm: true },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({
      ok: true,
      intent: 'delegate_task',
      approvalRequired: false,
      started: false,
      queued: false,
    });
    expect(res.payload.room).toMatchObject({
      status: 'idle',
      mode: 'chat',
      cwd: '/safe/tmp/noe',
      delegatedFromNoe: { dryRunOnly: true },
    });
    expect(res.payload.room.members[0]).toMatchObject({ adapterId: 'codex', enabled: true });
    expect(res.payload.room.topic).toContain('不启动 CLI');
  });

  it('autoStart creates a manual approval gate and queued autopilot job without starting', () => {
    const roomStore = makeRoomStore();
    const approval = { id: 'approval-1', status: 'pending' };
    const job = { id: 'job-1', action: 'start_noe_delegate', status: 'queued' };
    const agentRun = { id: 'agent-run-1', status: 'queued' };
    const approvalStore = {
      createApproval(input) {
        expect(input.type).toBe('manual');
        expect(input.requesterType).toBe('noe');
        expect(input.payload).toMatchObject({
          targetAdapter: 'codex',
          targetMode: 'chat',
        });
        expect(input.payload.risk).toContain('does not start CLI adapters');
        return approval;
      },
    };
    const scheduleStore = {
      enqueueJob(input) {
        expect(input.action).toBe('start_noe_delegate');
        expect(input.payload).toMatchObject({
          approvalId: 'approval-1',
          requireApproval: true,
          autoStart: true,
        });
        return job;
      },
    };
    const agentRunStore = {
      create(input) {
        expect(input).toMatchObject({
          status: 'queued',
          approvalId: 'approval-1',
          sourceType: 'noe_delegate_autostart',
          dispatchTags: ['noe', 'governance'],
        });
        return agentRun;
      },
    };
    const { app, routes } = makeApp();
    registerNoeDelegationRoutes(app, {
      roomStore,
      approvalStore,
      scheduleStore,
      agentRunStore,
      getRoomAdapterPool: () => new Map([['codex', { displayName: 'Codex' }]]),
    });

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({
      body: { text: '让 Codex 帮我写单测', confirm: true, autoStart: true },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.payload.approvalRequired).toBe(true);
    expect(res.payload.approval).toBe(approval);
    expect(res.payload.job).toBe(job);
    expect(res.payload.agentRun).toBe(agentRun);
    expect(res.payload.started).toBe(false);
    expect(res.payload.queued).toBe(true);
    expect(roomStore.calls.create).toBe(1);
  });
});
