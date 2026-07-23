import { describe, expect, it } from 'vitest';
import {
  formatNoeAcuiCard,
  installCognitiveAcuiLite,
  renderNoeAcuiCards,
} from '../../public/src/web/cognitive-acui-lite.js';

function makeRoot() {
  const children = [];
  const send = { id: 'send-btn' };
  const row = {
    children,
    insertBefore(node) { children.push(node); },
  };
  return {
    created: [],
    ownerDocument: {
      createElement: (tagName) => ({ tagName, dataset: {}, onclick: null }),
    },
    querySelector(selector) {
      if (selector === '#input-row') return row;
      if (selector === '#send-btn') return send;
      if (selector === '#btnAcuiCards') return children.find((child) => child.id === 'btnAcuiCards') || null;
      return null;
    },
  };
}

describe('cognitive ACUI-lite web helper', () => {
  it('formats visible cards without secret-looking values', () => {
    const text = formatNoeAcuiCard({
      type: 'review',
      status: 'running',
      title: '复审',
      message: 'XIAOMI_API_KEY=[redacted]',
      evidenceRefs: ['output/report.json'],
      blockers: ['waiting-review'],
    });

    expect(text).toContain('review / running');
    expect(text).toContain('证据：output/report.json');
    expect(text).not.toContain('tp-unit-test');
  });

  it('renders only active cards and skips hidden ones', () => {
    const messages = [];
    const out = renderNoeAcuiCards([
      { title: 'active', message: 'visible' },
      { title: 'hidden', message: 'invisible', hidden: true },
    ], { add: (role, text) => messages.push({ role, text }) });

    expect(out.count).toBe(1);
    expect(messages[0].text).toContain('active');
    expect(messages[0].text).not.toContain('invisible');
  });

  it('installs a status button in the input row', () => {
    const root = makeRoot();
    const out = installCognitiveAcuiLite({ root });

    expect(out.ok).toBe(true);
    expect(root.querySelector('#btnAcuiCards').textContent).toContain('状态');
  });
});
