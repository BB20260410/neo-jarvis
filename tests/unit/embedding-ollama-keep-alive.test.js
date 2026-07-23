// keep_alive 透传：让 Ollama embedding 模型常驻，根治按需唤醒间歇失效
// （reference_ollama_ondemand_embedding_failure）。验证 NOE_OLLAMA_KEEP_ALIVE flag 正确进 request body。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  embed,
  ollamaEmbed,
  resolveOllamaKeepAlive,
} from '../../src/embeddings/EmbeddingProvider.js';
import { probeOllamaEmbeddingModel } from '../../src/memory/NoeMemoryCopyValidation.js';

const OK_EMBED = {
  ok: true,
  status: 200,
  json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4] }),
};

/** 捕获最后一次 fetch 的 body（解析成对象）。 */
function captureFetch(response = OK_EMBED) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return response;
  });
  return { fn, calls, lastBody: () => calls.at(-1)?.body };
}

describe('resolveOllamaKeepAlive', () => {
  it('未设 NOE_OLLAMA_KEEP_ALIVE + 未显式传 → 默认 -1（常驻治本）', () => {
    expect(resolveOllamaKeepAlive(undefined, {})).toBe(-1);
  });

  it('显式传入优先于 env', () => {
    expect(resolveOllamaKeepAlive('5m', { NOE_OLLAMA_KEEP_ALIVE: '-1' })).toBe('5m');
  });

  it('env 提供时按 env（显式未传）', () => {
    expect(resolveOllamaKeepAlive(undefined, { NOE_OLLAMA_KEEP_ALIVE: '10m' })).toBe('10m');
    expect(resolveOllamaKeepAlive(undefined, { NOE_OLLAMA_KEEP_ALIVE: '300' })).toBe(300);
  });

  it('off 类值（0/off/false/none/default）→ undefined（不传字段，回 Ollama 默认 5min）', () => {
    for (const v of ['0', 'off', 'OFF', 'false', 'no', 'none', 'disabled', 'default', 'unset']) {
      expect(resolveOllamaKeepAlive(v, {})).toBeUndefined();
    }
    expect(resolveOllamaKeepAlive(undefined, { NOE_OLLAMA_KEEP_ALIVE: '0' })).toBeUndefined();
  });

  it('纯整数字符串归一成 number，时长字符串原样透传', () => {
    expect(resolveOllamaKeepAlive('-1', {})).toBe(-1);
    expect(resolveOllamaKeepAlive('600', {})).toBe(600);
    expect(resolveOllamaKeepAlive('10m', {})).toBe('10m');
    expect(resolveOllamaKeepAlive('1h', {})).toBe('1h');
  });

  it('空字符串 / null 回落默认 -1', () => {
    expect(resolveOllamaKeepAlive('', {})).toBe(-1);
    expect(resolveOllamaKeepAlive(null, { NOE_OLLAMA_KEEP_ALIVE: '   ' })).toBe(-1);
  });
});

describe('ollamaEmbed keep_alive 进 request body', () => {
  let savedFetch;
  let savedEnv;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedEnv = process.env.NOE_OLLAMA_KEEP_ALIVE;
    delete process.env.NOE_OLLAMA_KEEP_ALIVE;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.NOE_OLLAMA_KEEP_ALIVE;
    else process.env.NOE_OLLAMA_KEEP_ALIVE = savedEnv;
  });

  it('flag 未设 → body 带 keep_alive=-1（默认常驻）', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await ollamaEmbed('hello', { model: 'qwen3-embedding:0.6b', baseUrl: 'http://127.0.0.1:11434' });
    expect(cap.calls.at(-1).url).toBe('http://127.0.0.1:11434/api/embeddings');
    const body = cap.lastBody();
    expect(body).toMatchObject({ model: 'qwen3-embedding:0.6b', prompt: 'hello', keep_alive: -1 });
  });

  it('显式 keepAlive=5m → body 带 keep_alive=5m', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await ollamaEmbed('hi', { keepAlive: '5m' });
    expect(cap.lastBody()).toMatchObject({ prompt: 'hi', keep_alive: '5m' });
  });

  it('NOE_OLLAMA_KEEP_ALIVE=10m（env）→ body 带 keep_alive=10m', async () => {
    process.env.NOE_OLLAMA_KEEP_ALIVE = '10m';
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await ollamaEmbed('hi');
    expect(cap.lastBody().keep_alive).toBe('10m');
  });

  it('NOE_OLLAMA_KEEP_ALIVE=0（关）→ body 不含 keep_alive 字段', async () => {
    process.env.NOE_OLLAMA_KEEP_ALIVE = '0';
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await ollamaEmbed('hi');
    const body = cap.lastBody();
    expect(body).toMatchObject({ prompt: 'hi' });
    expect('keep_alive' in body).toBe(false);
  });

  it('显式 keepAlive=off → 不含 keep_alive 字段', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await ollamaEmbed('hi', { keepAlive: 'off' });
    expect('keep_alive' in cap.lastBody()).toBe(false);
  });
});

