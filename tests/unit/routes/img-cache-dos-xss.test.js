// B1.4 资源/DoS + SVG 存储型 XSS 防护测试
//
// 复现并钉死两个漏洞：
// 1. 资源/DoS(high)：远端缺失/伪造 Content-Length 时，旧实现直接 await resp.arrayBuffer()
//    无界缓冲 → 单请求可拖垮内存（OOM）。修复后必须流式读取 + 累计字节超 MAX_FILE_SIZE
//    立即中止，不依赖 Content-Length 头。
// 2. SVG(image/svg+xml) 缓存回放存储型 XSS(high)：endpoint 在同源 51835 上，若以
//    image/svg+xml 顶级文档渲染会执行内嵌 <script>。修复后 SVG 回放必须带
//    Content-Disposition: attachment + CSP(script-src 'none'; sandbox) + nosniff，
//    使浏览器即使直接访问也不执行脚本（<img> 加载 SVG 不受影响，图片仍显示）。
//
// 隔离：vi.mock node:os 把 homedir 指向临时目录，绝不污染真实 ~/.noe-panel。

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const TMP = mkdtempSync(join(tmpdir(), 'imgcache-dosxss-'));

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => TMP, default: { ...actual, homedir: () => TMP } };
});

let registerImgCacheRoutes;
let server;
let baseUrl;
const realFetch = global.fetch;

// 把一段二进制按 chunk 切成一个 web ReadableStream-like body（带 getReader）
function makeStreamBody(chunks) {
  let i = 0;
  return {
    getReader() {
      let cancelled = false;
      return {
        async read() {
          if (cancelled || i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i];
          i += 1;
          return { done: false, value };
        },
        cancel() { cancelled = true; return Promise.resolve(); },
        releaseLock() {},
      };
    },
  };
}

// 构造一个 mock Response。headersObj 大小写不敏感。
// 关键：默认 arrayBuffer() 抛错——强制被测实现走流式 body.getReader()，
// 而不是退回 await resp.arrayBuffer() 的无界全缓冲（即被修复的 DoS 漏洞本身）。
function mockResponse({ status = 200, ok = true, headers = {}, chunks = null, allowArrayBuffer = false }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const body = chunks ? makeStreamBody(chunks) : null;
  return {
    status,
    ok,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[String(k).toLowerCase()] : null) },
    body,
    arrayBuffer: async () => {
      if (!allowArrayBuffer) throw new Error('arrayBuffer() must not be called — stream the body instead (DoS guard)');
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out.buffer;
    },
  };
}

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
  global.fetch = realFetch;
});

function imgUrl(target) {
  return `${baseUrl}/api/img-cache?url=${encodeURIComponent(target)}`;
}

const MAX_FILE_SIZE = 8 * 1024 * 1024;

describe('B1.4 资源/DoS：Content-Length 缺失/伪造时流式上限', () => {
  it('Content-Length 缺失但真实体超上限 → 流式累计中止，返 413，不全缓冲', async () => {
    // 没有 content-length 头；真实体 = 9MB（>8MB），分块流出
    const oneMB = new Uint8Array(1024 * 1024).fill(7);
    const chunks = Array.from({ length: 9 }, () => oneMB);
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/png' }, // 故意不带 content-length
      chunks,
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/huge-no-len.png'));
    expect(r.status).toBe(413);
  });

  it('Content-Length 伪造为小值但真实体超上限 → 仍按真实字节中止，返 413', async () => {
    const oneMB = new Uint8Array(1024 * 1024).fill(7);
    const chunks = Array.from({ length: 9 }, () => oneMB);
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/png', 'content-length': '3' }, // 撒谎说只有 3 字节
      chunks,
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/huge-fake-len.png'));
    expect(r.status).toBe(413);
  });

  it('Content-Length 声明超上限 → 早拒 413（不下载体）', async () => {
    let bodyRead = false;
    global.fetch = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: (k) => ({ 'content-type': 'image/png', 'content-length': String(MAX_FILE_SIZE + 1) }[String(k).toLowerCase()] || null) },
      get body() { bodyRead = true; return makeStreamBody([new Uint8Array([1])]); },
      arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(1); },
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/declared-huge.png'));
    expect(r.status).toBe(413);
    expect(bodyRead).toBe(false); // 头就拒了，没碰 body
  });

  it('正常小图（无 content-length，流式）→ 200 且字节正确', async () => {
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/png' },
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/small-stream.png'));
    expect(r.status).toBe(200);
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });
});

describe('B1.4 SVG 存储型 XSS 防护', () => {
  const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/api/secret')</script></svg>`;

  it('MISS-DL 下载 SVG → 回放带 attachment + CSP(script-src none/sandbox) + nosniff', async () => {
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/svg+xml' },
      chunks: [new TextEncoder().encode(EVIL_SVG)],
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/evil-miss.svg'));
    expect(r.status).toBe(200);
    expect((r.headers.get('content-disposition') || '').toLowerCase()).toContain('attachment');
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain('sandbox');
    expect((r.headers.get('x-content-type-options') || '').toLowerCase()).toBe('nosniff');
  });

  it('HIT 回放 SVG（二次请求走缓存）→ 同样带 attachment + CSP + nosniff', async () => {
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/svg+xml' },
      chunks: [new TextEncoder().encode(EVIL_SVG)],
    }));
    // 先 MISS 建缓存
    await realFetch(imgUrl('http://1.1.1.1/evil-hit.svg'));
    // 再请求 → HIT
    const r = await realFetch(imgUrl('http://1.1.1.1/evil-hit.svg'));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-img-cache')).toBe('HIT');
    expect((r.headers.get('content-disposition') || '').toLowerCase()).toContain('attachment');
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain('sandbox');
    expect((r.headers.get('x-content-type-options') || '').toLowerCase()).toBe('nosniff');
  });

  it('非 SVG 图片（png）回放不加 attachment（不影响正常 <img> 显示）', async () => {
    global.fetch = vi.fn(async () => mockResponse({
      headers: { 'content-type': 'image/png' },
      chunks: [new Uint8Array([1, 2, 3])],
    }));
    const r = await realFetch(imgUrl('http://1.1.1.1/normal.png'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBeNull();
  });
});
