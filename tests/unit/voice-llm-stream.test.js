// LLM 流式早鸟 TTS（方向三·语音延迟终局）：大脑边吐字边检首句并行合成，收尾对账防放错音频。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createEarlySentenceDetector } from '../../src/voice/VoiceStreamEarlyTts.js';
import { OllamaChatAdapter } from '../../src/room/OllamaChatAdapter.js';
import { OpenAICompatChatAdapter } from '../../src/room/OpenAICompatChatAdapter.js';
import { LmStudioChatAdapter } from '../../src/room/LmStudioChatAdapter.js';
import { VoiceSession, splitFirstSentence } from '../../src/voice/VoiceSession.js';

afterEach(() => vi.unstubAllGlobals());

describe('createEarlySentenceDetector 首句探测（与 splitFirstSentence 同口径）', () => {
  it('首句成形即返回，且与最终 splitFirstSentence(全文).first 逐字一致', () => {
    const full = '今天天气很好，适合出门散步。要不要我帮你查一下附近公园的人流情况，顺便提醒你带伞？';
    const d = createEarlySentenceDetector();
    let got = null;
    for (const ch of full) { const r = d.push(ch); if (r) { got = r; break; } }
    expect(got).toBe(splitFirstSentence(full).first);
  });

  it('凑不够 40 字不触发（短回复走整段旧路）', () => {
    const d = createEarlySentenceDetector();
    expect(d.push('好的。马上来')).toBeNull();
    expect(d.sentence()).toBeNull();
  });

  it('首句不足 6 字不在碎句上开播', () => {
    const d = createEarlySentenceDetector();
    const r = d.push('嗯。' + '后面是一大段足够长的内容继续说下去说够四十个字符的长度要求再多说几个字');
    expect(r === null || r.length >= 6).toBe(true);
  });

  it('reasoning 泄漏（<think / harmony 标记）→ 永久放弃早鸟', () => {
    const d = createEarlySentenceDetector();
    expect(d.push('<think>用户在问天气，我应该先分析一下他的意图再决定怎么回答比较好。')).toBeNull();
    expect(d.push('今天天气很好，适合出门散步。要不要我帮你查一下附近公园的人流情况？')).toBeNull();
  });

  it('只触发一次（首句已成形后续 push 恒 null）', () => {
    const full = '今天天气很好，适合出门散步。要不要我帮你查一下附近公园的人流情况，顺便提醒你带伞？';
    const d = createEarlySentenceDetector();
    const fired = [];
    for (const ch of full) { const r = d.push(ch); if (r) fired.push(r); }
    expect(fired.length).toBe(1);
  });

  it('sanitize 注入式：清洗函数生效在前缀上', () => {
    const d = createEarlySentenceDetector({ sanitize: (s) => String(s).replace(/noe/gi, '宝贝') });
    const full = 'noe在的，今天天气很好适合出门散步呀。要不要我帮你查一下附近公园的人流情况，顺便提醒你带伞出门？';
    let got = null;
    for (const ch of full) { const r = d.push(ch); if (r) { got = r; break; } }
    expect(got).toContain('宝贝');
    expect(got).not.toMatch(/noe/i);
  });
});

describe('OllamaChatAdapter 流式（onDelta 才开 stream，结果同形）', () => {
  function ndjsonStream(lines) {
    // adapter 只要求 resp.body 可 for-await（Node fetch 的 web 流也满足）；测试用 Node Readable 最简
    return Readable.from(lines.map((l) => Buffer.from(JSON.stringify(l) + '\n')));
  }

  it('onDelta 收到每片增量，最终 reply=全文、token 数来自 done 行', async () => {
    let sentBody = null;
    vi.stubGlobal('fetch', async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, body: ndjsonStream([
        { message: { content: '今天' }, done: false },
        { message: { content: '天气很好。' }, done: false },
        { message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 34 },
      ]) };
    });
    const a = new OllamaChatAdapter({ id: 'ollama' });
    const pieces = [];
    const r = await a._doChat([{ role: 'user', content: 'hi' }], { onDelta: (p) => pieces.push(p) });
    expect(sentBody.stream).toBe(true);
    expect(pieces).toEqual(['今天', '天气很好。']);
    expect(r).toMatchObject({ reply: '今天天气很好。', tokensIn: 12, tokensOut: 34 });
  });

  it('不传 onDelta 仍走非流式（stream:false，老行为不变）', async () => {
    let sentBody = null;
    vi.stubGlobal('fetch', async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: '在的' }, prompt_eval_count: 1, eval_count: 2 }) };
    });
    const a = new OllamaChatAdapter({ id: 'ollama' });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(sentBody.stream).toBe(false);
    expect(r.reply).toBe('在的');
  });

  it('onDelta 回调抛错不阻断生成（早鸟是锦上添花）', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, body: ndjsonStream([
      { message: { content: '今天天气很好。' }, done: false },
      { message: { content: '' }, done: true },
    ]) }));
    const a = new OllamaChatAdapter({ id: 'ollama' });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], { onDelta: () => { throw new Error('回调炸了'); } });
    expect(r.reply).toBe('今天天气很好。');
  });
});