describe('embed() 将 keepAlive 透传到 ollama 路径', () => {
  let savedFetch;
  let savedEnv;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedEnv = process.env.NOE_OLLAMA_KEEP_ALIVE;
    delete process.env.NOE_OLLAMA_KEEP_ALIVE;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.NOE_OLLAMA_KEEP_ALIVE;
    else process.env.NOE_OLLAMA_KEEP_ALIVE = savedEnv;
  });

  it('provider=ollama 默认带 keep_alive=-1', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    const out = await embed('q', { provider: 'ollama', model: 'm', baseUrl: 'http://x' });
    expect(out.provider).toBe('ollama');
    expect(cap.lastBody().keep_alive).toBe(-1);
  });

  it('provider=ollama + 显式 keepAlive 透传', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    await embed('q', { provider: 'ollama', baseUrl: 'http://x', keepAlive: '7m' });
    expect(cap.lastBody().keep_alive).toBe('7m');
  });

  it('provider=hash 不触发任何 fetch（不受 keep_alive 影响，离线兜底路径不变）', async () => {
    const cap = captureFetch();
    globalThis.fetch = cap.fn;
    const out = await embed('q', { provider: 'hash' });
    expect(out.provider).toBe('hash');
    expect(cap.fn).not.toHaveBeenCalled();
  });

  it('ollama fetch 失败 → 退 hash-fallback（keep_alive 不影响 fallback）', async () => {
    const cap = captureFetch({ ok: false, status: 500, json: async () => ({}) });
    globalThis.fetch = cap.fn;
    const out = await embed('q', { provider: 'ollama', baseUrl: 'http://x' });
    expect(out.fallback).toBe(true);
    expect(out.provider).toBe('hash-fallback');
    // 仍然尝试过带 keep_alive 的请求
    expect(cap.lastBody().keep_alive).toBe(-1);
  });
});

describe('probeOllamaEmbeddingModel keep_alive', () => {
  function mkProbeFetch({ tagsModels = ['qwen3-embedding:0.6b'], embedDim = 4 } = {}) {
    const calls = [];
    const fn = vi.fn(async (url, opts) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: tagsModels.map((name) => ({ name })) }) };
      }
      return { ok: true, json: async () => ({ embedding: Array.from({ length: embedDim }, (_, i) => i + 1) }) };
    });
    return { fn, embedBody: () => calls.find((c) => String(c.url).endsWith('/api/embeddings'))?.body };
  }

  it('默认（keepAlive 未传）probe embed body 带 keep_alive=-1', async () => {
    const saved = process.env.NOE_OLLAMA_KEEP_ALIVE;
    delete process.env.NOE_OLLAMA_KEEP_ALIVE;
    try {
      const m = mkProbeFetch();
      const out = await probeOllamaEmbeddingModel({ model: 'qwen3-embedding:0.6b', fetchImpl: m.fn });
      expect(out.ok).toBe(true);
      expect(m.embedBody().keep_alive).toBe(-1);
    } finally {
      if (saved === undefined) delete process.env.NOE_OLLAMA_KEEP_ALIVE;
      else process.env.NOE_OLLAMA_KEEP_ALIVE = saved;
    }
  });

  it('显式 keepAlive=off → probe embed body 不含 keep_alive', async () => {
    const m = mkProbeFetch();
    const out = await probeOllamaEmbeddingModel({ model: 'qwen3-embedding:0.6b', keepAlive: 'off', fetchImpl: m.fn });
    expect(out.ok).toBe(true);
    expect('keep_alive' in m.embedBody()).toBe(false);
  });
});
