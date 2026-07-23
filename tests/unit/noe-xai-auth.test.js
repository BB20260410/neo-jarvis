import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { hasXaiCredentials, resolveXaiBrainConfig } from '../../src/room/NoeXaiAuth.js';

describe('hasXaiCredentials', () => {
  it('returns true when XAI_API_KEY is set', () => {
    expect(hasXaiCredentials({ XAI_API_KEY: 'test-key' })).toBe(true);
  });

  it('returns true when NOE_XAI_API_KEY is set', () => {
    expect(hasXaiCredentials({ NOE_XAI_API_KEY: 'test-key' })).toBe(true);
  });

  it('returns false when no env key and no oauth store', () => {
    expect(hasXaiCredentials({})).toBe(false);
  });

  it('returns false for whitespace-only api key', () => {
    expect(hasXaiCredentials({ XAI_API_KEY: '   ' })).toBe(false);
  });
});

describe('resolveXaiBrainConfig', () => {
  it('returns mode off when NOE_USE_XAI_BRAIN is not 1', () => {
    const cfg = resolveXaiBrainConfig({ XAI_API_KEY: 'k' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('off');
  });

  it('returns api_key mode when flag on and API key present (no oauth)', () => {
    const cfg = resolveXaiBrainConfig({
      NOE_USE_XAI_BRAIN: '1',
      XAI_API_KEY: 'k',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe('api_key');
  });

  it('returns off when flag on but no credentials', () => {
    const cfg = resolveXaiBrainConfig({ NOE_USE_XAI_BRAIN: '1' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('off');
  });

  it('applies default model, reasoningEffort and baseUrl', () => {
    const cfg = resolveXaiBrainConfig({});
    expect(cfg.model).toBe('grok-4.5');
    expect(cfg.reasoningEffort).toBe('high');
    expect(cfg.baseUrl).toBe('https://api.x.ai/v1');
  });

  it('honours custom model and baseUrl env overrides', () => {
    const cfg = resolveXaiBrainConfig({
      NOE_XAI_MODEL: 'grok-custom',
      XAI_BASE_URL: 'https://api.x.ai/custom',
      NOE_XAI_REASONING_EFFORT: 'low',
    });
    expect(cfg.model).toBe('grok-custom');
    expect(cfg.baseUrl).toBe('https://api.x.ai/custom');
    expect(cfg.reasoningEffort).toBe('low');
  });
});
