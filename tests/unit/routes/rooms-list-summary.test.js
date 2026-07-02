import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClusterExecutionBudgetEstimate,
  registerRoomsRoutes,
  runClusterAdapterLiveChecks,
  summarizeRoom,
} from '../../../src/server/routes/rooms.js';
import {
  buildClusterEngineeringTaskList,
  buildClusterWorkflowAudit,
} from '../../../src/room/CrossVerifyDispatcher.js';

function makeRoom(overrides = {}) {
  return {
    id: 'room-1',
    name: 'Heavy room',
    mode: 'squad',
    status: 'done',
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:10:00.000Z',
    cwd: '/tmp/project',
    members: [
      { adapterId: 'claude', displayName: 'Claude', model: 'sonnet', role: 'pm', agentProfileId: 'xike-chief', enabled: true, token: 'drop-me' },
      { adapterId: 'codex', displayName: 'Codex', enabled: false },
    ],
    topic: 'important topic',
    debateRounds: 2,
    qaStrictness: 'standard',
    currentRound: -1,
    currentMacroRound: 2,
    finalConsensus: 'large final consensus should not be listed',
    userInterventions: [{ at: '2026-05-24T00:05:00.000Z', content: 'note' }],
    rounds: [
      { kind: 'r1_propose', turns: [{ speaker: 'claude', content: 'SECRET_TURN_CONTENT' }] },
      { kind: 'r2_critique', turns: [{ speaker: 'codex', content: 'MORE_SECRET_TURN_CONTENT' }] },
    ],
    taskList: [{ id: 't1', title: 'Task', attempts: [{ content: 'SECRET_ATTEMPT_CONTENT' }] }],
    conversation: [{ from: 'user', content: 'SECRET_CHAT_CONTENT' }],
    archived: false,
    archivedAt: null,
    objective: {
      id: 'obj-1',
      title: 'Ship ActivityLog',
      description: 'Make activity auditable',
      acceptanceCriteria: ['events are searchable'],
      status: 'active',
    },
    lineage: {
      projectId: '/tmp/project',
      parentRoomId: 'room-parent',
      parentTaskId: 'task-parent',
      taskId: 'task-1',
      objectiveId: 'obj-1',
      source: 'manual',
    },
    roleCards: [
      { memberId: 'claude', displayName: 'Claude', role: 'pm', title: 'PM', reportTo: null, scope: ['task_split'] },
      { memberId: 'codex', displayName: 'Codex', role: 'dev', title: 'DEV', reportTo: 'pm', scope: ['implementation'] },
    ],
    projectContextSummary: {
      fileCount: 1,
      totalChars: 42,
      truncated: false,
      files: [{ name: 'AGENTS.md', path: '/tmp/project/AGENTS.md', includedChars: 42, truncated: false }],
    },
    ...overrides,
  };
}

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete', 'patch']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  return { app, routes };
}

function makeDeps(roomStore, overrides = {}) {
  const noopDispatcher = { abort() {} };
  return {
    roomStore,
    safeResolveFsPath: () => '/tmp/project',
    safeSlice: (value, limit) => String(value).slice(0, limit),
    roomAdapterPool: { has: () => true, get: (id) => ({ id, displayName: id, chat: async () => ({ reply: 'ok' }) }) },
    debateDispatcher: noopDispatcher,
    squadDispatcher: noopDispatcher,
    arenaDispatcher: noopDispatcher,
    soloChatDispatcher: noopDispatcher,
    roomWsClients: new Map(),
    skillStore: {
      list: () => [
        { name: 'qa', enabled: true },
        { name: 'browse', enabled: true },
        { name: 'disabled-skill', enabled: false },
      ],
    },
    MAX_ROOMS: 500,
    ...overrides,
  };
}

