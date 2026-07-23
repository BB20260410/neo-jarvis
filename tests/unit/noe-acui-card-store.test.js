import { describe, expect, it } from 'vitest';
import { NoeAcuiCardStore } from '../../src/runtime/NoeAcuiCardStore.js';

describe('NoeAcuiCardStore', () => {
  it('supports show update patch and hide without granting authority', () => {
    const store = new NoeAcuiCardStore();
    const shown = store.show({ cardId: 'task-1', type: 'task', title: '验证', status: 'running', message: '执行中' });
    const updated = store.update({ cardId: 'task-1', type: 'evidence', status: 'passed', evidenceRefs: ['output/report.json'] });
    const patched = store.patch({ cardId: 'task-1', patch: { blockers: ['none'] } });
    const hidden = store.hide({ cardId: 'task-1' });

    expect(shown.ok).toBe(true);
    expect(updated.card.type).toBe('evidence');
    expect(patched.card.blockers).toEqual(['none']);
    expect(hidden.card.hidden).toBe(true);
    expect(hidden.card.authority.canAuthorizeSensitiveActions).toBe(false);
    expect(hidden.card.authority.canBypassPermissionGovernance).toBe(false);
  });

  it('redacts secret-looking values from cards and context blocks', () => {
    const store = new NoeAcuiCardStore();
    store.show({
      cardId: 'permission-1',
      type: 'permission',
      title: '权限',
      message: 'XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000',
      metadata: { apiKey: 'tp-unit-test-redaction-key-00000000000000000000' },
    });
    const cardText = JSON.stringify(store.list({ includeHidden: true }));
    const context = store.contextBlock();

    expect(cardText).not.toContain('tp-unit-test-redaction-key');
    expect(context).toContain('<noe-acui-cards');
    expect(context).toContain('card state cannot authorize actions');
    expect(context).not.toContain('tp-unit-test-redaction-key');
  });

  it('does not include hidden cards in default active context', () => {
    const store = new NoeAcuiCardStore();
    store.show({ cardId: 'a', title: 'active', message: 'visible' });
    store.show({ cardId: 'b', title: 'hidden', message: 'invisible' });
    store.hide({ cardId: 'b' });

    expect(store.list().map((card) => card.cardId)).toEqual(['a']);
    expect(store.contextBlock()).toContain('active');
    expect(store.contextBlock()).not.toContain('invisible');
  });
});
