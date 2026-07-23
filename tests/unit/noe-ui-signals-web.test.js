import { describe, expect, it } from 'vitest';
import {
  buildNoeUiSignalPayload,
  describeNoeUiElement,
  installNoeUiSignalLifecycle,
  noeUiSignalToken,
  postNoeUiSignal,
} from '../../public/src/web/noe-ui-signals.js';

function makeStorage(values = {}) {
  return { getItem: (key) => values[key] || '' };
}

function makeElement({ id = '', tagName = 'BUTTON', title = '', dataset = {}, parent = null } = {}) {
  return {
    id,
    tagName,
    title,
    dataset,
    parent,
    getAttribute(name) { return name === 'aria-label' ? this.ariaLabel || '' : ''; },
    closest(selector) {
      if (selector.includes('[data-noe-panel]')) return this.dataset.noePanel ? this : parent?.closest?.(selector) || null;
      if (selector.includes('button') || selector.includes('.drawer-item') || selector.includes('[data-ui-signal-action]')) return this;
      return null;
    },
    matches() { return true; },
    querySelectorAll() { return []; },
  };
}

describe('noe-ui-signals web helper', () => {
  it('resolves owner token from URL before storage', () => {
    const win = {
      location: { search: '?t=query-token' },
      localStorage: makeStorage({ 'panel-owner-token': 'local-token' }),
      sessionStorage: makeStorage({ 'panel-owner-token': 'session-token' }),
    };

    expect(noeUiSignalToken(win)).toBe('query-token');
  });

  it('builds redacted UI signal payloads without raw secret fields', () => {
    const payload = buildNoeUiSignalPayload('card.action', {
      component: 'LocalCouncilPanel',
      action: 'run',
      payload: { apiKey: 'tp-fake-secret-value-for-redaction', safe: 'visible' },
    });

    expect(payload).toMatchObject({ event: 'card.action', component: 'LocalCouncilPanel', action: 'run' });
    expect(payload.payload.apiKey).toBe('[redacted]');
    expect(payload.payload.safe).toBe('visible');
    expect(JSON.stringify(payload)).not.toContain('tp-fake-secret-value-for-redaction');
  });

  it('describes UI elements by id and panel metadata rather than input contents', () => {
    const el = makeElement({ id: 'btnNoeLoopStart', dataset: { noePanel: 'loop' } });

    expect(describeNoeUiElement(el)).toMatchObject({ cardId: 'btnNoeLoopStart', target: 'loop', action: 'btnNoeLoopStart' });
  });

  it('posts UI signals through the protected API endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const out = await postNoeUiSignal('card.action', { action: 'run' }, { fetchImpl, token: 'owner-token' });

    expect(out.ok).toBe(true);
    expect(calls[0].url).toBe('/api/noe/ui-signals');
    expect(calls[0].init.headers['X-Panel-Owner-Token']).toBe('owner-token');
    expect(JSON.parse(calls[0].init.body).action).toBe('run');
  });

  it('installs mounted and click lifecycle hooks for existing panels', () => {
    const panel = makeElement({ id: 'panel-l1', tagName: 'ASIDE' });
    const button = makeElement({ id: 'btnVision', tagName: 'BUTTON', parent: panel });
    const events = {};
    const root = {
      body: {},
      querySelectorAll: () => [panel],
      addEventListener: (name, fn) => { events[name] = fn; },
    };
    const win = { addEventListener: () => {}, __noeUiSignalLifecycleInstalled: false };
    const posted = [];
    const out = installNoeUiSignalLifecycle({ root, win, post: (event, payload) => posted.push({ event, payload }) });
    events.click({ target: button });

    expect(out).toMatchObject({ ok: true, mountedCount: 1 });
    expect(posted.map((item) => item.event)).toEqual(['card.mounted', 'card.action']);
    expect(posted[1].payload.action).toBe('btnVision');
  });
});
