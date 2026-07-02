// @ts-check
// S23：term 路由从 server.js 提取后的行为锁定测试（假 pty，不起真 shell）
import { describe, expect, it } from 'vitest';
import { registerTermRoutes } from '../../../src/server/routes/term.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  }
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
  };
}

function makeFakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(shell, args, opts) {
      const term = {
        pid: 12345, shell, opts,
        killed: false,
        kill() { this.killed = true; },
        onData() {}, onExit() {},
      };
      spawned.push(term);
      return term;
    },
  };
}

function setup() {
  const { app, routes } = makeApp();
  const pty = makeFakePty();
  const { terminals } = registerTermRoutes(app, {
    pty,
    safeResolveFsPath: (p) => (p.startsWith('/safe') ? p : null),
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
  });
  const invoke = (method, path, req) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    const res = makeRes();
    r.handlers[r.handlers.length - 1](req, res);
    return res;
  };
  return { invoke, terminals, pty };
}

describe('term routes (S23 提取)', () => {
  it('创建终端：非法 shell 回退 /bin/zsh，越权 cwd 回退 home，terminals Map 同步', () => {
    const { invoke, terminals } = setup();
    const res = invoke('post', '/api/term', { body: { shell: '/bin/evil', cwd: '/etc' } });
    expect(res.payload.ok).toBe(true);
    expect(res.payload.shell).toBe('/bin/zsh');
    expect(res.payload.cwd).not.toBe('/etc');
    expect(terminals.size).toBe(1);
    expect(terminals.get(res.payload.termId).approvalInputBuffer).toBe('');
  });

  it('GET /api/term 列表与 DELETE 清理（kill + 关 ws + 出 Map）', () => {
    const { invoke, terminals } = setup();
    const { payload } = invoke('post', '/api/term', { body: {} });
    const listed = invoke('get', '/api/term', {});
    expect(listed.payload).toHaveLength(1);
    expect(listed.payload[0].id).toBe(payload.termId);

    let wsClosed = false;
    terminals.get(payload.termId).clients.add({ close() { wsClosed = true; } });
    const del = invoke('delete', '/api/term/:id', { params: { id: payload.termId } });
    expect(del.payload).toEqual({ ok: true });
    expect(terminals.size).toBe(0);
    expect(wsClosed).toBe(true);

    expect(invoke('delete', '/api/term/:id', { params: { id: 'nope' } }).statusCode).toBe(404);
  });

  it('达到 20 个上限 → 429', () => {
    const { invoke } = setup();
    for (let i = 0; i < 20; i++) expect(invoke('post', '/api/term', { body: {} }).payload.ok).toBe(true);
    expect(invoke('post', '/api/term', { body: {} }).statusCode).toBe(429);
  });
});
