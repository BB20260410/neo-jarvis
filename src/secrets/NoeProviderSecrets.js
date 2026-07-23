import { spawnSync } from 'node:child_process';
import { loadRoomAdaptersConfig } from '../room/RoomAdaptersConfig.js';

export const NOE_MODEL_KEYCHAIN_SERVICE = 'Neo Jarvis Noe model API keys';

export const NOE_PROVIDER_SECRET_PROFILES = {
  minimax: {
    label: 'MiniMax M3',
    envNames: ['MINIMAX_API_KEY'],
    keychainAccounts: ['MINIMAX_API_KEY', 'minimax', 'MiniMax-M3'],
    configReaders: [
      (config) => config?.minimax?.apiKey,
    ],
  },
  xiaomi: {
    label: 'Xiaomi MiMo',
    envNames: ['XIAOMI_API_KEY', 'MIMO_API_KEY'],
    keychainAccounts: ['XIAOMI_API_KEY', 'MIMO_API_KEY', 'xiaomi', 'mimo', 'Xiaomi-MiMo'],
    configReaders: [
      (config) => (Array.isArray(config?.customs)
        ? config.customs.find((item) => /xiaomi|mimo/i.test(`${item.id} ${item.displayName} ${item.baseUrl} ${item.model}`))?.apiKey
        : ''),
    ],
  },
  gemini: {
    label: 'Google Gemini',
    envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    keychainAccounts: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'gemini', 'Google-Gemini'],
    configReaders: [
      (config) => config?.gemini?.apiKey,
      (config) => (Array.isArray(config?.customs)
        ? config.customs.find((item) => /gemini|google/i.test(`${item.id} ${item.displayName} ${item.baseUrl} ${item.model}`))?.apiKey
        : ''),
    ],
  },
  openai: {
    label: 'OpenAI / Codex',
    envNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    keychainAccounts: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'openai', 'codex', 'OpenAI-Codex'],
    configReaders: [
      (config) => config?.openai?.apiKey,
      (config) => config?.codex?.apiKey,
      (config) => (Array.isArray(config?.customs)
        ? config.customs.find((item) => /openai|codex|gpt/i.test(`${item.id} ${item.displayName} ${item.baseUrl} ${item.model}`))?.apiKey
        : ''),
    ],
  },
  anthropic: {
    label: 'Anthropic Claude',
    envNames: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    keychainAccounts: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'anthropic', 'claude', 'Anthropic-Claude'],
    configReaders: [
      (config) => config?.anthropic?.apiKey,
      (config) => config?.claude?.apiKey,
      (config) => (Array.isArray(config?.customs)
        ? config.customs.find((item) => /anthropic|claude/i.test(`${item.id} ${item.displayName} ${item.baseUrl} ${item.model}`))?.apiKey
        : ''),
    ],
  },
};

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function secretPresent(value) {
  return clean(value).length > 0 && !clean(value).includes('...');
}

function sanitizeError(error) {
  return clean(error?.message || error || '', 300)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-api-key]')
    .replace(/tp-[a-z0-9]{20,}/gi, '[redacted-api-key]')
    .replace(/(api[_-]?key|token|secret|password)[=:]\S+/gi, '$1=[redacted]');
}

export function readMacosKeychainSecret({
  account,
  service = NOE_MODEL_KEYCHAIN_SERVICE,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
} = {}) {
  const normalizedAccount = clean(account, 200);
  if (!normalizedAccount) return { ok: false, error: 'keychain_account_required' };
  if (platform !== 'darwin') return { ok: false, error: 'macos_keychain_unavailable' };
  try {
    const result = spawnSyncImpl('security', [
      'find-generic-password',
      '-a', normalizedAccount,
      '-s', service,
      '-w',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const value = clean(result.stdout);
    if (result.status === 0 && secretPresent(value)) return { ok: true, value };
    return {
      ok: false,
      error: sanitizeError(result.stderr || result.error || `security_exit_${result.status}`) || 'keychain_secret_not_found',
    };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) || 'keychain_read_failed' };
  }
}

