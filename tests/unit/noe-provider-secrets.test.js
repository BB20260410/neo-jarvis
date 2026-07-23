import { describe, expect, it } from 'vitest';
import {
  auditNoeProviderSecrets,
  checkMacosKeychainSecretPresence,
  describeNoeProviderSecretFailure,
  readMacosKeychainSecret,
  resolveNoeProviderSecret,
} from '../../src/secrets/NoeProviderSecrets.js';
import { runM3SuggestionTask } from '../../src/room/MiniMaxSuggestionPipeline.js';
import { createWebSearch } from '../../src/research/WebSearch.js';
import { MiniMaxTtsClient } from '../../src/voice/MiniMaxTtsClient.js';
import { discoverChatModels } from '../../src/voice/ChatModelCatalog.js';

function validM3Plan() {
  return JSON.stringify({
    actions: ['suggestions'],
    diffs: [],
    suggestions: ['ok'],
    risk_notes: [],
    product_gaps: [],
    evidence_gaps: [],
    patch_suggestions: [],
    do_not_block_reason: 'unit test',
    final_authority: 'Claude/GPT-Codex',
  });
}

describe('NoeProviderSecrets', () => {
  it('uses environment variables before keychain or config', () => {
    const out = resolveNoeProviderSecret('minimax', {
      env: { MINIMAX_API_KEY: 'env-key' },
      keychainReader: () => ({ ok: true, value: 'keychain-key' }),
      roomConfigLoader: () => ({ minimax: { apiKey: 'config-key' } }),
    });

    expect(out).toMatchObject({ ok: true, source: 'env', sourceRef: 'MINIMAX_API_KEY' });
    expect(out.value).toBe('env-key');
  });

  it('falls back to macOS Keychain when env is absent', () => {
    const out = resolveNoeProviderSecret('xiaomi', {
      env: {},
      keychainReader: ({ account }) => account === 'MIMO_API_KEY'
        ? { ok: true, value: 'keychain-xiaomi-key' }
        : { ok: false, error: 'not found' },
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({ ok: true, source: 'keychain', sourceRef: 'MIMO_API_KEY' });
    expect(out.value).toBe('keychain-xiaomi-key');
  });

  it('falls back to existing room adapter config without printing the value', () => {
    const out = resolveNoeProviderSecret('minimax', {
      env: {},
      keychainReader: () => ({ ok: false, error: 'not found' }),
      roomConfigLoader: () => ({ minimax: { apiKey: 'room-config-key' } }),
    });

    expect(out).toMatchObject({ ok: true, source: 'room-adapters-config', sourceRef: 'minimax' });
    expect(out.value).toBe('room-config-key');
  });

  it('audits provider readiness across online model providers without returning secret values', () => {
    const out = auditNoeProviderSecrets({
      providers: ['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic'],
      env: {
        MINIMAX_API_KEY: 'sk-unitsecret-minimax-000000000000000000',
        GEMINI_API_KEY: 'fake-gemini-unitsecret-000000000000000000',
      },
      keychainReader: ({ account }) => account === 'MIMO_API_KEY'
        ? { ok: true, value: 'tp-unitsecret-xiaomi-000000000000000000' }
        : { ok: false, error: 'not found secret-value' },
      roomConfigLoader: () => ({
        openai: { apiKey: 'sk-unitsecret-openai-000000000000000000' },
        customs: [{ id: 'claude-online', displayName: 'Claude', apiKey: 'fake-anthropic-unitsecret-000000000000000000' }],
      }),
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'provider-secret-readiness',
      configuredCount: 5,
      missingCount: 0,
      secretValuesReturned: false,
    });
    expect(out.configuredProviders).toEqual(['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic']);
    expect(out.providers.find((item) => item.provider === 'minimax')).toMatchObject({ configured: true, source: 'env', sourceRef: 'MINIMAX_API_KEY' });
    expect(out.providers.find((item) => item.provider === 'xiaomi')).toMatchObject({ configured: true, source: 'keychain', sourceRef: 'MIMO_API_KEY' });
    expect(out.providers.find((item) => item.provider === 'anthropic')).toMatchObject({ configured: true, source: 'room-adapters-config' });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('unitsecret');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('value":"');
  });

  it('reports unconfigured providers with setup guidance but no secret value', () => {
    const out = resolveNoeProviderSecret('xiaomi', {
      env: {},
      keychainReader: () => ({ ok: false, error: 'not found tp-unitsecret000000000000000000000000000000' }),
      roomConfigLoader: () => ({ customs: [] }),
    });
    const message = describeNoeProviderSecretFailure('xiaomi', out);

    expect(out.ok).toBe(false);
    expect(message).toContain('npm run noe:keys:model:setup');
    expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
    expect(message).not.toContain('tp-unitsecret');
  });

  it('reads macOS keychain through security without putting the secret in argv', () => {
    const calls = [];
    const out = readMacosKeychainSecret({
      account: 'MINIMAX_API_KEY',
      platform: 'darwin',
      spawnSyncImpl: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: 'key-from-keychain\n', stderr: '' };
      },
    });

    expect(out).toEqual({ ok: true, value: 'key-from-keychain' });
    expect(calls[0].cmd).toBe('security');
    expect(calls[0].args).toEqual([
      'find-generic-password',
      '-a',
      'MINIMAX_API_KEY',
      '-s',
      'Neo Jarvis Noe model API keys',
      '-w',
    ]);
    expect(calls[0].args).not.toContain('key-from-keychain');
  });

  it('checks macOS keychain presence without requesting the secret value', () => {
    const calls = [];
    const out = checkMacosKeychainSecretPresence({
      account: 'MINIMAX_API_KEY',
      platform: 'darwin',
      spawnSyncImpl: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(out).toMatchObject({
      ok: true,
      source: 'keychain',
      sourceRef: 'MINIMAX_API_KEY',
      valueReturned: false,
      rawValueRead: false,
    });
    expect(calls[0].cmd).toBe('security');
    expect(calls[0].args).toEqual([
      'find-generic-password',
      '-a',
      'MINIMAX_API_KEY',
      '-s',
      'Neo Jarvis Noe model API keys',
    ]);
    expect(calls[0].args).not.toContain('-w');
    expect(calls[0].args).not.toContain('-g');
  });

  it('keeps high-use MiniMax paths working from the shared resolver when env is absent', async () => {
    const resolver = (provider) => ({ ok: provider === 'minimax', value: 'keychain-shared-key', source: 'keychain', sourceRef: 'MINIMAX_API_KEY' });

    const m3 = await runM3SuggestionTask({
      taskType: 'evidence_review',
      context: 'P0 resolver integration',
    }, {
      secretResolver: resolver,
      adapter: { _doChat: async () => ({ reply: validM3Plan() }) },
    });
    expect(m3.ok).toBe(true);

    const tts = new MiniMaxTtsClient({ secretResolver: resolver });
    expect(tts.configured()).toBe(true);
    expect(tts.secretStatus).toMatchObject({ ok: true, source: 'keychain', sourceRef: 'MINIMAX_API_KEY' });

    const web = createWebSearch({
      secretResolver: resolver,
      fetchImpl: async (_url, req) => {
        expect(req.headers.Authorization).toBe('Bearer keychain-shared-key');
        return { ok: true, json: async () => ({ organic: [{ title: 'R', link: 'https://example.com', snippet: 'S' }] }) };
      },
    });
    expect((await web.search('q'))[0]).toMatchObject({ source: 'minimax', title: 'R' });
    expect(web.status()).toMatchObject({ minimax: true, minimaxKeySource: 'keychain' });

    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u === 'http://lm.invalid/v1/models') return { ok: false, status: 503, text: async () => '' };
      if (u === 'http://ollama.invalid/api/tags') return { ok: false, status: 503, text: async () => '' };
      if (u === 'https://api.minimax.chat/v1/models') return { ok: false, status: 405, text: async () => '' };
      return { ok: false, status: 404, text: async () => '' };
    };
    try {
      const catalog = await discoverChatModels({
        env: { NOE_LMSTUDIO_URL: 'http://lm.invalid/v1', NOE_OLLAMA_URL: 'http://ollama.invalid', PATH: '' },
        getAdapter: () => null,
        secretResolver: resolver,
      });
      const minimax = catalog.providers.find((item) => item.id === 'minimax');
      expect(minimax).toMatchObject({ available: true, secretStatus: { configured: true, source: 'keychain', sourceRef: 'MINIMAX_API_KEY' } });
    } finally {
      globalThis.fetch = oldFetch;
    }

    const serialized = JSON.stringify({ m3, tts: tts.secretStatus, web: web.status() });
    expect(serialized).not.toContain('keychain-shared-key');
  });
});