describe('OpenAICompat/LmStudio 流式（SSE，onDelta 才开，结果同形）', () => {
  function sseStream(events) {
    return Readable.from(events.map((e) => Buffer.from(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)));
  }

  it('SSE 增量回调 + 最终 reply 全文 + usage 来自末尾 chunk；请求体带 stream/stream_options', async () => {
    let sentBody = null;
    vi.stubGlobal('fetch', async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, body: sseStream([
        { choices: [{ delta: { content: '今天' } }] },
        { choices: [{ delta: { content: '天气很好。' } }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } },
        '[DONE]',
      ]) };
    });
    const a = new OpenAICompatChatAdapter({ id: 'x', apiKey: 'k', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' });
    const pieces = [];
    const r = await a._doChat([{ role: 'user', content: 'hi' }], { onDelta: (p) => pieces.push(p) });
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(pieces).toEqual(['今天', '天气很好。']);
    expect(r).toMatchObject({ reply: '今天天气很好。', tokensIn: 7, tokensOut: 9 });
  });

  it('不传 onDelta 仍走非流式（请求体无 stream，老行为不变）', async () => {
    let sentBody = null;
    vi.stubGlobal('fetch', async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '在的' } }], usage: {} }) };
    });
    const a = new OpenAICompatChatAdapter({ id: 'x', apiKey: 'k', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' });
    const r = await a._doChat([{ role: 'user', content: 'hi' }], {});
    expect(sentBody.stream).toBeUndefined();
    expect(r.reply).toBe('在的');
  });

  it('LmStudioChatAdapter 继承流式：ensureModel 照跑、onDelta 照收', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, body: sseStream([
      { choices: [{ delta: { content: '本地模型在听。' } }] },
      '[DONE]',
    ]) }));
    const ensured = [];
    const a = new LmStudioChatAdapter({ id: 'lmstudio', apiKey: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-x', ensureModel: async (m) => { ensured.push(m); return { ok: true }; }, currentLoaded: async () => 'gemma-x' });
    const pieces = [];
    const r = await a._doChat([{ role: 'user', content: 'hi' }], { onDelta: (p) => pieces.push(p) });
    expect(ensured).toEqual(['gemma-x']);
    expect(pieces).toEqual(['本地模型在听。']);
    expect(r.reply).toBe('本地模型在听。');
  });
});

describe('VoiceSession × LLM 流式早鸟（门控默认 OFF + 收尾对账）', () => {
  const LONG_REPLY = '今天天气很好，适合出门散步。要不要我帮你查一下附近公园的人流情况，顺便提醒你带伞？';

  function makeStreamSession({ reply = LONG_REPLY, finalReply = null, llmStream = true } = {}) {
    const ttsCalls = [];
    const adapter = {
      chat: async (messages, o) => {
        if (typeof o.onDelta === 'function') for (const ch of reply) o.onDelta(ch);
        return { reply: finalReply ?? reply };
      },
    };
    const vs = new VoiceSession({
      llmStream,
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async (text) => { ttsCalls.push(text); return { audioBuffer: Buffer.from('audio-' + text.length), format: 'mp3' }; } },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
    });
    return { vs, ttsCalls };
  }

  it('早鸟命中：TTS 只合成一次首句，restTtsText=剩余文本（与旧 C9 响应同形）', async () => {
    const { vs, ttsCalls } = makeStreamSession();
    const r = await vs.chatText('今天怎么样');
    expect(r.ok).toBe(true);
    const expectSplit = splitFirstSentence(r.reply);
    expect(ttsCalls).toEqual([expectSplit.first]); // 只有早鸟那一次，没有第二次合成
    expect(r.audioBase64).toBeTruthy();
    expect(r.restTtsText).toBe(expectSplit.rest);
  });

  it('对账失败（最终 reply 被换）→ 丢早鸟、按最终 reply 走旧路重新合成', async () => {
    const final = '换了一个完全不同的回答内容，这句也足够长可以切出首句来。后面还有第二句继续说。';
    const { vs, ttsCalls } = makeStreamSession({ reply: LONG_REPLY, finalReply: final });
    const r = await vs.chatText('今天怎么样');
    expect(r.ok).toBe(true);
    const finalFirst = splitFirstSentence(r.reply).first;
    expect(ttsCalls.length).toBe(2);              // 早鸟一次（浪费）+ 对账失败后旧路一次
    expect(ttsCalls[1]).toBe(finalFirst);         // 实际采用的是最终 reply 的首句
    expect(r.restTtsText).toBe(splitFirstSentence(r.reply).rest);
  });

  it('门控默认 OFF：adapter 收不到 onDelta、行为与旧完全一致', async () => {
    let sawOnDelta = false;
    const adapter = { chat: async (m, o) => { sawOnDelta = typeof o.onDelta === 'function'; return { reply: LONG_REPLY }; } };
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
    });
    const r = await vs.chatText('今天怎么样');
    expect(r.ok).toBe(true);
    expect(sawOnDelta).toBe(false);
  });

  it('noTts 时不开早鸟（不浪费合成）', async () => {
    const { vs, ttsCalls } = makeStreamSession();
    const r = await vs.chatText('今天怎么样', { noTts: true });
    expect(r.ok).toBe(true);
    expect(ttsCalls).toEqual([]);
  });

  it('早鸟合成失败 → 旧路兜底，回复照常返回', async () => {
    const ttsCalls = [];
    let failFirst = true;
    const adapter = { chat: async (m, o) => { if (o.onDelta) for (const ch of LONG_REPLY) o.onDelta(ch); return { reply: LONG_REPLY }; } };
    const vs = new VoiceSession({
      llmStream: true,
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async (text) => {
        ttsCalls.push(text);
        if (failFirst) { failFirst = false; throw new Error('TTS 首试挂了'); }
        return { audioBuffer: Buffer.from('x'), format: 'mp3' };
      } },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
    });
    const r = await vs.chatText('今天怎么样');
    expect(r.ok).toBe(true);
    expect(r.audioBase64).toBeTruthy(); // 旧路兜底成功
    expect(ttsCalls.length).toBeGreaterThanOrEqual(2);
  });
});
