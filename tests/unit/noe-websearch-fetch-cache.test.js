// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createWebSearch } from '../../src/research/WebSearch.js';
import { createPrefetchStore } from '../../src/prefetch/NoePrefetchStore.js';

const okHtml = () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<main><p>正文内容 abc def ghi</p></main>' });

describe('WebSearch.fetchContent × fetchCache (③A)', () => {
  it('OFF（无 fetchCache）：每次都抓（零回归）', async () => {
    let calls = 0;
    const ws = createWebSearch({ fetchImpl: async () => { calls += 1; return okHtml(); } });
    await ws.fetchContent('https://example.com/a');
    await ws.fetchContent('https://example.com/a');
    expect(calls).toBe(2);
  });

  it('ON 命中：同 URL+maxChars 第二次返缓存（只抓 1 次）', async () => {
    let calls = 0;
    const store = createPrefetchStore();
    const ws = createWebSearch({ fetchImpl: async () => { calls += 1; return okHtml(); }, fetchCache: store });
    const r1 = await ws.fetchContent('https://example.com/a', { maxChars: 1000 });
    const r2 = await ws.fetchContent('https://example.com/a', { maxChars: 1000 });
    expect(calls).toBe(1); // 第二次命中缓存，未再抓
    expect(r2).toEqual(r1);
    expect(r2.ok).toBe(true);
  });

  it('失败不缓存：HTTP 500 两次都抓（避缓存毒化）', async () => {
    let calls = 0;
    const store = createPrefetchStore();
    const ws = createWebSearch({ fetchImpl: async () => { calls += 1; return { ok: false, status: 500, headers: { get: () => '' } }; }, fetchCache: store });
    await ws.fetchContent('https://example.com/a');
    await ws.fetchContent('https://example.com/a');
    expect(calls).toBe(2);
  });

  it('maxChars 隔离：同 URL 不同 maxChars 各抓一次（避截断不一致）', async () => {
    let calls = 0;
    const store = createPrefetchStore();
    const ws = createWebSearch({ fetchImpl: async () => { calls += 1; return okHtml(); }, fetchCache: store });
    await ws.fetchContent('https://example.com/a', { maxChars: 500 });
    await ws.fetchContent('https://example.com/a', { maxChars: 1000 });
    expect(calls).toBe(2);
  });
});
