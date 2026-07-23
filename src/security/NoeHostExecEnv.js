// Host child-process environment sanitizer.
// Inspired by OpenClaw's host-exec env discipline: subprocesses should inherit
// only explicit, non-injection, non-secret environment keys.

export const NOE_DEFAULT_SAFE_HOST_EXEC_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
]);

const DANGEROUS_ENV_KEY_RE = /^(DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|PYTHONPATH$|RUBYOPT$|PERL5OPT$|GIT_CONFIG_|BASH_ENV$|ENV$|ZDOTDIR$)/i;
const SECRET_ENV_KEY_RE = /(?:API[_-]?KEY|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|REFRESH[_-]?TOKEN|SECRET|SESSION[_-]?TOKEN|TOKEN)/i;

function normalizeKey(key = '') {
  return String(key || '').trim();
}

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

export function isDangerousHostExecEnvKey(key = '') {
  const k = normalizeKey(key);
  return !k || DANGEROUS_ENV_KEY_RE.test(k);
}

export function isSecretHostExecEnvKey(key = '') {
  return SECRET_ENV_KEY_RE.test(normalizeKey(key));
}

export function sanitizeNoeHostExecEnv(env = process.env, {
  allowlist = NOE_DEFAULT_SAFE_HOST_EXEC_ENV_KEYS,
  allowSecrets = false,
  defaults = {},
} = {}) {
  const allowed = new Set((Array.isArray(allowlist) ? allowlist : NOE_DEFAULT_SAFE_HOST_EXEC_ENV_KEYS).map(normalizeKey).filter(Boolean));
  const out = {};
  for (const key of allowed) {
    if (isDangerousHostExecEnvKey(key)) continue;
    if (!allowSecrets && isSecretHostExecEnvKey(key)) continue;
    const value = normalizeValue(env?.[key]);
    if (value) out[key] = value;
  }
  for (const [keyRaw, valueRaw] of Object.entries(defaults || {})) {
    const key = normalizeKey(keyRaw);
    if (!key || isDangerousHostExecEnvKey(key)) continue;
    if (!allowSecrets && isSecretHostExecEnvKey(key)) continue;
    const value = normalizeValue(valueRaw);
    if (value && out[key] === undefined) out[key] = value;
  }
  return out;
}

export function buildNoeSafeChildProcessEnv(env = process.env, {
  extraEnv = {},
  allowlist = NOE_DEFAULT_SAFE_HOST_EXEC_ENV_KEYS,
  defaults = {},
  allowSecrets = false,
} = {}) {
  const merged = { ...(env || {}), ...(extraEnv || {}) };
  const mergedAllowlist = [
    ...(Array.isArray(allowlist) ? allowlist : NOE_DEFAULT_SAFE_HOST_EXEC_ENV_KEYS),
    ...Object.keys(extraEnv || {}),
  ];
  return sanitizeNoeHostExecEnv(merged, {
    allowlist: mergedAllowlist,
    defaults,
    allowSecrets,
  });
}
