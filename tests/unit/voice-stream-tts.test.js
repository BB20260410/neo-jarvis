// C9 流式语音（首句优先两段式）：长回复只先合成首句（首声提前数秒），剩余文本带回
// restTtsText 给前端经 /api/noe/voice/tts 续播；短回复/显式关闭/无声路径行为与旧版一致。
import { describe, expect, it } from 'vitest';
import { VoiceSession, splitFirstSentence } from '../../src/voice/VoiceSession.js';

describe('splitFirstSentence', () => {
  it('长回复按首个句界拆成 first/rest', () => {
    const r = splitFirstSentence('今天天气不错，适合出门走走。下午可能有阵雨，记得带伞别淋湿了。回来路上顺便买点水果吧，家里的水果都吃完了。');
    expect(r.first).toBe('今天天气不错，适合出门走走。');
    expect(r.rest.startsWith('下午可能有阵雨')).toBe(true);
  });

  it('短回复(<40字)不拆', () => {
    expect(splitFirstSentence('好的，没问题。马上来。')).toBeNull();
  });

  it('首句太碎(<6字)并入下一句', () => {
    const r = splitFirstSentence('嗯。我想了一下这个问题确实值得好好讨论一番。后面这部分是剩余的内容，要足够长才能让总长超过门槛。');
    expect(r.first).toBe('嗯。我想了一下这个问题确实值得好好讨论一番。');
  });

  it('无句界不拆；首句占比超 70% 不拆', () => {
    expect(splitFirstSentence('这一段完全没有任何句子边界标点所以没办法切分出首句来播放'.repeat(2))).toBeNull();
    const long = '这是一个非常非常非常非常非常非常非常非常非常非常长的首句一直到很后面才结束。尾巴。';
    expect(splitFirstSentence(long)).toBeNull();
  });
});

function makeSession({ reply, ttsCalls }) {
  return new VoiceSession({
    sttClient: { transcribe: async () => '' },
    ttsClient: { synthesize: async (text) => { ttsCalls.push(text); return { audioBuffer: Buffer.from('audio:' + text.length), format: 'mp3' }; } },
    brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
    getAdapter: () => ({ chat: async () => ({ reply }) }),
    ownerGate: { check: () => ({ ok: true }) },
  });
}

describe('VoiceSession × 首句优先', () => {
  const LONG = '今天天气不错，适合出门走走。下午可能有阵雨，记得带伞。回来路上买点水果吧，家里水果吃完了。';

  it('长回复：只合成首句，restTtsText 带剩余文本', async () => {
    const ttsCalls = [];
    const r = await makeSession({ reply: LONG, ttsCalls }).chatText('随便聊聊', { noTts: false });
    expect(r.ok).toBe(true);
    expect(ttsCalls).toEqual(['今天天气不错，适合出门走走。']);
    expect(r.restTtsText.startsWith('下午可能有阵雨')).toBe(true);
    expect(r.audioBase64).toBeTruthy();
  });

  it('短回复：整段合成，restTtsText 为 null', async () => {
    const ttsCalls = [];
    const r = await makeSession({ reply: '好呀。', ttsCalls }).chatText('在吗', { noTts: false });
    expect(ttsCalls).toEqual(['好呀。']);
    expect(r.restTtsText).toBeNull();
  });

  it('opts.streamTts=false 显式关闭：整段合成', async () => {
    const ttsCalls = [];
    const r = await makeSession({ reply: LONG, ttsCalls }).chatText('随便聊聊', { noTts: false, streamTts: false });
    // sanitize 会把句子重组为空格相接（既有行为），断言"一次整段合成且含首尾句"而非逐字
    expect(ttsCalls.length).toBe(1);
    expect(ttsCalls[0]).toContain('今天天气不错');
    expect(ttsCalls[0]).toContain('家里水果吃完了');
    expect(r.restTtsText).toBeNull();
  });

  it('noTts：不合成也不带 restTtsText', async () => {
    const ttsCalls = [];
    const r = await makeSession({ reply: LONG, ttsCalls }).chatText('随便聊聊', { noTts: true });
    expect(ttsCalls).toEqual([]);
    expect(r.restTtsText).toBeNull();
  });

  it('首句合成失败（兜底链全挂）：restTtsText 不带，ttsError 与旧行为一致', async () => {
    const session = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => { throw new Error('TTS 全挂'); } },
      brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: LONG }) }),
      ownerGate: { check: () => ({ ok: true }) },
    });
    const r = await session.chatText('随便聊聊', { noTts: false });
    expect(r.audioBase64).toBeNull();
    expect(r.restTtsText).toBeNull();
    expect(r.ttsError).toContain('TTS 全挂');
  });

  it('synthesizeText：走同一回退链；空文本明确报错', async () => {
    const ttsCalls = [];
    const s = makeSession({ reply: 'x', ttsCalls });
    const ok = await s.synthesizeText('  续播文本  ');
    expect(ok.audioBase64).toBeTruthy();
    expect(ttsCalls).toEqual(['续播文本']);
    const bad = await s.synthesizeText('   ');
    expect(bad.audioBase64).toBeNull();
    expect(bad.ttsErr.message).toContain('文本为空');
  });
});