export function checkMacosKeychainSecretPresence({
  account,
  service = NOE_MODEL_KEYCHAIN_SERVICE,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
} = {}) {
  const normalizedAccount = clean(account, 200);
  if (!normalizedAccount) return { ok: false, error: 'keychain_account_required' };
  if (platform !== 'darwin') return { ok: false, error: 'macos_keychain_unavailable' };
  try {
    const result = spawnSyncImpl('security', [
      'find-generic-password',
      '-a', normalizedAccount,
      '-s', service,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (result.status === 0) {
      return {
        ok: true,
        source: 'keychain',
        sourceRef: normalizedAccount,
        valueReturned: false,
        rawValueRead: false,
      };
    }
    return {
      ok: false,
      error: sanitizeError(result.stderr || result.error || `security_exit_${result.status}`) || 'keychain_secret_not_found',
      valueReturned: false,
      rawValueRead: false,
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeError(error) || 'keychain_presence_check_failed',
      valueReturned: false,
      rawValueRead: false,
    };
  }
}

/**
 * ⚠️ 返回明文 secret value。审计 §3.2 M③：调用方绝不可把本函数返回值整体序列化进 runtime 状态 /
 * freedom payload / 日志（value 是明文密钥）。需对外暴露状态时改用上层 `secretValuesReturned:false`
 * 的 Safe 视图（只给 source/sourceRef，不含 value）。
 */
export function resolveNoeProviderSecret(provider, {
  env = process.env,
  keychainReader = readMacosKeychainSecret,
  roomConfigLoader = loadRoomAdaptersConfig,
  keychainService = NOE_MODEL_KEYCHAIN_SERVICE,
} = {}) {
  const profile = NOE_PROVIDER_SECRET_PROFILES[provider];
  if (!profile) return { ok: false, provider, source: 'unknown', error: `unknown_provider:${provider}` };

  for (const envName of profile.envNames) {
    const value = clean(env?.[envName]);
    if (secretPresent(value)) {
      return { ok: true, provider, value, source: 'env', sourceRef: envName };
    }
  }

  for (const account of profile.keychainAccounts) {
    const result = keychainReader({ account, service: keychainService });
    if (result?.ok && secretPresent(result.value)) {
      return { ok: true, provider, value: result.value, source: 'keychain', sourceRef: account };
    }
  }

  let config = null;
  try { config = roomConfigLoader?.(); } catch {}
  if (config) {
    for (const reader of profile.configReaders || []) {
      const value = clean(reader(config));
      if (secretPresent(value)) {
        return { ok: true, provider, value, source: 'room-adapters-config', sourceRef: provider };
      }
    }
  }

  return {
    ok: false,
    provider,
    source: 'unconfigured',
    error: `${profile.label} API key is not configured in environment, macOS Keychain, or room adapter config`,
    checked: {
      envNames: [...profile.envNames],
      keychainService,
      keychainAccounts: [...profile.keychainAccounts],
      roomAdaptersConfig: true,
    },
  };
}

export function describeNoeProviderSecretFailure(provider, resolution = {}) {
  const profile = NOE_PROVIDER_SECRET_PROFILES[provider];
  const label = profile?.label || provider;
  if (resolution?.ok) return `${label} API key resolved from ${resolution.source}`;
  return `${label} API key is not configured. Run npm run noe:keys:model:setup once, or set ${profile?.envNames?.join('/')} for this process.`;
}

function normalizeProviders(providers = []) {
  const input = Array.isArray(providers) ? providers : String(providers || '').split(',');
  const known = Object.keys(NOE_PROVIDER_SECRET_PROFILES);
  const selected = input.map((item) => clean(item, 80)).filter(Boolean);
  const ids = selected.length ? selected : known;
  return [...new Set(ids)].filter((provider) => NOE_PROVIDER_SECRET_PROFILES[provider]);
}

function safeProviderSecretResolution(provider, resolution = {}) {
  const profile = NOE_PROVIDER_SECRET_PROFILES[provider] || {};
  return {
    ok: resolution.ok === true,
    provider,
    label: profile.label || provider,
    configured: resolution.ok === true,
    source: clean(resolution.source || (resolution.ok ? 'unknown' : 'unconfigured'), 120),
    sourceRef: clean(resolution.sourceRef || '', 180),
    error: resolution.ok ? '' : clean(resolution.error || describeNoeProviderSecretFailure(provider, resolution), 500),
    checked: resolution.ok ? {
      envNames: [...(profile.envNames || [])],
      keychainAccounts: [...(profile.keychainAccounts || [])],
      roomAdaptersConfig: Boolean(profile.configReaders?.length),
    } : resolution.checked,
    valueReturned: false,
    secretValuesReturned: false,
  };
}

export function auditNoeProviderSecrets({
  providers,
  env = process.env,
  keychainReader = readMacosKeychainSecret,
  roomConfigLoader = loadRoomAdaptersConfig,
  keychainService = NOE_MODEL_KEYCHAIN_SERVICE,
} = {}) {
  const providerIds = normalizeProviders(providers);
  const results = providerIds.map((provider) => {
    const resolution = resolveNoeProviderSecret(provider, {
      env,
      keychainReader,
      roomConfigLoader,
      keychainService,
    });
    return safeProviderSecretResolution(provider, resolution);
  });
  const configuredProviders = results.filter((item) => item.configured).map((item) => item.provider);
  const missingProviders = results.filter((item) => !item.configured).map((item) => item.provider);
  return {
    ok: true,
    adapter: 'provider-secret-readiness',
    providers: results,
    providerCount: results.length,
    configuredCount: configuredProviders.length,
    missingCount: missingProviders.length,
    configuredProviders,
    missingProviders,
    keychainService,
    valueReturned: false,
    secretValuesReturned: false,
  };
}
