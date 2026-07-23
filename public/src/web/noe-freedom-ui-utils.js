const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9_-]{16,}|tp-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;
const SECRET_KEY_RE = /secret|token|key|password|authorization|credential|cookie/i;
const SECRET_QUERY_RE = /([?&#][^=&#]*(?:secret|token|key|password|authorization|credential|cookie)[^=&#]*=)([^&#\s]+)/gi;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function clean(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function redactFreedomUiString(value) {
  return String(value ?? '')
    .replace(SECRET_TEXT_RE, '[redacted]')
    .replace(SECRET_QUERY_RE, '$1[redacted]');
}

export function redactFreedomUiValue(value) {
  if (typeof value === 'string') return redactFreedomUiString(value);
  if (Array.isArray(value)) return value.map(redactFreedomUiValue);
  if (!value || typeof value !== 'object') return value;
  const looksLikeBrowserDomAction = Boolean(value.selector || value.type || value.kind || value.action);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const browserDomValueKey = looksLikeBrowserDomAction && /^(value|text|content)$/i.test(key);
    out[key] = SECRET_KEY_RE.test(key) || browserDomValueKey ? '[redacted]' : redactFreedomUiValue(item);
  }
  return out;
}
