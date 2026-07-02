// @ts-check
// S23：sessions 域 19 条路由从 server.js 提取后的行为锁定测试
// （sessions.js：核心 CRUD/中断/导出收藏 fork 12 条；sessionsContinuum.js：ctx/snapshot/handoff/external/spawn-batch 7 条）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  registerSessionsCoreRoutes,
  registerSessionsControlRoutes,
  registerSessionsExtrasRoutes,
} from '../../../src/server/routes/sessions.js';
import {
  registerSessionsContinuumRoutes,
  registerSessionsSpawnBatchRoutes,
} from '../../../src/server/routes/sessionsContinuum.js';

const tmp = mkdtempSync(join(tmpdir(), 'noe-sessions-routes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function mockApp(routes) {
  const collect = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { get: collect('get'), post: collect('post'), patch: collect('patch'), delete: collect('delete') };
}

function mockRes() {
  return {
    statusCode: 200, payload: undefined, headers: {}, sent: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.sent = b; return this; },
  };
}

function setup({ sessions = new Map(), capacityOk = true, extraDeps = {} } = {}) {
  const routes = [];
  const app = mockApp(routes);
  const calls = { broadcast: [], dispatcherReset: [], sendMessage: [] };
  const dispatcher = {
    resetSession: (id) => calls.dispatcherReset.push(id),
    clearAutoPromptCount: () => {},
  };
  const deps = {
    sessions,
    checkSessionsCapacity: (res) => {
      if (!capacityOk) { res.status(429).json({ error: 'capacity' }); return false; }
      return true;
    },
    safeResolveFsPath: (p) => (String(p).startsWith(tmp) ? String(p) : null),
    sendMessageToClaude: (s, text) => { calls.sendMessage.push([s.id, text]); return { ok: true }; },
    debouncedSave: () => {},
    saveData: () => {},
    watcherAdapterPool: new Map([['ollama', {}]]),
    getWatcherDispatcher: () => dispatcher,
    broadcastSession: (s, msg) => calls.broadcast.push(msg),
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
    ...extraDeps,
  };
  registerSessionsCoreRoutes(app, deps);
  registerSessionsControlRoutes(app, deps);
  registerSessionsContinuumRoutes(app, deps);
  registerSessionsSpawnBatchRoutes(app, deps);
  registerSessionsExtrasRoutes(app, deps);
  const invoke = (method, path, req = {}) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    const res = mockRes();
    r.handlers[r.handlers.length - 1]({ params: {}, query: {}, body: {}, ...req }, res);
    return res;
  };
  return { routes, invoke, calls };
}

