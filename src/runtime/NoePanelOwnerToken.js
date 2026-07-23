// @ts-check
/**
 * Pure helpers for panel owner-token bootstrap (SSOT key: panel-owner-token).
 * Mirrors public/app.js Round-5 bootstrap; used by home shell + unit tests.
 */

export const PANEL_OWNER_TOKEN_STORAGE_KEY = 'panel-owner-token';

/**
 * @param {string} search location.search (with or without leading ?)
 * @returns {string} token if length >= 32, else ''
 */
export function extractOwnerTokenFromSearch(search) {
  try {
    const raw = String(search || '');
    const q = raw.startsWith('?') ? raw.slice(1) : raw;
    const params = new URLSearchParams(q);
    const t = (params.get('t') || '').trim();
    return t.length >= 32 ? t : '';
  } catch {
    return '';
  }
}

/**
 * Apply URL bootstrap into a storage-like object (session/local).
 * @param {string} search
 * @param {{ getItem?: Function, setItem?: Function }} [sessionStore]
 * @param {{ getItem?: Function, setItem?: Function }} [localStore]
 * @returns {{ token: string, bootstrapped: boolean, searchWithoutToken: string }}
 */
export function bootstrapOwnerTokenFromSearch(search, sessionStore = null, localStore = null) {
  const token = extractOwnerTokenFromSearch(search);
  if (!token) {
    return { token: '', bootstrapped: false, searchWithoutToken: String(search || '') };
  }
  try { sessionStore?.setItem?.(PANEL_OWNER_TOKEN_STORAGE_KEY, token); } catch { /* ignore */ }
  try { localStore?.setItem?.(PANEL_OWNER_TOKEN_STORAGE_KEY, token); } catch { /* ignore */ }
  // strip t= from search string for history.replaceState consumers
  try {
    const raw = String(search || '');
    const q = raw.startsWith('?') ? raw.slice(1) : raw;
    const params = new URLSearchParams(q);
    params.delete('t');
    const next = params.toString();
    return { token, bootstrapped: true, searchWithoutToken: next ? `?${next}` : '' };
  } catch {
    return { token, bootstrapped: true, searchWithoutToken: '' };
  }
}

/**
 * Resolve token from storage + optional memory fallback (app.js order).
 * @param {{ getItem?: Function }} [sessionStore]
 * @param {{ getItem?: Function }} [localStore]
 * @param {string} [memoryToken]
 */
export function resolvePanelOwnerToken(sessionStore = null, localStore = null, memoryToken = '') {
  try {
    return (
      sessionStore?.getItem?.(PANEL_OWNER_TOKEN_STORAGE_KEY)
      || localStore?.getItem?.(PANEL_OWNER_TOKEN_STORAGE_KEY)
      || memoryToken
      || ''
    );
  } catch {
    return memoryToken || '';
  }
}

/**
 * Headers for authenticated panel API calls (SSOT header name).
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function ownerAuthHeaders(token) {
  const t = String(token || '').trim();
  if (!t) return {};
  return { 'X-Panel-Owner-Token': t };
}

/**
 * Preserve query string when rewriting path (e.g. / → /home.html).
 * @param {string} originalUrl e.g. /?t=abc&electron=1
 * @param {string} targetPath e.g. /home.html
 */
export function redirectPathPreservingQuery(originalUrl, targetPath) {
  const url = String(originalUrl || '/');
  const qIdx = url.indexOf('?');
  const qs = qIdx >= 0 ? url.slice(qIdx) : '';
  const base = String(targetPath || '/').split('?')[0];
  return `${base}${qs}`;
}
