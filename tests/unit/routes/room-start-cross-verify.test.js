import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CrossVerifyDispatcher } from '../../../src/room/CrossVerifyDispatcher.js';
import {
  abortAndFlushActiveRoomDispatchers,
  abortActiveRoomDispatchers,
  buildClusterConcurrencyBudget,
  clearClusterStartReservationsForTest,
  prepareClusterRunGate,
  parseGoalModeCommandTopic,
  reconcileClusterRuntimeState,
  recoverClusterRuntimeAfterNonFatalError,
  registerRoomStartRoutes,
  reserveClusterStart,
  runClusterRuntimeWatchdogOnce,
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

function makeStubAdapter(replies) {
  let i = 0;
  return {
    id: 'route-stub-' + Math.random().toString(36).slice(2, 8),
    displayName: 'RouteStub',
    async chat() {
      const reply = replies[i % replies.length];
      i++;
      return { reply, tokensIn: 1, tokensOut: 1 };
    },
  };
}

describe('room start route: cross_verify dry-run', () => {
  it('shutdown helper aborts cross_verify active rooms together with other dispatchers', () => {
    const makeDispatcher = (prefix, count) => {
      const roomIds = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
      return {
        activeAborts: new Map(roomIds.map((roomId) => [roomId, new AbortController()])),
        aborted: [],
        abort(roomId) {
          this.aborted.push(roomId);
          const aborter = this.activeAborts.get(roomId);
          aborter?.abort();
          this.activeAborts.delete(roomId);
          return true;
        },
      };
    };
    const debate = makeDispatcher('debate', 1);
    const squad = makeDispatcher('squad', 1);
    const arena = makeDispatcher('arena', 1);
    const soloChat = makeDispatcher('solo', 1);
    const crossVerify = makeDispatcher('cross', 2);

    const result = abortActiveRoomDispatchers([
      { name: 'debate', dispatcher: debate },
      { name: 'squad', dispatcher: squad },
      { name: 'arena', dispatcher: arena },
      { name: 'soloChat', dispatcher: soloChat },
      { name: 'crossVerify', dispatcher: crossVerify },
    ]);

    expect(result.abortedCount).toBe(6);
    expect(result.results.find((item) => item.name === 'crossVerify')).toMatchObject({
      abortedCount: 2,
      roomIds: ['cross-1', 'cross-2'],
    });
    expect(crossVerify.aborted).toEqual(['cross-1', 'cross-2']);
    expect(crossVerify.activeAborts.size).toBe(0);
    expect([debate, squad, arena, soloChat].every((dispatcher) => dispatcher.activeAborts.size === 0)).toBe(true);
  });

  it('shutdown helper flushes roomStore after cross_verify abort updates room status', () => {
    const order = [];
    const rooms = new Map([
      ['cross-running', { id: 'cross-running', mode: 'cross_verify', status: 'running' }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      setStatus: vi.fn((id, status) => {
        order.push(`setStatus:${status}`);
        rooms.set(id, { ...rooms.get(id), status });
      }),
      flush: vi.fn(() => {
        order.push(`flush:${rooms.get('cross-running').status}`);
      }),
    };
    const crossVerify = {
      activeAborts: new Map([['cross-running', new AbortController()]]),
      abort(roomId) {
        const aborter = this.activeAborts.get(roomId);
        aborter.abort();
        this.activeAborts.delete(roomId);
        roomStore.setStatus(roomId, 'paused');
        return true;
      },
    };

    const result = abortAndFlushActiveRoomDispatchers({
      roomStore,
      dispatchers: [{ name: 'crossVerify', dispatcher: crossVerify }],
    });

    expect(result).toMatchObject({
      abortedCount: 1,
      flushed: true,
      flushError: null,
    });
    expect(order).toEqual(['setStatus:paused', 'flush:paused']);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(rooms.get('cross-running').status).toBe('paused');
  });

  it('shutdown helper still aborts active rooms when final flush fails', () => {
    const aborter = new AbortController();
    const crossVerify = {
      activeAborts: new Map([['cross-running', aborter]]),
      abort(roomId) {
        this.activeAborts.get(roomId)?.abort();
        this.activeAborts.delete(roomId);
        return true;
      },
    };
    const roomStore = {
      flush: vi.fn(() => {
        throw new Error('disk full');
      }),
    };

    const result = abortAndFlushActiveRoomDispatchers({
      roomStore,
      dispatchers: [{ name: 'crossVerify', dispatcher: crossVerify }],
    });

    expect(result).toMatchObject({
      abortedCount: 1,
      flushed: false,
      flushError: 'disk full',
    });
    expect(aborter.signal.aborted).toBe(true);
    expect(crossVerify.activeAborts.size).toBe(0);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('runtime reconciler pauses active running room when heartbeat is stalled', () => {
    const oldTimeout = process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
    process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = '1000';
    try {
      const aborter = new AbortController();
      const rooms = new Map([
        ['stalled-room', {
          id: 'stalled-room',
          name: '卡死房间',
          mode: 'cross_verify',
          status: 'running',
          clusterRuntimeHeartbeat: {
            statusVersion: 'cluster-runtime-heartbeat-v1',
            startedAt: '2026-06-01T00:00:00.000Z',
            lastProgressAt: '2026-06-01T00:00:00.000Z',
            lastEvent: 'propose_start',
          },
        }],
      ]);
      const roomStore = {
        list: () => [...rooms.values()],
        get: (id) => rooms.get(id),
        update: (id, patch) => rooms.set(id, { ...rooms.get(id), ...patch }),
      };
      const dispatcher = { activeAborts: new Map([['stalled-room', aborter]]) };
      const broadcasts = [];

      const result = reconcileClusterRuntimeState({
        roomStore,
        dispatcher,
        broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
        now: new Date('2026-06-01T00:00:02.500Z'),
      });

      const room = rooms.get('stalled-room');
      expect(result).toMatchObject({
        status: 'recovered',
        stalledActiveRoomCount: 1,
      });
      expect(result.stalledActiveRooms[0]).toMatchObject({
        roomId: 'stalled-room',
        reason: 'active_running_without_progress_timeout',
        stallTimeoutMs: 1000,
        resumePolicy: {
          statusVersion: 'cluster-runtime-resume-policy-v1',
          autoResumeAllowed: true,
          manualResumeAllowed: true,
          stallRecoveryCount: 1,
          maxStallRecoveries: 3,
        },
      });
      expect(room.status).toBe('paused');
      expect(room.clusterRuntimeRecovery).toMatchObject({
        reason: 'active_running_without_progress_timeout',
        action: 'paused_for_resume',
      });
      expect(room.clusterRuntimeResumePolicy).toMatchObject({
        autoResumeAllowed: true,
        nextAction: 'auto_resume_allowed_with_watchdog',
      });
      expect(aborter.signal.aborted).toBe(true);
      expect(dispatcher.activeAborts.has('stalled-room')).toBe(false);
      expect(broadcasts[0]).toMatchObject({
        roomId: 'stalled-room',
        reason: 'active_running_without_progress_timeout',
      });
    } finally {
      if (oldTimeout === undefined) delete process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = oldTimeout;
    }
  });

  it('runtime reconciler blocks automatic resume after repeated stall recoveries', () => {
    const oldTimeout = process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
    const oldMaxRecoveries = process.env.PANEL_CLUSTER_MAX_STALL_RECOVERIES;
    const oldWindow = process.env.PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS;
    process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = '1000';
    process.env.PANEL_CLUSTER_MAX_STALL_RECOVERIES = '2';
    process.env.PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS = '60000';
    try {
      const aborter = new AbortController();
      const rooms = new Map([
        ['repeat-stalled-room', {
          id: 'repeat-stalled-room',
          mode: 'cross_verify',
          status: 'running',
          clusterRuntimeHeartbeat: {
            statusVersion: 'cluster-runtime-heartbeat-v1',
            startedAt: '2026-06-01T00:00:00.000Z',
            lastProgressAt: '2026-06-01T00:00:00.000Z',
            lastEvent: 'review_start',
          },
          clusterRuntimeRecoveryEvents: [{
            reason: 'active_running_without_progress_timeout',
            at: '2026-06-01T00:00:01.500Z',
          }],
        }],
      ]);
      const roomStore = {
        list: () => [...rooms.values()],
        get: (id) => rooms.get(id),
        update: (id, patch) => rooms.set(id, { ...rooms.get(id), ...patch }),
      };
      const dispatcher = { activeAborts: new Map([['repeat-stalled-room', aborter]]) };

      const result = reconcileClusterRuntimeState({
        roomStore,
        dispatcher,
        now: new Date('2026-06-01T00:00:02.500Z'),
      });

      expect(result.stalledActiveRooms[0].resumePolicy).toMatchObject({
        autoResumeAllowed: false,
        manualResumeAllowed: true,
        stallRecoveryCount: 2,
        maxStallRecoveries: 2,
        nextAction: 'manual_review_required_before_resume',
      });
      expect(rooms.get('repeat-stalled-room').clusterRuntimeResumePolicy).toMatchObject({
        autoResumeAllowed: false,
        nextAction: 'manual_review_required_before_resume',
      });
    } finally {
      if (oldTimeout === undefined) delete process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = oldTimeout;
      if (oldMaxRecoveries === undefined) delete process.env.PANEL_CLUSTER_MAX_STALL_RECOVERIES;
      else process.env.PANEL_CLUSTER_MAX_STALL_RECOVERIES = oldMaxRecoveries;
      if (oldWindow === undefined) delete process.env.PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS;
      else process.env.PANEL_CLUSTER_STALL_RECOVERY_WINDOW_MS = oldWindow;
    }
  });

  it('POST /api/rooms/:id/debate triggers 集群协同 through HTTP route and persists audit', async () => {
    const oldHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-cv-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    try {
      const { ChatRoomStore } = await import('../../../src/room/ChatRoomStore.js');
      const roomStore = new ChatRoomStore();
      const broadcasts = [];
      const ack = JSON.stringify({ agree: true, reasoning: '同意', suggestions: [], critical_issues: [] });
      const plan = '# API 阶段方案\nnpm test -- tests/unit/example.test.js\n### 文件落地验证\ncat src/example.js';
      const adapterA = makeStubAdapter([plan, ack]);
      const adapterB = makeStubAdapter([plan, ack]);
      const room = roomStore.create({
        name: 'api dry-run 集群协同',
        mode: 'cross_verify',
        cwd: tempHome,
        members: [{ adapterId: adapterA.id, enabled: true }, { adapterId: adapterB.id, enabled: true }],
      });
      const crossVerifyDispatcher = new CrossVerifyDispatcher({
        store: roomStore,
        adapters: new Map([[adapterA.id, adapterA], [adapterB.id, adapterB]]),
        broadcast: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
      });
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: { start: () => { throw new Error('wrong dispatcher'); } },
        squadDispatcher: { start: () => { throw new Error('wrong dispatcher'); } },
        arenaDispatcher: { start: () => { throw new Error('wrong dispatcher'); } },
        crossVerifyDispatcher,
        broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
        roomAdapterPool: new Map([
          [adapterA.id, { chat: async () => ({ reply: 'OK' }) }],
          [adapterB.id, { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });

      const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/debate');
      const req = { params: { id: room.id }, body: { topic: 'API 层 dry-run 做一个最小游戏项目' } };
      const res = makeResponse();
      await route.handlers[1](req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));
      roomStore.flush();

      const saved = JSON.parse(readFileSync(join(tempHome, '.noe-panel', 'rooms.json'), 'utf8'))
        .rooms.find((item) => item.id === room.id);
      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(saved.status).toBe('paused');
      expect(saved.taskList).toHaveLength(11);
      expect(saved.clusterWorkflowAudit).toMatchObject({
        overallStatus: 'complete',
        counts: { total: 11, blocking: 0 },
      });
      expect(saved.clusterDeliveryManifest.deliveryGate).toMatchObject({
        status: 'blocked',
        blockers: ['agent_run_evidence_incomplete=0/4'],
      });
      expect(saved.clusterWorkflowAudit.acceptanceSummary.total).toBe(9);
      expect(saved.taskList[10].consensus.stageArtifact.retrospectiveReport.scopeStageCount).toBe(10);
      expect(broadcasts.some((msg) => msg.type === 'cross_verify_paused' && msg.reason === 'delivery_gate_blocked')).toBe(true);
    } finally {
      process.env.HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('validates topic and debateRounds before starting dispatcher', async () => {
    const roomStore = { get: () => ({ id: 'r1', mode: 'cross_verify' }) };
    const { app, routes } = makeApp();
    const crossVerifyDispatcher = { start: vi.fn() };
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: crossVerifyDispatcher,
      squadDispatcher: crossVerifyDispatcher,
      arenaDispatcher: crossVerifyDispatcher,
      crossVerifyDispatcher,
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

    const missingTopicRes = makeResponse();
    await route.handlers[1]({ params: { id: 'r1' }, body: {} }, missingTopicRes);
    expect(missingTopicRes.statusCode).toBe(400);

    const badRoundsRes = makeResponse();
    await route.handlers[1]({ params: { id: 'r1' }, body: { topic: 'x', debateRounds: 99 } }, badRoundsRes);
    expect(badRoundsRes.statusCode).toBe(422);
    expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
  });

  it('persists startup runtime recovery before returning topic validation errors', async () => {
    const rooms = new Map([
      ['r1', {
        id: 'r1',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };
    const { app, routes } = makeApp();
    const crossVerifyDispatcher = { start: vi.fn(), activeAborts: new Map() };
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: crossVerifyDispatcher,
      squadDispatcher: crossVerifyDispatcher,
      arenaDispatcher: crossVerifyDispatcher,
      crossVerifyDispatcher,
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

    const res = makeResponse();
    await route.handlers[1]({ params: { id: 'r1' }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({ error: 'topic required' });
    expect(rooms.get('r1')).toMatchObject({
      status: 'paused',
      clusterRuntimeRecovery: {
        type: 'cluster_runtime_recovered',
        reason: 'stale_running_without_dispatcher',
        action: 'paused_for_resume',
      },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
  });

  it('blocks startup before validation when runtime recovery cannot be flushed', async () => {
    const rooms = new Map([
      ['r1', {
        id: 'r1',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('disk full before validation');
      }),
    };
    const { app, routes } = makeApp();
    const crossVerifyDispatcher = { start: vi.fn(), activeAborts: new Map() };
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: crossVerifyDispatcher,
      squadDispatcher: crossVerifyDispatcher,
      arenaDispatcher: crossVerifyDispatcher,
      crossVerifyDispatcher,
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

    const res = makeResponse();
    await route.handlers[1]({ params: { id: 'r1' }, body: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({
      ok: false,
      error: 'cluster_runtime_recovery_flush_failed',
      message: 'disk full before validation',
      runtimeReconciliation: {
        status: 'recovered',
        flushed: false,
        flushError: 'disk full before validation',
      },
    });
    expect(rooms.get('r1').clusterRuntimeRecoveryPersistPending).toMatchObject({
      reason: 'runtime_recovery_flush_failed',
      flushError: 'disk full before validation',
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
  });

  it('rejects duplicate start while the same room is already running before dispatcher is invoked', async () => {
    const roomStore = {
      get: () => ({
        id: 'r1',
        mode: 'cross_verify',
        status: 'running',
        members: [
          { adapterId: 'claude', enabled: true },
          { adapterId: 'codex', enabled: true },
        ],
      }),
    };
    const { app, routes } = makeApp();
    const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: crossVerifyDispatcher,
      squadDispatcher: crossVerifyDispatcher,
      arenaDispatcher: crossVerifyDispatcher,
      crossVerifyDispatcher,
      broadcastRoom: () => {},
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
    });
    const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

    const res = makeResponse();
    await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '重复点击启动' } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ ok: false, error: 'room_already_running', roomId: 'r1' });
    expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
  });

  it('does not mark room error when dispatcher rejects a raced duplicate start as already running', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-duplicate-race-'));
    try {
      const broadcasts = [];
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          status: 'idle',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        setStatus: vi.fn(),
        update: vi.fn(),
        list: () => [],
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.reject(new Error('room already running'))) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '重复竞态启动' } }, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(crossVerifyDispatcher.start).toHaveBeenCalledTimes(1);
      expect(roomStore.setStatus).not.toHaveBeenCalledWith('r1', 'error');
      expect(broadcasts).toEqual([
        { roomId: 'r1', type: 'room_start_ignored', mode: 'cross_verify', reason: 'already_running' },
      ]);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('passes goalMode option to cross_verify dispatcher', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-goal-mode-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏', goalMode: true } }, res);

      expect(res.statusCode).toBe(200);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('r1', '做一个游戏', { goalMode: true });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('enables goalMode and strips /目标 command prefix for cross_verify starts', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-goal-command-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '/目标 做一个游戏', goalMode: false } }, res);

      expect(res.statusCode).toBe(200);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('r1', '做一个游戏', { goalMode: true });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('parses Chinese and English goal command prefixes', () => {
    expect(parseGoalModeCommandTopic('/目标 做一个游戏')).toEqual({ topic: '做一个游戏', goalModeCommand: true });
    expect(parseGoalModeCommandTopic('／目标：做一个游戏')).toEqual({ topic: '做一个游戏', goalModeCommand: true });
    expect(parseGoalModeCommandTopic('/goal build a game')).toEqual({ topic: 'build a game', goalModeCommand: true });
    expect(parseGoalModeCommandTopic('普通任务')).toEqual({ topic: '普通任务', goalModeCommand: false });
  });

  it('allows starting multiple cross_verify rooms through the HTTP route without a global single-room lock', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-multi-room-'));
    try {
      const rooms = new Map([
        ['room-a', {
          id: 'room-a',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
        ['room-b', {
          id: 'room-b',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
      ]);
      const roomStore = {
        get: (id) => rooms.get(id),
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const resA = makeResponse();
      const resB = makeResponse();
      await Promise.all([
        route.handlers[1]({ params: { id: 'room-a' }, body: { topic: '并发项目 A', goalMode: true } }, resA),
        route.handlers[1]({ params: { id: 'room-b' }, body: { topic: '并发项目 B', goalMode: true } }, resB),
      ]);

      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(resA.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(resB.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('room-a', '并发项目 A', { goalMode: true });
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('room-b', '并发项目 B', { goalMode: true });
      expect(crossVerifyDispatcher.start).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('reports concurrency budget from current running cross_verify rooms', () => {
    const roomStore = {
      list: () => [
        {
          id: 'running-1',
          mode: 'cross_verify',
          status: 'running',
          members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
        },
        {
          id: 'running-2',
          mode: 'cross_verify',
          status: 'running',
          members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'gemini-cli', enabled: true }],
        },
        {
          id: 'paused-ignored',
          mode: 'cross_verify',
          status: 'paused',
          members: [{ adapterId: 'claude', enabled: true }],
        },
      ],
    };

    const budget = buildClusterConcurrencyBudget({
      id: 'new-room',
      mode: 'cross_verify',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    }, {
      roomStore,
      maxRunningRooms: 5,
      maxAdapterRunningRooms: 3,
    });

    expect(budget).toMatchObject({
      status: 'warn',
      runningRoomCount: 2,
      projectedRunningRoomCount: 3,
      adapterLoad: { claude: 2, codex: 1, 'gemini-cli': 1 },
      projectedAdapterLoad: { claude: 3, codex: 2 },
    });
    expect(budget.warnings).toEqual(expect.arrayContaining([
      'running_rooms_high=3/5',
      'adapter_running_rooms_high:claude=3/3',
    ]));
    expect(budget.blockers).toEqual([]);
  });

  it('prepareClusterRunGate blocks cross_verify resume when adapter concurrency budget is exhausted', async () => {
    const oldLimit = process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
    process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = '3';
    try {
      const room = {
        id: 'resume-target',
        mode: 'cross_verify',
        status: 'paused',
        topic: '继续做项目',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const runningRoom = (id) => ({
        id,
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      });
      const roomStore = {
        get: (id) => (id === room.id ? room : null),
        list: () => [room, runningRoom('running-a'), runningRoom('running-b'), runningRoom('running-c')],
        update: vi.fn(),
      };
      const runClusterLiveChecks = vi.fn(async () => ({ status: 'passed', passedCount: 2, checks: [] }));

      const gate = await prepareClusterRunGate(room, {
        roomStore,
        dispatcher: { activeAborts: new Map() },
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
        topic: room.topic,
      });

      expect(gate).toMatchObject({
        ok: false,
        statusCode: 409,
        error: 'cluster_concurrency_blocked',
      });
      expect(gate.concurrencyBudget.blockers).toEqual(expect.arrayContaining([
        'adapter_running_rooms_gt_3:claude=4',
        'adapter_running_rooms_gt_3:codex=4',
      ]));
      expect(runClusterLiveChecks).not.toHaveBeenCalled();
    } finally {
      if (oldLimit === undefined) delete process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = oldLimit;
      clearClusterStartReservationsForTest();
    }
  });

  it('prepareClusterRunGate counts in-flight resume reservation and releases it explicitly', async () => {
    const oldLimit = process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
    process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = '1';
    clearClusterStartReservationsForTest();
    let gateA;
    try {
      const roomA = {
        id: 'resume-a',
        mode: 'cross_verify',
        status: 'paused',
        topic: '续跑 A',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const roomB = {
        id: 'resume-b',
        mode: 'cross_verify',
        status: 'paused',
        topic: '续跑 B',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const rooms = new Map([[roomA.id, roomA], [roomB.id, roomB]]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      };
      const runClusterLiveChecks = vi.fn(async () => ({
        status: 'passed',
        passedCount: 2,
        checks: [{ adapterId: 'claude', passed: true }, { adapterId: 'codex', passed: true }],
      }));
      const gateOptions = {
        roomStore,
        dispatcher: { activeAborts: new Map() },
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
      };

      gateA = await prepareClusterRunGate(roomA, { ...gateOptions, topic: roomA.topic });
      const gateBWhileAStarting = await prepareClusterRunGate(roomB, { ...gateOptions, topic: roomB.topic });
      gateA.reservation.release();
      gateA = null;
      const gateBAfterRelease = await prepareClusterRunGate(roomB, { ...gateOptions, topic: roomB.topic });
      gateBAfterRelease.reservation.release();

      expect(gateA).toBe(null);
      expect(gateBWhileAStarting).toMatchObject({
        ok: false,
        statusCode: 409,
        error: 'cluster_concurrency_blocked',
      });
      expect(gateBWhileAStarting.concurrencyBudget.startingRoomCount).toBe(1);
      expect(gateBWhileAStarting.concurrencyBudget.startingRooms).toEqual([
        expect.objectContaining({ roomId: 'resume-a', adapterIds: ['claude', 'codex'] }),
      ]);
      expect(gateBAfterRelease).toMatchObject({ ok: true });
      expect(runClusterLiveChecks).toHaveBeenCalledTimes(2);
    } finally {
      gateA?.reservation?.release?.();
      if (oldLimit === undefined) delete process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = oldLimit;
      clearClusterStartReservationsForTest();
    }
  });

  it('prepareClusterRunGate reconciles stale activeAbort before concurrency budget', async () => {
    const oldMaxRooms = process.env.PANEL_CLUSTER_MAX_RUNNING_ROOMS;
    process.env.PANEL_CLUSTER_MAX_RUNNING_ROOMS = '2';
    clearClusterStartReservationsForTest();
    let gate;
    try {
      const room = {
        id: 'new-room-after-stale-abort',
        mode: 'cross_verify',
        status: 'paused',
        topic: '启动前清理 stale activeAbort',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const staleAbort = new AbortController();
      const staleRoom = {
        id: 'stale-active-abort',
        mode: 'cross_verify',
        status: 'paused',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const runningRoom = {
        id: 'already-running-room',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const runningAbort = new AbortController();
      const rooms = new Map([[room.id, room], [staleRoom.id, staleRoom], [runningRoom.id, runningRoom]]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
        flush: vi.fn(),
      };
      const dispatcher = { activeAborts: new Map([[runningRoom.id, runningAbort], [staleRoom.id, staleAbort]]) };
      const runClusterLiveChecks = vi.fn(async () => ({
        status: 'passed',
        passedCount: 2,
        checks: [{ adapterId: 'claude', passed: true }, { adapterId: 'codex', passed: true }],
      }));

      gate = await prepareClusterRunGate(room, {
        roomStore,
        dispatcher,
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
        topic: room.topic,
      });

      expect(gate).toMatchObject({
        ok: true,
        runtimeReconciliation: {
          status: 'recovered',
          cleanedActiveAbortCount: 1,
          flushed: true,
        },
        concurrencyBudget: {
          status: 'passed',
          activeAbortRoomCount: 0,
          projectedRunningRoomCount: 2,
        },
      });
      expect(staleAbort.signal.aborted).toBe(true);
      expect(dispatcher.activeAborts.has(staleRoom.id)).toBe(false);
      expect(roomStore.flush).toHaveBeenCalledTimes(1);
      expect(runClusterLiveChecks).toHaveBeenCalledTimes(1);
    } finally {
      gate?.reservation?.release?.();
      if (oldMaxRooms === undefined) delete process.env.PANEL_CLUSTER_MAX_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_RUNNING_ROOMS = oldMaxRooms;
      clearClusterStartReservationsForTest();
    }
  });

  it('prepareClusterRunGate blocks startup when runtime recovery cannot be flushed', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'blocked-after-recovery-flush-fail',
      mode: 'cross_verify',
      status: 'paused',
      topic: '恢复无法落盘时不能启动',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const staleRoom = {
      id: 'stale-abort-flush-fail',
      mode: 'cross_verify',
      status: 'paused',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const rooms = new Map([[room.id, room], [staleRoom.id, staleRoom]]);
    const staleAbort = new AbortController();
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('disk full during recovery');
      }),
    };
    const dispatcher = { activeAborts: new Map([[staleRoom.id, staleAbort]]) };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher,
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_persist_failed',
      message: 'disk full during recovery',
      runtimeReconciliation: {
        status: 'recovered',
        cleanedActiveAbortCount: 1,
        flushed: false,
        flushError: 'disk full during recovery',
      },
    });
    expect(staleAbort.signal.aborted).toBe(true);
    expect(dispatcher.activeAborts.has(staleRoom.id)).toBe(false);
    expect(rooms.get(staleRoom.id).clusterRuntimeRecoveryPersistPending).toMatchObject({
      reason: 'runtime_recovery_flush_failed',
      flushError: 'disk full during recovery',
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(runClusterLiveChecks).not.toHaveBeenCalled();

    const secondGate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher,
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(secondGate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_persist_failed',
      runtimePersistPending: {
        pendingRooms: [
          expect.objectContaining({ roomId: staleRoom.id }),
        ],
      },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(2);
    expect(runClusterLiveChecks).not.toHaveBeenCalled();
  });

  it('prepareClusterRunGate blocks startup when stale running recovery update fails', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'blocked-after-stale-running-update-fail',
      mode: 'cross_verify',
      status: 'paused',
      topic: '恢复写入失败不能启动',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const staleRunning = {
      id: 'stale-running-update-fail',
      mode: 'cross_verify',
      status: 'running',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const rooms = new Map([[room.id, room], [staleRunning.id, staleRunning]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => {
        if (id === staleRunning.id) throw new Error('store update failed');
        rooms.set(id, { ...rooms.get(id), ...patch });
      }),
      flush: vi.fn(),
    };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher: { activeAborts: new Map() },
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_failed',
      message: 'store update failed',
      runtimeReconciliation: {
        status: 'recovery_failed',
        recoveryErrorCount: 1,
        recoveredRoomCount: 0,
        recoveryErrors: [
          expect.objectContaining({
            roomId: staleRunning.id,
            reason: 'stale_running_without_dispatcher',
            error: 'store update failed',
          }),
        ],
      },
    });
    expect(rooms.get(staleRunning.id).status).toBe('running');
    expect(roomStore.flush).not.toHaveBeenCalled();
    expect(runClusterLiveChecks).not.toHaveBeenCalled();
  });

  it('prepareClusterRunGate leaves stale activeAbort in place when recovery metadata update fails', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'blocked-after-active-abort-update-fail',
      mode: 'cross_verify',
      status: 'paused',
      topic: 'activeAbort 恢复写入失败不能启动',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const staleRoom = {
      id: 'stale-active-abort-update-fail',
      mode: 'cross_verify',
      status: 'paused',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const rooms = new Map([[room.id, room], [staleRoom.id, staleRoom]]);
    const staleAbort = new AbortController();
    const dispatcher = { activeAborts: new Map([[staleRoom.id, staleAbort]]) };
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => {
        if (id === staleRoom.id) throw new Error('metadata update failed');
        rooms.set(id, { ...rooms.get(id), ...patch });
      }),
      flush: vi.fn(),
    };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher,
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_failed',
      message: 'metadata update failed',
      runtimeReconciliation: {
        status: 'recovery_failed',
        recoveryErrorCount: 1,
        cleanedActiveAbortCount: 0,
        recoveryErrors: [
          expect.objectContaining({
            roomId: staleRoom.id,
            reason: 'stale_dispatcher_active_abort_without_running_room',
            error: 'metadata update failed',
          }),
        ],
      },
    });
    expect(staleAbort.signal.aborted).toBe(false);
    expect(dispatcher.activeAborts.has(staleRoom.id)).toBe(true);
    expect(roomStore.flush).not.toHaveBeenCalled();
    expect(runClusterLiveChecks).not.toHaveBeenCalled();
  });

  it('prepareClusterRunGate resolves pending runtime recovery persistence before startup', async () => {
    clearClusterStartReservationsForTest();
    let gate;
    try {
      const room = {
        id: 'start-after-pending-recovery-persisted',
        mode: 'cross_verify',
        status: 'paused',
        topic: 'pending 恢复落盘后启动',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const recoveredRoom = {
        id: 'pending-recovered-room',
        mode: 'cross_verify',
        status: 'paused',
        clusterRuntimeRecoveryPersistPending: {
          reason: 'runtime_recovery_flush_failed',
          flushError: 'disk full during recovery',
          at: '2026-06-01T00:00:00.000Z',
        },
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      };
      const rooms = new Map([[room.id, room], [recoveredRoom.id, recoveredRoom]]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
        flush: vi.fn(),
      };
      const runClusterLiveChecks = vi.fn(async () => ({
        status: 'passed',
        passedCount: 2,
        checks: [{ adapterId: 'claude', passed: true }, { adapterId: 'codex', passed: true }],
      }));

      gate = await prepareClusterRunGate(room, {
        roomStore,
        dispatcher: { activeAborts: new Map() },
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
        topic: room.topic,
      });

      expect(gate).toMatchObject({
        ok: true,
        runtimeReconciliation: { status: 'clean' },
        concurrencyBudget: { status: 'passed' },
      });
      expect(rooms.get(recoveredRoom.id).clusterRuntimeRecoveryPersistPending).toBeUndefined();
      expect(roomStore.flush).toHaveBeenCalledTimes(2);
      expect(runClusterLiveChecks).toHaveBeenCalledTimes(1);
    } finally {
      gate?.reservation?.release?.();
      clearClusterStartReservationsForTest();
    }
  });

  it('prepareClusterRunGate restores pending marker when pending-clear update fails', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'blocked-after-pending-clear-update-fail',
      mode: 'cross_verify',
      status: 'paused',
      topic: 'pending 清除写入失败不能启动',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const pending = {
      reason: 'runtime_recovery_flush_failed',
      flushError: 'previous disk full',
      at: '2026-06-01T00:00:00.000Z',
    };
    const recoveredRoom = {
      id: 'pending-clear-update-fail-room',
      mode: 'cross_verify',
      status: 'paused',
      clusterRuntimeRecoveryPersistPending: pending,
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const rooms = new Map([[room.id, room], [recoveredRoom.id, recoveredRoom]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => {
        if (id === recoveredRoom.id
          && Object.prototype.hasOwnProperty.call(patch, 'clusterRuntimeRecoveryPersistPending')
          && patch.clusterRuntimeRecoveryPersistPending === undefined) {
          throw new Error('clear pending update failed');
        }
        rooms.set(id, { ...rooms.get(id), ...patch });
      }),
      flush: vi.fn(),
    };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher: { activeAborts: new Map() },
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_pending_clear_failed',
      message: 'clear pending update failed',
      runtimePersistPending: {
        clearErrors: [
          expect.objectContaining({
            roomId: recoveredRoom.id,
            error: 'clear pending update failed',
          }),
        ],
      },
    });
    expect(rooms.get(recoveredRoom.id).clusterRuntimeRecoveryPersistPending).toEqual(pending);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(runClusterLiveChecks).not.toHaveBeenCalled();
  });

  it('prepareClusterRunGate restores pending marker when pending-clear flush fails', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'blocked-after-pending-clear-flush-fail',
      mode: 'cross_verify',
      status: 'paused',
      topic: 'pending 清除落盘失败不能启动',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const pending = {
      reason: 'runtime_recovery_flush_failed',
      flushError: 'previous disk full',
      at: '2026-06-01T00:00:00.000Z',
    };
    const recoveredRoom = {
      id: 'pending-clear-fail-room',
      mode: 'cross_verify',
      status: 'paused',
      clusterRuntimeRecoveryPersistPending: pending,
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    };
    const rooms = new Map([[room.id, room], [recoveredRoom.id, recoveredRoom]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error('disk full while clearing pending'); })
        .mockImplementationOnce(() => { throw new Error('disk full while pending remains'); }),
    };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher: { activeAborts: new Map() },
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_pending_clear_failed',
      message: 'disk full while clearing pending',
      runtimePersistPending: {
        pendingRooms: [
          expect.objectContaining({ roomId: recoveredRoom.id }),
        ],
      },
    });
    expect(rooms.get(recoveredRoom.id).clusterRuntimeRecoveryPersistPending).toEqual(pending);
    expect(runClusterLiveChecks).not.toHaveBeenCalled();

    const secondGate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher: { activeAborts: new Map() },
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(secondGate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_runtime_recovery_persist_failed',
      runtimePersistPending: {
        pendingRooms: [
          expect.objectContaining({ roomId: recoveredRoom.id }),
        ],
      },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(3);
    expect(runClusterLiveChecks).not.toHaveBeenCalled();
  });

  it('prepareClusterRunGate blocks startup when degraded member state cannot be flushed', async () => {
    clearClusterStartReservationsForTest();
    const room = {
      id: 'degrade-flush-fail-room',
      mode: 'cross_verify',
      status: 'paused',
      topic: '成员降级落盘失败不能启动',
      members: [
        { adapterId: 'claude', displayName: 'Claude', enabled: true },
        { adapterId: 'codex', displayName: 'GPT', enabled: true },
      ],
    };
    const rooms = new Map([[room.id, room]]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('degraded state disk full');
      }),
    };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'warn',
      passedCount: 1,
      checks: [
        { adapterId: 'claude', passed: true },
        { adapterId: 'codex', passed: false, blockers: ['live_ping_failed=provider offline'] },
      ],
    }));

    const gate = await prepareClusterRunGate(room, {
      roomStore,
      dispatcher: { activeAborts: new Map() },
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
      topic: room.topic,
    });

    expect(gate).toMatchObject({
      ok: false,
      statusCode: 503,
      error: 'cluster_startup_degrade_persist_failed',
      message: 'degraded state disk full',
      degradedMembers: [
        expect.objectContaining({
          adapterId: 'codex',
          reason: 'startup_live_check_hard_failed',
        }),
      ],
    });
    expect(roomStore.update).toHaveBeenCalledTimes(2);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(rooms.get(room.id).members).toEqual([
      { adapterId: 'claude', displayName: 'Claude', enabled: true },
      { adapterId: 'codex', displayName: 'GPT', enabled: true },
    ]);
    expect(rooms.get(room.id).clusterStartupLiveCheck).toBeUndefined();
    expect(rooms.get(room.id).clusterStartupDegradedMembers).toBeUndefined();
    expect(rooms.get(room.id).clusterDroppedMembers).toBeUndefined();
    const retryReservation = reserveClusterStart(room);
    expect(retryReservation.ok).toBe(true);
    retryReservation.release();
    clearClusterStartReservationsForTest();
  });

  it('prepareClusterRunGate persists degraded members when room provides roomId only', async () => {
    clearClusterStartReservationsForTest();
    let gate;
    try {
      const room = {
        roomId: 'degrade-room-id-only',
        mode: 'cross_verify',
        status: 'paused',
        topic: 'roomId-only 降级持久化',
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      };
      const rooms = new Map([[room.roomId, room]]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
        flush: vi.fn(),
      };
      const runClusterLiveChecks = vi.fn(async () => ({
        status: 'warn',
        passedCount: 1,
        checks: [
          { adapterId: 'claude', passed: true },
          { adapterId: 'codex', passed: false, blockers: ['live_ping_failed=provider offline'] },
        ],
      }));

      gate = await prepareClusterRunGate(room, {
        roomStore,
        dispatcher: { activeAborts: new Map() },
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
        topic: room.topic,
      });

      expect(gate).toMatchObject({
        ok: true,
        degradedMembers: [
          expect.objectContaining({
            adapterId: 'codex',
            reason: 'startup_live_check_hard_failed',
          }),
        ],
      });
      expect(roomStore.update).toHaveBeenCalledWith('degrade-room-id-only', expect.objectContaining({
        clusterStartupDegradedMembers: [
          expect.objectContaining({ adapterId: 'codex' }),
        ],
      }));
      expect(rooms.get(room.roomId).members.find((member) => member.adapterId === 'codex')).toMatchObject({
        enabled: false,
        failoverDisabled: true,
        failoverReason: 'startup_live_check_hard_failed',
      });
      expect(roomStore.flush).toHaveBeenCalledTimes(1);
    } finally {
      gate?.reservation?.release?.();
      clearClusterStartReservationsForTest();
    }
  });

  it('GET cluster-concurrency-budget reports running rooms and in-flight reservations', async () => {
    clearClusterStartReservationsForTest();
    const reservation = reserveClusterStart({
      id: 'starting-1',
      mode: 'cross_verify',
      members: [{ adapterId: 'claude', enabled: true }],
    });
    try {
      const rooms = new Map([
        ['running-1', {
          id: 'running-1',
          name: '正在跑的房间',
          mode: 'cross_verify',
          status: 'running',
          members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
        }],
      ]);
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
        crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/concurrency-budget');

      const res = makeResponse();
      await route.handlers[1]({ query: {} }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        roomId: null,
        concurrencyBudget: {
          projectionEnabled: false,
          runningRoomCount: 1,
          startingRoomCount: 1,
          projectedRunningRoomCount: 2,
          adapterLoad: { claude: 2, codex: 1 },
        },
      });
      expect(res.payload.concurrencyBudget.runningRooms).toEqual([
        { roomId: 'running-1', name: '正在跑的房间', adapterIds: ['claude', 'codex'] },
      ]);
      expect(res.payload.concurrencyBudget.startingRooms).toEqual([
        expect.objectContaining({ roomId: 'starting-1', adapterIds: ['claude'] }),
      ]);
    } finally {
      reservation.release();
      clearClusterStartReservationsForTest();
    }
  });

  it('GET cluster-health reports strict health for a clean running cluster', async () => {
    const rooms = new Map([
      ['running-1', {
        id: 'running-1',
        name: '健康运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
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
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/health');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      runtimeReconciliation: { status: 'clean' },
      concurrencyBudget: { status: 'passed', runningRoomCount: 1 },
      health: {
        status: 'passed',
        blockers: [],
        checks: [
          { name: 'budget_api', status: 'passed' },
          { name: 'runtime_reconciliation', status: 'passed', value: 'clean' },
          { name: 'concurrency_budget', status: 'passed', value: 'passed' },
          { name: 'cluster_config', status: 'passed', value: 'passed' },
        ],
      },
    });
  });

  it('GET cluster-readiness reports machine-readable readiness for long-running cluster operations', async () => {
    const rooms = new Map([
      ['running-1', {
        id: 'running-1',
        name: '健康运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
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
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/readiness');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      readiness: {
        readinessVersion: 'cluster-readiness-v1',
        status: 'passed',
        blockers: [],
        capabilities: {
          mode: 'cross_verify',
          multiRoom: true,
          maxRunningRooms: 5,
          maxAdapterRunningRooms: 3,
        },
      },
    });
    expect(res.payload.readiness.checks.map((check) => check.id)).toEqual([
      'runtime_recovery_clean',
      'persist_recovery_clean',
      'concurrency_budget_available',
      'multi_room_capacity',
      'adapter_room_capacity',
      'cluster_config_safe',
    ]);
  });

  it('GET cluster-readiness blocks dangerous cluster config combinations', async () => {
    const oldMemberTimeout = process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
    const oldStallTimeout = process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
    process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = '30000';
    process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = '30000';
    try {
      const roomStore = { list: () => [], get: () => null };
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: { start: vi.fn() },
        squadDispatcher: { start: vi.fn() },
        arenaDispatcher: { start: vi.fn() },
        crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/readiness');

      const res = makeResponse();
      await route.handlers[1]({ query: {} }, res);

      expect(res.statusCode).toBe(503);
      expect(res.payload.readiness).toMatchObject({
        status: 'blocked',
        blockers: ['cluster_config=member_call_timeout_gte_stall_timeout=30000/30000'],
      });
      expect(res.payload.configAudit).toMatchObject({
        status: 'blocked',
        blockers: ['member_call_timeout_gte_stall_timeout=30000/30000'],
      });
    } finally {
      if (oldMemberTimeout === undefined) delete process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = oldMemberTimeout;
      if (oldStallTimeout === undefined) delete process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = oldStallTimeout;
    }
  });

  it('GET cluster-diagnostics returns machine-readable operations checklist', async () => {
    const rooms = new Map([
      ['running-1', {
        id: 'running-1',
        name: '健康运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
      ['paused-1', {
        id: 'paused-1',
        name: '暂停房间',
        mode: 'cross_verify',
        status: 'paused',
        members: [{ adapterId: 'claude', enabled: true }],
      }],
    ]);
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
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/diagnostics');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      health: { status: 'passed' },
      readiness: { status: 'passed' },
      diagnostics: {
        diagnosticsVersion: 'cluster-diagnostics-v1',
        status: 'passed',
        summary: {
          roomSummary: {
            total: 2,
            running: 1,
            paused: 1,
          },
        },
        invariants: {
          safeToStart: true,
          multiRoomEnabled: true,
          configSafe: true,
        },
        findings: [],
      },
      assurance: {
        assuranceVersion: 'cluster-assurance-v1',
        status: 'passed',
        ok: true,
        summary: {
          gateCount: 8,
          blockedGateCount: 0,
        },
      },
      healthTrend: {
        trendVersion: 'cluster-health-trend-v1',
        status: 'passed',
        ok: true,
      },
      resourceGuard: {
        guardVersion: 'cluster-resource-guard-v1',
        status: 'passed',
        ok: true,
      },
      opsGuard: {
        guardVersion: 'cluster-ops-guard-v1',
        status: 'passed',
        ok: true,
      },
    });
  });

  it('GET cluster-ops-guard exposes exception storm and backlog gate for automation', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cluster-ops-guard-route-'));
    const oldHistory = process.env.PANEL_HEALTH_HISTORY_PATH;
    const oldWarnHeap = process.env.PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_RATIO;
    const oldMaxHeap = process.env.PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_RATIO;
    const oldWarnHandles = process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_HANDLES;
    const oldMaxHandles = process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_HANDLES;
    const oldWarnRequests = process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_REQUESTS;
    const oldMaxRequests = process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_REQUESTS;
    process.env.PANEL_HEALTH_HISTORY_PATH = join(tmp, 'history.jsonl');
    process.env.PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_RATIO = '1';
    process.env.PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_RATIO = '2';
    process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_HANDLES = '999999';
    process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_HANDLES = '999999';
    process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_REQUESTS = '999999';
    process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_REQUESTS = '999999';
    try {
      const rooms = new Map([
        ['running-1', {
          id: 'running-1',
          mode: 'cross_verify',
          status: 'running',
          members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
        }],
        ['done-1', { id: 'done-1', mode: 'cross_verify', status: 'done' }],
      ]);
      const roomStore = {
        list: () => [...rooms.values()],
        get: (id) => rooms.get(id),
      };
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: { start: vi.fn() },
        squadDispatcher: { start: vi.fn() },
        arenaDispatcher: { start: vi.fn() },
        crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/ops-guard');

      const res = makeResponse();
      await route.handlers[1]({ query: {} }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.opsGuard).toMatchObject({
        guardVersion: 'cluster-ops-guard-v1',
        ok: true,
        summary: {
          roomSummary: {
            total: 2,
            inFlight: 1,
          },
        },
      });
      expect(res.payload.opsGuard.status).not.toBe('blocked');
      expect(res.payload.diagnostics.invariants.safeToStart).toBe(true);
    } finally {
      if (oldHistory === undefined) delete process.env.PANEL_HEALTH_HISTORY_PATH;
      else process.env.PANEL_HEALTH_HISTORY_PATH = oldHistory;
      if (oldWarnHeap === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_RATIO;
      else process.env.PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_RATIO = oldWarnHeap;
      if (oldMaxHeap === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_RATIO;
      else process.env.PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_RATIO = oldMaxHeap;
      if (oldWarnHandles === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_HANDLES;
      else process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_HANDLES = oldWarnHandles;
      if (oldMaxHandles === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_HANDLES;
      else process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_HANDLES = oldMaxHandles;
      if (oldWarnRequests === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_REQUESTS;
      else process.env.PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_REQUESTS = oldWarnRequests;
      if (oldMaxRequests === undefined) delete process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_REQUESTS;
      else process.env.PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_REQUESTS = oldMaxRequests;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('GET cluster-resource-guard exposes resource pressure gate for automation', async () => {
    const roomStore = { list: () => [], get: () => null };
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/resource-guard');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.resourceGuard).toMatchObject({
      guardVersion: 'cluster-resource-guard-v1',
      status: 'passed',
      ok: true,
    });
    expect(res.payload.diagnostics.status).toBe('passed');
  });

  it('GET cluster-health-trend exposes long-term degradation gate for automation', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cluster-health-trend-route-'));
    const oldHistory = process.env.PANEL_HEALTH_HISTORY_PATH;
    process.env.PANEL_HEALTH_HISTORY_PATH = join(tmp, 'history.jsonl');
    try {
      const roomStore = { list: () => [], get: () => null };
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: { start: vi.fn() },
        squadDispatcher: { start: vi.fn() },
        arenaDispatcher: { start: vi.fn() },
        crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/health-trend');

      const res = makeResponse();
      await route.handlers[1]({ query: {} }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.healthTrend).toMatchObject({
        trendVersion: 'cluster-health-trend-v1',
        status: 'passed',
        ok: true,
      });
      expect(res.payload.diagnostics.status).toBe('passed');
    } finally {
      if (oldHistory === undefined) delete process.env.PANEL_HEALTH_HISTORY_PATH;
      else process.env.PANEL_HEALTH_HISTORY_PATH = oldHistory;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('GET cluster-diagnostics returns 503 for blocked diagnostics', async () => {
    const oldMemberTimeout = process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
    const oldStallTimeout = process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
    process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = '30000';
    process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = '30000';
    try {
      const roomStore = { list: () => [], get: () => null };
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: { start: vi.fn() },
        squadDispatcher: { start: vi.fn() },
        arenaDispatcher: { start: vi.fn() },
        crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/diagnostics');

      const res = makeResponse();
      await route.handlers[1]({ query: {} }, res);

      expect(res.statusCode).toBe(503);
      expect(res.payload.diagnostics).toMatchObject({
        status: 'blocked',
        invariants: { safeToStart: false },
      });
      expect(res.payload.assurance).toMatchObject({
        status: 'blocked',
        ok: false,
      });
      expect(res.payload.diagnostics.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'config_audit_blocked',
        'readiness_blocked',
      ]));
    } finally {
      if (oldMemberTimeout === undefined) delete process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = oldMemberTimeout;
      if (oldStallTimeout === undefined) delete process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_STALL_TIMEOUT_MS = oldStallTimeout;
    }
  });

  it('GET cluster-health returns 503 when runtime recovery had to repair stale state', async () => {
    const rooms = new Map([
      ['stale-running-room', {
        id: 'stale-running-room',
        name: '假运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };
    const broadcasts = [];
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
      broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/health');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({
      ok: true,
      runtimeReconciliation: {
        status: 'recovered',
        recoveredRoomCount: 1,
        flushed: true,
        flushError: null,
      },
      health: {
        status: 'blocked',
        blockers: expect.arrayContaining(['runtime_status=recovered']),
      },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(rooms.get('stale-running-room').status).toBe('paused');
    expect(broadcasts).toEqual([
      expect.objectContaining({
        roomId: 'stale-running-room',
        type: 'cluster_runtime_recovered',
        reason: 'stale_running_without_dispatcher',
      }),
    ]);

    const secondRes = makeResponse();
    await route.handlers[1]({ query: {} }, secondRes);
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.payload).toMatchObject({
      runtimeReconciliation: { status: 'clean' },
      health: { status: 'passed', blockers: [] },
    });
  });

  it('GET cluster-health reports blocked when runtime recovery cannot be flushed to disk', async () => {
    const rooms = new Map([
      ['stale-flush-fail-room', {
        id: 'stale-flush-fail-room',
        name: '落盘失败房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('disk full during health recovery');
      }),
    };
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/health');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({
      runtimeReconciliation: {
        status: 'recovered',
        flushed: false,
        flushError: 'disk full during health recovery',
      },
      health: {
        status: 'blocked',
        blockers: expect.arrayContaining([
          'runtime_status=recovered',
          'runtime_flush_error_present',
        ]),
      },
    });
    expect(rooms.get('stale-flush-fail-room').clusterRuntimeRecoveryPersistPending).toMatchObject({
      reason: 'runtime_recovery_flush_failed',
      flushError: 'disk full during health recovery',
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('does not double-count a room that is both running and still has a start reservation', () => {
    clearClusterStartReservationsForTest();
    const reservation = reserveClusterStart({
      id: 'handoff-room',
      mode: 'cross_verify',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    });
    try {
      const roomStore = {
        list: () => [
          {
            id: 'handoff-room',
            mode: 'cross_verify',
            status: 'running',
            members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
          },
        ],
      };

      const budget = buildClusterConcurrencyBudget(null, {
        roomStore,
        projectCurrentRoom: false,
        maxRunningRooms: 5,
        maxAdapterRunningRooms: 3,
      });

      expect(budget).toMatchObject({
        runningRoomCount: 1,
        startingRoomCount: 0,
        activeAbortRoomCount: 0,
        projectedRunningRoomCount: 1,
        adapterLoad: { claude: 1, codex: 1 },
      });
      expect(budget.startingRooms).toEqual([]);
    } finally {
      reservation.release();
      clearClusterStartReservationsForTest();
    }
  });

  it('excludes current room from budget projection even when caller provides roomId only', () => {
    const roomStore = {
      list: () => [
        {
          id: 'resume-room-id-only',
          mode: 'cross_verify',
          status: 'running',
          members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
        },
      ],
    };

    const budget = buildClusterConcurrencyBudget({
      roomId: 'resume-room-id-only',
      mode: 'cross_verify',
      members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
    }, {
      roomStore,
      maxRunningRooms: 2,
      maxAdapterRunningRooms: 2,
    });

    expect(budget).toMatchObject({
      runningRoomCount: 0,
      startingRoomCount: 0,
      projectedRunningRoomCount: 1,
      adapterLoad: {},
      projectedAdapterLoad: { claude: 1, codex: 1 },
      status: 'passed',
    });
    expect(budget.blockers).toEqual([]);
  });

  it('GET cluster-concurrency-budget cleans dispatcher activeAbort when store status is not running', async () => {
    const rooms = new Map([
      ['active-abort-room', {
        id: 'active-abort-room',
        name: 'dispatcher 内部运行房',
        mode: 'cross_verify',
        status: 'idle',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };
    const activeAbort = new AbortController();
    const crossVerifyDispatcher = {
      start: vi.fn(),
      activeAborts: new Map([['active-abort-room', activeAbort]]),
    };
    const broadcasts = [];
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher,
      broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/concurrency-budget');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      concurrencyBudget: {
        projectionEnabled: false,
        runningRoomCount: 0,
        startingRoomCount: 0,
        activeAbortRoomCount: 0,
        projectedRunningRoomCount: 0,
        adapterLoad: {},
      },
      runtimeReconciliation: {
        status: 'recovered',
        cleanedActiveAbortCount: 1,
        flushed: true,
        flushError: null,
        cleanedActiveAborts: [
          {
            roomId: 'active-abort-room',
            status: 'idle',
            reason: 'stale_dispatcher_active_abort_without_running_room',
          },
        ],
      },
    });
    expect(activeAbort.signal.aborted).toBe(true);
    expect(crossVerifyDispatcher.activeAborts.has('active-abort-room')).toBe(false);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(rooms.get('active-abort-room').clusterRuntimeRecovery).toMatchObject({
      type: 'cluster_runtime_recovered',
      reason: 'stale_dispatcher_active_abort_without_running_room',
      action: 'cleared_dispatcher_active_abort',
    });
    expect(res.payload.concurrencyBudget.activeAbortRooms).toEqual([]);
    expect(broadcasts).toEqual([
      expect.objectContaining({
        roomId: 'active-abort-room',
        type: 'cluster_runtime_recovered',
        reason: 'stale_dispatcher_active_abort_without_running_room',
      }),
    ]);
  });

  it('GET cluster-concurrency-budget auto-recovers stale running room without dispatcher activeAbort', async () => {
    const rooms = new Map([
      ['stale-running-room', {
        id: 'stale-running-room',
        name: '假运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const broadcasts = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
      broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/concurrency-budget');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(rooms.get('stale-running-room')).toMatchObject({
      status: 'paused',
      clusterRuntimeRecovery: {
        type: 'cluster_runtime_recovered',
        reason: 'stale_running_without_dispatcher',
        action: 'paused_for_resume',
      },
    });
    expect(res.payload).toMatchObject({
      ok: true,
      runtimeReconciliation: {
        status: 'recovered',
        recoveredRoomCount: 1,
        flushed: true,
        flushError: null,
        recoveredRooms: [
          {
            roomId: 'stale-running-room',
            previousStatus: 'running',
            nextStatus: 'paused',
            reason: 'stale_running_without_dispatcher',
          },
        ],
      },
      concurrencyBudget: {
        runningRoomCount: 0,
        projectedRunningRoomCount: 0,
      },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(broadcasts).toEqual([
      expect.objectContaining({
        roomId: 'stale-running-room',
        type: 'cluster_runtime_recovered',
        reason: 'stale_running_without_dispatcher',
        previousStatus: 'running',
        nextStatus: 'paused',
      }),
    ]);
  });

  it('GET cluster-concurrency-budget exposes flush failure when auto-recovery cannot be persisted', async () => {
    const rooms = new Map([
      ['budget-flush-fail-room', {
        id: 'budget-flush-fail-room',
        name: '预算巡检落盘失败房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('disk full during budget recovery');
      }),
    };
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map() },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/concurrency-budget');

    const res = makeResponse();
    await route.handlers[1]({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      runtimeReconciliation: {
        status: 'recovered',
        flushed: false,
        flushError: 'disk full during budget recovery',
      },
      concurrencyBudget: {
        runningRoomCount: 0,
        projectedRunningRoomCount: 0,
      },
    });
    expect(rooms.get('budget-flush-fail-room').clusterRuntimeRecoveryPersistPending).toMatchObject({
      reason: 'runtime_recovery_flush_failed',
      flushError: 'disk full during budget recovery',
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('runtime watchdog auto-recovers stale running rooms and broadcasts global recovery', () => {
    const fixedNow = new Date('2026-06-01T00:00:00.000Z');
    const order = [];
    const rooms = new Map([
      ['stale-watchdog-room', {
        id: 'stale-watchdog-room',
        name: 'watchdog 假运行房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomEvents = [];
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => {
        rooms.set(id, { ...rooms.get(id), ...patch });
        order.push(`update:${rooms.get(id).status}`);
      }),
      flush: vi.fn(() => {
        order.push(`flush:${rooms.get('stale-watchdog-room').status}`);
      }),
    };

    const result = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      broadcastRoom: (roomId, msg) => roomEvents.push({ roomId, ...msg }),
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
      flushOnRecovery: true,
    });

    expect(result).toMatchObject({
      status: 'recovered',
      flushed: true,
      flushError: null,
      recoveredRoomCount: 1,
      recoveredRooms: [
        {
          roomId: 'stale-watchdog-room',
          previousStatus: 'running',
          nextStatus: 'paused',
          reason: 'stale_running_without_dispatcher',
          at: fixedNow.toISOString(),
        },
      ],
    });
    expect(rooms.get('stale-watchdog-room')).toMatchObject({
      status: 'paused',
      clusterRuntimeRecovery: {
        type: 'cluster_runtime_recovered',
        reason: 'stale_running_without_dispatcher',
        at: fixedNow.toISOString(),
      },
    });
    expect(roomEvents).toEqual([
      expect.objectContaining({
        roomId: 'stale-watchdog-room',
        type: 'cluster_runtime_recovered',
        nextStatus: 'paused',
      }),
    ]);
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_recovered',
        recoveredRoomCount: 1,
        at: fixedNow.toISOString(),
      }),
    ]);
    expect(order).toEqual(['update:paused', 'flush:paused']);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('runtime watchdog clears stale activeAbort for non-running room and releases budget occupancy', () => {
    const fixedNow = new Date('2026-06-01T00:05:00.000Z');
    const rooms = new Map([
      ['paused-active-abort-room', {
        id: 'paused-active-abort-room',
        name: 'paused 但 dispatcher 残留',
        mode: 'cross_verify',
        status: 'paused',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const activeAbort = new AbortController();
    const dispatcher = { activeAborts: new Map([['paused-active-abort-room', activeAbort]]) };
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
    };

    const result = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher,
      broadcastRoom: () => {},
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: 'recovered',
      recoveredRoomCount: 0,
      cleanedActiveAbortCount: 1,
      cleanedActiveAborts: [
        {
          roomId: 'paused-active-abort-room',
          status: 'paused',
          reason: 'stale_dispatcher_active_abort_without_running_room',
          at: fixedNow.toISOString(),
        },
      ],
    });
    expect(activeAbort.signal.aborted).toBe(true);
    expect(dispatcher.activeAborts.has('paused-active-abort-room')).toBe(false);
    expect(rooms.get('paused-active-abort-room').status).toBe('paused');
    expect(rooms.get('paused-active-abort-room').clusterRuntimeRecovery).toMatchObject({
      action: 'cleared_dispatcher_active_abort',
      reason: 'stale_dispatcher_active_abort_without_running_room',
    });
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_recovered',
        recoveredRoomCount: 0,
        cleanedActiveAbortCount: 1,
      }),
    ]);
  });

  it('runtime watchdog broadcasts global recovery failure when stale running update fails', () => {
    const fixedNow = new Date('2026-06-01T00:08:00.000Z');
    const rooms = new Map([
      ['watchdog-update-fail-room', {
        id: 'watchdog-update-fail-room',
        name: 'watchdog 写入失败房间',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const roomEvents = [];
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn(() => {
        throw new Error('update failed in watchdog');
      }),
      flush: vi.fn(),
    };

    const result = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      broadcastRoom: (roomId, msg) => roomEvents.push({ roomId, ...msg }),
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
      flushOnRecovery: true,
    });

    expect(result).toMatchObject({
      status: 'recovery_failed',
      recoveryErrorCount: 1,
      recoveredRoomCount: 0,
      cleanedActiveAbortCount: 0,
      flushed: false,
      flushError: null,
      recoveryErrors: [
        expect.objectContaining({
          roomId: 'watchdog-update-fail-room',
          reason: 'stale_running_without_dispatcher',
          error: 'update failed in watchdog',
        }),
      ],
    });
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_recovery_failed',
        recoveryErrorCount: 1,
        at: fixedNow.toISOString(),
      }),
    ]);
    expect(roomEvents).toEqual([]);
    expect(roomStore.flush).not.toHaveBeenCalled();
  });

  it('runtime watchdog resolves pending recovery persistence before normal reconciliation', () => {
    const fixedNow = new Date('2026-06-01T00:09:00.000Z');
    const pending = {
      reason: 'runtime_recovery_flush_failed',
      flushError: 'previous disk full',
      at: '2026-06-01T00:00:00.000Z',
    };
    const rooms = new Map([
      ['watchdog-pending-room', {
        id: 'watchdog-pending-room',
        name: 'watchdog pending 房间',
        mode: 'cross_verify',
        status: 'paused',
        clusterRuntimeRecoveryPersistPending: pending,
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(),
    };

    const result = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: 'clean',
      runtimePersistPending: {
        ok: true,
        status: 'resolved',
        pendingRooms: [
          expect.objectContaining({ roomId: 'watchdog-pending-room' }),
        ],
      },
    });
    expect(rooms.get('watchdog-pending-room').clusterRuntimeRecoveryPersistPending).toBeUndefined();
    expect(roomStore.flush).toHaveBeenCalledTimes(2);
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_pending_resolved',
        at: fixedNow.toISOString(),
      }),
    ]);
  });

  it('runtime watchdog broadcasts pending failure and skips reconciliation when pending cannot persist', () => {
    const fixedNow = new Date('2026-06-01T00:09:30.000Z');
    const pending = {
      reason: 'runtime_recovery_flush_failed',
      flushError: 'previous disk full',
      at: '2026-06-01T00:00:00.000Z',
    };
    const rooms = new Map([
      ['watchdog-pending-fail-room', {
        id: 'watchdog-pending-fail-room',
        name: 'watchdog pending 失败房间',
        mode: 'cross_verify',
        status: 'paused',
        clusterRuntimeRecoveryPersistPending: pending,
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
      ['would-be-stale-running', {
        id: 'would-be-stale-running',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      flush: vi.fn(() => {
        throw new Error('pending still cannot flush');
      }),
    };

    const result = runClusterRuntimeWatchdogOnce({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: 'pending_failed',
      runtimePersistPending: {
        ok: false,
        error: 'cluster_runtime_recovery_persist_failed',
        message: 'pending still cannot flush',
        pendingRooms: [
          expect.objectContaining({ roomId: 'watchdog-pending-fail-room' }),
        ],
      },
      recoveredRoomCount: 0,
      recoveryErrorCount: 0,
    });
    expect(rooms.get('would-be-stale-running').status).toBe('running');
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_pending_failed',
        error: 'cluster_runtime_recovery_persist_failed',
        message: 'pending still cannot flush',
        at: fixedNow.toISOString(),
      }),
    ]);
    expect(roomStore.update).not.toHaveBeenCalled();
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('nonfatal recovery repairs stale running cluster room before snapshot flush fallback', () => {
    const fixedNow = new Date('2026-06-01T00:10:00.000Z');
    const order = [];
    const rooms = new Map([
      ['nonfatal-stale-room', {
        id: 'nonfatal-stale-room',
        name: '非致命异常后假运行',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
    const globalEvents = [];
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => {
        rooms.set(id, { ...rooms.get(id), ...patch });
        order.push(`update:${rooms.get(id).status}`);
      }),
      flush: vi.fn(() => {
        order.push(`flush:${rooms.get('nonfatal-stale-room').status}`);
      }),
    };

    const result = recoverClusterRuntimeAfterNonFatalError({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      broadcastRoom: () => {},
      broadcastGlobal: (msg) => globalEvents.push(msg),
      now: fixedNow,
      source: 'unhandledRejection',
    });

    expect(result).toMatchObject({
      status: 'recovered',
      source: 'unhandledRejection',
      snapshotFlushed: false,
      flushError: null,
      runtimeReconciliation: {
        status: 'recovered',
        recoveredRoomCount: 1,
        flushed: true,
      },
    });
    expect(order).toEqual(['update:paused', 'flush:paused']);
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
    expect(globalEvents).toEqual([
      expect.objectContaining({
        type: 'cluster_runtime_watchdog_recovered',
        recoveredRoomCount: 1,
        flushed: true,
      }),
    ]);
  });

  it('nonfatal recovery keeps old emergency snapshot flush when runtime is clean', () => {
    const roomStore = {
      list: () => [],
      flush: vi.fn(),
    };

    const result = recoverClusterRuntimeAfterNonFatalError({
      roomStore,
      dispatcher: { activeAborts: new Map() },
      source: 'unhandledRejection',
    });

    expect(result).toMatchObject({
      status: 'clean',
      snapshotFlushed: true,
      snapshotFlushError: null,
      flushError: null,
      runtimeReconciliation: { status: 'clean' },
    });
    expect(roomStore.flush).toHaveBeenCalledTimes(1);
  });

  it('recovers stale running cross_verify room before start instead of returning room_already_running', async () => {
    const rooms = new Map([
      ['stale-start-room', {
        id: 'stale-start-room',
        name: '启动前假运行房',
        mode: 'cross_verify',
        status: 'running',
        cwd: '/tmp',
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      }],
    ]);
    const roomStore = {
      get: (id) => rooms.get(id),
      list: () => [...rooms.values()],
      update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
    };
    const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()), activeAborts: new Map() };
    const runClusterLiveChecks = vi.fn(async () => ({
      status: 'passed',
      passedCount: 2,
      checks: [
        { adapterId: 'claude', passed: true },
        { adapterId: 'codex', passed: true },
      ],
    }));
    const { app, routes } = makeApp();
    registerRoomStartRoutes(app, {
      roomStore,
      requireOwnerToken: (_req, _res, next) => next(),
      debateDispatcher: { start: vi.fn() },
      squadDispatcher: { start: vi.fn() },
      arenaDispatcher: { start: vi.fn() },
      crossVerifyDispatcher,
      broadcastRoom: () => {},
      roomAdapterPool: new Map([
        ['claude', { chat: async () => ({ reply: 'OK' }) }],
        ['codex', { chat: async () => ({ reply: 'OK' }) }],
      ]),
      runClusterLiveChecks,
    });
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/debate');

    const res = makeResponse();
    await route.handlers[1]({ params: { id: 'stale-start-room' }, body: { topic: '继续完成项目' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
    expect(rooms.get('stale-start-room').status).toBe('paused');
    expect(runClusterLiveChecks).toHaveBeenCalledTimes(1);
    expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('stale-start-room', '继续完成项目', {});
  });

  it('GET cluster-concurrency-budget with roomId projects that room against current load', async () => {
    const rooms = new Map([
      ['running-1', {
        id: 'running-1',
        mode: 'cross_verify',
        status: 'running',
        members: [{ adapterId: 'claude', enabled: true }],
      }],
      ['target-room', {
        id: 'target-room',
        mode: 'cross_verify',
        status: 'idle',
        members: [{ adapterId: 'claude', enabled: true }, { adapterId: 'codex', enabled: true }],
      }],
    ]);
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
      crossVerifyDispatcher: { start: vi.fn(), activeAborts: new Map([['running-1', new AbortController()]]) },
      broadcastRoom: () => {},
    });
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/cluster/concurrency-budget');

    const res = makeResponse();
    await route.handlers[1]({ query: { roomId: 'target-room' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      roomId: 'target-room',
      mode: 'cross_verify',
      concurrencyBudget: {
        projectionEnabled: true,
        runningRoomCount: 1,
        projectedRunningRoomCount: 2,
        adapterLoad: { claude: 1 },
        projectedAdapterLoad: { claude: 2, codex: 1 },
      },
    });
  });

  it('blocks starting another cross_verify room when shared adapter concurrency would exceed the server budget', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-concurrency-block-'));
    try {
      const currentRoom = {
        id: 'new-room',
        mode: 'cross_verify',
        cwd: tempHome,
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      };
      const runningRoom = (id) => ({
        id,
        mode: 'cross_verify',
        status: 'running',
        cwd: tempHome,
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      });
      const roomStore = {
        get: () => currentRoom,
        list: () => [currentRoom, runningRoom('running-1'), runningRoom('running-2'), runningRoom('running-3')],
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'new-room' }, body: { topic: '第 4 个同模型并发项目' } }, res);

      expect(res.statusCode).toBe(409);
      expect(res.payload).toMatchObject({ ok: false, error: 'cluster_concurrency_blocked' });
      expect(res.payload.concurrencyBudget.blockers).toEqual(expect.arrayContaining([
        'adapter_running_rooms_gt_3:claude=4',
        'adapter_running_rooms_gt_3:codex=4',
      ]));
      expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('counts in-flight cross_verify starts as concurrency reservations before rooms become running', async () => {
    const oldLimit = process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-inflight-concurrency-'));
    let releaseLiveCheck;
    const liveCheckGate = new Promise((resolve) => { releaseLiveCheck = resolve; });
    process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = '1';
    clearClusterStartReservationsForTest();
    try {
      const rooms = new Map([
        ['room-a', {
          id: 'room-a',
          mode: 'cross_verify',
          status: 'idle',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
        ['room-b', {
          id: 'room-b',
          mode: 'cross_verify',
          status: 'idle',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
      ]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      const liveCheckCalls = [];
      const liveAdapter = (id) => ({
        chat: async () => {
          liveCheckCalls.push(id);
          await liveCheckGate;
          return { reply: 'OK' };
        },
      });
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', liveAdapter('claude')],
          ['codex', liveAdapter('codex')],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const resA = makeResponse();
      const firstStart = route.handlers[1]({ params: { id: 'room-a' }, body: { topic: '并发预约 A' } }, resA);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(liveCheckCalls.length).toBeGreaterThan(0);

      const resB = makeResponse();
      await route.handlers[1]({ params: { id: 'room-b' }, body: { topic: '并发预约 B' } }, resB);

      releaseLiveCheck();
      await firstStart;

      expect(resA.statusCode).toBe(200);
      expect(resA.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(resB.statusCode).toBe(409);
      expect(resB.payload).toMatchObject({ ok: false, error: 'cluster_concurrency_blocked' });
      expect(resB.payload.concurrencyBudget.startingRoomCount).toBe(1);
      expect(resB.payload.concurrencyBudget.startingRooms).toEqual([
        expect.objectContaining({
          roomId: 'room-a',
          adapterIds: ['claude', 'codex'],
        }),
      ]);
      expect(resB.payload.concurrencyBudget.blockers).toEqual(expect.arrayContaining([
        'adapter_running_rooms_gt_1:claude=2',
        'adapter_running_rooms_gt_1:codex=2',
      ]));
      expect(crossVerifyDispatcher.start).toHaveBeenCalledTimes(1);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('room-a', '并发预约 A', {});
    } finally {
      releaseLiveCheck?.();
      if (oldLimit === undefined) delete process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = oldLimit;
      clearClusterStartReservationsForTest();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps start reservation until dispatcher synchronously takes ownership', async () => {
    const oldLimit = process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
    process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = '1';
    clearClusterStartReservationsForTest();
    try {
      const rooms = new Map([
        ['room-a', {
          id: 'room-a',
          mode: 'cross_verify',
          status: 'idle',
          cwd: '/tmp',
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
        ['room-b', {
          id: 'room-b',
          mode: 'cross_verify',
          status: 'idle',
          cwd: '/tmp',
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
      ]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn((id, patch) => rooms.set(id, { ...rooms.get(id), ...patch })),
      };
      let observedBudgetInsideStart = null;
      const crossVerifyDispatcher = {
        activeAborts: new Map(),
        start: vi.fn(() => {
          observedBudgetInsideStart = buildClusterConcurrencyBudget(rooms.get('room-b'), {
            roomStore,
            activeAbortRooms: [],
          });
          return Promise.resolve();
        }),
      };
      const { app, routes } = makeApp();
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks: vi.fn(async () => ({
          status: 'passed',
          passedCount: 2,
          checks: [{ adapterId: 'claude', passed: true }, { adapterId: 'codex', passed: true }],
        })),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'room-a' }, body: { topic: '启动占位顺序' } }, res);

      expect(res.statusCode).toBe(200);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledTimes(1);
      expect(observedBudgetInsideStart).toMatchObject({
        status: 'blocked',
        startingRoomCount: 1,
      });
      expect(observedBudgetInsideStart.startingRooms).toEqual([
        expect.objectContaining({ roomId: 'room-a', adapterIds: ['claude', 'codex'] }),
      ]);
    } finally {
      if (oldLimit === undefined) delete process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = oldLimit;
      clearClusterStartReservationsForTest();
    }
  });

  it('releases in-flight start reservation when live check throws before dispatcher start', async () => {
    const oldLimit = process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-reservation-release-'));
    process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = '1';
    clearClusterStartReservationsForTest();
    try {
      const rooms = new Map([
        ['room-a', {
          id: 'room-a',
          mode: 'cross_verify',
          status: 'idle',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
        ['room-b', {
          id: 'room-b',
          mode: 'cross_verify',
          status: 'idle',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }],
      ]);
      const roomStore = {
        get: (id) => rooms.get(id),
        list: () => [...rooms.values()],
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      let liveCheckCalls = 0;
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks: async () => {
          liveCheckCalls += 1;
          if (liveCheckCalls === 1) throw new Error('live check infrastructure failed');
          return {
            status: 'passed',
            passedCount: 2,
            total: 2,
            checks: [
              { adapterId: 'claude', displayName: 'Claude', passed: true, status: 'passed' },
              { adapterId: 'codex', displayName: 'GPT', passed: true, status: 'passed' },
            ],
            blockers: [],
          };
        },
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const resA = makeResponse();
      await route.handlers[1]({ params: { id: 'room-a' }, body: { topic: '异常释放 A' } }, resA);
      const resB = makeResponse();
      await route.handlers[1]({ params: { id: 'room-b' }, body: { topic: '异常释放 B' } }, resB);

      expect(resA.statusCode).toBe(503);
      expect(resA.payload).toMatchObject({
        ok: false,
        error: 'cluster_live_check_failed',
        message: 'live check infrastructure failed',
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.payload).toMatchObject({ ok: true, started: true, mode: 'cross_verify' });
      expect(resB.payload.concurrencyBudget.startingRoomCount).toBe(0);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledTimes(1);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('room-b', '异常释放 B', {});
    } finally {
      if (oldLimit === undefined) delete process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS;
      else process.env.PANEL_CLUSTER_MAX_ADAPTER_RUNNING_ROOMS = oldLimit;
      clearClusterStartReservationsForTest();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('blocks cross_verify start when cluster preflight fails', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-preflight-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [{ adapterId: 'claude', enabled: true }],
        }),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(409);
      expect(res.payload).toMatchObject({ ok: false, error: 'cluster_preflight_blocked' });
      expect(res.payload.preflight.blockers).toContain('members:enabled_members_lt_2');
      expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('allows cross_verify start with one enabled member only when failover evidence exists', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-solo-takeover-preflight-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'solo-takeover-room',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: false, failoverDisabled: true, failoverReason: 'quota_exhausted' },
          ],
          clusterDroppedMembers: [
            { adapterId: 'codex', reason: 'quota_exhausted', recoverable: false },
          ],
        }),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()), activeAborts: new Map() };
      const runClusterLiveChecks = vi.fn(async () => ({
        status: 'passed',
        passedCount: 1,
        checks: [{ adapterId: 'claude', passed: true }],
      }));
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => ({ reply: 'OK' }) }],
        ]),
        runClusterLiveChecks,
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'solo-takeover-room' }, body: { topic: '剩余 Claude 继续完成项目' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        started: true,
        concurrencyBudget: {
          currentAdapters: ['claude'],
        },
      });
      expect(runClusterLiveChecks).toHaveBeenCalledTimes(1);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('solo-takeover-room', '剩余 Claude 继续完成项目', {});
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('starts cross_verify degraded when one enabled adapter cannot chat and another can take over', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-preflight-chat-'));
    try {
      const rooms = new Map([['r1', {
        id: 'r1',
        mode: 'cross_verify',
        cwd: tempHome,
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      }]]);
      const roomUpdates = [];
      const roomStore = {
        get: (id) => rooms.get(id),
        update: vi.fn((id, patch) => {
          roomUpdates.push(patch);
          rooms.set(id, { ...rooms.get(id), ...patch });
        }),
        flush: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: {
          has: () => true,
          get: (id) => (id === 'claude' ? { id, chat: async () => ({ reply: 'ok' }) } : { id }),
        },
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: true, started: true, liveCheckDegraded: true });
      expect(res.payload.liveCheck.blockers).toContain('codex:chat_unavailable');
      expect(roomUpdates[0].members.find((m) => m.adapterId === 'codex')).toMatchObject({
        enabled: false,
        failoverDisabled: true,
        failoverReason: 'startup_live_check_hard_failed',
      });
      expect(roomStore.flush).toHaveBeenCalledTimes(1);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('r1', '做一个游戏', {});
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('blocks cross_verify start when no enabled adapter can chat', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-preflight-all-chat-missing-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: {
          has: () => true,
          get: (id) => ({ id }),
        },
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(409);
      expect(res.payload).toMatchObject({ ok: false, error: 'cluster_preflight_blocked' });
      expect(res.payload.preflight.blockers).toEqual(expect.arrayContaining([
        'adapters:adapter_unavailable=claude:chat_unavailable',
        'adapters:adapter_unavailable=codex:chat_unavailable',
      ]));
      expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('starts cross_verify in degraded mode when at least one live adapter ping passes', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-live-fail-'));
    try {
      const roomUpdates = [];
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        update: (_id, patch) => roomUpdates.push(patch),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => { throw new Error('provider offline'); } }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: true, started: true, liveCheckDegraded: true });
      expect(res.payload.liveCheck.blockers[0]).toContain('codex:live_ping_failed=provider offline');
      expect(roomUpdates[0].members.find((m) => m.adapterId === 'codex')).toMatchObject({
        enabled: false,
        failoverDisabled: true,
        failoverReason: 'startup_live_check_hard_failed',
      });
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('r1', '做一个游戏', {});
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('does not permanently disable members on startup live ping timeout', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-live-soft-timeout-'));
    try {
      const roomUpdates = [];
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        update: (_id, patch) => roomUpdates.push(patch),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn(() => Promise.resolve()) };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => { throw new Error('cluster_adapter_live_ping_timeout'); } }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: true, started: true });
      expect(res.payload.liveCheckDegraded).toBeUndefined();
      expect(roomUpdates).toHaveLength(0);
      expect(crossVerifyDispatcher.start).toHaveBeenCalledWith('r1', '做一个游戏', {});
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('blocks cross_verify start when all live adapter pings fail', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-live-all-fail-'));
    try {
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members: [
            { adapterId: 'claude', displayName: 'Claude', enabled: true },
            { adapterId: 'codex', displayName: 'GPT', enabled: true },
          ],
        }),
        update: vi.fn(),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn() };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map([
          ['claude', { chat: async () => { throw new Error('provider offline'); } }],
          ['codex', { chat: async () => { throw new Error('quota exceeded'); } }],
        ]),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个游戏' } }, res);

      expect(res.statusCode).toBe(409);
      expect(res.payload).toMatchObject({ ok: false, error: 'cluster_live_check_blocked' });
      expect(res.payload.liveCheck.blockers).toEqual(expect.arrayContaining([
        'claude:live_ping_failed=provider offline',
        'codex:live_ping_failed=quota exceeded',
      ]));
      expect(roomStore.update).not.toHaveBeenCalled();
      expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('blocks cross_verify start when cluster execution budget estimate is too large', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'noe-route-budget-block-'));
    try {
      const members = Array.from({ length: 7 }, (_, i) => ({
        adapterId: `agent-${i}`,
        displayName: `Agent ${i}`,
        enabled: true,
      }));
      const roomStore = {
        get: () => ({
          id: 'r1',
          mode: 'cross_verify',
          cwd: tempHome,
          members,
        }),
      };
      const { app, routes } = makeApp();
      const crossVerifyDispatcher = { start: vi.fn() };
      registerRoomStartRoutes(app, {
        roomStore,
        requireOwnerToken: (_req, _res, next) => next(),
        debateDispatcher: crossVerifyDispatcher,
        squadDispatcher: crossVerifyDispatcher,
        arenaDispatcher: crossVerifyDispatcher,
        crossVerifyDispatcher,
        broadcastRoom: () => {},
        roomAdapterPool: new Map(members.map((member) => [member.adapterId, { chat: async () => ({ reply: 'OK' }) }])),
      });
      const route = routes.find((item) => item.path === '/api/rooms/:id/debate');

      const res = makeResponse();
      await route.handlers[1]({ params: { id: 'r1' }, body: { topic: '做一个大型游戏' } }, res);

      expect(res.statusCode).toBe(409);
      expect(res.payload).toMatchObject({ ok: false, error: 'cluster_preflight_blocked' });
      expect(res.payload.preflight.blockers).toEqual(expect.arrayContaining([
        'execution_budget:member_count_gt_6',
        'execution_budget:estimated_calls_gt_360',
      ]));
      expect(crossVerifyDispatcher.start).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
