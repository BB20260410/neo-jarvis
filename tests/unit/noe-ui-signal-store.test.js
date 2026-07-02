import { describe, expect, it } from 'vitest';
import { makeGatewayFrame } from '../../src/runtime/NoeGatewayProtocol.js';
import { NoeUiSignalStore } from '../../src/runtime/NoeUiSignalStore.js';

describe('NoeUiSignalStore', () => {
  it('records and consumes UI signals into a context-only block', () => {
    const store = new NoeUiSignalStore();
    const recorded = store.record({
      event: 'card.action',
      component: 'LocalCouncilPanel',
      action: 'open-ledger',
      payload: { safe: 'visible' },
    });

    expect(recorded.ok).toBe(true);
    expect(store.snapshot()).toMatchObject({ total: 1, unconsumed: 1, consumed: 0 });
    const consumed = store.consume();
    expect(consumed.count).toBe(1);
    expect(consumed.contextBlock).toContain('<noe-ui-signals');
    expect(consumed.contextBlock).toContain('context-only');
    expect(consumed.contextBlock).toContain('open-ledger');
    expect(store.snapshot()).toMatchObject({ total: 1, unconsumed: 0, consumed: 1 });
  });

  it('rejects unknown UI events instead of turning them into commands', () => {
    const store = new NoeUiSignalStore();
    const result = store.record({ event: 'card.delete', component: 'DangerCard' });

    expect(result).toMatchObject({ ok: false, error: 'invalid_ui_signal_event:card.delete' });
    expect(store.snapshot().total).toBe(0);
  });

  it('redacts secret-like payloads even when callers provide raw gateway frames', () => {
    const store = new NoeUiSignalStore();
    const frame = makeGatewayFrame({
      type: 'event',
      kind: 'ui',
      payload: {
        event: 'card.action',
        component: 'SecretCard',
        action: 'inspect',
        payload: { apiKey: 'tp-fake-secret-value-for-redaction' },
      },
    });
    const result = store.record({ frame });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.item)).not.toContain('tp-fake-secret-value-for-redaction');
    expect(result.item.frame.payload.payload.apiKey).toBe('[redacted]');
  });

  it('peekContextBlock 非消费式：peek 不标记 consumed，议会路径 consume 仍拿得到全部信号', () => {
    const store = new NoeUiSignalStore();
    store.record({ event: 'card.action', component: 'LocalCouncilPanel', action: 'open-ledger' });

    const peeked = store.peekContextBlock();
    expect(peeked).toContain('<noe-ui-signals');
    expect(peeked).toContain('open-ledger');
    expect(store.snapshot()).toMatchObject({ total: 1, unconsumed: 1, consumed: 0 }); // peek 后未消费

    const consumed = store.consume(); // 议会路径不被饿死
    expect(consumed.count).toBe(1);
    expect(consumed.contextBlock).toContain('open-ledger');
    expect(store.snapshot()).toMatchObject({ unconsumed: 0, consumed: 1 });
    expect(store.peekContextBlock()).toBe(''); // 消费完 peek 也为空（不读已消费项）
  });

  it('peekContextBlock 空库返回空串且尊重 limit', () => {
    const store = new NoeUiSignalStore();
    expect(store.peekContextBlock()).toBe('');
    for (let i = 0; i < 12; i += 1) store.record({ event: 'card.mounted', component: 'C', cardId: `p-${i}` });
    store.record({ event: 'card.action', component: 'C', action: 'last-action' });
    const block = store.peekContextBlock({ limit: 3 });
    expect(block).toContain('last-action');
    expect(block).not.toContain('p-0');
  });

  it('consumes the most recent signals so user actions are not drowned by mounted cards', () => {
    const store = new NoeUiSignalStore();
    for (let i = 0; i < 25; i += 1) {
      store.record({ event: 'card.mounted', component: 'CognitiveSurface', cardId: `panel-${i}` });
    }
    store.record({ event: 'card.action', component: 'LocalCouncilPanel', action: 'run-local-council' });

    const consumed = store.consume({ limit: 5 });

    expect(consumed.count).toBe(5);
    expect(consumed.contextBlock).toContain('run-local-council');
    expect(consumed.contextBlock).not.toContain('panel-0');
  });
});
