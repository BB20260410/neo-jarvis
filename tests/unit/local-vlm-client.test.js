import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalVlmClient } from '../../src/vision/LocalVlmClient.js';

afterEach(() => vi.unstubAllGlobals());

function okReply(content = '看到屏幕') {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function emptyReply() {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  };
}

describe('LocalVlmClient', () => {
  it('默认用主脑 Qwen 35B A3B VLM', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okReply('Qwen 看到了');
    });
    const client = new LocalVlmClient({
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    const text = await client.describeImages([{ buffer: Buffer.from('x'), format: 'png' }]);

    expect(text).toBe('Qwen 看到了');
    expect(ensured).toEqual(['qwen/qwen3.6-35b-a3b']);
    expect(bodies[0].model).toBe('qwen/qwen3.6-35b-a3b');
    expect(bodies[0]).toMatchObject({ max_tokens: 1200, temperature: 0.1, top_p: 0.9 });
    expect(client.lastUsedModel).toBe('qwen/qwen3.6-35b-a3b');
    expect(client.lastFallback).toBeNull();
  });

  it('Qwen 无回复时默认不 fallback 到其它 VLM', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      return emptyReply();
    });
    const client = new LocalVlmClient({
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    await expect(client.describeImages([{ buffer: Buffer.from('x'), format: 'png' }])).rejects.toThrow(/VLM 无回复/);

    expect(ensured).toEqual(['qwen/qwen3.6-35b-a3b']);
    expect(bodies.map((b) => b.model)).toEqual(['qwen/qwen3.6-35b-a3b']);
    expect(client.lastUsedModel).toBeNull();
    expect(client.lastFallback).toBeNull();
  });

  it('显式 Qwen VLM 模型保持 Qwen', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okReply('Qwen 看到了');
    });
    const client = new LocalVlmClient({
      model: 'qwen3-vl-8b-instruct-mlx',
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    await client.describeImages([{ buffer: Buffer.from('x'), format: 'png' }]);

    expect(ensured).toEqual(['qwen3-vl-8b-instruct-mlx']);
    expect(bodies.map((b) => b.model)).toEqual(['qwen3-vl-8b-instruct-mlx']);
  });

  it('显式 fallbackModel 才能做手动实验 fallback', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      return bodies.length === 1 ? emptyReply() : okReply('实验 fallback 看到了');
    });
    const client = new LocalVlmClient({
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    const text = await client.describeImages(
      [{ buffer: Buffer.from('x'), format: 'png' }],
      '看图',
      { fallbackModel: 'manual-experiment-vlm' },
    );

    expect(text).toBe('实验 fallback 看到了');
    expect(ensured).toEqual(['qwen/qwen3.6-35b-a3b', 'manual-experiment-vlm']);
    expect(bodies.map((b) => b.model)).toEqual(['qwen/qwen3.6-35b-a3b', 'manual-experiment-vlm']);
    expect(client.lastUsedModel).toBe('manual-experiment-vlm');
    expect(client.lastFallback).toMatchObject({ from: 'qwen/qwen3.6-35b-a3b', to: 'manual-experiment-vlm' });
  });

  it('显式指定 opts.model 时不隐式 fallback，避免调用者的模型选择被改写', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return emptyReply();
    });
    const client = new LocalVlmClient({
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    await expect(client.describeImages(
      [{ buffer: Buffer.from('x'), format: 'png' }],
      '看图',
      { model: 'custom-vlm' },
    )).rejects.toThrow(/VLM 无回复/);
    expect(ensured).toEqual(['custom-vlm']);
    expect(bodies.map((b) => b.model)).toEqual(['custom-vlm']);
  });

  it('fallbackModel=0 时 Qwen 失败也不加载其它模型', async () => {
    const ensured = [];
    const bodies = [];
    vi.stubGlobal('fetch', async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return emptyReply();
    });
    const client = new LocalVlmClient({
      fallbackModel: '0',
      ensureModel: async (model) => { ensured.push(model); return { ok: true }; },
    });

    await expect(client.describeImages([{ buffer: Buffer.from('x'), format: 'png' }])).rejects.toThrow(/VLM 无回复/);
    expect(ensured).toEqual(['qwen/qwen3.6-35b-a3b']);
    expect(bodies.map((b) => b.model)).toEqual(['qwen/qwen3.6-35b-a3b']);
  });
});
