// Gemini 自动降级链：配额满 → 自动切下一个 model 的核心是 buildGeminiFallbackChain 这个纯函数。
// 整个 spawn/PTY 部分在 in-process 单测里 mock 成本太高，这里只覆盖链构造逻辑——
// 保证：用户指定的 model 永远在链首，剩余 fallback 不重复、不漏。

import { describe, it, expect } from 'vitest';
import {
  buildGeminiFallbackChain,
  buildGeminiLivePingFallbackChain,
  GEMINI_FALLBACK_CHAIN,
  GEMINI_LIVE_PING_CHAIN,
  normalizeGeminiPreferredModel,
} from '../../../src/room/GeminiSpawnAdapter.js';

describe('buildGeminiFallbackChain', () => {
  it('默认链：从高能力到稳定到次稳', () => {
    expect(GEMINI_FALLBACK_CHAIN).toEqual(['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  it('不指定 preferred → 直接返回默认链副本（非引用）', () => {
    const c = buildGeminiFallbackChain();
    expect(c).toEqual(GEMINI_FALLBACK_CHAIN);
    expect(c).not.toBe(GEMINI_FALLBACK_CHAIN); // 副本
  });

  it('preferred 在默认链里 → 提到链首，剩余作 fallback', () => {
    expect(buildGeminiFallbackChain('gemini-2.5-flash'))
      .toEqual(['gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']);
    expect(buildGeminiFallbackChain('gemini-2.5-flash-lite'))
      .toEqual(['gemini-2.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('preferred 不在默认链里 → 放链首，默认链全部作为 fallback', () => {
    expect(buildGeminiFallbackChain('custom-gemini-model'))
      .toEqual(['custom-gemini-model', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  it('gemini-3.1 UI 输入保持最强模型，未知 3.5 输入映射到稳定 flash 链', () => {
    expect(normalizeGeminiPreferredModel('gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    expect(normalizeGeminiPreferredModel('gemini-3.5-flash')).toBe('gemini-2.5-flash');
    expect(buildGeminiFallbackChain('gemini-3.5-flash'))
      .toEqual(['gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']);
  });

  it('live ping 使用快速稳定链，不先消耗 pro 或无效 3.x', () => {
    expect(GEMINI_LIVE_PING_CHAIN).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    expect(buildGeminiLivePingFallbackChain('gemini-2.5-pro'))
      .toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    expect(buildGeminiLivePingFallbackChain('gemini-3.5-flash'))
      .toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  it('preferred=链首本身 → chain 不重复，等同默认链', () => {
    expect(buildGeminiFallbackChain('gemini-3.1-pro-preview'))
      .toEqual(['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  it('空串 / null / undefined 都按"无 preferred"处理', () => {
    expect(buildGeminiFallbackChain('')).toEqual(GEMINI_FALLBACK_CHAIN);
    expect(buildGeminiFallbackChain(null)).toEqual(GEMINI_FALLBACK_CHAIN);
    expect(buildGeminiFallbackChain(undefined)).toEqual(GEMINI_FALLBACK_CHAIN);
  });
});
