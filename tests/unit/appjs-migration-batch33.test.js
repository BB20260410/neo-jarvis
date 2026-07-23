// @ts-check
// 第三波手术 第33批 结构级防回归：server.js 余矿三连之二
// autopilot 房间操作（forwardRoomFromAutopilot/startRoomFromAutopilot，~116 行）迁出
// src/server/services/autopilot-room-ops.js。
// 注入约定：roomStore/broadcastRoom/broadcastGlobal 稳定 const 传值；roomAdapterPool/四 dispatcher
// 在组合根后文才构造且仅 job 运行时求值 → getter bag 注入；controller/scheduler 装配留守组合根。
// 风格对齐 appjs-migration-batch30/32：源码文本断言 + 真跑行为冒烟（fetch 桩/假 dispatcher）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/auth/owner-token.js', () => ({
  getOrCreateOwnerToken: () => 'batch33-test-token',
}));

const { createAutopilotRoomOps } = await import('../../src/server/services/autopilot-room-ops.js');

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/autopilot-room-ops.js';

describe('server.js 拆分第33批（autopilot 房间操作外迁）— 结构', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头 + 注入式工厂', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
    expect(moduleSrc).toContain('export function createAutopilotRoomOps({ roomStore, broadcastRoom, broadcastGlobal, getRoomAdapterPool, getDispatchers })');
  });

  it('server.js：工厂 import + getter bag 注入 + 同名解构，不再内联实现', () => {
    expect(serverSrc).toContain("import { createAutopilotRoomOps } from './src/server/services/autopilot-room-ops.js';");
    expect(serverSrc).toContain('const { forwardRoomFromAutopilot, startRoomFromAutopilot } = createAutopilotRoomOps({');
    expect(serverSrc).toContain('getRoomAdapterPool: () => roomAdapterPool,');
    expect(serverSrc).toContain('getDispatchers: () => ({ debateDispatcher, squadDispatcher, arenaDispatcher, crossVerifyDispatcher }),');
    expect(serverSrc).not.toContain('async function forwardRoomFromAutopilot(');
    expect(serverSrc).not.toContain('async function startRoomFromAutopilot(');
  });

  it('server.js：controller/scheduler 装配留守，注入点全保留', () => {
    expect(serverSrc).toContain('forwardRoom: forwardRoomFromAutopilot,');
    expect(serverSrc.match(/startRoom: startRoomFromAutopilot,/g)?.length, 'start_delegation/start_noe_delegate 注入点丢失').toBe(2);
    expect(serverSrc).toContain('return forwardRoomFromAutopilot({');
    expect(serverSrc).toContain('autopilotScheduler.start();');
  });

  it('行为契约关键字留在模块：self-call 转发/owner-token 头/集群闸门/兜底 release', () => {
    expect(moduleSrc).toContain("fetch(`http://127.0.0.1:${PORT_LOCAL}/api/rooms/forward`");
    expect(moduleSrc).toContain("'X-Panel-Owner-Token': ownerToken");
    expect(moduleSrc).toContain('runClusterRuntimeWatchdogOnce({');
    expect(moduleSrc).toContain('await prepareClusterRunGate(room, {');
    expect(moduleSrc).toContain('startGate?.reservation?.release?.();');
    expect(moduleSrc).toContain("claimedBy: `autopilot:${job?.id || 'delegation'}`,");
  });
});

