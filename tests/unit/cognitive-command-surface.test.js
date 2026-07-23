import { describe, expect, it } from 'vitest';
import {
  formatCommandHelp,
  installCognitiveCommandSurface,
  selectCommandFromDiscovery,
} from '../../public/src/web/cognitive-command-surface.js';

function makeElement({ id = '', className = '' } = {}) {
  return {
    id,
    className,
    dataset: {},
    textContent: '',
    title: '',
    onclick: null,
    parentNode: null,
  };
}

function makeRoot() {
  const parent = { inserted: [], insertBefore(node) { node.parentNode = this; this.inserted.push(node); } };
  const row = { inserted: [], insertBefore(node) { node.parentNode = this; this.inserted.push(node); } };
  const localCouncil = makeElement({ id: 'dLocalCouncil', className: 'drawer-item' });
  localCouncil.parentNode = parent;
  const send = makeElement({ id: 'send-btn' });
  send.parentNode = row;
  const elements = { dLocalCouncil: localCouncil, 'input-row': row, 'send-btn': send };
  return {
    parent,
    querySelector(selector) {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      return elements[id] || null;
    },
    createElement(tag) {
      return makeElement({ className: tag });
    },
  };
}

describe('cognitive command surface', () => {
  it('selects the first visible command from discovery results', () => {
    const command = selectCommandFromDiscovery({
      search: { results: [{ id: 'hidden', hiddenReason: 'permission' }, { id: 'noe.find_tool' }] },
    });

    expect(command.id).toBe('noe.find_tool');
  });

  it('formats help and dry-run output without implying execution', () => {
    const text = formatCommandHelp({
      ok: true,
      commandId: 'noe.find_tool',
      title: '查找可用工具',
      description: '按关键词查找工具',
      riskLevel: 'low',
      permissionRequired: false,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }, { ok: true, wouldExecute: false });

    expect(text).toContain('命令：查找可用工具');
    expect(text).toContain('输入：query');
    expect(text).toContain('不会执行');
  });

  it('installs a visible drawer entry after local council', () => {
    const oldDocument = globalThis.document;
    const root = makeRoot();
    globalThis.document = root;
    try {
      const out = installCognitiveCommandSurface({ root });

      expect(out.ok).toBe(true);
      expect(root.parent.inserted[0]).toMatchObject({
        id: 'dCommandSurface',
        className: 'drawer-item',
        textContent: '🧭 命令帮助 / 预演',
      });
      expect(typeof root.parent.inserted[0].onclick).toBe('function');
    } finally {
      globalThis.document = oldDocument;
    }
  });

  it('also installs a reachable input-row button for command help', () => {
    const oldDocument = globalThis.document;
    const root = makeRoot();
    globalThis.document = root;
    try {
      const out = installCognitiveCommandSurface({ root });

      expect(out.ok).toBe(true);
      expect(root.querySelector('#input-row').inserted[0]).toMatchObject({
        id: 'btnCommandSurface',
        className: 'cbtn',
        textContent: '🧭 命令',
      });
      expect(root.querySelector('#input-row').inserted[0].dataset.icon).toBe('🧭');
    } finally {
      globalThis.document = oldDocument;
    }
  });
});
