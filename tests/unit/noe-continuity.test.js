import { afterEach, describe, expect, it } from 'vitest';
import { setNoeContinuityProvider, buildNoeContinuityBlock } from '../../src/context/NoeContinuity.js';
import { ChatProfileStore } from '../../src/voice/ChatProfileStore.js';

// 连续记忆脊椎·读出侧：provider 注册 + ChatProfileStore.resolve 注入。

afterEach(() => setNoeContinuityProvider(null));   // 模块级单例，每测后清，避免串味

describe('NoeContinuity provider', () => {
  it('无 provider → 空串（resolve 行为零变化）', () => {
    setNoeContinuityProvider(null);
    expect(buildNoeContinuityBlock()).toBe('');
  });

  it('有 provider → 返回其生成的块（trim）', () => {
    setNoeContinuityProvider(() => '  <noe-self-state>我此刻：踏实</noe-self-state>  ');
    expect(buildNoeContinuityBlock()).toBe('<noe-self-state>我此刻：踏实</noe-self-state>');
  });

  it('provider 抛错被吞 → 空串（不阻断对话）', () => {
    setNoeContinuityProvider(() => { throw new Error('timeline down'); });
    expect(buildNoeContinuityBlock()).toBe('');
  });

  it('传非函数 → 清除 provider', () => {
    setNoeContinuityProvider(() => 'x');
    setNoeContinuityProvider('not-a-fn');
    expect(buildNoeContinuityBlock()).toBe('');
  });
});

describe('ChatProfileStore.resolve 注入连续记忆/自我状态', () => {
  // 临时文件路径，不碰真实 chat-profiles.json
  const store = new ChatProfileStore({ file: '/tmp/noe-continuity-test-profiles.json' });

  it('有 provider → systemPrompt 末尾含连续块（在 BOUNDARY 之前）', () => {
    setNoeContinuityProvider(() => '<noe-recent-timeline>\n- 刚刚：聊了 AI 意识\n</noe-recent-timeline>');
    const p = store.resolve('default');
    expect(p.systemPrompt).toContain('<noe-recent-timeline>');
    expect(p.systemPrompt).toContain('聊了 AI 意识');
    // 连续块在硬规则 BOUNDARY 之前（BOUNDARY 永远收尾）
    expect(p.systemPrompt.indexOf('noe-recent-timeline')).toBeLessThan(p.systemPrompt.indexOf('硬规则'));
  });

  it('无 provider → systemPrompt 不含连续块（行为与接线前一致）', () => {
    setNoeContinuityProvider(null);
    const p = store.resolve('default');
    expect(p.systemPrompt).not.toContain('noe-recent-timeline');
    expect(p.systemPrompt).toContain('硬规则');   // BOUNDARY 仍在
  });
});