function runFirstJsonHandler(route, query = {}) {
  let statusCode = 200;
  let payload;
  const req = { query, params: {}, body: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  // A1 后 GET /api/rooms 也挂了 requireOwnerToken，业务 handler 恒为最后一个（跳过 token 中间件直测业务逻辑）
  route.handlers.at(-1)(req, res);
  return { statusCode, payload };
}

function runOwnerRouteHandler(route, { params = {}, query = {}, body = {} } = {}) {
  let statusCode = 200;
  const headers = {};
  let payload;
  const req = { query, params, body };
  const res = {
    status(code) { statusCode = code; return this; },
    setHeader(key, value) { headers[key] = value; return this; },
    json(bodyValue) { payload = bodyValue; return this; },
    send(bodyValue) { payload = bodyValue; return this; },
  };
  route.handlers[1](req, res);
  return { statusCode, headers, payload };
}

async function runOwnerRouteHandlerAsync(route, { params = {}, query = {}, body = {} } = {}) {
  let statusCode = 200;
  const headers = {};
  let payload;
  const req = { query, params, body };
  const res = {
    status(code) { statusCode = code; return this; },
    setHeader(key, value) { headers[key] = value; return this; },
    json(bodyValue) { payload = bodyValue; return this; },
    send(bodyValue) { payload = bodyValue; return this; },
  };
  await route.handlers[1](req, res);
  return { statusCode, headers, payload };
}

describe('rooms list summary', () => {
  it('summarizeRoom keeps list metadata and strips heavy room bodies', () => {
    const summary = summarizeRoom(makeRoom());
    expect(summary.id).toBe('room-1');
    expect(summary.members).toEqual([
      { adapterId: 'claude', displayName: 'Claude', model: 'sonnet', role: 'pm', agentProfileId: 'xike-chief', enabled: true },
      { adapterId: 'codex', displayName: 'Codex', model: '', role: undefined, enabled: false },
    ]);
    expect(summary.roundCount).toBe(2);
    expect(summary.turnCount).toBe(2);
    expect(summary.taskCount).toBe(1);
    expect(summary.conversationCount).toBe(1);
    expect(summary.userInterventionCount).toBe(1);
    expect(summary.hasFinalConsensus).toBe(true);
    expect(summary.objective).toEqual({ id: 'obj-1', title: 'Ship ActivityLog', status: 'active', acceptanceCount: 1 });
    expect(summary.lineage).toMatchObject({ projectId: '/tmp/project', parentRoomId: 'room-parent', taskId: 'task-1', objectiveId: 'obj-1' });
    expect(summary.roleCards).toHaveLength(2);
    expect(summary.roleCards[1]).toMatchObject({ memberId: 'codex', role: 'dev', reportTo: 'pm' });
    expect(summary.projectContext).toMatchObject({ fileCount: 1, totalChars: 42 });
    const json = JSON.stringify(summary);
    expect(json).not.toContain('SECRET_TURN_CONTENT');
    expect(json).not.toContain('SECRET_CHAT_CONTENT');
    expect(json).not.toContain('SECRET_ATTEMPT_CONTENT');
    expect(json).not.toContain('large final consensus');
    expect(json).not.toContain('drop-me');
  });

  it('GET /api/rooms defaults to compact summaries', () => {
    const activeRoom = makeRoom();
    const archivedRoom = makeRoom({ id: 'room-archived', archived: true, archivedAt: '2026-05-24T01:00:00.000Z' });
    const roomStore = {
      list: () => [activeRoom],
      listArchived: () => [archivedRoom],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const listRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms');
    const { statusCode, payload } = runFirstJsonHandler(listRoute);

    expect(statusCode).toBe(200);
    expect(payload.compact).toBe(true);
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0].rounds).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('SECRET_TURN_CONTENT');
  });

  it('GET /api/rooms?full=1 preserves the legacy full payload path', () => {
    const activeRoom = makeRoom();
    const roomStore = {
      list: () => [activeRoom],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const listRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms');
    const { payload } = runFirstJsonHandler(listRoute, { full: '1' });

    expect(payload.compact).toBe(false);
    expect(payload.rooms[0].rounds[0].turns[0].content).toBe('SECRET_TURN_CONTENT');
    expect(payload.fullPayloadPolicy.omittedCount).toBe(0);
  });

  it('GET /api/rooms?full=1 omits oversized room bodies so the list endpoint stays responsive', () => {
    const activeRoom = makeRoom({
      rounds: [{
        kind: 'huge',
        turns: [{ speaker: 'claude', content: 'X'.repeat(260_000) }],
      }],
    });
    const roomStore = {
      list: () => [activeRoom],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const listRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms');
    const { payload } = runFirstJsonHandler(listRoute, { full: '1' });

    expect(payload.compact).toBe(false);
    expect(payload.fullPayloadPolicy.omittedCount).toBe(1);
    expect(payload.rooms[0]).toMatchObject({
      id: 'room-1',
      fullPayloadOmitted: true,
      fullPayloadReason: 'room_too_large_for_list',
      detailEndpoint: '/api/rooms/room-1',
    });
    expect(payload.rooms[0].rounds).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('X'.repeat(1000));
  });

  it('POST /api/rooms creates isolated project directories for duplicate Chinese cluster names', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'noe-cluster-projects-'));
    const created = [];
    const roomStore = {
      list: () => created,
      listArchived: () => [],
      get: () => null,
      create(input) {
        const room = { id: `room-${created.length + 1}`, ...input };
        created.push(room);
        return room;
      },
    };
    const safeResolveFsPath = (pathValue) => {
      if (typeof pathValue !== 'string') return null;
      if (pathValue === baseDir || pathValue.startsWith(`${baseDir}/`)) return pathValue;
      return null;
    };
    try {
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, { safeResolveFsPath }));
      const createRoute = routes.find((route) => route.method === 'post' && route.path === '/api/rooms');
      const body = {
        name: '文字传奇',
        mode: 'cross_verify',
        projectScaffold: { baseDir, projectName: '文字传奇' },
        members: [
          { adapterId: 'claude', displayName: 'Claude', enabled: true },
          { adapterId: 'codex', displayName: 'GPT', enabled: true },
        ],
      };

      const first = runOwnerRouteHandler(createRoute, { body });
      const second = runOwnerRouteHandler(createRoute, { body });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.payload.room.cwd).toMatch(new RegExp(`${baseDir}/文字传奇`));
      expect(second.payload.room.cwd).toMatch(new RegExp(`${baseDir}/文字传奇-`));
      expect(first.payload.room.cwd).not.toBe(second.payload.room.cwd);
      expect(first.payload.room.clusterRuntimeState).toMatchObject({
        event: 'api_create_response',
        phase: 'idle',
      });
      for (const room of [first.payload.room, second.payload.room]) {
        expect(existsSync(join(room.cwd, 'project.md'))).toBe(true);
        expect(existsSync(join(room.cwd, 'requirements.md'))).toBe(true);
        expect(existsSync(join(room.cwd, 'handoff.md'))).toBe(true);
        expect(existsSync(join(room.cwd, 'artifacts'))).toBe(true);
        expect(existsSync(join(room.cwd, 'attachments'))).toBe(true);
        expect(existsSync(join(room.cwd, 'logs'))).toBe(true);
        expect(readFileSync(join(room.cwd, 'project.md'), 'utf8')).toContain('Working boundary');
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('POST /api/rooms can create the default nested cluster project base under a safe existing ancestor', () => {
    const homeLikeRoot = mkdtempSync(join(tmpdir(), 'noe-safe-home-'));
    const baseDir = join(homeLikeRoot, 'Desktop', 'NoeProjects');
    const created = [];
    const roomStore = {
      list: () => created,
      listArchived: () => [],
      get: () => null,
      create(input) {
        const room = { id: `room-${created.length + 1}`, ...input };
        created.push(room);
        return room;
      },
    };
    const safeResolveFsPath = (pathValue) => {
      if (typeof pathValue !== 'string') return null;
      if (pathValue === homeLikeRoot) return pathValue;
      if (pathValue.startsWith(`${homeLikeRoot}/`) && existsSync(pathValue)) return pathValue;
      return null;
    };
    try {
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, { safeResolveFsPath }));
      const createRoute = routes.find((route) => route.method === 'post' && route.path === '/api/rooms');

      const result = runOwnerRouteHandler(createRoute, {
        body: {
          name: '文字传奇',
          mode: 'cross_verify',
          projectScaffold: { baseDir, projectName: '文字传奇' },
        },
      });

      expect(result.statusCode).toBe(200);
      expect(result.payload.room.cwd).toMatch(new RegExp(`${baseDir}/文字传奇`));
      expect(existsSync(join(result.payload.room.cwd, 'attachments'))).toBe(true);
      expect(existsSync(join(result.payload.room.cwd, 'logs'))).toBe(true);
    } finally {
      rmSync(homeLikeRoot, { recursive: true, force: true });
    }
  });

  it('POST /api/rooms rejects cluster project bases outside the writable sandbox', () => {
    const roomStore = {
      list: () => [],
      listArchived: () => [],
      get: () => null,
      create() {
        throw new Error('create should not be called');
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, { safeResolveFsPath: () => null }));
    const createRoute = routes.find((route) => route.method === 'post' && route.path === '/api/rooms');

    const result = runOwnerRouteHandler(createRoute, {
      body: {
        name: '越权项目',
        mode: 'cross_verify',
        projectScaffold: { baseDir: '/etc', projectName: '越权项目' },
      },
    });

    expect(result.statusCode).toBe(403);
    expect(result.payload).toMatchObject({
      ok: false,
      error: '项目根目录越权或敏感',
    });
  });

  it('/api/rooms/search is registered before /api/rooms/:id', () => {
    const roomStore = {
      list: () => [],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const paths = routes.filter((route) => route.method === 'get').map((route) => route.path);
    expect(paths.indexOf('/api/rooms/search')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/rooms/search')).toBeLessThan(paths.indexOf('/api/rooms/:id'));
  });

  it('/api/rooms/search finds objective metadata', () => {
    const roomStore = {
      list: () => [makeRoom()],
      listArchived: () => [],
      get: () => null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));

    const searchRoute = routes.find((route) => route.method === 'get' && route.path === '/api/rooms/search');
    const { statusCode, payload } = runFirstJsonHandler({ ...searchRoute, handlers: [searchRoute.handlers[1]] }, { q: 'ActivityLog' });

    expect(statusCode).toBe(200);
    expect(payload.count).toBe(1);
    expect(payload.hits[0].where).toBe('objective:title');
  });

  it('GET /api/rooms/:id/cluster-delivery-package exposes the package index', () => {
    const room = makeRoom({
      mode: 'cross_verify',
      clusterDeliveryManifest: { fingerprint: 'b'.repeat(64), readyForDelivery: true },
      clusterDeliveryReportMarkdown: '# 集群协同交付报告',
      clusterDeliveryPackage: {
        packageVersion: 'cluster-delivery-package-v1',
        status: 'ready',
        manifestFingerprint: 'b'.repeat(64),
        artifacts: [
          { kind: 'delivery_manifest_json', filename: 'room-cluster-delivery.json' },
          { kind: 'delivery_report_markdown', filename: 'room-cluster-report.md' },
        ],
      },
    });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-delivery-package');

    const { statusCode, payload } = runOwnerRouteHandler(route, { params: { id: 'room-1' } });

    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.package.packageVersion).toBe('cluster-delivery-package-v1');
    expect(payload.package.artifacts.map((item) => item.kind)).toEqual([
      'delivery_manifest_json',
      'delivery_report_markdown',
    ]);
    expect(payload.manifestFingerprint).toBe('b'.repeat(64));
  });

  it('GET /api/rooms/:id/cluster-preflight checks cross-verify readiness', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-preflight-'));
    const room = makeRoom({
      mode: 'cross_verify',
      cwd,
      members: [
        { adapterId: 'claude', displayName: 'Claude', enabled: true },
        { adapterId: 'codex', displayName: 'GPT', enabled: true },
      ],
    });
    try {
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
      };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore));
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-preflight');

      const { statusCode, payload } = runOwnerRouteHandler(route, { params: { id: 'room-1' }, query: { topic: '做一个游戏' } });

      expect(statusCode).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.preflight).toMatchObject({
        preflightVersion: 'cluster-preflight-v1',
        status: 'passed',
        total: 8,
      });
      expect(payload.preflight.checks.map((item) => item.id)).toEqual([
        'mode',
        'members',
        'adapters',
        'project_goal',
        'cwd',
        'lifecycle',
        'delivery_archive',
        'execution_budget',
      ]);
      expect(payload.preflight.budgetEstimate).toMatchObject({
        estimateVersion: 'cluster-execution-budget-estimate-v1',
        memberCount: 2,
        status: 'passed',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('buildClusterExecutionBudgetEstimate blocks oversized model clusters before launch', () => {
    const room = makeRoom({
      mode: 'cross_verify',
      members: Array.from({ length: 7 }, (_, i) => ({
        adapterId: `adapter-${i}`,
        displayName: `Agent ${i}`,
        enabled: true,
      })),
    });

    const estimate = buildClusterExecutionBudgetEstimate(room);

    expect(estimate.status).toBe('blocked');
    expect(estimate.blockers).toEqual(expect.arrayContaining([
      'member_count_gt_6',
      'estimated_calls_gt_360',
      'estimated_tokens_gt_1200000',
    ]));
  });

  it('GET /api/rooms/:id/cluster-preflight warns on partial adapter chat loss so live check can degrade', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-preflight-chat-'));
    const room = makeRoom({
      mode: 'cross_verify',
      cwd,
      members: [
        { adapterId: 'claude', displayName: 'Claude', enabled: true },
        { adapterId: 'codex', displayName: 'GPT', enabled: true },
      ],
    });
    try {
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
      };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, {
        roomAdapterPool: {
          has: () => true,
          get: (id) => (id === 'claude' ? { id, chat: async () => ({ reply: 'ok' }) } : { id }),
        },
      }));
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-preflight');

      const { statusCode, payload } = runOwnerRouteHandler(route, { params: { id: 'room-1' }, query: { topic: '做一个游戏' } });

      expect(statusCode).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.preflight.status).toBe('warn');
      expect(payload.preflight.warnings).toContain('adapters:adapter_unavailable=codex:chat_unavailable');
      expect(payload.preflight.checks.find((item) => item.id === 'adapters')?.evidence).toEqual(expect.arrayContaining([
        'Claude:claude:chat_ready',
        'GPT:codex:chat_unavailable',
      ]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('runClusterAdapterLiveChecks verifies enabled adapters with a lightweight chat ping', async () => {
    const calls = [];
    const room = makeRoom({
      mode: 'cross_verify',
      members: [
        { adapterId: 'claude', displayName: 'Claude', model: 'claude-opus-4-8', enabled: true },
        { adapterId: 'codex', displayName: 'GPT', model: 'gpt-5.5', enabled: true },
      ],
    });
    const liveCheck = await runClusterAdapterLiveChecks(room, {
      topic: '做一个游戏',
      roomAdapterPool: new Map([
        ['claude', { chat: async (_messages, opts) => { calls.push({ adapterId: 'claude', opts }); return { reply: 'OK' }; } }],
        ['codex', { chat: async (_messages, opts) => { calls.push({ adapterId: 'codex', opts }); return { reply: 'OK' }; } }],
      ]),
      timeoutMs: 1000,
    });

    expect(liveCheck).toMatchObject({
      liveCheckVersion: 'cluster-adapter-live-check-v1',
      status: 'passed',
      passedCount: 2,
      total: 2,
    });
    expect(liveCheck.checks.every((item) => item.passed)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.opts?.livePing === true)).toBe(true);
    expect(calls.every((call) => call.opts?.skipBudget === true)).toBe(true);
    expect(calls.every((call) => call.opts?.agentRunLifecycle === false)).toBe(true);
  });

  it('GET /api/rooms/:id/cluster-preflight?live=1 returns blocked live check when adapter ping fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-preflight-live-'));
    const room = makeRoom({
      mode: 'cross_verify',
      cwd,
      members: [
        { adapterId: 'claude', displayName: 'Claude', enabled: true },
        { adapterId: 'codex', displayName: 'GPT', enabled: true },
      ],
    });
    try {
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
      };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, {
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['codex', { chat: async () => { throw new Error('provider offline'); } }],
        ]),
      }));
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-preflight');

      const { statusCode, payload } = await runOwnerRouteHandlerAsync(route, {
        params: { id: 'room-1' },
        query: { topic: '做一个游戏', live: '1' },
      });

      expect(statusCode).toBe(409);
      expect(payload.ok).toBe(false);
      expect(payload.preflight.status).toBe('passed');
      expect(payload.liveCheck.status).toBe('blocked');
      expect(payload.liveCheck.blockers[0]).toContain('codex:live_ping_failed=provider offline');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('GET /api/rooms/:id/cluster-preflight?live=1 treats live ping timeout as a soft warning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-preflight-timeout-'));
    const room = makeRoom({
      mode: 'cross_verify',
      cwd,
      members: [
        { adapterId: 'claude', displayName: 'Claude', enabled: true },
        { adapterId: 'gemini-cli', displayName: 'Gemini CLI', enabled: true },
      ],
    });
    try {
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
      };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, {
        roomAdapterPool: new Map([
          ['claude', { chat: async () => ({ reply: 'OK' }) }],
          ['gemini-cli', { chat: async () => { throw new Error('cluster_adapter_live_ping_timeout'); } }],
        ]),
      }));
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-preflight');

      const { statusCode, payload } = await runOwnerRouteHandlerAsync(route, {
        params: { id: 'room-1' },
        query: { topic: '做一个游戏', live: '1' },
      });

      expect(statusCode).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.liveCheck.status).toBe('warn');
      expect(payload.liveCheck.blockers).toEqual([]);
      expect(payload.liveCheck.warnings).toContain('gemini-cli:live_ping_timeout');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('GET /api/rooms/:id/cluster-preflight blocks missing members and goal', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-preflight-block-'));
    const room = makeRoom({
      mode: 'cross_verify',
      cwd,
      name: '',
      topic: '',
      objective: null,
      members: [{ adapterId: 'claude', displayName: 'Claude', enabled: true }],
    });
    try {
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
      };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore));
      const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-preflight');

      const { statusCode, payload } = runOwnerRouteHandler(route, { params: { id: 'room-1' } });

      expect(statusCode).toBe(409);
      expect(payload.ok).toBe(false);
      expect(payload.preflight.status).toBe('blocked');
      expect(payload.preflight.blockers).toEqual(expect.arrayContaining([
        'members:enabled_members_lt_2',
        'project_goal:project_goal_missing',
      ]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('POST /api/rooms/:id/cluster-evidence-links verifies succeeded Agent Run evidence', () => {
    const room = makeRoom({ id: 'room-evidence', mode: 'cross_verify' });
    let updated;
    const activityEvents = [];
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const agentRunStore = {
      getTimeline: (id) => id === 'agent-run-ok' ? {
        run: { id, status: 'succeeded' },
        toolResults: [{ id: 'tool-1' }],
        archives: [],
        artifacts: [{ id: 'artifact-1' }],
      } : null,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, {
      agentRunStore,
      activityLog: { recordSafe: (event) => activityEvents.push(event) },
    }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const { statusCode, payload } = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-ok', summary: '真实执行证据' },
    });

    expect(statusCode).toBe(201);
    expect(payload.ok).toBe(true);
    expect(payload.link).toMatchObject({
      stageId: 'implementation',
      agentRunId: 'agent-run-ok',
      verified: true,
      toolResultCount: 1,
      artifactCount: 1,
      evidenceCount: 2,
    });
    expect(updated.clusterEvidenceLinks).toHaveLength(1);
    expect(activityEvents[0]).toMatchObject({
      action: 'cluster.evidence.linked',
      entityType: 'cluster_evidence_link',
      status: 'verified',
      roomId: 'room-evidence',
      taskId: 'implementation',
    });
  });

  it('POST /api/rooms/:id/cluster-evidence-links recomputes delivery gate after final code evidence link', () => {
    const taskList = buildClusterEngineeringTaskList('项目目标');
    for (const task of taskList) {
      task.status = 'done';
      task.stageArtifact = {
        gates: [{ status: 'passed' }],
        evidenceRequirement: { required: ['implementation', 'unit_test', 'integration_test', 'functional_validation'].includes(task.stageId), status: 'passed' },
        evidence: [{ memberId: 'a#1', signals: ['command_evidence'], commands: ['npm test'] }],
        signoffs: [{ memberId: 'a#1', agree: true }, { memberId: 'b#2', agree: true }],
        risks: [],
      };
      if (task.stageId === 'acceptance') {
        task.stageArtifact.acceptanceRequirement = { required: true, status: 'passed' };
        task.stageArtifact.acceptanceReport = { summary: { total: 11, passed: 11, passed_with_risks: 0, insufficient: 0, failed: 0 } };
      }
      task.consensus = { finalPlan: `# ${task.stageLabel}`, stageArtifact: task.stageArtifact };
    }
    let current = makeRoom({
      id: 'room-evidence-refresh',
      name: '集群协同证据刷新',
      mode: 'cross_verify',
      status: 'paused',
      topic: '项目目标',
      members: [{ enabled: true }, { enabled: true }],
      taskList,
      clusterWorkflowAudit: buildClusterWorkflowAudit(taskList),
      clusterEvidenceLinks: [
        { verified: true, stageId: 'implementation', stageLabel: '代码开发', agentRunId: 'run-1', evidenceCount: 1, toolResultCount: 1 },
        { verified: true, stageId: 'unit_test', stageLabel: '单元测试', agentRunId: 'run-2', evidenceCount: 1, toolResultCount: 1 },
        { verified: true, stageId: 'integration_test', stageLabel: '集成测试', agentRunId: 'run-3', evidenceCount: 1, toolResultCount: 1 },
      ],
    });
    const roomStore = {
      list: () => [current],
      listArchived: () => [],
      get: () => current,
      update: (_id, patch) => {
        current = { ...current, ...patch };
        return current;
      },
    };
    const agentRunStore = {
      getTimeline: (id) => ({
        run: { id, status: 'succeeded' },
        toolResults: [{ id: 'tool-4' }],
        archives: [],
        artifacts: [],
      }),
    };
    const activityEvents = [];
    const wsMessages = [];
    const roomWsClients = new Map([[
      'room-evidence-refresh',
      new Set([{ send: (payload) => wsMessages.push(JSON.parse(payload)) }]),
    ]]);
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, {
      agentRunStore,
      activityLog: { recordSafe: (event) => activityEvents.push(event) },
      roomWsClients,
    }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const { statusCode, payload } = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-refresh' },
      body: { stageId: 'functional_validation', agentRunId: 'run-4', summary: '功能验证证据' },
    });

    expect(statusCode).toBe(201);
    expect(payload.room.status).toBe('done');
    expect(payload.room.clusterEvidenceLinks).toHaveLength(4);
    expect(payload.room.clusterDeliveryManifest).toMatchObject({
      readyForDelivery: true,
      deliveryGate: { status: 'passed', blockers: [] },
    });
    expect(payload.room.clusterDeliveryPackage).toMatchObject({
      status: 'ready',
      readyForArchive: true,
      deliveryGateStatus: 'passed',
    });
    expect(payload.room.clusterDeliveryReportMarkdown).toContain('# 集群协同交付报告');
    expect(activityEvents.map((event) => event.action)).toEqual([
      'cluster.evidence.linked',
      'cluster.delivery.ready',
    ]);
    expect(activityEvents[1]).toMatchObject({
      actorType: 'system',
      entityType: 'cluster_delivery_manifest',
      status: 'ready',
      details: {
        trigger: 'cluster_evidence_linked',
        stageId: 'functional_validation',
        deliveryGateStatus: 'passed',
        readyForDelivery: true,
        packageStatus: 'ready',
      },
    });
    expect(wsMessages).toEqual([expect.objectContaining({
      type: 'cluster_delivery_ready',
      roomId: 'room-evidence-refresh',
      stageId: 'functional_validation',
      deliveryGateStatus: 'passed',
      readyForDelivery: true,
      packageStatus: 'ready',
    })]);
  });

  it('POST /api/rooms/:id/cluster-evidence-links rejects failed or empty Agent Run evidence', () => {
    const room = makeRoom({ id: 'room-evidence-bad', mode: 'cross_verify' });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const agentRunStore = {
      getTimeline: () => ({ run: { id: 'agent-run-bad', status: 'failed' }, toolResults: [{ id: 'tool-1' }], archives: [], artifacts: [] }),
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, { agentRunStore }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const { statusCode, payload } = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-bad' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-bad' },
    });

    expect(statusCode).toBe(422);
    expect(payload.error).toContain('not succeeded');
  });

  it('POST /api/rooms/:id/cluster-evidence-links rejects succeeded Agent Run with only failed tool evidence', () => {
    const room = makeRoom({ id: 'room-evidence-failed-tool', mode: 'cross_verify' });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const agentRunStore = {
      getTimeline: () => ({
        run: { id: 'agent-run-failed-tool', status: 'succeeded', roomId: 'room-evidence-failed-tool' },
        toolResults: [{ id: 'tool-failed', status: 'failed' }],
        archives: [],
        artifacts: [],
      }),
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, { agentRunStore }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const { statusCode, payload } = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-failed-tool' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-failed-tool' },
    });

    expect(statusCode).toBe(422);
    expect(payload.error).toContain('no verifiable evidence');
  });

  it('POST /api/rooms/:id/cluster-evidence-links rejects Agent Run evidence from another room or task', () => {
    const taskList = buildClusterEngineeringTaskList('项目目标');
    const room = makeRoom({
      id: 'room-evidence-owner',
      mode: 'cross_verify',
      taskList,
    });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const timelines = {
      'agent-run-other-room': {
        run: { id: 'agent-run-other-room', status: 'succeeded', roomId: 'other-room', taskId: 'CE05' },
        toolResults: [{ id: 'tool-1' }],
        archives: [],
        artifacts: [],
      },
      'agent-run-other-task': {
        run: { id: 'agent-run-other-task', status: 'succeeded', roomId: 'room-evidence-owner', taskId: 'CE06' },
        toolResults: [{ id: 'tool-2' }],
        archives: [],
        artifacts: [],
      },
    };
    const agentRunStore = {
      getTimeline: (id) => timelines[id],
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, { agentRunStore }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const otherRoom = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-owner' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-other-room' },
    });
    const otherTask = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-owner' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-other-task' },
    });

    expect(otherRoom.statusCode).toBe(422);
    expect(otherRoom.payload.error).toContain('different room');
    expect(otherTask.statusCode).toBe(422);
    expect(otherTask.payload.error).toContain('different task');
  });

  it('POST /api/rooms/:id/cluster-evidence-links is idempotent for duplicate stage Agent Run links', () => {
    const existingLink = {
      id: 'cluster-evidence-existing',
      stageId: 'implementation',
      stageLabel: '代码开发',
      agentRunId: 'agent-run-dup',
      verified: true,
      evidenceCount: 1,
      toolResultCount: 1,
      archiveCount: 0,
      artifactCount: 0,
    };
    let current = makeRoom({
      id: 'room-evidence-dup',
      mode: 'cross_verify',
      clusterEvidenceLinks: [existingLink],
    });
    const updates = [];
    const activityEvents = [];
    const roomStore = {
      list: () => [current],
      listArchived: () => [],
      get: () => current,
      update: (_id, patch) => {
        updates.push(patch);
        current = { ...current, ...patch };
        return current;
      },
    };
    const agentRunStore = {
      getTimeline: (id) => ({
        run: { id, status: 'succeeded', roomId: 'room-evidence-dup' },
        toolResults: [{ id: 'tool-dup' }],
        archives: [],
        artifacts: [],
      }),
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore, {
      agentRunStore,
      activityLog: { recordSafe: (event) => activityEvents.push(event) },
    }));
    const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-evidence-links');

    const { statusCode, payload } = runOwnerRouteHandler(route, {
      params: { id: 'room-evidence-dup' },
      body: { stageId: 'implementation', agentRunId: 'agent-run-dup' },
    });

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ ok: true, duplicate: true });
    expect(payload.link).toEqual(existingLink);
    expect(current.clusterEvidenceLinks).toEqual([existingLink]);
    expect(updates).toHaveLength(1);
    expect(updates[0].clusterEvidenceLinks).toEqual([existingLink]);
    expect(activityEvents).toEqual([]);
  });

  it('GET /api/rooms/:id/cluster-delivery-package/:artifactKind/download downloads manifest and report artifacts', () => {
    const room = makeRoom({
      mode: 'cross_verify',
      clusterDeliveryManifest: { fingerprint: 'c'.repeat(64), readyForDelivery: true },
      clusterDeliveryReportMarkdown: '# 集群协同交付报告\n\n## 阶段交付矩阵',
      clusterDeliveryPackage: {
        packageVersion: 'cluster-delivery-package-v1',
        status: 'ready',
        manifestFingerprint: 'c'.repeat(64),
        artifacts: [
          { kind: 'delivery_manifest_json', filename: 'room-cluster-delivery.json' },
          { kind: 'delivery_report_markdown', filename: 'room-cluster-report.md' },
        ],
      },
    });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const route = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-delivery-package/:artifactKind/download');

    const manifest = runOwnerRouteHandler(route, { params: { id: 'room-1', artifactKind: 'manifest' } });
    const report = runOwnerRouteHandler(route, { params: { id: 'room-1', artifactKind: 'report' } });

    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['Content-Type']).toContain('application/json');
    expect(manifest.headers['Content-Disposition']).toContain('room-cluster-delivery.json');
    expect(JSON.parse(manifest.payload).fingerprint).toBe('c'.repeat(64));
    expect(report.statusCode).toBe(200);
    expect(report.headers['Content-Type']).toContain('text/markdown');
    expect(report.headers['Content-Disposition']).toContain('room-cluster-report.md');
    expect(report.payload).toContain('# 集群协同交付报告');
  });

  it('POST /api/rooms/:id/cluster-delivery-package/archive writes delivery artifacts and records archive metadata', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noe-cluster-delivery-'));
    try {
      const room = makeRoom({
        id: 'room-archive',
        cwd,
        mode: 'cross_verify',
        topic: '归档交付测试',
        clusterDeliveryManifest: { fingerprint: 'd'.repeat(64), readyForDelivery: true },
        clusterDeliveryReportMarkdown: '# 集群协同交付报告\n\n## 阶段交付矩阵',
        clusterDeliveryPackage: {
          packageVersion: 'cluster-delivery-package-v1',
          status: 'ready',
          readyForArchive: true,
          manifestFingerprint: 'd'.repeat(64),
          artifacts: [
            { kind: 'delivery_manifest_json', label: 'Manifest', filename: 'room-cluster-delivery.json' },
            { kind: 'delivery_report_markdown', label: 'Report', filename: 'room-cluster-report.md' },
          ],
        },
      });
      let updated;
      const activityEvents = [];
      const roomStore = {
        list: () => [room],
        listArchived: () => [],
        get: () => room,
        update: (_id, patch) => {
          updated = { ...room, ...patch };
          return updated;
        },
      };
      const activityLog = { recordSafe: (event) => activityEvents.push(event) };
      const { app, routes } = makeApp();
      registerRoomsRoutes(app, makeDeps(roomStore, { activityLog }));
      const route = routes.find((item) => item.method === 'post' && item.path === '/api/rooms/:id/cluster-delivery-package/archive');

      const { statusCode, payload } = runOwnerRouteHandler(route, { params: { id: 'room-archive' }, body: { requestedBy: 'test' } });

      expect(statusCode).toBe(201);
      expect(payload.ok).toBe(true);
      expect(payload.archive.artifacts.map((item) => item.kind)).toEqual([
        'delivery_package_index_json',
        'delivery_manifest_json',
        'delivery_report_markdown',
      ]);
      expect(updated.clusterDeliveryArchive.id).toBe(payload.archive.id);
      expect(updated.clusterDeliveryArchives).toHaveLength(1);
      expect(activityEvents).toHaveLength(1);
      expect(activityEvents[0]).toMatchObject({
        action: 'cluster.delivery.archived',
        actorType: 'user',
        actorId: 'test',
        roomId: 'room-archive',
        entityType: 'cluster_delivery_archive',
        entityId: payload.archive.id,
        status: 'ready',
      });
      expect(activityEvents[0].details).toMatchObject({
        archiveId: payload.archive.id,
        artifactCount: 3,
        manifestFingerprint: 'd'.repeat(64),
        readyForArchive: true,
      });
      for (const artifact of payload.archive.artifacts) {
        const abs = join(cwd, artifact.path);
        expect(existsSync(abs)).toBe(true);
        expect(readFileSync(abs, 'utf8').length).toBeGreaterThan(0);
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      }

      roomStore.get = () => updated;
      const downloadRoute = routes.find((item) => item.method === 'get' && item.path === '/api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download');
      const downloadedReport = runOwnerRouteHandler(downloadRoute, {
        params: { id: 'room-archive', archiveId: payload.archive.id, artifactKind: 'report' },
      });
      expect(downloadedReport.statusCode).toBe(200);
      expect(downloadedReport.headers).toMatchObject({
        'X-Xike-Cluster-Delivery-Archive': payload.archive.id,
        'X-Xike-Cluster-Delivery-Artifact': 'delivery_report_markdown',
      });
      expect(downloadedReport.payload).toContain('# 集群协同交付报告');

      const reportArtifact = payload.archive.artifacts.find((item) => item.kind === 'delivery_report_markdown');
      const tamperedRoom = {
        ...updated,
        clusterDeliveryArchives: [{
          ...payload.archive,
          artifacts: payload.archive.artifacts.map((item) => item.kind === 'delivery_report_markdown'
            ? { ...item, sha256: '0'.repeat(64) }
            : item),
        }],
      };
      roomStore.get = () => tamperedRoom;
      const tampered = runOwnerRouteHandler(downloadRoute, {
        params: { id: 'room-archive', archiveId: payload.archive.id, artifactKind: reportArtifact.kind },
      });
      expect(tampered.statusCode).toBe(422);
      expect(tampered.payload.error).toContain('digest mismatch');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('PATCH /api/rooms/:id keeps lineage objectiveId aligned with updated objective', () => {
    const room = makeRoom();
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { objective: { title: 'New target' } } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.objective.title).toBe('New target');
    expect(updated.lineage.objectiveId).toBe(updated.objective.id);
  });

  it('PATCH /api/rooms/:id preserves valid member agent profile bindings', () => {
    const room = makeRoom({ mode: 'squad' });
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = {
      params: { id: 'room-1' },
      body: {
        members: [
          { adapterId: 'claude', displayName: 'Claude PM', role: 'pm', agentProfileId: 'xike-architect', enabled: true },
          { adapterId: 'codex', displayName: 'Codex QA', role: 'qa', agentProfileId: '', enabled: true },
        ],
      },
    };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.members[0]).toMatchObject({ role: 'pm', agentProfileId: 'xike-architect' });
    expect(updated.members[1].agentProfileId).toBeUndefined();
    expect(updated.roleCards).toHaveLength(2);
  });

  it('PATCH /api/rooms/:id rejects unknown member agent profile ids', () => {
    const room = makeRoom({ mode: 'squad' });
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = {
      params: { id: 'room-1' },
      body: {
        members: [
          { adapterId: 'claude', displayName: 'Claude PM', role: 'pm', agentProfileId: 'not-real-profile', enabled: true },
        ],
      },
    };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(422);
    expect(res.payload.error).toContain('agentProfileId');
  });

  it('PATCH /api/rooms/:id saves only installed enabled room skills', () => {
    const room = makeRoom();
    let updated;
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: (_id, patch) => {
        updated = { ...room, ...patch };
        return updated;
      },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { skills: ['qa', 'browse', 'qa'] } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(200);
    expect(updated.skills).toEqual(['qa', 'browse']);
    expect(res.payload.room.skills).toEqual(['qa', 'browse']);
  });

  it('PATCH /api/rooms/:id rejects unknown or disabled room skills', () => {
    const room = makeRoom();
    const roomStore = {
      list: () => [room],
      listArchived: () => [],
      get: () => room,
      update: () => { throw new Error('should not update'); },
    };
    const { app, routes } = makeApp();
    registerRoomsRoutes(app, makeDeps(roomStore));
    const patchRoute = routes.find((route) => route.method === 'patch' && route.path === '/api/rooms/:id');
    const req = { params: { id: 'room-1' }, body: { skills: ['qa', 'disabled-skill'] } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };

    patchRoute.handlers[1](req, res);

    expect(res.statusCode).toBe(422);
    expect(res.payload.error).toContain('skills');
  });
});
