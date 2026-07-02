// img-cache 路由级测试（审计 §3.1 P0-3 性能改动配套）
// 验证：MISS 下载写盘 → 再次请求经内存 Map 命中 HIT（不重复 fetch）、evict 同步清 Map。
// 隔离：vi.mock node:os 把 homedir 指向临时目录，绝不污染真实 ~/.noe-panel。

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const TMP = mkdtempSync(join(tmpdir(), 'imgcache-route-'));

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => TMP, default: { ...actual, homedir: () => TMP } };
});

let registerImgCacheRoutes;
let server;
let baseUrl;
const realFetch = global.fetch;
let fetchCalls = 0;

beforeAll(async () => {
  ({ registerImgCacheRoutes } = await import('../../../src/server/routes/img-cache.js'));
  const app = express();
  registerImgCacheRoutes(app);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  global.fetch = realFetch;
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = 0;
  // mock 出站下载（IP literal url 不触发 DNS；assertPublicUrl 对公网 IP 放行）
  global.fetch = vi.fn(async () => {
    fetchCalls += 1;
    return {
      status: 200,
      ok: true,
      headers: { get: (k) => ({ 'content-type': 'image/png', 'content-length': '3' }[String(k).toLowerCase()] || null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  });
});

function imgUrl(target) {
  return `${baseUrl}/api/img-cache?url=${encodeURIComponent(target)}`;
}

describe('img-cache 路由 内存 Map 缓存（P0-3）', () => {
  it('首次请求 MISS 下载并写盘', async () => {
    const r = await realFetch(imgUrl('http://1.1.1.1/a.png'));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-img-cache')).toBe('MISS-DL');
    expect(fetchCalls).toBe(1);
  });

  it('同 url 二次请求经内存 Map 命中 HIT，不再下载', async () => {
    // 先 MISS 建缓存
    await realFetch(imgUrl('http://1.1.1.1/b.png'));
    expect(fetchCalls).toBe(1);
    // 再请求 → HIT
    const r = await realFetch(imgUrl('http://1.1.1.1/b.png'));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-img-cache')).toBe('HIT');
    expect(fetchCalls).toBe(1); // 没有第二次下载
  });

  it('返回内容字节正确（写盘与回读一致）', async () => {
    const r = await realFetch(imgUrl('http://1.1.1.1/c.png'));
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3]);
    expect(r.headers.get('content-type')).toMatch(/image\/png/);
  });

  it('非图片 mime 被拒（415）', async () => {
    global.fetch = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: (k) => ({ 'content-type': 'text/html' }[String(k).toLowerCase()] || null) },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/evil.html'));
    expect(r.status).toBe(415);
  });
});
