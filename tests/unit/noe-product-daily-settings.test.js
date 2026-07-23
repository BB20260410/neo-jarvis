// @ts-check
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NoeProductDailySettingsStore,
  cleanProductDailySettings,
  toPublicProductSettingsDto,
  productSettingsDtoHasNoSecrets,
} from '../../src/runtime/NoeProductDailySettings.js';

describe('NoeProductDailySettings', () => {
  it('round-trips modelBaseUrl + modelId + voice via temp store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-product-settings-'));
    const file = join(dir, 'settings.json');
    try {
      const store = new NoeProductDailySettingsStore({ file });
      const saved = store.update({
        modelBaseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'local-gemma',
        voiceEnabled: false,
      });
      expect(saved.modelBaseUrl).toBe('http://127.0.0.1:1234/v1');
      expect(saved.modelId).toBe('local-gemma');
      expect(saved.voiceEnabled).toBe(false);
      expect(productSettingsDtoHasNoSecrets(saved)).toBe(true);

      const reloaded = new NoeProductDailySettingsStore({ file });
      const again = reloaded.status();
      expect(again.modelBaseUrl).toBe('http://127.0.0.1:1234/v1');
      expect(again.modelId).toBe('local-gemma');
      expect(again.voiceEnabled).toBe(false);

      const disk = JSON.parse(readFileSync(file, 'utf-8'));
      expect(disk.modelBaseUrl).toBe('http://127.0.0.1:1234/v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('public DTO never echoes apiKey / token keys or sk- values', () => {
    const dirty = {
      modelBaseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-x',
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      token: 'secret-token-value',
      voiceEnabled: true,
    };
    const dto = toPublicProductSettingsDto(dirty);
    expect(dto.apiKey).toBeUndefined();
    expect(dto.token).toBeUndefined();
    expect(productSettingsDtoHasNoSecrets(dto)).toBe(true);
    expect(JSON.stringify(dto)).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz/);

    const redactedUrl = toPublicProductSettingsDto({
      modelBaseUrl: 'https://x/sk-abcdefghijklmnopqrstuvwxyz012345',
      modelId: 'm',
    });
    expect(redactedUrl.modelBaseUrl).toBe('[REDACTED]');
  });

  it('cleanProductDailySettings clamps and defaults', () => {
    const c = cleanProductDailySettings({});
    expect(c.voiceEnabled).toBe(true);
    expect(c.modelBaseUrl).toBe('');
    expect(c.modelId).toBe('');
  });
});
