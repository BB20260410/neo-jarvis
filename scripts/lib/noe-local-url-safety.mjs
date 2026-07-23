// @ts-check

export function isAllowedLocalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
}

export function collectUrlLikeValues(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlLikeValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/url|endpoint|href|origin/i.test(key) && typeof item === 'string') {
        out.push(item);
        continue;
      }
      collectUrlLikeValues(item, out);
    }
  }
  return out;
}

export function nonLocalUrls(value) {
  return collectUrlLikeValues(value).filter((url) => !isAllowedLocalUrl(url));
}