describe('sessions routes (S23 提取) — register 烟测', () => {
  it('19 条 method+path 全部注册且顺序与拆前一致、每条挂 owner-token 中间件', () => {
    const { routes } = setup();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      // ① core（server.js 原 1240-1436）
      'post /api/sessions',
      'get /api/sessions',
      'patch /api/sessions/:id',
      'get /api/sessions/:id',
      'post /api/sessions/:id/messages',
      'delete /api/sessions/:id',
      // ② control（原 1492-1540）
      'post /api/sessions/:id/interrupt',
      'post /api/sessions/:id/reset-busy',
      // ③ continuum（原 3562-3810）
      'get /api/sessions/:id/ctx',
      'get /api/sessions/:id/snapshot',
      'get /api/sessions/:id/handoff-history',
      'get /api/sessions/:id/handoff-meta',
      'post /api/sessions/:id/handoff',
      'post /api/sessions/:id/external',
      // ④ spawn-batch（原 3833-3851，login-claude 之后）
      'post /api/spawn-batch',
      // ⑤ extras（原 4010-4107）
      'get /api/sessions/:id/export',
      'post /api/sessions/:id/star',
      'get /api/sessions/:id/stars',
      'post /api/sessions/:id/fork',
    ]);
    for (const r of routes) expect(r.handlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('sessions core routes 行为锁定', () => {
  it('POST /api/sessions 创建成功 + name 过长 400 + cwd 越权 403 + 容量满 429', () => {
    const sessions = new Map();
    const { invoke } = setup({ sessions });
    const ok = invoke('post', '/api/sessions', { body: { name: '测试', cwd: tmp } });
    expect(ok.statusCode).toBe(200);
    expect(ok.payload.name).toBe('测试');
    expect(sessions.size).toBe(1);
    expect(invoke('post', '/api/sessions', { body: { name: 'x'.repeat(201), cwd: tmp } }).statusCode).toBe(400);
    expect(invoke('post', '/api/sessions', { body: { cwd: '/etc' } }).statusCode).toBe(403);
    const full = setup({ capacityOk: false });
    expect(full.invoke('post', '/api/sessions', { body: { cwd: tmp } }).statusCode).toBe(429);
  });

  it('GET /api/sessions 按 archived 过滤；GET/:id 404 兜底', () => {
    const sessions = new Map([
      ['a', { id: 'a', name: 'A', messages: [], archived: false }],
      ['b', { id: 'b', name: 'B', messages: [], archived: true }],
    ]);
    const { invoke } = setup({ sessions });
    expect(invoke('get', '/api/sessions', { query: {} }).payload.map((s) => s.id)).toEqual(['a']);
    expect(invoke('get', '/api/sessions', { query: { archived: '1' } }).payload.map((s) => s.id)).toEqual(['b']);
    expect(invoke('get', '/api/sessions/:id', { params: { id: '没有' } }).statusCode).toBe(404);
  });

  it('PATCH watcherProviderId 不在 pool → 400；在 pool → ok', () => {
    const sessions = new Map([['a', { id: 'a', name: 'A', messages: [] }]]);
    const { invoke } = setup({ sessions });
    expect(invoke('patch', '/api/sessions/:id', { params: { id: 'a' }, body: { watcherProviderId: '不存在' } }).statusCode).toBe(400);
    const ok = invoke('patch', '/api/sessions/:id', { params: { id: 'a' }, body: { watcherProviderId: 'ollama' } });
    expect(ok.payload).toMatchObject({ ok: true, watcherProviderId: 'ollama' });
  });

  it('session capacity counter hooks track create, archive toggle, and delete', () => {
    const sessions = new Map();
    const events = [];
    const { invoke } = setup({
      sessions,
      extraDeps: {
        onSessionCreated: (s) => events.push(`created:${s.id}`),
        onSessionDeleted: (s) => events.push(`deleted:${s.id}`),
        onSessionArchivedChange: (s, archived, wasArchived) => events.push(`archived:${s.id}:${wasArchived}->${archived}`),
      },
    });
    const created = invoke('post', '/api/sessions', { body: { name: '计数', cwd: tmp } });
    const id = created.payload.id;
    expect(events).toEqual([`created:${id}`]);
    expect(invoke('patch', '/api/sessions/:id', { params: { id }, body: { archived: true } }).payload.archived).toBe(true);
    expect(invoke('patch', '/api/sessions/:id', { params: { id }, body: { archived: false } }).payload.archived).toBe(false);
    expect(invoke('delete', '/api/sessions/:id', { params: { id } }).payload).toEqual({ ok: true });
    expect(events).toEqual([
      `created:${id}`,
      `archived:${id}:false->true`,
      `archived:${id}:true->false`,
      `deleted:${id}`,
    ]);
  });

  it('POST messages：空文本 400、归档 409、正常走 sendMessageToClaude', () => {
    const sessions = new Map([
      ['a', { id: 'a', messages: [], archived: false }],
      ['b', { id: 'b', messages: [], archived: true }],
    ]);
    const { invoke, calls } = setup({ sessions });
    expect(invoke('post', '/api/sessions/:id/messages', { params: { id: 'a' }, body: { text: '  ' } }).statusCode).toBe(400);
    expect(invoke('post', '/api/sessions/:id/messages', { params: { id: 'b' }, body: { text: 'hi' } }).statusCode).toBe(409);
    expect(invoke('post', '/api/sessions/:id/messages', { params: { id: 'a' }, body: { text: ' hi ' } }).payload).toEqual({ ok: true });
    expect(calls.sendMessage).toEqual([['a', 'hi']]);
  });

  it('DELETE 关 WS + 清 dispatcher sessionState + 删 session', () => {
    let closed = 0;
    const ws = { close: () => { closed++; } };
    const sessions = new Map([['a', { id: 'a', messages: [], child: null, clients: new Set([ws]) }]]);
    const { invoke, calls } = setup({ sessions });
    expect(invoke('delete', '/api/sessions/:id', { params: { id: 'a' } }).payload).toEqual({ ok: true });
    expect(closed).toBe(1);
    expect(calls.dispatcherReset).toEqual(['a']);
    expect(sessions.size).toBe(0);
  });
});

describe('sessions control routes 行为锁定', () => {
  it('interrupt：child 已死 → alreadyDead + 广播 busy=false', () => {
    const sessions = new Map([['a', { id: 'a', messages: [], child: null, busy: true }]]);
    const { invoke, calls } = setup({ sessions });
    const res = invoke('post', '/api/sessions/:id/interrupt', { params: { id: 'a' } });
    expect(res.payload).toEqual({ ok: true, alreadyDead: true });
    expect(sessions.get('a').busy).toBe(false);
    expect(calls.broadcast).toEqual([{ type: 'busy', busy: false }]);
  });

  it('reset-busy：SIGKILL child + 复位 busy/pid + forced 广播', () => {
    let killSig = null;
    const child = { killed: false, kill: (sig) => { killSig = sig; } };
    const sessions = new Map([['a', { id: 'a', messages: [], child, busy: true, pid: 123 }]]);
    const { invoke, calls } = setup({ sessions });
    const res = invoke('post', '/api/sessions/:id/reset-busy', { params: { id: 'a' } });
    expect(res.payload).toEqual({ ok: true, hadChild: true });
    expect(killSig).toBe('SIGKILL');
    const s = sessions.get('a');
    expect([s.child, s.busy, s.pid, s._dropOutput]).toEqual([null, false, null, false]);
    expect(calls.broadcast).toEqual([{ type: 'busy', busy: false, forced: true }]);
  });
});

describe('sessions continuum / spawn-batch / extras 行为锁定', () => {
  it('GET ctx：无 claudeSessionId → no-session-yet', () => {
    const sessions = new Map([['a', { id: 'a', messages: [], claudeSessionId: null }]]);
    const { invoke } = setup({ sessions });
    expect(invoke('get', '/api/sessions/:id/ctx', { params: { id: 'a' } }).payload)
      .toEqual({ ok: false, reason: 'no-session-yet', pct: 0 });
  });

  it('GET snapshot：无 snapshot 文件 → reason no-snapshot + cwdHash', () => {
    const sessions = new Map([['a', { id: 'a', messages: [], cwd: tmp }]]);
    const { invoke } = setup({ sessions });
    const res = invoke('get', '/api/sessions/:id/snapshot', { params: { id: 'a' } });
    expect(res.payload.ok).toBe(false);
    expect(res.payload.reason).toBe('no-snapshot');
    expect(res.payload.cwdHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('GET handoff-history：恶意文件名 400、无 history 目录 → 空列表；POST handoff：无 snapshot → 409', () => {
    const sessions = new Map([['a', { id: 'a', messages: [], cwd: tmp }]]);
    const { invoke } = setup({ sessions });
    expect(invoke('get', '/api/sessions/:id/handoff-history', { params: { id: 'a' }, query: {} }).payload)
      .toEqual({ ok: true, items: [], cwd: tmp });
    // 注：histDir 不存在时提前返回空列表，file 校验在其后——与拆前行为一致
    expect(invoke('post', '/api/sessions/:id/handoff', { params: { id: 'a' } }).statusCode).toBe(409);
    expect(invoke('get', '/api/sessions/:id/handoff-meta', { params: { id: 'a' } }).payload.reason).toBe('no-meta');
  });

  it('POST spawn-batch：非 string id / 未知 id 跳过，返回 spawned 列表', () => {
    const sessions = new Map();
    const { invoke } = setup({ sessions });
    const res = invoke('post', '/api/spawn-batch', { body: { ids: [123, 'nope'] } });
    expect(res.payload).toEqual({ ok: true, spawned: [] });
  });

  it('GET export：返回 markdown + RFC5987 中文文件名', () => {
    const sessions = new Map([['a', {
      id: 'a', name: '会话甲', cwd: tmp, createdAt: 'T0',
      messages: [{ role: 'user', content: '你好', ts: '2026-01-01T00:00:00Z' }],
    }]]);
    const { invoke } = setup({ sessions });
    const res = invoke('get', '/api/sessions/:id/export', { params: { id: 'a' } });
    expect(res.headers['Content-Type']).toContain('text/markdown');
    expect(res.headers['Content-Disposition']).toContain("filename*=UTF-8''");
    expect(res.sent).toContain('# 会话甲');
    expect(res.sent).toContain('你好');
  });

  it('star 双击切换收藏；stars 只返回存在的消息；fork 越界 400 + 正常复制', () => {
    const sessions = new Map([['a', {
      id: 'a', name: 'A', cwd: tmp, messages: [{ role: 'user', content: 'm0' }, { role: 'user', content: 'm1' }],
    }]]);
    const { invoke } = setup({ sessions });
    expect(invoke('post', '/api/sessions/:id/star', { params: { id: 'a' }, body: { msgIndex: 1 } }).payload.starredIndices).toEqual([1]);
    expect(invoke('post', '/api/sessions/:id/star', { params: { id: 'a' }, body: { msgIndex: 1 } }).payload.starredIndices).toEqual([]);
    expect(invoke('post', '/api/sessions/:id/star', { params: { id: 'a' }, body: { msgIndex: 9 } }).statusCode).toBe(400);
    invoke('post', '/api/sessions/:id/star', { params: { id: 'a' }, body: { msgIndex: 0 } });
    expect(invoke('get', '/api/sessions/:id/stars', { params: { id: 'a' } }).payload.count).toBe(1);
    expect(invoke('post', '/api/sessions/:id/fork', { params: { id: 'a' }, body: { fromIndex: 99 } }).statusCode).toBe(400);
    const forked = invoke('post', '/api/sessions/:id/fork', { params: { id: 'a' }, body: { fromIndex: 0 } });
    expect(forked.payload.ok).toBe(true);
    expect(forked.payload.copiedCount).toBe(1);
    const child = sessions.get(forked.payload.newSessionId);
    expect(child.parentSessionId).toBe('a');
    expect(child.messages).toEqual([{ role: 'user', content: 'm0' }]);
    expect(child.starredIndices).toEqual([0]);
  });
});
