// @ts-check
// 回归：GeminiChatAdapter / MiniMaxChatAdapter 必须把截断 finishReason 映射成
// 与 OpenAICompatChatAdapter 一致的 incomplete 字段，且能被 SoloChatDispatcher
// 的 isIncompleteChatResult 识别。
//
// 修复前：两个 native adapter 的 _doChat 只返回 {reply,tokensIn,tokensOut,raw}，
// 不含任何 finishReason/incomplete 字段 → 下面 toMatchObject({incomplete:true,...})
// 全部失败、isIncompleteChatResult 全返回 false。修复后通过。
// 确定性：stub 全局 fetch，不触网、不依赖真实时钟（timeout 默认 0 不挂 timer）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiChatAdapter } from '../../src/room/GeminiChatAdapter.js';
import { MiniMaxChatAdapter } from '../../src/room/MiniMaxChatAdapter.js';
import { completionStatusForFinishReason } from '../../src/room/finishReason.js';

afterEach(() => vi.unstubAllGlobals());

// 复刻 SoloChatDispatcher.isIncompleteChatResult 的判定契约（保持与生产同口径）。
function isIncompleteChatResult(result = {}) {
  const finishReason = String(result.finishReason || result.finish_reason || '').trim().toLowerCase();
  const completionStatus = String(result.completionStatus || '').trim().toLowerCase();
  return result.incomplete === true
    || result.truncated === true
    || result.continuationRequired === true
    || completionStatus === 'incomplete_length'
    || finishReason === 'length'
    || finishReason === 'max_tokens';
}

describe('finishReason 共享映射', () => {
  it("'MAX_TOKENS'（Gemini 大写形态）lowercase 后命中 max_tokens 判定", () => {
    expect(completionStatusForFinishReason('MAX_TOKENS')).toMatchObject({
      finishReason: 'max_tokens',
      truncated: true,
      incomplete: true,
      continuationRequired: true,
      completionStatus: 'incomplete_length',
    });
  });

  it("'STOP' 视为正常完成", () => {
    expect(completionStatusForFinishReason('STOP')).toMatchObject({
      truncated: false,
      incomplete: false,
      completionStatus: 'complete',
    });
  });
});

describe('GeminiChatAdapter 截断标记', () => {
  it('finishReason=MAX_TOKENS 时标记 incomplete，可被 isIncompleteChatResult 识别', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '这是一段还没说完的' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 65536 },
      }),
    }));
    const a = new GeminiChatAdapter({ apiKey: 'k' });
    const r = await a._doChat([{ role: 'user', content: '写一篇超长报告' }], {});

    expect(r).toMatchObject({
      reply: '这是一段还没说完的',
      finishReason: 'max_tokens',
      truncated: true,
      incomplete: true,
      continuationRequired: true,
      completionStatus: 'incomplete_length',
    });
    expect(r.raw).toMatchObject({ incomplete: true, completionStatus: 'incomplete_length' });
    expect(isIncompleteChatResult(r)).toBe(true);
  });

  it('finishReason=STOP 时为完整结果，不误判 incomplete', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '完整回复。' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    }));
    const a = new GeminiChatAdapter({ apiKey: 'k' });
    const r = await a._doChat([{ role: 'user', content: '你好' }], {});

    expect(r).toMatchObject({ reply: '完整回复。', incomplete: false, completionStatus: 'complete' });
    expect(isIncompleteChatResult(r)).toBe(false);
  });

  it('MAX_TOKENS 导致正文为空时标 incomplete 返回，不再误抛 safety 拦截错误', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 65536 },
      }),
    }));
    const a = new GeminiChatAdapter({ apiKey: 'k' });
    const r = await a._doChat([{ role: 'user', content: '思考很久' }], {});

    expect(r).toMatchObject({ reply: '', incomplete: true, completionStatus: 'incomplete_length' });
    expect(isIncompleteChatResult(r)).toBe(true);
  });

  it('真·空 reply 且非截断（safety 拦截）仍抛错', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
        usageMetadata: {},
      }),
    }));
    const a = new GeminiChatAdapter({ apiKey: 'k' });
    await expect(a._doChat([{ role: 'user', content: 'hi' }], {})).rejects.toThrow(/响应空 reply/);
  });
});

describe('MiniMaxChatAdapter 截断标记', () => {
  it('finish_reason=length 时标记 incomplete，可被 isIncompleteChatResult 识别', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '半截被截断的输出' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 32768 },
      }),
    }));
    const a = new MiniMaxChatAdapter({ apiKey: 'k' });
    const r = await a._doChat([{ role: 'user', content: '写很长的内容' }], {});

    expect(r).toMatchObject({
      reply: '半截被截断的输出',
      finishReason: 'length',
      truncated: true,
      incomplete: true,
      continuationRequired: true,
      completionStatus: 'incomplete_length',
    });
    expect(r.raw).toMatchObject({ incomplete: true, completionStatus: 'incomplete_length' });
    expect(isIncompleteChatResult(r)).toBe(true);
  });

  it('finish_reason=stop 时为完整结果，不误判 incomplete', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '完整回复。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const a = new MiniMaxChatAdapter({ apiKey: 'k' });
    const r = await a._doChat([{ role: 'user', content: '你好' }], {});

    expect(r).toMatchObject({ reply: '完整回复。', incomplete: false, completionStatus: 'complete' });
    expect(isIncompleteChatResult(r)).toBe(false);
  });

  it('真·空 reply 且非截断仍抛错', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} }),
    }));
    const a = new MiniMaxChatAdapter({ apiKey: 'k' });
    await expect(a._doChat([{ role: 'user', content: 'hi' }], {})).rejects.toThrow(/响应空 reply/);
  });
});
