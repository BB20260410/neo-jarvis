import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IdentityModelSettingsStore } from '../../src/identity/IdentityModelSettingsStore.js';

describe('IdentityModelSettingsStore', () => {
  it('persists face and voice model settings locally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-model-settings-'));
    const file = join(dir, 'settings.json');
    try {
      const store = new IdentityModelSettingsStore({ file });
      expect(store.status()).toMatchObject({ voice: { enabled: true, engine: 'campplus' }, face: { enabled: true } });
      store.update({ voiceEnabled: false, voiceEngine: 'voice-lite', faceEnabled: false });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const reloaded = new IdentityModelSettingsStore({ file });
      expect(reloaded.status()).toMatchObject({ voice: { enabled: false, engine: 'voice-lite' }, face: { enabled: false } });
      reloaded.update({ voiceEngine: 'unknown', voiceEnabled: true, faceEnabled: true });
      expect(reloaded.status()).toMatchObject({ voice: { enabled: true, engine: 'campplus' }, face: { enabled: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
