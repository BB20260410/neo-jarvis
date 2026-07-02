// @ts-check
// 志玲做中文主声音：preferLocalChinese=true 时 _pickTts 含中文优先本地 cosyVoiceTts 槽（志玲），MiniMax 退备用。
import { describe, it, expect } from 'vitest';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

const fakeTts = (id) => ({ id, async synthesize() { return { audioBuffer: Buffer.from(''), format: 'wav' }; } });
const base = (extra) => new VoiceSession({ brainRouter: {}, getAdapter: () => null, ...extra });

describe('VoiceSession._pickTts（志玲中文主声音开关）', () => {
  it('preferLocalChinese=true + 含中文 → 本地志玲(cosyVoiceTts)', () => {
    const cosy = fakeTts('zhiling'); const mini = fakeTts('minimax');
    const vs = base({ ttsClient: mini, cosyVoiceTts: cosy, preferLocalChinese: true });
    expect(vs._pickTts('你好，今天辛苦了')).toBe(cosy);
  });

  it('preferLocalChinese=true + 纯英文 → 不走志玲，回 MiniMax', () => {
    const cosy = fakeTts('zhiling'); const mini = fakeTts('minimax');
    const vs = base({ ttsClient: mini, cosyVoiceTts: cosy, preferLocalChinese: true });
    expect(vs._pickTts('hello world')).toBe(mini);
  });

  it('preferLocalChinese=false(默认) + 含中文 → MiniMax(原行为不变)', () => {
    const cosy = fakeTts('zhiling'); const mini = fakeTts('minimax');
    const vs = base({ ttsClient: mini, cosyVoiceTts: cosy });
    expect(vs._pickTts('你好')).toBe(mini);
  });

  it('preferLocalChinese=true 但未注入 cosyVoiceTts → 回退 MiniMax(不崩)', () => {
    const mini = fakeTts('minimax');
    const vs = base({ ttsClient: mini, cosyVoiceTts: null, preferLocalChinese: true });
    expect(vs._pickTts('你好')).toBe(mini);
  });
});
