import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOE_MEMORY_EMBED_BASEURL,
  DEFAULT_NOE_MEMORY_EMBED_MODEL,
  DEFAULT_NOE_MEMORY_EMBED_PROVIDER,
  resolveNoeMemorySemanticConfig,
} from '../../src/memory/NoeMemorySemanticConfig.js';

describe('resolveNoeMemorySemanticConfig', () => {
  it('defaults to the local ollama qwen3 semantic provider for the free profile', () => {
    expect(resolveNoeMemorySemanticConfig({})).toMatchObject({
      enabled: true,
      provider: DEFAULT_NOE_MEMORY_EMBED_PROVIDER,
      model: DEFAULT_NOE_MEMORY_EMBED_MODEL,
      baseUrl: DEFAULT_NOE_MEMORY_EMBED_BASEURL,
      source: 'default',
    });
  });

  it('enables the configured provider and applies the local qwen3 model default for ollama', () => {
    expect(resolveNoeMemorySemanticConfig({ NOE_MEMORY_EMBED: 'ollama' })).toMatchObject({
      enabled: true,
      provider: 'ollama',
      model: DEFAULT_NOE_MEMORY_EMBED_MODEL,
      source: 'NOE_MEMORY_EMBED',
    });
  });

  it('keeps the semantic provider off when the autonomy profile is explicitly minimal', () => {
    expect(resolveNoeMemorySemanticConfig({ NOE_AUTONOMY_PROFILE: 'off' })).toMatchObject({
      enabled: false,
      disabledExplicitly: false,
      provider: '',
      source: '',
    });
  });

  it('honors the provider alias and ollama base URL aliases', () => {
    expect(resolveNoeMemorySemanticConfig({
      NOE_MEMORY_EMBED_PROVIDER: 'ollama',
      NOE_MEMORY_EMBED_MODEL: 'embed-custom',
      NOE_OLLAMA_URL: 'http://ollama.local',
    })).toMatchObject({
      enabled: true,
      provider: 'ollama',
      model: 'embed-custom',
      baseUrl: 'http://ollama.local',
      source: 'NOE_MEMORY_EMBED_PROVIDER',
    });
  });

  it('treats explicit off values as disabled instead of provider names', () => {
    expect(resolveNoeMemorySemanticConfig({ NOE_MEMORY_EMBED: '0' })).toMatchObject({
      enabled: false,
      disabledExplicitly: true,
      provider: '',
      source: 'NOE_MEMORY_EMBED',
    });
  });
});
