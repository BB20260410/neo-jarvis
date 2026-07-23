import { describe, expect, it } from 'vitest';
import {
  formatTaskFlowSummary,
  installCognitiveTaskFlow,
  shouldCreateTaskFlow,
} from '../../public/src/web/cognitive-taskflow.js';

function makeRoot() {
  const row = { inserted: [], insertBefore(node) { node.parentNode = this; this.inserted.push(node); } };
  const send = { id: 'send-btn', parentNode: row };
  const elements = { 'input-row': row, 'send-btn': send };
  return {
    querySelector(selector) {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      return elements[id] || null;
    },
    createElement(tag) {
      return {
        tag,
        id: '',
        className: '',
        dataset: {},
        title: '',
        textContent: '',
        type: '',
        onclick: null,
      };
    },
  };
}

describe('cognitive taskflow', () => {
  it('formats taskflow summaries for visible supervision', () => {
    const text = formatTaskFlowSummary({
      flowId: 'ui-1',
      goal: '完成验证',
      status: 'running',
      currentStep: { id: 'verify', title: '验证', status: 'pending' },
      stepCounts: { passed: 2, failed: 0, pending: 3 },
      evidenceCount: 4,
    });

    expect(text).toContain('任务流：ui-1');
    expect(text).toContain('当前步骤：验证（pending）');
    expect(text).toContain('证据：4 条');
  });

  it('installs a reachable input-row taskflow button', () => {
    const oldDocument = globalThis.document;
    const root = makeRoot();
    globalThis.document = root;
    try {
      const out = installCognitiveTaskFlow({ root });

      expect(out.ok).toBe(true);
      expect(root.querySelector('#input-row').inserted[0]).toMatchObject({
        id: 'btnTaskFlow',
        className: 'cbtn',
        textContent: '📋 任务',
      });
      expect(root.querySelector('#input-row').inserted[0].dataset.icon).toBe('📋');
    } finally {
      globalThis.document = oldDocument;
    }
  });

  it('reuses only running flows and creates a new one for completed flows', () => {
    expect(shouldCreateTaskFlow(null)).toBe(true);
    expect(shouldCreateTaskFlow({ flowId: 'active', status: 'running' })).toBe(false);
    expect(shouldCreateTaskFlow({ flowId: 'done', status: 'succeeded' })).toBe(true);
    expect(shouldCreateTaskFlow({ flowId: 'failed', status: 'failed' })).toBe(true);
  });
});
