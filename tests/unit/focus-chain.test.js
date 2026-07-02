import { describe, it, expect } from 'vitest';
import { focusChainHeader, buildDoneSummaries } from '../../src/planner/FocusChain.js';

describe('focusChainHeader', () => {
  it('returns empty string when mainGoal is missing or falsy', () => {
    expect(focusChainHeader({ mainGoal: '', doneSummaries: ['a'], userMsgCount: 5 })).toBe('');
    expect(focusChainHeader({ doneSummaries: ['a'], userMsgCount: 5 })).toBe('');
    expect(focusChainHeader({ mainGoal: 0, userMsgCount: 5 })).toBe('');
  });

  it('returns empty string when userMsgCount is 0', () => {
    expect(focusChainHeader({ mainGoal: 'goal', userMsgCount: 0, doneSummaries: ['a'] })).toBe('');
  });

  it('returns empty string when userMsgCount is not a multiple of triggerInterval', () => {
    expect(focusChainHeader({ mainGoal: 'goal', userMsgCount: 3, triggerInterval: 5 })).toBe('');
    expect(focusChainHeader({ mainGoal: 'goal', userMsgCount: 7, triggerInterval: 5 })).toBe('');
    expect(focusChainHeader({ mainGoal: 'goal', userMsgCount: 2, triggerInterval: 4 })).toBe('');
  });

  it('produces a fully formatted header on trigger multiples', () => {
    const out = focusChainHeader({
      mainGoal: '实现X',
      doneSummaries: ['A', 'B'],
      userMsgCount: 5,
      triggerInterval: 5,
    });
    expect(out).toContain('⚠️ FOCUS CHAIN（每 5 轮自动提醒一次）');
    expect(out).toContain('🎯 主目标：实现X');
    expect(out).toContain('📋 最近 5 步摘要：');
    expect(out).toContain('  1. A');
    expect(out).toContain('  2. B');
    expect(out).toContain('⏭️ 本轮只决定下一步那一件事，不要扩散到无关分支。');
    expect(out).toContain('--- 用户消息 ---');
    // 末尾应包含一个空行分隔
    expect(out.endsWith('\n')).toBe(true);
  });

  it('uses default triggerInterval of 5 when not provided', () => {
    expect(focusChainHeader({ mainGoal: 'g', userMsgCount: 10 })).toContain('每 5 轮');
    // 9 不是 5 的倍数 => 空
    expect(focusChainHeader({ mainGoal: 'g', userMsgCount: 9 })).toBe('');
  });

  it('shows "(尚无)" when doneSummaries is empty', () => {
    const out = focusChainHeader({ mainGoal: 'g', doneSummaries: [], userMsgCount: 5 });
    expect(out).toContain('(尚无)');
    expect(out).not.toContain('1. ');
  });

  it('only includes the last triggerInterval summaries', () => {
    const summaries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const out = focusChainHeader({
      mainGoal: 'g',
      doneSummaries: summaries,
      userMsgCount: 6,
      triggerInterval: 3,
    });
    expect(out).toContain('📋 最近 3 步摘要：');
    expect(out).toContain('  1. e');
    expect(out).toContain('  2. f');
    expect(out).toContain('  3. g');
    expect(out).not.toContain('  1. a');
    expect(out).not.toContain('  1. d');
  });

  it('respects custom triggerInterval values', () => {
    const out = focusChainHeader({
      mainGoal: 'g',
      doneSummaries: ['x'],
      userMsgCount: 4,
      triggerInterval: 4,
    });
    expect(out).toContain('每 4 轮');
    expect(out).toContain('📋 最近 4 步摘要：');
    // 4 的下一个倍数是 8
    expect(focusChainHeader({ mainGoal: 'g', userMsgCount: 8, triggerInterval: 4 })).toContain('每 4 轮');
    // 6 不是 4 的倍数 => 空
    expect(focusChainHeader({ mainGoal: 'g', userMsgCount: 6, triggerInterval: 4 })).toBe('');
  });

  it('handles triggerInterval of 1 (every message)', () => {
    const out = focusChainHeader({
      mainGoal: 'g',
      doneSummaries: ['s1'],
      userMsgCount: 1,
      triggerInterval: 1,
    });
    expect(out).toContain('每 1 轮');
    expect(out).toContain('  1. s1');
  });
});

describe('buildDoneSummaries', () => {
  it('returns empty array for empty messages', () => {
    expect(buildDoneSummaries([])).toEqual([]);
  });

  it('filters out non-assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'reply' },
    ];
    expect(buildDoneSummaries(messages)).toEqual(['reply']);
  });

  it('filters out assistant messages with empty/missing content', () => {
    const messages = [
      { role: 'assistant', content: '' },
      { role: 'assistant' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'kept' },
    ];
    expect(buildDoneSummaries(messages)).toEqual(['kept']);
  });

  it('collapses whitespace runs (spaces, tabs, newlines) to single spaces', () => {
    const messages = [
      { role: 'assistant', content: 'hello   world\n\tfoo  bar' },
    ];
    expect(buildDoneSummaries(messages)).toEqual(['hello world foo bar']);
  });

  it('truncates content to 80 characters', () => {
    const long = 'x'.repeat(200);
    const messages = [{ role: 'assistant', content: long }];
    const result = buildDoneSummaries(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(80);
    expect(result[0]).toBe('x'.repeat(80));
  });

  it('truncates after whitespace collapse (collapse first, then slice)', () => {
    // 200 个 'a' 用空格分隔 -> 折叠后是 'a a a ...' (399 chars) -> 切到 80
    const spaced = Array.from({ length: 200 }, () => 'a').join(' ');
    const messages = [{ role: 'assistant', content: spaced }];
    const result = buildDoneSummaries(messages);
    expect(result[0]).toHaveLength(80);
    // 折叠后前 80 字符应为 'a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a'
    expect(result[0].startsWith('a a a a')).toBe(true);
  });

  it('takes the last N messages based on max', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant',
      content: `m${i}`,
    }));
    expect(buildDoneSummaries(messages, 2)).toEqual(['m3', 'm4']);
    expect(buildDoneSummaries(messages, 3)).toEqual(['m2', 'm3', 'm4']);
    // max 大于总数时全部返回
    expect(buildDoneSummaries(messages, 10)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('uses default max of 10', () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: 'assistant',
      content: `m${i}`,
    }));
    const result = buildDoneSummaries(messages);
    expect(result).toHaveLength(10);
    expect(result[0]).toBe('m5');
    expect(result[9]).toBe('m14');
  });

  it('preserves order of the kept tail', () => {
    const messages = [
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'middle-user' },
      { role: 'assistant', content: 'second' },
      { role: 'assistant', content: 'third' },
    ];
    // 默认 max=10，全部满足过滤条件，顺序为 messages 中的原始顺序
    expect(buildDoneSummaries(messages)).toEqual(['first', 'second', 'third']);
  });

  it('integrates with focusChainHeader end-to-end', () => {
    const messages = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'step   one' },
      { role: 'assistant', content: 'step two' },
      { role: 'assistant', content: 'step three' },
    ];
    const summaries = buildDoneSummaries(messages);
    const header = focusChainHeader({
      mainGoal: '完成X',
      doneSummaries: summaries,
      userMsgCount: 5,
    });
    expect(header).toContain('🎯 主目标：完成X');
    expect(header).toContain('  1. step one');
    expect(header).toContain('  2. step two');
    expect(header).toContain('  3. step three');
  });
});
