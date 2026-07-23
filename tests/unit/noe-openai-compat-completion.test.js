import { describe, it, expect } from 'vitest';
import { createCompletionCapability, COMPLETION_MODE } from '../../src/room/OpenAICompatCompletion.js';

// 造一个可脚本化的 fetch mock：按 url 返回不同响应，记录每次请求体。
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: init?.headers });
    return handler({ url: String(url), body, init });
  };
  fn.calls = calls;
  return fn;
}
function jsonResp(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

describe('createCompletionCapability —— 端点探测 + 回退', () => {
  it('probe：/completions 返回 200 → RAW 模式', async () => {
    const fetchImpl = mockFetch(() => jsonResp({ choices: [{ text: 'ok' }] }));
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl, probeTimeoutMs: 0 });
    expect(await cap.probe()).toBe(COMPLETION_MODE.RAW);
  });

  it('probe：/completions 返回 404 → 回退 CHAT_PREFIX', async () => {
    const fetchImpl = mockFetch(() => jsonResp({ error: 'no such endpoint' }, 404));
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl, probeTimeoutMs: 0 });
    expect(await cap.probe()).toBe(COMPLETION_MODE.CHAT_PREFIX);
  });

  it('probe：端点存在但模型名非法报 400 → 仍判 RAW（端点存在即可，续写时用真模型名）', async () => {
    const fetchImpl = mockFetch(() => jsonResp({ error: 'model not found' }, 400));
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl, probeTimeoutMs: 0 });
    expect(await cap.probe()).toBe(COMPLETION_MODE.RAW);
  });

  it('RAW 续写：打 /completions，prompt 原样带上，解析 choices[0].text + hitStop', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      expect(url).toContain('/completions');
      return jsonResp({ choices: [{ text: '继续的思考', finish_reason: 'stop' }], usage: { completion_tokens: 7 } });
    });
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl });
    cap.setMode(COMPLETION_MODE.RAW);
    const r = await cap.complete({ prompt: 'PFX<think>想了一半', model: 'q', stop: ['</think>'], maxTokens: 100 });
    expect(r.text).toBe('继续的思考');
    expect(r.hitStop).toBe(true);
    expect(r.via).toBe(COMPLETION_MODE.RAW);
    expect(r.tokensOut).toBe(7);
    // prompt 必须原样进 body（续写本质）
    const last = fetchImpl.calls[fetchImpl.calls.length - 1];
    expect(last.body.prompt).toBe('PFX<think>想了一半');
    expect(last.body.stop).toEqual(['</think>']);
  });

  it('不打印 secret：Authorization 带 apiKey，但返回值里没有 key', async () => {
    const fetchImpl = mockFetch(() => jsonResp({ choices: [{ text: 'x' }] }));
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', apiKey: 'sk-supersecret', fetchImpl });
    cap.setMode(COMPLETION_MODE.RAW);
    const r = await cap.complete({ prompt: 'p', model: 'q' });
    expect(fetchImpl.calls[0].headers.Authorization).toBe('Bearer sk-supersecret');
    expect(JSON.stringify(r)).not.toContain('sk-supersecret');
  });

  it('CHAT_PREFIX 回退：prefix 作为末尾 assistant 消息 + priorMessages 在前', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      expect(url).toContain('/chat/completions');
      return jsonResp({ choices: [{ message: { content: '续写片段' }, finish_reason: 'stop' }] });
    });
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl });
    cap.setMode(COMPLETION_MODE.CHAT_PREFIX);
    const r = await cap.complete({
      prompt: '<think>半截', model: 'q', stop: ['</think>'],
      priorMessages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    });
    expect(r.text).toBe('续写片段');
    expect(r.via).toBe(COMPLETION_MODE.CHAT_PREFIX);
    const msgs = fetchImpl.calls[fetchImpl.calls.length - 1].body.messages;
    expect(msgs[0]).toEqual({ role: 'system', content: 'S' });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'assistant', content: '<think>半截' });
  });

  it('RAW 运行期失效（500）→ 自动降级 chat-prefix 并记住模式，下次直接走回退', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.includes('/completions') && !url.includes('/chat/')) return jsonResp({ error: 'boom' }, 500);
      return jsonResp({ choices: [{ message: { content: 'fallback' }, finish_reason: 'stop' }] });
    });
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl, log: { warn() {} } });
    cap.setMode(COMPLETION_MODE.RAW);
    const r1 = await cap.complete({ prompt: 'p', model: 'q' });
    expect(r1.text).toBe('fallback');
    expect(cap.currentMode()).toBe(COMPLETION_MODE.CHAT_PREFIX);
    // 第二次：已记成 CHAT_PREFIX，不应再打 /completions
    fetchImpl.calls.length = 0;
    await cap.complete({ prompt: 'p2', model: 'q' });
    expect(fetchImpl.calls.every((c) => c.url.includes('/chat/completions'))).toBe(true);
  });

  it('chat-prefix 非 2xx 抛错（让上层 fail-open 回退普通深思）', async () => {
    const fetchImpl = mockFetch(() => jsonResp({ error: 'down' }, 503));
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl });
    cap.setMode(COMPLETION_MODE.CHAT_PREFIX);
    await expect(cap.complete({ prompt: 'p', model: 'q' })).rejects.toThrow(/503/);
  });

  it('缺 baseUrl 立即抛；complete 缺 model 立即抛', async () => {
    expect(() => createCompletionCapability({ baseUrl: '' })).toThrow(/baseUrl/);
    const cap = createCompletionCapability({ baseUrl: 'http://x/v1', fetchImpl: mockFetch(() => jsonResp({})) });
    cap.setMode(COMPLETION_MODE.RAW);
    await expect(cap.complete({ prompt: 'p' })).rejects.toThrow(/model/);
  });
});
