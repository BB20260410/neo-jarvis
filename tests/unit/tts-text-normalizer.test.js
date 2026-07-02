// @ts-check
import { describe, expect, it } from 'vitest';
import { normalizeTtsText } from '../../src/voice/TtsTextNormalizer.js';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

describe('normalizeTtsText（TTS 文本归一化纯函数）', () => {
  it('剥 markdown 符号与链接，保留文字', () => {
    const out = normalizeTtsText('**你好** `code` _x_ ~~d~~ > q 看[文档](https://a.com)吧');
    expect(out).not.toMatch(/[*#`_~>]/);
    expect(out).toContain('你好');
    expect(out).toContain('文档');
    expect(out).not.toContain('https://a.com');
  });

  it('剥 emoji，保留中文标点（核心：兜底引擎不该念符号）', () => {
    expect(normalizeTtsText('今天真好😀，出去玩吧！🎉')).toBe('今天真好，出去玩吧！');
    expect(normalizeTtsText('好的👍🏻')).toBe('好的');
  });

  it('折叠空白并 trim', () => {
    expect(normalizeTtsText('  你好   世界  ')).toBe('你好 世界');
  });

  it('fail-open：null/undefined/数字 → 安全字符串', () => {
    expect(normalizeTtsText(null)).toBe('');
    expect(normalizeTtsText(undefined)).toBe('');
    expect(normalizeTtsText(123)).toBe('123');
  });

  it('纯中文文本原样保留', () => {
    expect(normalizeTtsText('两美元三十五美分')).toBe('两美元三十五美分');
  });
});

describe('VoiceSession._synthesize 在回退链入口统一归一化（修兜底引擎念 emoji 的真实 bug）', () => {
  function makeVs(extra = {}) {
    return new VoiceSession({
      ttsClient: extra.ttsClient,
      kokoroTts: extra.kokoroTts || null,
      cosyVoiceTts: extra.cosyVoiceTts || null,
      brainRouter: { route: () => ({}) },
      getAdapter: () => null,
    });
  }

  it('主 TTS 收到的是归一化后文本（无 emoji/markdown）', async () => {
    const got = [];
    const tts = { synthesize: async (text) => { got.push(text); return { audioBuffer: Buffer.from('a'), format: 'mp3' }; } };
    const vs = makeVs({ ttsClient: tts });
    await vs._synthesize('你好😀 **加粗** 🎉');
    expect(got[0]).not.toContain('😀');
    expect(got[0]).not.toContain('🎉');
    expect(got[0]).not.toContain('*');
    expect(got[0]).toContain('你好');
  });

  it('CosyVoice 中文兜底引擎也收到归一化文本（原 bug：只 MiniMax 内部 cleanText）', async () => {
    const cosyGot = [];
    // 主 TTS 抛错 → 回退链走到 CosyVoice（含中文才走）
    const tts = { synthesize: async () => { throw new Error('主选失败'); } };
    const cosy = { synthesize: async (text) => { cosyGot.push(text); return { audioBuffer: Buffer.from('a'), format: 'mp3' }; } };
    const vs = makeVs({ ttsClient: tts, cosyVoiceTts: cosy });
    await vs._synthesize('你好😀，世界🎉');
    expect(cosyGot.length).toBe(1);
    expect(cosyGot[0]).not.toContain('😀');
    expect(cosyGot[0]).not.toContain('🎉');
    expect(cosyGot[0]).toContain('你好');
  });

  it('fail-open：reply 全是符号被剥空时回退原文，不让合成哑掉', async () => {
    const got = [];
    const tts = { synthesize: async (text) => { got.push(text); return { audioBuffer: Buffer.from('a'), format: 'mp3' }; } };
    const vs = makeVs({ ttsClient: tts });
    await vs._synthesize('***###');
    // 归一化后为空 → 回退原文（绝不传空串导致"文本为空"哑掉）
    expect(got[0]).toBe('***###');
  });
});
