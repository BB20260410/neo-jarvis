const SECRET_KEY_RE = /secret|token|key|password|authorization/i;

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function safePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    const k = clean(key, 80);
    if (!k) continue;
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else if (typeof value === 'string') out[k] = clean(value, 240);
    else if (typeof value === 'number' || typeof value === 'boolean') out[k] = value;
  }
  return out;
}

export function noeUiSignalToken(win = globalThis.window) {
  try {
    const search = new URLSearchParams(win?.location?.search || globalThis.location?.search || '');
    return search.get('t')
      || win?.localStorage?.getItem?.('panel-owner-token')
      || win?.sessionStorage?.getItem?.('panel-owner-token')
      || '';
  } catch {
    return '';
  }
}

export function buildNoeUiSignalPayload(event, extra = {}) {
  return {
    event: clean(event, 80) || 'card.action',
    component: clean(extra.component, 160) || 'CognitiveSurface',
    cardId: clean(extra.cardId || extra.id, 160),
    target: clean(extra.target, 240),
    action: clean(extra.action, 160),
    dwellMs: Math.max(0, Number(extra.dwellMs) || 0),
    message: clean(extra.message, 500),
    payload: safePayload(extra.payload),
  };
}

export function describeNoeUiElement(el) {
  if (!el) return {};
  const panel = el.closest?.('[data-noe-panel]')?.dataset?.noePanel || '';
  return {
    cardId: clean(el.id || panel || el.dataset?.uiSignalId || '', 160),
    target: clean(panel || el.id || el.dataset?.uiSignalTarget || el.getAttribute?.('aria-label') || el.title || el.tagName || '', 240),
    action: clean(el.dataset?.uiSignalAction || el.dataset?.vmode || el.id || el.getAttribute?.('aria-label') || el.title || el.tagName || '', 160),
    payload: {
      tag: clean(el.tagName, 40).toLowerCase(),
      panel,
    },
  };
}

export async function postNoeUiSignal(event, extra = {}, { fetchImpl = globalThis.fetch, token = noeUiSignalToken(), keepalive = true } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };
  const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token || '' };
  try {
    const res = await fetchImpl('/api/noe/ui-signals', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildNoeUiSignalPayload(event, extra)),
      keepalive,
    });
    return res?.json ? await res.json().catch(() => ({ ok: Boolean(res.ok) })) : { ok: Boolean(res?.ok) };
  } catch (e) {
    return { ok: false, error: e?.message || 'ui_signal_post_failed' };
  }
}

export function installNoeUiSignalLifecycle({
  root = globalThis.document,
  win = globalThis.window,
  selector = '.panel,[data-noe-panel],.drawer-item',
  component = 'CognitiveSurface',
  post = postNoeUiSignal,
} = {}) {
  if (!root?.querySelectorAll || win?.__noeUiSignalLifecycleInstalled) return { ok: false, reason: 'ui_signal_lifecycle_unavailable_or_installed' };
  win.__noeUiSignalLifecycleInstalled = true;
  const mounted = new Map();
  const markMounted = (el) => {
    if (!el || mounted.has(el)) return;
    mounted.set(el, Date.now());
    post('card.mounted', { component, ...describeNoeUiElement(el) });
  };
  root.querySelectorAll(selector).forEach(markMounted);
  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (node?.matches?.(selector)) markMounted(node);
          node?.querySelectorAll?.(selector).forEach(markMounted);
        }
      }
    })
    : null;
  observer?.observe?.(root.body || root, { childList: true, subtree: true });
  root.addEventListener?.('click', (event) => {
    const el = event.target?.closest?.('button,a,.drawer-item,[data-ui-signal-action]');
    if (!el) return;
    post('card.action', { component, ...describeNoeUiElement(el) });
  }, true);
  win?.addEventListener?.('beforeunload', () => {
    for (const [el, startedAt] of mounted.entries()) {
      post('card.dismissed', { component, ...describeNoeUiElement(el), dwellMs: Date.now() - startedAt }, { keepalive: true });
    }
  }, { once: true });
  return { ok: true, mountedCount: mounted.size };
}