function makeDeps(overrides = {}) {
  const calls = { updates: [], statuses: [], roomMsgs: [], globalMsgs: [] };
  const roomStore = {
    update: (id, patch) => calls.updates.push({ id, patch }),
    setStatus: (id, s) => calls.statuses.push({ id, s }),
    get: () => null,
  };
  const deps = {
    roomStore,
    broadcastRoom: (roomId, msg) => calls.roomMsgs.push({ roomId, msg }),
    broadcastGlobal: (msg) => calls.globalMsgs.push(msg),
    getRoomAdapterPool: () => new Map(),
    getDispatchers: () => ({
      debateDispatcher: { start: vi.fn(() => Promise.resolve('ok')) },
      squadDispatcher: { start: vi.fn(() => Promise.resolve('ok')) },
      arenaDispatcher: { start: vi.fn(() => Promise.resolve('ok')) },
      crossVerifyDispatcher: { start: vi.fn(() => Promise.resolve('ok')) },
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe('server.js 拆分第33批 — 真跑行为冒烟', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('startRoom：已 running 直接拒启；空 topic 抛错；未知 mode 返回 `${mode}_room`', async () => {
    const { deps } = makeDeps();
    const { startRoomFromAutopilot } = createAutopilotRoomOps(deps);
    await expect(startRoomFromAutopilot({ room: { id: 'r1', status: 'running', topic: 't' } }))
      .resolves.toEqual({ started: false, reason: 'already_running', roomId: 'r1' });
    await expect(startRoomFromAutopilot({ room: { id: 'r2', mode: 'debate' } }))
      .rejects.toThrow('delegation target room has empty topic');
    await expect(startRoomFromAutopilot({ room: { id: 'r3', mode: 'solo_chat', topic: 't' } }))
      .resolves.toEqual({ started: false, reason: 'solo_chat_room', roomId: 'r3' });
    await expect(startRoomFromAutopilot({ room: null })).rejects.toThrow('startRoomFromAutopilot requires room');
  });

  it('startRoom debate 顺路：dispatcher.start 被调 + claim 落库 + delegation_autostart 广播', async () => {
    const dispatchers = {
      debateDispatcher: { start: vi.fn(() => Promise.resolve('ok')) },
      squadDispatcher: { start: vi.fn() }, arenaDispatcher: { start: vi.fn() }, crossVerifyDispatcher: { start: vi.fn() },
    };
    const { deps, calls } = makeDeps({ getDispatchers: () => dispatchers });
    const { startRoomFromAutopilot } = createAutopilotRoomOps(deps);
    const r = await startRoomFromAutopilot({ room: { id: 'r9', mode: 'debate', topic: '主题' }, job: { id: 'j7' } });
    expect(r).toEqual({ started: true, roomId: 'r9', mode: 'debate' });
    expect(dispatchers.debateDispatcher.start).toHaveBeenCalledWith('r9', '主题');
    expect(calls.updates).toContainEqual({ id: 'r9', patch: { claimedBy: 'autopilot:j7', autostartedBy: 'j7' } });
    expect(calls.globalMsgs.some((m) => m.type === 'delegation_autostart' && m.targetRoomId === 'r9')).toBe(true);
  });

  it('startRoom：dispatcher.start 同步抛 → 异步兜底广播 error + 房间置 error（不向上抛）', async () => {
    const dispatchers = {
      debateDispatcher: { start: vi.fn(() => { throw new Error('boom33'); }) },
      squadDispatcher: { start: vi.fn() }, arenaDispatcher: { start: vi.fn() }, crossVerifyDispatcher: { start: vi.fn() },
    };
    const { deps, calls } = makeDeps({ getDispatchers: () => dispatchers });
    const { startRoomFromAutopilot } = createAutopilotRoomOps(deps);
    const r = await startRoomFromAutopilot({ room: { id: 'rE', mode: 'debate', topic: 't' }, job: { id: 'jE' } });
    expect(r.started).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(calls.roomMsgs.some((m) => m.roomId === 'rE' && m.msg.type === 'debate_error' && m.msg.error === 'boom33')).toBe(true);
    expect(calls.statuses).toContainEqual({ id: 'rE', s: 'error' });
  });

  it('forwardRoom：self-call 带 owner-token 头，成功回 newRoomId 并标记 hops/claim；失败抛错', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      seen.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true, newRoomId: 'nr1' }) };
    }));
    const { deps, calls } = makeDeps();
    const { forwardRoomFromAutopilot } = createAutopilotRoomOps(deps);
    const r = await forwardRoomFromAutopilot({ sourceRoomId: 's1', targetMode: 'debate', autoStart: true, name: 'n', autopilotHops: 2, claimedBy: 'autopilot:jx' });
    expect(r).toEqual({ newRoomId: 'nr1' });
    expect(seen[0].url).toContain('/api/rooms/forward');
    expect(seen[0].opts.headers['X-Panel-Owner-Token']).toBe('batch33-test-token');
    expect(calls.updates).toContainEqual({ id: 'nr1', patch: { autopilotHops: 2, claimedBy: 'autopilot:jx' } });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'nope' }) })));
    await expect(forwardRoomFromAutopilot({ sourceRoomId: 's1', targetMode: 'debate' })).rejects.toThrow('nope');
  });
});
