import {
  NOE_PROVIDER_SECRET_PROFILES,
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from './NoeProviderSecrets.js';
import { loadRoomAdaptersConfig } from '../room/RoomAdaptersConfig.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';
const DEFAULT_XIAOMI_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

const DEFAULT_MODELS = Object.freeze({
  minimax: 'MiniMax-M3',
  xiaomi: 'mimo-v2.5-pro',
  gemini: 'gemini-3.1-pro-preview',
  openai: '',
  anthropic: '',
});

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim())
    .replace(/([?&](?:key|api_key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, max);
}

function normalizeProviders(providers) {
  const input = providers === undefined || providers === null ? Object.keys(NOE_PROVIDER_SECRET_PROFILES) : providers;
  const list = Array.isArray(input) ? input : String(input).split(',');
  return [...new Set(list.map((item) => clean(item, 80)).filter(Boolean))]
    .filter((provider) => NOE_PROVIDER_SECRET_PROFILES[provider])
    .slice(0, 20);
}

function firstCustom(config = {}, pattern) {
  return Array.isArray(config.customs)
    ? config.customs.find((item) => pattern.test(`${item.id} ${item.displayName} ${item.baseUrl} ${item.model}`))
    : null;
}

function loadConfig(roomConfigLoader) {
  try { return roomConfigLoader?.() || {}; } catch { return {}; }
}

function runtimeConfigForProvider(provider, { env = process.env, config = {} } = {}) {
  if (provider === 'minimax') {
    return {
      baseUrl: clean(env.MINIMAX_BASE_URL || config.minimax?.baseUrl || DEFAULT_MINIMAX_BASE_URL, 1000),
      model: clean(env.MINIMAX_MODEL || config.minimax?.model || DEFAULT_MODELS.minimax, 200),
      healthPath: '/models',
      auth: 'bearer',
    };
  }
  if (provider === 'xiaomi') {
    const custom = firstCustom(config, /xiaomi|mimo/i);
    return {
      baseUrl: clean(env.XIAOMI_BASE_URL || custom?.baseUrl || DEFAULT_XIAOMI_BASE_URL, 1000),
      model: clean(env.XIAOMI_MODEL || custom?.model || DEFAULT_MODELS.xiaomi, 200),
      healthPath: '/models',
      auth: 'bearer',
    };
  }
  if (provider === 'gemini') {
    const custom = firstCustom(config, /gemini|google/i);
    return {
      baseUrl: clean(env.GEMINI_BASE_URL || config.gemini?.baseUrl || custom?.baseUrl || DEFAULT_GEMINI_BASE_URL, 1000),
      model: clean(env.GEMINI_MODEL || config.gemini?.model || custom?.model || DEFAULT_MODELS.gemini, 200),
      healthPath: '/models',
      auth: 'query_key',
    };
  }
  if (provider === 'openai') {
    const custom = firstCustom(config, /openai|codex|gpt/i);
    return {
      baseUrl: clean(env.OPENAI_BASE_URL || config.openai?.baseUrl || custom?.baseUrl || DEFAULT_OPENAI_BASE_URL, 1000),
      model: clean(env.OPENAI_MODEL || config.openai?.model || custom?.model || DEFAULT_MODELS.openai, 200),
      healthPath: '/models',
      auth: 'bearer',
    };
  }
  if (provider === 'anthropic') {
    const custom = firstCustom(config, /anthropic|claude/i);
    return {
      baseUrl: clean(env.ANTHROPIC_BASE_URL || config.anthropic?.baseUrl || custom?.baseUrl || DEFAULT_ANTHROPIC_BASE_URL, 1000),
      model: clean(env.ANTHROPIC_MODEL || config.anthropic?.model || custom?.model || DEFAULT_MODELS.anthropic, 200),
      healthPath: '/models',
      auth: 'anthropic',
    };
  }
  return { baseUrl: '', model: '', healthPath: '/models', auth: 'bearer' };
}

function buildRequest({ provider, runtime, apiKey }) {
  void provider;   // 预留字段（按 provider 差异化构建请求时启用）；保留解构名维持契约（2026-06-10 清 lint）
  const base = runtime.baseUrl.replace(/\/$/, '');
  const path = runtime.healthPath || '/models';
  const safeEndpoint = `${base}${path}`;
  if (runtime.auth === 'query_key') {
    return {
      url: `${safeEndpoint}?key=${encodeURIComponent(apiKey)}`,
      endpoint: safeEndpoint,
      init: { method: 'GET', headers: { Accept: 'application/json' } },
    };
  }
  if (runtime.auth === 'anthropic') {
    return {
      url: safeEndpoint,
      endpoint: safeEndpoint,
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
    };
  }
  return {
    url: safeEndpoint,
    endpoint: safeEndpoint,
    init: {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
  };
}

function modelIdFromEntry(entry = {}) {
  const id = entry.id || entry.name || entry.model || '';
  return clean(String(id).replace(/^models\//, ''), 240);
}

function parseModelList(data = {}) {
  const raw = Array.isArray(data.data) ? data.data
    : Array.isArray(data.models) ? data.models
      : Array.isArray(data) ? data
        : [];
  const models = raw.map(modelIdFromEntry).filter(Boolean);
  return {
    ids: models,
    count: models.length,
    sample: models.slice(0, 12),
  };
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'reachable';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'models_endpoint_not_found';
  if (status === 429) return 'rate_limited_or_quota';
  if (status >= 500) return 'provider_server_error';
  return 'request_failed';
}

export async function probeNoeProviderHealth(provider, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  secretResolver = resolveNoeProviderSecret,
  roomConfigLoader = loadRoomAdaptersConfig,
} = {}) {
  const profile = NOE_PROVIDER_SECRET_PROFILES[provider];
  if (!profile) return { ok: false, provider, status: 'unknown_provider', error: `unknown_provider:${clean(provider, 80)}` };
  const secret = secretResolver(provider, { env, roomConfigLoader });
  const config = loadConfig(roomConfigLoader);
  const runtime = runtimeConfigForProvider(provider, { env, config });
  const base = {
    provider,
    label: profile.label,
    configured: secret?.ok === true,
    secretSource: secret?.source || 'unconfigured',
    secretSourceRef: secret?.ok ? secret.sourceRef || '' : '',
    baseUrl: runtime.baseUrl,
    endpoint: runtime.baseUrl ? `${runtime.baseUrl.replace(/\/$/, '')}${runtime.healthPath || '/models'}` : '',
    model: runtime.model || '',
    healthCheck: 'models_endpoint',
    valueReturned: false,
    secretValuesReturned: false,
  };
  const apiKey = secret?.value || '';
  if (!apiKey) {
    return {
      ...base,
      ok: false,
      reachable: false,
      authOk: false,
      status: 'secret_unconfigured',
      error: describeNoeProviderSecretFailure(provider, secret),
    };
  }
  if (typeof fetchImpl !== 'function') {
    return { ...base, ok: false, reachable: false, authOk: false, status: 'fetch_unavailable', error: 'fetch_unavailable' };
  }

  const request = buildRequest({ provider, runtime, apiKey });
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(request.url, request.init);
    const status = Number(response?.status) || 0;
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch {}
    const models = status >= 200 && status < 300 ? parseModelList(data || {}) : { ids: [], count: 0, sample: [] };
    return {
      ...base,
      endpoint: request.endpoint,
      ok: status >= 200 && status < 300,
      reachable: status > 0,
      authOk: status >= 200 && status < 300,
      status: classifyStatus(status),
      httpStatus: status,
      elapsedMs: Date.now() - startedAt,
      modelCount: models.count,
      sampleModels: models.sample,
      selectedModelListed: runtime.model ? models.ids.includes(runtime.model) : undefined,
      error: status >= 200 && status < 300 ? '' : clean(text || `http_${status}`, 1000),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      reachable: false,
      authOk: false,
      status: 'network_error',
      elapsedMs: Date.now() - startedAt,
      error: clean(error?.message || error, 1000),
    };
  }
}

export async function auditNoeProviderHealth({
  providers,
  env = process.env,
  fetchImpl = globalThis.fetch,
  secretResolver = resolveNoeProviderSecret,
  roomConfigLoader = loadRoomAdaptersConfig,
} = {}) {
  const ids = normalizeProviders(providers);
  const results = [];
  for (const provider of ids) {
    results.push(await probeNoeProviderHealth(provider, {
      env,
      fetchImpl,
      secretResolver,
      roomConfigLoader,
    }));
  }
  return {
    ok: true,
    adapter: 'provider-health-readiness',
    providers: results,
    providerCount: results.length,
    reachableCount: results.filter((item) => item.reachable === true).length,
    authOkCount: results.filter((item) => item.authOk === true).length,
    configuredCount: results.filter((item) => item.configured === true).length,
    unavailableProviders: results.filter((item) => item.ok !== true).map((item) => item.provider),
    valueReturned: false,
    secretValuesReturned: false,
  };
}
