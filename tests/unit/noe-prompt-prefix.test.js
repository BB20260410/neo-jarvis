import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLATILE_PATTERNS,
  buildCacheablePrompt,
  splitStablePrefix,
} from '../../src/context/NoePromptPrefix.js';

describe('splitStablePrefix', () => {
  it('把日期 / 时间行剥离到 <runtime> 块，稳定前缀不再含易变内容', () => {
    const prompt = [
      'You are Noe, a helpful assistant.',
      "Today's date is 2026-06-09.",
      'Current time: 14:01:46',
      'Always be concise.',
    ].join('\n');
    const r = splitStablePrefix(prompt);
    expect(r.stablePrefix).toContain('You are Noe');
    expect(r.stablePrefix).toContain('Always be concise.');
    expect(r.stablePrefix).not.toContain('2026-06-09');
    expect(r.stablePrefix).not.toContain('14:01:46');
    expect(r.runtimeBlock).toContain('<runtime>');
    expect(r.runtimeBlock).toContain('2026-06-09');
    expect(r.runtimeBlock).toContain('14:01:46');
    expect(r.runtimeBlock).toContain('</runtime>');
    expect(r.volatileLines).toHaveLength(2);
    expect(r.stableRatio).toBeCloseTo(0.5, 5);
    // combined = 稳定前缀 + 空行 + runtime 块
    expect(r.combined).toBe(`${r.stablePrefix}\n\n${r.runtimeBlock}`);
  });

  it('无易变行时 combined 与原文逐字节一致（缓存命中前提）', () => {
    const prompt = 'You are Noe.\nBe kind.\nBe precise.';
    const r = splitStablePrefix(prompt);
    expect(r.combined).toBe(prompt);
    expect(r.stablePrefix).toBe(prompt);
    expect(r.runtimeBlock).toBe('');
    expect(r.volatileLines).toEqual([]);
    expect(r.stableRatio).toBe(1);
  });

  it('稳定前缀逐轮不变：仅易变值变化时 stablePrefix 保持相同', () => {
    const mk = (date, time) => `System rules.\nDate: ${date}\nTime: ${time}\nEnd rules.`;
    const a = splitStablePrefix(mk('2026-06-09', '14:01'));
    const b = splitStablePrefix(mk('2026-06-10', '09:30'));
    expect(a.stablePrefix).toBe(b.stablePrefix); // 缓存前缀稳定
    expect(a.runtimeBlock).not.toBe(b.runtimeBlock); // 易变内容确有不同
  });

  it('识别 sessionId / cwd / uuid / 类时间戳', () => {
    const prompt = [
      'Stable header.',
      'session_id: abc123',
      'cwd: /Users/x/project',
      'trace 550e8400-e29b-41d4-a716-446655440000',
      'epoch 1780978673',
      'Stable footer.',
    ].join('\n');
    const r = splitStablePrefix(prompt);
    expect(r.volatileLines).toHaveLength(4);
    expect(r.stablePrefix).toBe('Stable header.\nStable footer.');
  });

  it('全部是易变行时稳定前缀为空，combined 仅含 runtime 块', () => {
    const prompt = 'Date: 2026-06-09\nTime: 10:00';
    const r = splitStablePrefix(prompt);
    expect(r.stablePrefix).toBe('');
    expect(r.stableRatio).toBe(0);
    expect(r.combined).toBe(r.runtimeBlock);
  });

  it('支持自定义 tag 与 extraPatterns', () => {
    const prompt = 'Keep this.\nBUILD=deadbeef';
    const r = splitStablePrefix(prompt, { tag: 'env', extraPatterns: [/BUILD=/] });
    expect(r.runtimeBlock).toBe('<env>\nBUILD=deadbeef\n</env>');
    expect(r.stablePrefix).toBe('Keep this.');
  });

  it('patterns 完全替换默认规则', () => {
    const prompt = "Today's date is 2026-06-09.\nFOO bar";
    // 用一个只认 FOO 的规则集 → 日期行不再被当易变
    const r = splitStablePrefix(prompt, { patterns: [/FOO/] });
    expect(r.stablePrefix).toContain('2026-06-09');
    expect(r.runtimeBlock).toContain('FOO bar');
  });

  it('带 /g 标志的自定义正则不会因 lastIndex 漂移而交替漏判', () => {
    const prompt = ['VER 2026-01-01', 'VER 2026-02-02', 'VER 2026-03-03', 'VER 2026-04-04'].join('\n');
    // 入口会去掉 g 标志：4 行应全部识别为易变，而非「匹配一次跳一次」只识别 2 行
    const r = splitStablePrefix(prompt, { patterns: [/VER \d{4}-\d{2}-\d{2}/g] });
    expect(r.volatileLines).toHaveLength(4);
    expect(r.stablePrefix).toBe('');
  });

  it('收紧后的时间规则不再误伤比例 / 章节 / 比例尺等稳定内容', () => {
    const prompt = [
      'Mix at ratio 1:30 parts water.',
      'Aspect ratio 16:9 preferred.',
      'See chapter 1:15 for details.',
      'Scale 1:50 model.',
    ].join('\n');
    const r = splitStablePrefix(prompt);
    expect(r.volatileLines).toHaveLength(0); // 全部留在稳定前缀
    expect(r.combined).toBe(prompt);
  });

  it('仍能识别真实时刻（HH:MM:SS / AM-PM / time 标签上下文）', () => {
    const prompt = [
      'Header.',
      'Logged at 14:01:46 today.',
      'Reminder 9:30 PM tonight.',
      'Current time: 14:05',
    ].join('\n');
    const r = splitStablePrefix(prompt);
    expect(r.volatileLines).toHaveLength(3);
    expect(r.stablePrefix).toBe('Header.');
  });

  it('易变行保留原始缩进（不被 trim）', () => {
    const prompt = "Stable.\n    Today's date is 2026-06-09.";
    const r = splitStablePrefix(prompt);
    expect(r.runtimeBlock).toContain("    Today's date is 2026-06-09."); // 缩进保真
  });

  it('空 / 非字符串输入安全', () => {
    expect(splitStablePrefix('')).toMatchObject({ stablePrefix: '', combined: '', stableRatio: 1 });
    expect(splitStablePrefix(null)).toMatchObject({ combined: '' });
    expect(splitStablePrefix(undefined)).toMatchObject({ combined: '' });
  });

  it('默认规则集是非空的正则数组', () => {
    expect(DEFAULT_VOLATILE_PATTERNS.length).toBeGreaterThan(5);
    expect(DEFAULT_VOLATILE_PATTERNS.every((re) => re instanceof RegExp)).toBe(true);
  });
});

describe('buildCacheablePrompt', () => {
  it('稳定段与易变段分开组装', () => {
    const r = buildCacheablePrompt(
      ['You are Noe.', 'Follow the rules.'],
      ['Date: 2026-06-09', 'cwd: /tmp'],
    );
    expect(r.stablePrefix).toBe('You are Noe.\n\nFollow the rules.');
    expect(r.runtimeBlock).toBe('<runtime>\nDate: 2026-06-09\ncwd: /tmp\n</runtime>');
    expect(r.combined).toBe(`${r.stablePrefix}\n\n${r.runtimeBlock}`);
  });

  it('无易变段时不产出 runtime 块，combined 即稳定前缀', () => {
    const r = buildCacheablePrompt('Only stable.', []);
    expect(r.runtimeBlock).toBe('');
    expect(r.combined).toBe('Only stable.');
  });

  it('接受字符串形态的入参并自定义 tag', () => {
    const r = buildCacheablePrompt('S', 'V', { tag: 'ctx' });
    expect(r.combined).toBe('S\n\n<ctx>\nV\n</ctx>');
  });
});
