// @ts-check
// S23：files/file/browse/search 路由从 server.js 提取后的行为锁定测试
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerFilesRoutes } from '../../../src/server/routes/files.js';

const tmp = mkdtempSync(join(tmpdir(), 'noe-files-routes-'));
writeFileSync(join(tmp, 'a.txt'), 'hello 文本');
writeFileSync(join(tmp, 'bin.dat'), Buffer.from([1, 2, 0, 4]));
mkdirSync(join(tmp, 'sub'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(sessions = new Map()) {
  const routes = [];
  const app = { get: (path, ...handlers) => routes.push({ path, handlers }) };
  registerFilesRoutes(app, {
    safeResolveFsPath: (p) => (String(p).startsWith(tmp) ? String(p) : null),
    send500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
    sessions,
  });
  const invoke = (path, req) => {
    const r = routes.find((x) => x.path === path);
    const res = {
      statusCode: 200, payload: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.payload = b; return this; },
    };
    r.handlers[r.handlers.length - 1](req, res);
    return res;
  };
  return { invoke };
}

describe('files routes (S23 提取)', () => {
  it('GET /api/files 列目录（目录优先排序），越权 403，文件 400', () => {
    const { invoke } = setup();
    const res = invoke('/api/files', { query: { path: tmp } });
    expect(res.payload.items.map((i) => i.name)).toEqual(['sub', 'a.txt', 'bin.dat']);
    expect(invoke('/api/files', { query: { path: '/etc' } }).statusCode).toBe(403);
    expect(invoke('/api/files', { query: { path: join(tmp, 'a.txt') } }).statusCode).toBe(400);
  });

  it('GET /api/file 读文本；二进制（NUL）→ 415', () => {
    const { invoke } = setup();
    const ok = invoke('/api/file', { query: { path: join(tmp, 'a.txt') } });
    expect(ok.payload.content).toBe('hello 文本');
    expect(invoke('/api/file', { query: { path: join(tmp, 'bin.dat') } }).statusCode).toBe(415);
  });

  it('GET /api/browse 只列子目录', () => {
    const { invoke } = setup();
    const res = invoke('/api/browse', { query: { path: tmp } });
    expect(res.payload.items).toEqual([{ name: 'sub', path: join(tmp, 'sub'), isDir: true }]);
  });

  it('GET /api/search 跨 session 命中、归档默认排除、空 q → 400', () => {
    const sessions = new Map([
      ['s1', { id: 's1', name: '甲', cwd: '/x', messages: [{ role: 'user', content: '找到 needle 了', ts: '2026-01-02' }] }],
      ['s2', { id: 's2', name: '乙', cwd: '/y', archived: true, messages: [{ role: 'user', content: 'needle 在归档', ts: '2026-01-03' }] }],
    ]);
    const { invoke } = setup(sessions);
    const res = invoke('/api/search', { query: { q: 'needle' } });
    expect(res.payload.count).toBe(1);
    expect(res.payload.hits[0].sessionId).toBe('s1');
    const withArchived = invoke('/api/search', { query: { q: 'needle', includeArchived: '1' } });
    expect(withArchived.payload.count).toBe(2);
    expect(withArchived.payload.hits[0].sessionId).toBe('s2'); // ts 倒序，最近优先
    expect(invoke('/api/search', { query: {} }).statusCode).toBe(400);
  });
});
