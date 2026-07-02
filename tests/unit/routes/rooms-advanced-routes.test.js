// @ts-check
// S23：rooms-advanced 域 14 条路由从 server.js 提取后的行为锁定测试
// （roomsAdvanced.js：report/runtime-processes/task-ops/lifecycle 9 条；
//   roomsForward.js：forward/quick 2 条；roomsMedia.js：media×2+chat 3 条）
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  registerRoomsLifecycleRoutes,
  registerRoomsReportRoutes,
  registerRoomsRuntimeProcessesRoutes,
  registerRoomsTaskOpsRoutes,
} from '../../../src/server/routes/roomsAdvanced.js';
import { registerRoomsForwardRoutes, registerRoomsQuickRoutes } from '../../../src/server/routes/roomsForward.js';
import { registerRoomsMediaRoutes } from '../../../src/server/routes/roomsMedia.js';

function mockApp(routes) {
  const collect = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { get: collect('get'), post: collect('post'), patch: collect('patch'), delete: collect('delete') };
}

function mockRes() {
  return {
    statusCode: 200, payload: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    sendFile(p) { this.payload = { sentFile: p }; return this; },
  };
}

function setup({ rooms = [], maxRooms = 500, roomMediaDir = '/tmp/noe-test-room-media' } = {}) {
  const routes = [];
  const app = mockApp(routes);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const calls = { broadcast: [], saved: 0, aborts: [] };
  const roomStore = {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    save: () => { calls.saved += 1; },
    update: (id, patch) => Object.assign(byId.get(id) || {}, patch),
    create: (data) => { const r = { id: 'new-room', ...data }; byId.set(r.id, r); return r; },
    setStatus: () => {},
  };
  const mkDispatcher = (name, abortResult) => ({
    abort: (id) => { calls.aborts.push(`${name}:${id}`); return abortResult; },
    activeAborts: new Map(),
    start: async () => {},
    resume: async () => {},
    retryTask: async () => {},
    sendMessage: async () => {},
  });
  const deps = {
    roomStore,
    roomAdapterPool: new Map([['claude', { id: 'claude' }]]),
    MAX_ROOMS: maxRooms,
    safeResolveFsPath: (p) => String(p),
    safeResolveFsPathForWrite: (p) => String(p),
    safeSlice: (s, n) => String(s).slice(0, n),
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
    broadcastRoom: (roomId, msg) => calls.broadcast.push(msg),
    broadcastGlobal: (msg) => calls.broadcast.push(msg),
    collectPanelRuntimeProcesses: () => ({ ok: true, processes: [{ pid: 1 }] }),
    debateDispatcher: mkDispatcher('debate', false),
    squadDispatcher: mkDispatcher('squad', true),
    arenaDispatcher: mkDispatcher('arena', false),
    soloChatDispatcher: mkDispatcher('soloChat', false),
    crossVerifyDispatcher: mkDispatcher('crossVerify', false),
    prepareClusterRunGate: async () => ({ ok: true }),
    runClusterRuntimeWatchdogOnce: () => ({ recoveryErrorCount: 0, recoveredRooms: [] }),
    archiveStore: { getConfig: () => ({ rootPath: '/tmp' }) },
    defaultReportPath: () => '/tmp/report.md',
    generateReport: async () => ({ ok: true, content: 'x' }),
    permissionGovernance: { evaluatePermission: () => null },
    permissionApprovalIdFromRequest: () => null,
    permissionHttpStatus: () => 403,
    permissionHttpBody: (p) => p,
    activityLog: { recordSafe: () => {} },
    metricsStore: { record: () => {} },
    roomTemplatesStore: { get: () => null },
    ROOM_MEDIA_DIR: roomMediaDir,
  };
  // 按 server.js 原注册顺序调用（report → runtime → task-ops → forward → lifecycle → media → quick）
  registerRoomsReportRoutes(app, deps);
  registerRoomsRuntimeProcessesRoutes(app, deps);
  registerRoomsTaskOpsRoutes(app, deps);
  registerRoomsForwardRoutes(app, deps);
  registerRoomsLifecycleRoutes(app, deps);
  registerRoomsMediaRoutes(app, deps);
  registerRoomsQuickRoutes(app, deps);
  const invoke = async (method, path, req = {}) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    const res = mockRes();
    await r.handlers[r.handlers.length - 1]({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
    return res;
  };
  return { routes, invoke, calls, roomStore };
}

describe('rooms-advanced routes (S23 提取) — register 烟测', () => {
  it('14 条 method+path 全部注册且顺序与拆前一致、每条挂 owner-token 中间件', () => {
    const { routes } = setup();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'post /api/rooms/:id/report',
      'get /api/reports/:jobId',
      'get /api/rooms/:id/runtime-processes',
      'post /api/rooms/:id/tasks/:tid/inject',
      'get /api/rooms/:id/tasks/:tid/diff',
      'post /api/rooms/forward',
      'post /api/rooms/:id/retry-turn',
      'post /api/rooms/:id/retry-task',
      'post /api/rooms/:id/resume',
      'post /api/rooms/:id/abort',
      'post /api/rooms/:id/media',
      'get /api/rooms/:id/media/:mediaId',
      'post /api/rooms/:id/chat',
      'post /api/rooms/quick',
    ]);
    for (const r of routes) expect(r.handlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('rooms-advanced routes — 行为锁定抽测', () => {
  it('GET /api/reports/:jobId：jobId 非法 → 400；合法格式但不存在 → 404', async () => {
    const { invoke } = setup();
    expect((await invoke('get', '/api/reports/:jobId', { params: { jobId: 'bad!!' } })).statusCode).toBe(400);
    expect((await invoke('get', '/api/reports/:jobId', { params: { jobId: 'rpt-0123456789ab' } })).statusCode).toBe(404);
  });

  it('GET runtime-processes：房不存在 → 404；存在 → 返快照', async () => {
    const { invoke } = setup({ rooms: [{ id: 'r1', status: 'idle', cwd: '/tmp' }] });
    expect((await invoke('get', '/api/rooms/:id/runtime-processes', { params: { id: 'nope' } })).statusCode).toBe(404);
    const res = await invoke('get', '/api/rooms/:id/runtime-processes', { params: { id: 'r1' } });
    expect(res.statusCode).toBe(200);
    expect(res.payload.roomId).toBe('r1');
    expect(res.payload.processes).toHaveLength(1);
  });

  it('POST inject：空 content → 400；正常注入 → save + broadcast', async () => {
    const { invoke, calls } = setup({ rooms: [{ id: 'r1', taskList: [{ id: 't1' }] }] });
    expect((await invoke('post', '/api/rooms/:id/tasks/:tid/inject', {
      params: { id: 'r1', tid: 't1' }, body: { content: '' },
    })).statusCode).toBe(400);
    const ok = await invoke('post', '/api/rooms/:id/tasks/:tid/inject', {
      params: { id: 'r1', tid: 't1' }, body: { content: '补充提示' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.payload.ok).toBe(true);
    expect(calls.saved).toBe(1);
    expect(calls.broadcast.some((m) => m.type === 'task_injection_added')).toBe(true);
  });

  it('POST abort：房不存在 → 404；存在 → 5 个 dispatcher 全试、aborted 聚合', async () => {
    const { invoke, calls } = setup({ rooms: [{ id: 'r1' }] });
    expect((await invoke('post', '/api/rooms/:id/abort', { params: { id: 'nope' } })).statusCode).toBe(404);
    const res = await invoke('post', '/api/rooms/:id/abort', { params: { id: 'r1' } });
    expect(res.payload).toEqual({ ok: true, aborted: true });   // squad mock 返 true
    expect(calls.aborts).toHaveLength(5);
  });

  it('POST forward：缺 sourceRoomId → 400；超 MAX_ROOMS（deps 注入值）→ 429', async () => {
    const { invoke } = setup({ rooms: [{ id: 'r1' }] });
    expect((await invoke('post', '/api/rooms/forward', { body: {} })).statusCode).toBe(400);
    const capped = setup({ rooms: [{ id: 'r1' }], maxRooms: 1 });
    expect((await capped.invoke('post', '/api/rooms/forward', { body: { sourceRoomId: 'r1' } })).statusCode).toBe(429);
  });

  it('POST forward：seedScope=all 生成 transcript topic 且不被 token warning 块 TDZ 中断', async () => {
    const { invoke, roomStore } = setup({ rooms: [{
      id: 'r1',
      name: '源房',
      cwd: '/tmp',
      mode: 'chat',
      topic: '原始主题',
      finalConsensus: '最终结论',
      conversation: [{ from: 'user', content: '第一句' }, { from: 'assistant', displayName: 'Noe', content: '第二句' }],
    }] });
    const res = await invoke('post', '/api/rooms/forward', { body: { sourceRoomId: 'r1', targetMode: 'squad', seedScope: 'all' } });
    expect(res.statusCode).toBe(200);
    const room = roomStore.get(res.payload.newRoomId);
    expect(room.topic).toContain('源房原始 topic');
    expect(room.topic).toContain('第一句');
    expect(room.topic).toContain('最终结论');
  });

  it('POST chat：mode != chat → 400', async () => {
    const { invoke } = setup({ rooms: [{ id: 'r1', mode: 'debate' }] });
    expect((await invoke('post', '/api/rooms/:id/chat', { params: { id: 'r1' }, body: { text: 'hi' } })).statusCode).toBe(400);
  });

  it('GET media/:mediaId：房存在但附件不存在 → 404', async () => {
    const { invoke } = setup({ rooms: [{ id: 'r1', mediaAttachments: [] }] });
    expect((await invoke('get', '/api/rooms/:id/media/:mediaId', { params: { id: 'r1', mediaId: 'm1' } })).statusCode).toBe(404);
  });

  it('GET media/:mediaId：fallback 存储内的合法附件 → sendFile', async () => {
    const roomMediaDir = mkdtempSync(join(tmpdir(), 'noe-room-media-'));
    try {
      const roomDir = join(roomMediaDir, 'r1');
      mkdirSync(roomDir, { recursive: true });
      const filePath = join(roomDir, 'm1.png');
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const { invoke } = setup({
        roomMediaDir,
        rooms: [{ id: 'r1', mediaAttachments: [{ id: 'm1', path: filePath, mime: 'image/png' }] }],
      });
      const res = await invoke('get', '/api/rooms/:id/media/:mediaId', { params: { id: 'r1', mediaId: 'm1' } });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ sentFile: realpathSync(filePath) });
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    } finally {
      rmSync(roomMediaDir, { recursive: true, force: true });
    }
  });

  it('GET media/:mediaId：附件路径不在房间受控存储内 → 404', async () => {
    const roomMediaDir = mkdtempSync(join(tmpdir(), 'noe-room-media-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'noe-room-media-outside-'));
    try {
      const outsideFile = join(outsideDir, 'leak.png');
      writeFileSync(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const { invoke } = setup({
        roomMediaDir,
        rooms: [{ id: 'r1', mediaAttachments: [{ id: 'm1', path: outsideFile, mime: 'image/png' }] }],
      });
      const res = await invoke('get', '/api/rooms/:id/media/:mediaId', { params: { id: 'r1', mediaId: 'm1' } });
      expect(res.statusCode).toBe(404);
      expect(res.payload).toEqual({ error: 'media not found' });
    } finally {
      rmSync(roomMediaDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('POST quick：缺 topic → 400；超 MAX_ROOMS → 429', async () => {
    const { invoke } = setup();
    expect((await invoke('post', '/api/rooms/quick', { body: {} })).statusCode).toBe(400);
    const capped = setup({ rooms: [{ id: 'r1' }], maxRooms: 1 });
    expect((await capped.invoke('post', '/api/rooms/quick', { body: { topic: 'x' } })).statusCode).toBe(429);
  });
});
