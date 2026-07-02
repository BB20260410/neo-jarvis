// @ts-check

export const DEFAULT_NOE_MEMORY_EMBED_PROVIDER = 'ollama';
export const DEFAULT_NOE_MEMORY_EMBED_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_NOE_MEMORY_EMBED_BASEURL = 'http://127.0.0.1:11434';

const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'none', 'disabled']);
const OFF_PROFILES = new Set(['0', 'off', 'false', 'minimal']);

export function isNoeMemorySemanticOff(value) {
  if (value === undefined || value === null) return false;
  return OFF_VALUES.has(String(value).trim().toLowerCase());
}

export function resolveNoeMemorySemanticConfig(env = process.env) {
  const hasPrimary = Object.prototype.hasOwnProperty.call(env, 'NOE_MEMORY_EMBED');
  const rawProvider = hasPrimary ? env.NOE_MEMORY_EMBED : env.NOE_MEMORY_EMBED_PROVIDER;
  const rawText = rawProvider === undefined || rawProvider === null ? '' : String(rawProvider).trim();
  const disabledExplicitly = isNoeMemorySemanticOff(rawText);
  const profile = String(env.NOE_AUTONOMY_PROFILE || 'free').trim().toLowerCase();
  const defaultEnabled = !OFF_PROFILES.has(profile);
  if (!rawText || disabledExplicitly) {
    if (!rawText && defaultEnabled) {
      return {
        enabled: true,
        disabledExplicitly: false,
        provider: DEFAULT_NOE_MEMORY_EMBED_PROVIDER,
        model: String(env.NOE_MEMORY_EMBED_MODEL || DEFAULT_NOE_MEMORY_EMBED_MODEL).trim(),
        baseUrl: String(env.NOE_MEMORY_EMBED_BASEURL || env.NOE_OLLAMA_URL || env.OLLAMA_HOST || DEFAULT_NOE_MEMORY_EMBED_BASEURL).trim(),
        source: 'default',
      };
    }
    return {
      enabled: false,
      disabledExplicitly,
      provider: '',
      model: '',
      baseUrl: '',
      source: hasPrimary ? 'NOE_MEMORY_EMBED' : '',
    };
  }
  const provider = rawText;
  return {
    enabled: true,
    disabledExplicitly: false,
    provider,
    model: String(env.NOE_MEMORY_EMBED_MODEL || (provider === 'ollama' ? DEFAULT_NOE_MEMORY_EMBED_MODEL : '')).trim(),
    baseUrl: String(env.NOE_MEMORY_EMBED_BASEURL || env.NOE_OLLAMA_URL || env.OLLAMA_HOST || (provider === 'ollama' ? DEFAULT_NOE_MEMORY_EMBED_BASEURL : '')).trim(),
    source: hasPrimary ? 'NOE_MEMORY_EMBED' : 'NOE_MEMORY_EMBED_PROVIDER',
  };
}
