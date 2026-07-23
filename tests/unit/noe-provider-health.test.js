import { describe, expect, it } from 'vitest';
import {
  auditNoeProviderHealth,
  probeNoeProviderHealth,
} from '../../src/secrets/NoeProviderHealth.js';

function jsonResponse(status, data) {
  return {
    status,
    text: async () => JSON.stringify(data),
  };
}

function resolverWith(values = {}) {
  return (provider) => values[provider]
    ? { ok: true, provider, value: values[provider], source: 'unit', sourceRef: `${provider}_unit` }
    : { ok: false, provider, source: 'unconfigured', error: `${provider} missing` };
}

describe('NoeProviderHealth', () => {
  it('does not call provider health endpoints when the provider secret is missing', async () => {
    const calls = [];
    const out = await probeNoeProviderHealth('minimax', {
      secretResolver: resolverWith({}),
      fetchImpl: async () => { calls.push('called'); return jsonResponse(200, {}); },
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({
      ok: false,
      provider: 'minimax',
      status: 'secret_unconfigured',
      reachable: false,
      secretValuesReturned: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('checks OpenAI-compatible providers through the models endpoint without returning secret values', async () => {
    const calls = [];
    const out = await probeNoeProviderHealth('xiaomi', {
      secretResolver: resolverWith({ xiaomi: 'fake-xiaomi-unithealth-000000000000000000000000' }),
      env: { XIAOMI_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1', XIAOMI_MODEL: 'mimo-v2.5-pro' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        expect(init.headers.Authorization).toMatch(/^Bearer /);
        return jsonResponse(200, { data: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2.5' }] });
      },
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({
      ok: true,
      provider: 'xiaomi',
      status: 'reachable',
      httpStatus: 200,
      modelCount: 2,
      selectedModelListed: true,
      secretValuesReturned: false,
    });
    expect(calls[0].url).toBe('https://token-plan-cn.xiaomimimo.com/v1/models');
    expect(JSON.stringify(out)).not.toContain('unithealth');
  });

  it('checks Gemini models through query-key auth but redacts the key from outputs', async () => {
    const calls = [];
    const out = await probeNoeProviderHealth('gemini', {
      secretResolver: resolverWith({ gemini: 'fake-gemini-unithealth-000000000000000000000000' }),
      env: { GEMINI_MODEL: 'gemini-3.1-pro-preview' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        expect(url).toContain('key=');
        return jsonResponse(200, { models: [{ name: 'models/gemini-3.1-pro-preview' }] });
      },
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({
      ok: true,
      provider: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      modelCount: 1,
      selectedModelListed: true,
      secretValuesReturned: false,
    });
    expect(calls[0].init.headers).toEqual({ Accept: 'application/json' });
    expect(JSON.stringify(out)).not.toContain('unithealth');
    expect(JSON.stringify(out)).not.toContain('key=');
  });

  it('checks the selected model against the full model list while only outputting a small sample', async () => {
    const data = { data: Array.from({ length: 14 }, (_, i) => ({ id: i === 13 ? 'mimo-v2.5-pro' : `model-${i}` })) };
    const out = await probeNoeProviderHealth('xiaomi', {
      secretResolver: resolverWith({ xiaomi: 'fake-xiaomi-unithealth-000000000000000000000000' }),
      env: { XIAOMI_MODEL: 'mimo-v2.5-pro' },
      fetchImpl: async () => jsonResponse(200, data),
      roomConfigLoader: () => ({}),
    });

    expect(out.modelCount).toBe(14);
    expect(out.sampleModels).toHaveLength(12);
    expect(out.sampleModels).not.toContain('mimo-v2.5-pro');
    expect(out.selectedModelListed).toBe(true);
  });

  it('redacts provider error bodies and classifies auth failures', async () => {
    const out = await probeNoeProviderHealth('openai', {
      secretResolver: resolverWith({ openai: 'sk-unithealth-openai-000000000000000000' }),
      fetchImpl: async () => ({
        status: 401,
        text: async () => 'invalid API key sk-unithealth-openai-000000000000000000',
      }),
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({
      ok: false,
      provider: 'openai',
      status: 'auth_failed',
      httpStatus: 401,
    });
    expect(JSON.stringify(out)).not.toContain('unithealth');
  });

  it('audits multiple provider health checks and reports unavailable providers', async () => {
    const out = await auditNoeProviderHealth({
      providers: ['minimax', 'xiaomi', 'gemini'],
      secretResolver: resolverWith({
        minimax: 'sk-unithealth-minimax-000000000000000000',
        xiaomi: 'fake-xiaomi-unithealth-000000000000000000000000',
      }),
      fetchImpl: async (url) => url.includes('xiaomimimo')
        ? jsonResponse(429, { error: 'quota' })
        : jsonResponse(200, { data: [{ id: 'MiniMax-M3' }] }),
      roomConfigLoader: () => ({}),
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'provider-health-readiness',
      providerCount: 3,
      configuredCount: 2,
      reachableCount: 2,
      authOkCount: 1,
      secretValuesReturned: false,
    });
    expect(out.unavailableProviders).toEqual(['xiaomi', 'gemini']);
    expect(JSON.stringify(out)).not.toContain('unithealth');
  });
});
