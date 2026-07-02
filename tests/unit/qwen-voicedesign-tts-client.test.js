// @ts-check
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QwenVoiceDesignTtsClient } from '../../src/voice/QwenVoiceDesignTtsClient.js';

afterEach(() => vi.restoreAllMocks());

describe('QwenVoiceDesignTtsClient（本地志玲 VoiceDesign TTS）', () => {
  it('configured() 有 baseUrl 返回 true', () => {
    expect(new QwenVoiceDesignTtsClient({ baseUrl: 'http://127.0.0.1:8126' }).configured()).toBe(true);
  });

  it('synthesize 正常解析 base64 音频并带 text', async () => {
    const b64 = Buffer.from('FAKEWAV').toString('base64');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ audio: b64, format: 'wav' }) });
    vi.stubGlobal('fetch', fetchMock);
    const c = new QwenVoiceDesignTtsClient({ baseUrl: 'http://x' });
    const r = await c.synthesize('今天辛苦了');
    expect(r.format).toBe('wav');
    expect(r.audioBuffer.toString()).toBe('FAKEWAV');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('今天辛苦了');
  });

  it('synthesize 空文本抛错', async () => {
    const c = new QwenVoiceDesignTtsClient({ baseUrl: 'http://x' });
    await expect(c.synthesize('   ')).rejects.toThrow(/文本为空/);
  });

  it('synthesize 在 server 返回 error 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
    const c = new QwenVoiceDesignTtsClient({ baseUrl: 'http://x' });
    await expect(c.synthesize('你好')).rejects.toThrow(/boom/);
  });

  it('synthesize 传 opts.instruct 时进入请求体', async () => {
    const b64 = Buffer.from('W').toString('base64');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ audio: b64, format: 'wav' }) });
    vi.stubGlobal('fetch', fetchMock);
    const c = new QwenVoiceDesignTtsClient({ baseUrl: 'http://x', instruct: '' });
    await c.synthesize('你好', { instruct: '用悲伤的语气说' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instruct).toBe('用悲伤的语气说');
  });
});
