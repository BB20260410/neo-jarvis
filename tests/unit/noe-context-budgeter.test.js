// B7 上下文编排：预算内逐字保序；超预算按 keep 整段裁（小先丢、同级后加先丢）；绝不截半句。
import { describe, expect, it, vi } from 'vitest';
import { createContextComposer } from '../../src/context/NoeContextBudgeter.js';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

describe('NoeContextBudgeter', () => {
  it('预算内：按加入顺序输出，与旧 sys+= 拼接逐字一致', () => {
    const c = createContextComposer({ budgetTokens: 10_000 });
    c.add('a', '甲段');
    c.add('b', '乙段', { keep: 2 });
    c.add('c', '丙段', { keep: 9 });
    const r = c.compose();
    expect(r.text).toBe('\n\n甲段\n\n乙段\n\n丙段');
    expect(r.dropped).toEqual([]);
  });

  it('超预算：keep 小的先丢、同级后加先丢，存活段保序', () => {
    const c = createContextComposer({ budgetTokens: 30 }); // ~120 字符预算
    c.add('vital', 'V'.repeat(60), { keep: 8 });
    c.add('nice1', 'N'.repeat(60), { keep: 2 });
    c.add('nice2', 'M'.repeat(60), { keep: 2 });
    const r = c.compose();
    expect(r.dropped).toEqual(['nice2', 'nice1']); // 同级后加先丢
    expect(r.text).toContain('V');
    expect(r.text).not.toContain('N');
  });

  it('空段忽略；keep 越界被钳到 1-9', () => {
    const c = createContextComposer({ budgetTokens: 100 });
    c.add('empty', '   ');
    c.add('x', '内容', { keep: 99 });
    const r = c.compose();
    expect(r.dropped).toEqual([]);
    expect(r.text).toBe('\n\n内容');
  });

  it('单段超预算也整段丢（绝不截半句）', () => {
    const c = createContextComposer({ budgetTokens: 5 });
    c.add('huge', 'X'.repeat(400), { keep: 9 });
    const r = c.compose();
    expect(r.text).toBe('');
    expect(r.dropped).toEqual(['huge']);
  });
});

describe('VoiceSession × 预算裁剪集成', () => {
  it('NOE_CONTEXT_BUDGET_TOKENS 极小时低 keep 段（记忆召回）被裁、高 keep 段（动作/身份）保留', async () => {
    const seen = {};
    const session = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'wav' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
      getAdapter: () => ({ chat: async (messages) => { seen.sys = messages[0].content; return { reply: '好' }; } }),
      ownerGate: { check: () => ({ ok: true }) },
      memory: { recall: () => [{ body: '记忆内容'.repeat(120), scope: 'fact' }], write: () => {} },
      personStore: { list: () => [{ displayName: '张三', relation: '朋友' }] },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origEnv = process.env.NOE_CONTEXT_BUDGET_TOKENS;
    process.env.NOE_CONTEXT_BUDGET_TOKENS = '120'; // 极小预算逼出裁剪
    try {
      const r = await session.chatText('记住我明天要开会', { noTts: true });
      expect(r.ok).toBe(true);
      // 记忆召回(keep2)应被裁掉；高 keep 的动作结果应活着（"记住"触发动作桥）
      expect(seen.sys).not.toContain('你记得这些相关的事');
      const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('|');
      expect(warned).toContain('noe-context');
    } finally {
      if (origEnv === undefined) delete process.env.NOE_CONTEXT_BUDGET_TOKENS;
      else process.env.NOE_CONTEXT_BUDGET_TOKENS = origEnv;
      warnSpy.mockRestore();
    }
  });

  it('默认预算下输出与旧实现等价：全部注入段都在 system prompt 里', async () => {
    const seen = {};
    const session = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'wav' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
      getAdapter: () => ({ chat: async (messages) => { seen.sys = messages[0].content; return { reply: '好' }; } }),
      ownerGate: { check: () => ({ ok: true }) },
      memory: { recall: () => [{ body: '上次聊过天气', scope: 'fact' }], write: () => {} },
      personStore: { list: () => [{ displayName: '张三', relation: '朋友' }] },
    });
    const r = await session.chatText('随便聊聊', { noTts: true });
    expect(r.ok).toBe(true);
    expect(seen.sys).toContain('张三');            // 人物库
    expect(seen.sys).toContain('上次聊过天气');     // 记忆召回
    expect(seen.sys).toContain('<noe-self-knowledge>'); // 自我认知（resolve 注入或兜底）
  });
});
