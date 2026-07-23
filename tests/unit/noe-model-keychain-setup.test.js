import { describe, expect, it } from 'vitest';
import {
  buildSecurityAddGenericPasswordArgs,
  findExistingSecretAccountForProfile,
  PROVIDERS,
} from '../../scripts/noe-model-keychain-setup.mjs';
import {
  NOE_MODEL_KEYCHAIN_SERVICE,
  NOE_PROVIDER_SECRET_PROFILES,
} from '../../src/secrets/NoeProviderSecrets.js';

describe('noe-model-keychain-setup', () => {
  it('covers every provider secret profile so setup/check stay in sync', () => {
    expect(PROVIDERS).toEqual(Object.keys(NOE_PROVIDER_SECRET_PROFILES));
    expect(PROVIDERS).toEqual(expect.arrayContaining(['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic']));
  });

  it('prompts through security without putting the secret in argv', () => {
    const fakeSecret = 'tp-unit-redacted-key-that-must-not-enter-argv';
    const args = buildSecurityAddGenericPasswordArgs({
      account: 'MIMO_API_KEY',
      label: 'Xiaomi MiMo',
    });

    expect(args[0]).toBe('add-generic-password');
    expect(args).toContain('-U');
    expect(args).not.toContain('-A');
    expect(args).toContain('-T');
    expect(args[args.indexOf('-T') + 1]).toBe('/usr/bin/security');
    expect(args).toContain(NOE_MODEL_KEYCHAIN_SERVICE);
    expect(args).toContain('MIMO_API_KEY');
    expect(args.at(-1)).toBe('-w');
    expect(args).not.toContain(fakeSecret);
    expect(JSON.stringify(args)).not.toContain('tp-unit-redacted');
  });

  it('detects existing provider secrets across alternate keychain account names', () => {
    const calls = [];
    const out = findExistingSecretAccountForProfile(NOE_PROVIDER_SECRET_PROFILES.xiaomi, {
      keychainReader: ({ account }) => {
        calls.push(account);
        return account === 'MIMO_API_KEY'
          ? { ok: true, value: 'redacted' }
          : { ok: false, error: 'not found' };
      },
    });

    expect(out).toEqual({ ok: true, account: 'MIMO_API_KEY' });
    expect(calls).toContain('XIAOMI_API_KEY');
    expect(calls).toContain('MIMO_API_KEY');
    expect(calls).not.toContain('xiaomi');
  });
});
