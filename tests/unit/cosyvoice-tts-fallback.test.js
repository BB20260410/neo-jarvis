import { describe, expect, it } from 'vitest';
import { VoiceSession } from '../../src/voice/VoiceSession.js';
import { CosyVoiceTtsClient } from '../../src/voice/CosyVoiceTtsClient.js';
import { OpenAICompatibleVoiceGatewayClient } from '../../src/voice/OpenAICompatibleVoiceGatewayClient.js';

// 可编排的假 TTS：ok=false 时 synthesize 抛错
function fakeTts(name, ok = true) {
  const calls = [];
  return {
    calls,
    async synthesize(text) {
      calls.push(text);
      if (!ok) throw new Error(`${name} 不可用`);
      return { audioBuffer: Buffer.from(name), format: 'wav' };
    },
  };
}

function makeSession({ tts, kokoro = null, gateway = null, cosy = null }) {
  return new VoiceSession({
    sttClient: { transcribe: async () => '测试' },
    ttsClient: tts,
    kokoroTts: kokoro,
    voiceGatewayTts: gateway,
    cosyVoiceTts: cosy,
    brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
    getAdapter: () => ({ chat: async () => ({ reply: '好的呀' }) }),
    ownerGate: { check: () => ({ ok: true }) },
  });
}

describe('VoiceSession._synthesize 统一回退链（卡②）', () => {
  it('主选成功 → 不碰兜底', async () => {
    const minimax = fakeTts('minimax');
    const cosy = fakeTts('cosy');
    const s = makeSession({ tts: minimax, cosy });
    const r = await s._synthesize('你好');
    expect(Buffer.from(r.audioBase64, 'base64').toString()).toBe('minimax');
    expect(cosy.calls.length).toBe(0);
  });

  it('MiniMax 挂 + 中文 → CosyVoice 兜底出声（断网不哑）', async () => {
    const minimax = fakeTts('minimax', false);
    const cosy = fakeTts('cosy');
    const s = makeSession({ tts: minimax, cosy });
    const r = await s._synthesize('你好，今天怎么样');
    expect(r.ttsErr).toBeNull();
    expect(Buffer.from(r.audioBase64, 'base64').toString()).toBe('cosy');
  });

  it('MiniMax 挂 + voice gateway 启用 → 先走网关，不碰 CosyVoice', async () => {
    const minimax = fakeTts('minimax', false);
    const gateway = fakeTts('gateway');
    const cosy = fakeTts('cosy');
    const s = makeSession({ tts: minimax, gateway, cosy });
    const r = await s._synthesize('你好，今天怎么样');
    expect(r.ttsErr).toBeNull();
    expect(Buffer.from(r.audioBase64, 'base64').toString()).toBe('gateway');
    expect(cosy.calls.length).toBe(0);
  });

  it('MiniMax 挂 + 纯英文 → 不走 CosyVoice（中文兜底不管英文）', async () => {
    const minimax = fakeTts('minimax', false);
    const cosy = fakeTts('cosy');
    const s = makeSession({ tts: minimax, cosy });
    const r = await s._synthesize('hello world');
    expect(r.audioBase64).toBeNull();
    expect(r.ttsErr?.message).toContain('minimax 不可用');
    expect(cosy.calls.length).toBe(0);
  });

  it('Kokoro(英文主选)挂 → 回退 MiniMax；全挂带回最后的错', async () => {
    const minimax = fakeTts('minimax');
    const kokoro = fakeTts('kokoro', false);
    const s = makeSession({ tts: minimax, kokoro });
    const r = await s._synthesize('english only');
    expect(Buffer.from(r.audioBase64, 'base64').toString()).toBe('minimax');
    const sAllFail = makeSession({ tts: fakeTts('minimax', false), kokoro: fakeTts('kokoro', false), cosy: fakeTts('cosy', false) });
    const r2 = await sAllFail._synthesize('中文也救不了');
    expect(r2.audioBase64).toBeNull();
    expect(r2.ttsErr?.message).toContain('cosy 不可用'); // 链尾的错
  });

  it('chatText 全链：MiniMax 挂时中文回复仍出声（CosyVoice 兜底）', async () => {
    const cosy = fakeTts('cosy');
    const s = makeSession({ tts: fakeTts('minimax', false), cosy });
    const r = await s.chatText('随便聊聊', { noTts: false });
    expect(r.ok).toBe(true);
    expect(r.audioBase64).toBeTruthy();
    expect(Buffer.from(r.audioBase64, 'base64').toString()).toBe('cosy');
    expect(r.ttsError).toBeNull();
  });
});

describe('CosyVoiceTtsClient', () => {
  it('synthesize：POST /tts 返回 base64 wav', async () => {
    const reqs = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      reqs.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ audio: Buffer.from('wav-data').toString('base64'), format: 'wav' }) };
    };
    try {
      const c = new CosyVoiceTtsClient({ baseUrl: 'http://127.0.0.1:9999' });
      const r = await c.synthesize('你好');
      expect(r.format).toBe('wav');
      expect(r.audioBuffer.toString()).toBe('wav-data');
      expect(reqs[0].url).toBe('http://127.0.0.1:9999/tts');
      expect(reqs[0].body.text).toBe('你好');
      expect(reqs[0].body.voice).toBe('中文女');
    } finally { globalThis.fetch = origFetch; }
  });

  it('synthesize：服务报错/空文本 → 明确抛错', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    try {
      const c = new CosyVoiceTtsClient({ baseUrl: 'http://127.0.0.1:9999' });
      await expect(c.synthesize('你好')).rejects.toThrow('CosyVoice TTS: boom');
      await expect(c.synthesize('')).rejects.toThrow('文本为空');
    } finally { globalThis.fetch = origFetch; }
  });

  it('默认不设超时（跑模型不许超时误杀）；timeoutMs>0 才挂 abort', () => {
    expect(new CosyVoiceTtsClient().timeoutMs).toBe(0);
  });
});

describe('OpenAICompatibleVoiceGatewayClient', () => {
  it('默认不设合成超时（仅健康检查短探活）', () => {
    expect(new OpenAICompatibleVoiceGatewayClient().timeoutMs).toBe(0);
  });

  it('synthesize：POST /audio/speech 返回二进制音频', async () => {
    const reqs = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      reqs.push({ url, body: JSON.parse(init.body) });
      return { ok: true, arrayBuffer: async () => Uint8Array.from([103, 119]).buffer };
    };
    try {
      const c = new OpenAICompatibleVoiceGatewayClient({ baseUrl: 'http://127.0.0.1:23333/v1', model: 'tts-x', voice: 'zh', responseFormat: 'mp3' });
      const r = await c.synthesize('你好', { speed: 1.1 });
      expect(reqs[0].url).toBe('http://127.0.0.1:23333/v1/audio/speech');
      expect(reqs[0].body).toMatchObject({ model: 'tts-x', voice: 'zh', input: '你好', response_format: 'mp3', speed: 1.1 });
      expect(r.format).toBe('mp3');
      expect(r.audioBuffer.toString()).toBe('gw');
    } finally { globalThis.fetch = origFetch; }
  });

  it('synthesize：服务报错/空文本 → 明确抛错', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    try {
      const c = new OpenAICompatibleVoiceGatewayClient({ baseUrl: 'http://127.0.0.1:23333/v1' });
      await expect(c.synthesize('你好')).rejects.toThrow('Voice gateway TTS: boom');
      await expect(c.synthesize('')).rejects.toThrow('文本为空');
    } finally { globalThis.fetch = origFetch; }
  });
});
