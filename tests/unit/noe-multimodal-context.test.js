import { describe, it, expect } from 'vitest';
import { buildMultimodalContext } from '../../src/context/NoeMultimodalContext.js';

// 第三阶段·全模态一体化:把视觉/语音/文本/工具融进「一个」推理上下文,让 Neo 跨模态推理而非各管各的。
// 无缝的它=同一个上下文里同时看到"屏幕上是什么、主人刚在面板做了什么、语音开着没"。纯函数,只收有信号的模态(无信号不产噪声)。

describe('buildMultimodalContext', () => {
  it('多模态都有信号 → 融成一个上下文块', () => {
    const ctx = buildMultimodalContext({
      visionSummary: '屏幕上是 VS Code,打开着 server.js',
      uiSignal: { lastAction: '点击了任务卡', lastCard: 'task-42' },
      voiceActive: true,
      activeApp: 'Code',
    });
    expect(ctx).toContain('屏幕上是 VS Code');
    expect(ctx).toContain('点击了任务卡');
    expect(ctx).toContain('语音');
    expect(ctx).toContain('Code');
  });

  it('只有部分模态有信号 → 只放有的(不产空噪声)', () => {
    const ctx = buildMultimodalContext({ visionSummary: '屏幕上是浏览器' });
    expect(ctx).toContain('浏览器');
    expect(ctx).not.toContain('语音'); // voice 无信号不提
    expect(ctx).not.toContain('面板');
  });

  it('全无信号 → 空串(不注入垃圾)', () => {
    expect(buildMultimodalContext({})).toBe('');
    expect(buildMultimodalContext()).toBe('');
  });

  it('视觉过期(stale) → 标注不确定,不当实时', () => {
    const ctx = buildMultimodalContext({ visionSummary: '旧画面', visionStale: true });
    expect(ctx).toContain('可能已过期');
  });

  it('限长:超长 summary 截断(不撑爆 prompt)', () => {
    const ctx = buildMultimodalContext({ visionSummary: 'x'.repeat(2000) });
    expect(ctx.length).toBeLessThan(1200);
  });
});
