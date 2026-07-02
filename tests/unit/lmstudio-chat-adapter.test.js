import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LmStudioChatAdapter } from '../../src/room/LmStudioChatAdapter.js';

afterEach(() => vi.unstubAllGlobals());

function jsonReply(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
}

function stubOpenAIReply(content = '你好') {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }));
}

describe('LmStudioChatAdapter', () => {
  it('默认生成参数使用 Main Brain 分层预算，不把 contextLength 当 max_tokens', async () => {
    let body = null;
    vi.stubGlobal('fetch', async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '在的' } }], usage: {} }) };
    });
    const a = new LmStudioChatAdapter({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen/qwen3.6-35b-a3b',
      ensureModel: async () => ({ ok: true }),
    });
    await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(body).toMatchObject({
      model: 'qwen/qwen3.6-35b-a3b',
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 8192,
      reasoning_effort: 'none',
    });
  });

  it('finish_reason=length 时标记 truncated/incomplete，不能当完整成功', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '还没说完' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 8192 },
      }),
    }));
    const a = new LmStudioChatAdapter({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen/qwen3.6-35b-a3b',
      ensureModel: async () => ({ ok: true }),
    });

    const r = await a._doChat([{ role: 'user', content: '继续做完整审计' }], {});

    expect(r).toMatchObject({
      reply: '还没说完',
      finishReason: 'length',
      truncated: true,
      incomplete: true,
      continuationRequired: true,
      completionStatus: 'incomplete_length',
    });
    expect(r.raw).toMatchObject({ incomplete: true, completionStatus: 'incomplete_length' });
  });

  it('finish_reason=length 且正文为空时标记 incomplete，不把 hidden reasoning 耗尽误判为 adapter 异常', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '', reasoning_content: 'hidden reasoning' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } },
      }),
    }));
    const a = new LmStudioChatAdapter({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen/qwen3.6-35b-a3b',
      ensureModel: async () => ({ ok: true }),
    });

    const r = await a._doChat([{ role: 'user', content: '继续做完整审计' }], {});

    expect(r).toMatchObject({
      reply: '',
      finishReason: 'length',
      incomplete: true,
      continuationRequired: true,
      completionStatus: 'incomplete_length',
    });
  });

  it('显式 reasoningEffort=max 时规范为后端支持的 xhigh，而不是发送非法 max', async () => {
    let body = null;
    vi.stubGlobal('fetch', async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '在的' } }], usage: {} }) };
    });
    const a = new LmStudioChatAdapter({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen/qwen3.6-35b-a3b',
      ensureModel: async () => ({ ok: true }),
    });

    await a._doChat([{ role: 'user', content: 'hi' }], { reasoningEffort: 'max' });

    expect(body.reasoning_effort).toBe('xhigh');
  });

  it('无显式 opts.model 时使用配置默认模型，不跟随当前 loaded 模型漂移', async () => {
    let ensured = '';
    stubOpenAIReply('在的');
    const a = new LmStudioChatAdapter({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio', model: 'qwen/qwen3.6-35b-a3b', ensureModel: async (m) => { ensured = m; return { ok: true }; }, currentLoaded: async () => 'manual-experiment-loaded-model' });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(ensured).toBe('qwen/qwen3.6-35b-a3b');
    expect(r.reply).toBe('在的');
  });

  it('调用前自助 ensureLoaded(用本次实际 model)，再发请求', async () => {
    const seen = [];
    stubOpenAIReply('在的');
    const a = new LmStudioChatAdapter({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio', model: 'gemma-default', ensureModel: async (m) => { seen.push(m); return { ok: true }; } });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(seen).toEqual(['gemma-default']);
    expect(r.reply).toBe('在的');
  });

  it('配置默认模型为 Qwen 时自动链路保持 Qwen', async () => {
    const seen = [];
    stubOpenAIReply('在的');
    const a = new LmStudioChatAdapter({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio', model: 'qwen/qwen3.6-35b-a3b', ensureModel: async (m) => { seen.push(m); return { ok: true }; } });
    await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(seen).toEqual(['qwen/qwen3.6-35b-a3b']);
  });

  it('opts.model 覆盖时 ensureLoaded 的是被选中的那个模型', async () => {
    const seen = [];
    stubOpenAIReply();
    const a = new LmStudioChatAdapter({
      id: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'gemma-default',
      ensureModel: async (m) => { seen.push(m); return { ok: true }; },
      currentLoaded: async () => '另一个已加载模型',
    });
    await a._doChat([{ role: 'user', content: 'hi' }], { model: 'qwen/qwen3.6-35b-a3b' });
    expect(seen).toEqual(['qwen/qwen3.6-35b-a3b']);
  });

  it('opts.model 普通显式实验仍按调用方传入模型执行', async () => {
    const seen = [];
    stubOpenAIReply();
    const a = new LmStudioChatAdapter({
      id: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'gemma-default',
      ensureModel: async (m) => { seen.push(m); return { ok: true }; },
    });
    await a._doChat([{ role: 'user', content: 'hi' }], { model: 'manual-experiment-vlm' });
    expect(seen).toEqual(['manual-experiment-vlm']);
  });

  it('opts.model 旧 Q35 mlx/8bit 别名会归一到当前主脑，避免误拉实验模型', async () => {
    const seen = [];
    let body = null;
    vi.stubGlobal('fetch', async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) };
    });
    const a = new LmStudioChatAdapter({
      id: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'gemma-default',
      ensureModel: async (m) => { seen.push(m); return { ok: true }; },
    });
    await a._doChat([{ role: 'user', content: 'hi' }], { model: 'qwen3.6-35b-a3b-mlx@8bit' });
    expect(seen).toEqual(['qwen/qwen3.6-35b-a3b']);
    expect(body.model).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('ensureLoaded 失败也不阻断请求(让真实请求 + 上层 fallback 决定)', async () => {
    stubOpenAIReply('兜底也能答');
    const a = new LmStudioChatAdapter({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio', model: 'gemma-x', ensureModel: async () => { throw new Error('加载失败'); } });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(r.reply).toBe('兜底也能答');
    expect(a._lastEnsure).toMatchObject({ ok: false });
  });

  it('lms load 参数通过构造透传给 ensureModel', async () => {
    let opts = null;
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) }));
    const a = new LmStudioChatAdapter({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'm',
      loadTtlSeconds: 900,
      loadContextLength: 262144,
      loadParallel: 4,
      ensureModel: async (_m, o) => { opts = o; return { ok: true }; },
    });
    await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(opts).toMatchObject({ baseUrl: 'http://127.0.0.1:1234/v1', ttlSeconds: 900, contextLength: 262144, parallel: 4 });
  });
});

describe('OpenAICompatChatAdapter 空 reply / 瞬时传输故障自动重试（治语音真耳 len=0）', () => {
  const ORIGINAL = process.env.NOE_LLM_EMPTY_RETRY;
  beforeEach(() => { delete process.env.NOE_LLM_EMPTY_RETRY; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NOE_LLM_EMPTY_RETRY;
    else process.env.NOE_LLM_EMPTY_RETRY = ORIGINAL;
    vi.restoreAllMocks();
  });

  function adapter() {
    return new LmStudioChatAdapter({
      id: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'qwen/qwen3.6-35b-a3b',
      ensureModel: async () => ({ ok: true }),
    });
  }

  it('首次空 reply、重试拿到非空 → 最终返回非空（默认重试开启）', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1 ? jsonReply('') : jsonReply('我在认真陪着你呢。');
    });
    const r = await adapter()._doChat([{ role: 'user', content: 'hi' }], {});
    expect(calls).toBe(2);
    expect(r.reply).toBe('我在认真陪着你呢。');
  });

  it('首次瞬时传输故障(fetch failed)、重试成功 → 最终返回非空', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonReply('已经恢复正常了。');
    });
    const r = await adapter()._doChat([{ role: 'user', content: 'hi' }], {});
    expect(calls).toBe(2);
    expect(r.reply).toBe('已经恢复正常了。');
  });

  it('连续两次空、第三次非空 → 默认 2 次重试(共 3 次尝试)兜住', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls < 3 ? jsonReply('') : jsonReply('第三次终于答上来了。');
    });
    const r = await adapter()._doChat([{ role: 'user', content: 'hi' }], {});
    expect(calls).toBe(3);
    expect(r.reply).toBe('第三次终于答上来了。');
  });

  it('NOE_LLM_EMPTY_RETRY=0 关闭重试 → 空 reply 直接抛、只发一次请求（保留旧行为）', async () => {
    process.env.NOE_LLM_EMPTY_RETRY = '0';
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls += 1; return jsonReply(''); });
    await expect(adapter()._doChat([{ role: 'user', content: 'hi' }], {})).rejects.toThrow(/响应空 reply/);
    expect(calls).toBe(1);
  });

  it('重试耗尽仍空 → 抛带 code 的空 reply 错误，供上层做错误归因', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls += 1; return jsonReply(''); });
    let caught = null;
    await adapter()._doChat([{ role: 'user', content: 'hi' }], {}).catch((e) => { caught = e; });
    expect(calls).toBe(3); // 1 + 2 retries
    expect(caught?.code).toBe('OPENAI_COMPAT_EMPTY_REPLY');
  });

  it('真实 HTTP 4xx 业务错误不重试（不是瞬时传输故障）', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls += 1; return { ok: false, status: 400, text: async () => 'bad request' }; });
    await expect(adapter()._doChat([{ role: 'user', content: 'hi' }], {})).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('finish_reason=length 的截断不算空 reply，不重试（保留 incomplete 语义）', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 8192 } }) };
    });
    const r = await adapter()._doChat([{ role: 'user', content: 'hi' }], {});
    expect(calls).toBe(1);
    expect(r).toMatchObject({ reply: '', incomplete: true, completionStatus: 'incomplete_length' });
  });

  it('流式(onDelta)分支不重试，交由上层 adapter 链兜底（避免重复早鸟 TTS 副作用）', async () => {
    let calls = 0;
    // 返回一个流式空响应（没有任何 content delta、无 finish_reason 完成态）→ 抛空 reply
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return {
        ok: true,
        body: (async function* () { yield new TextEncoder().encode('data: [DONE]\n'); })(),
      };
    });
    await expect(
      adapter()._doChat([{ role: 'user', content: 'hi' }], { onDelta: () => {} }),
    ).rejects.toThrow(/响应空 reply/);
    expect(calls).toBe(1); // 流式只发一次，不重试
  });
});
