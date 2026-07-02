import { describe, expect, it } from 'vitest';
import { cleanGeminiCliOutput } from '../../src/room/GeminiSpawnAdapter.js';

// P1 去噪测试：gemini CLI PTY 输出清理（2026-06-10 实测 MCP 噪声混进正文同行）。

describe('cleanGeminiCliOutput', () => {
  it('剥除混在正文同行的 MCP 噪声（实测样本）', () => {
    expect(cleanGeminiCliOutput('MCP issues detected. Run /mcp list for status. 北京')).toBe('北京');
  });

  it('只有 MCP 短语没有后半句也剥', () => {
    expect(cleanGeminiCliOutput('MCP issues detected. 答案是 42')).toBe('答案是 42');
  });

  it('Warning / Ripgrep 整行剥除', () => {
    expect(cleanGeminiCliOutput('Warning: could not connect\nRipgrep is not available. fallback\n正文')).toBe('正文');
  });

  it('ANSI 转义与 CR 清理', () => {
    expect(cleanGeminiCliOutput('\x1B[32m你好\x1B[0m\r\n世界')).toBe('你好\n世界');
  });

  it('干净正文原样保留', () => {
    expect(cleanGeminiCliOutput('这是一段完整的模型回复。\n第二行。')).toBe('这是一段完整的模型回复。\n第二行。');
  });

  it('空输入返回空串', () => {
    expect(cleanGeminiCliOutput('')).toBe('');
    expect(cleanGeminiCliOutput(null)).toBe('');
  });
});
