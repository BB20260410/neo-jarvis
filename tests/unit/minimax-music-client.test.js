import { describe, expect, it } from 'vitest';
import { MiniMaxMusicClient } from '../../src/media/MiniMaxMusicClient.js';

// 波次5 P2 收尾测试：音乐客户端（API 形状核实自官方 CLI/SDK 源码 + test fixture）。

function makeClient(reply, capture = {}) {
  return new MiniMaxMusicClient({
    apiKey: 'k',
    fetchImpl: async (url, init) => { capture.url = String(url); capture.body = JSON.parse(init.body); return { json: async () => reply }; },
  });
}

describe('MiniMaxMusicClient', () => {
  it('请求体含官方字段，打到 /music_generation，返回 audio_url（官方 fixture 同款响应）', async () => {
    const cap = {};
    const c = makeClient({ data: { audio_url: 'https://example.com/music.mp3' }, base_resp: { status_code: 0, status_msg: 'success' } }, cap);
    const r = await c.generate('钢琴轻音乐，雨夜放松', { lyrics: '[Intro]\n[Verse] 雨声敲着窗' });
    expect(r.audioUrl).toBe('https://example.com/music.mp3');
    expect(cap.url).toContain('/music_generation');
    expect(cap.body.model).toBe('music-2.6-free');
    expect(cap.body.lyrics).toContain('[Verse]');
    expect(cap.body.is_instrumental).toBe(false);
  });

  it('纯音乐：lyrics 兜底 [intro] [outro]（官方 SDK 同款行为）', async () => {
    const cap = {};
    const c = makeClient({ data: { audio_url: 'u' }, base_resp: { status_code: 0 } }, cap);
    await c.generate('史诗管弦乐', { instrumental: true });
    expect(cap.body.lyrics).toBe('[intro] [outro]');
    expect(cap.body.is_instrumental).toBe(true);
  });

  it('audio_base64 形态也接受', async () => {
    const c = makeClient({ data: { audio_base64: 'QQ==' }, base_resp: { status_code: 0 } });
    const r = await c.generate('x');
    expect(r.audioBase64).toBe('QQ==');
    expect(r.audioUrl).toBe(null);
  });

  it('错误白名单：只透 status_code/status_msg', async () => {
    const c = makeClient({ base_resp: { status_code: 2049, status_msg: 'insufficient plan' }, internal_billing: 'LEAK' });
    let err;
    try { await c.generate('x'); } catch (e) { err = e; }
    expect(err.message).toContain('2049');
    expect(err.message).not.toContain('LEAK');
  });

  it('无音频返回 / 未配 key / 空 prompt 抛错', async () => {
    const c = makeClient({ data: {}, base_resp: { status_code: 0 } });
    await expect(c.generate('x')).rejects.toThrow(/无音频/);
    const c2 = new MiniMaxMusicClient({ secretResolver: () => ({ ok: false }), fetchImpl: async () => ({}) });
    await expect(c2.generate('x')).rejects.toThrow(/未配置/);
    await expect(makeClient({}).generate('  ')).rejects.toThrow(/为空/);
  });
});
