import { describe, expect, it } from 'vitest';
import {
  buildUiSignalsContextBlock,
  makeGatewayConnectFrame,
  makeGatewayFrame,
  makeUiSignalFrame,
  summarizeGatewayFrame,
  summarizeUiSignalFrames,
  validateGatewayFrame,
} from '../../src/runtime/NoeGatewayProtocol.js';

describe('NoeGatewayProtocol', () => {
  it('validates first connect frames with device identity and features', () => {
    const frame = makeGatewayConnectFrame({ deviceId: 'mac-main', deviceName: 'Mac', role: 'desktop', features: ['agent', 'memory'] });

    expect(validateGatewayFrame(frame)).toEqual({ ok: true, errors: [] });
    expect(summarizeGatewayFrame(frame)).toMatchObject({ type: 'connect', kind: 'presence', deviceId: 'mac-main' });
  });

  it('requires idempotency keys for side-effecting gateway requests', () => {
    const bad = makeGatewayFrame({ type: 'request', method: 'file.delete', payload: { path: 'a' } });
    const good = makeGatewayFrame({ type: 'request', method: 'file.delete', idempotencyKey: 'delete-a-once', payload: { path: 'a' } });

    expect(validateGatewayFrame(bad).errors).toContain('side_effecting_request_requires_idempotency_key');
    expect(validateGatewayFrame(good).ok).toBe(true);
  });

  it('keeps event kind vocabulary explicit', () => {
    const frame = makeGatewayFrame({ type: 'event', kind: 'council', payload: { roundId: 'r1' } });

    expect(validateGatewayFrame(frame).ok).toBe(true);
    expect(summarizeGatewayFrame(frame).payloadKeys).toEqual(['roundId']);
  });

  it('builds context-only UI signal frames with secret redaction', () => {
    const frame = makeUiSignalFrame({
      event: 'card.action',
      cardId: 'local-council',
      component: 'LocalCouncilPanel',
      action: 'expand-result',
      payload: { token: 'tp-not-a-real-secret-but-redacted', safe: 'visible' },
      createdAt: '2026-06-08T00:00:00.000Z',
    });

    expect(validateGatewayFrame(frame)).toEqual({ ok: true, errors: [] });
    expect(frame.payload.payload.token).toBe('[redacted]');
    expect(frame.payload.payload.safe).toBe('visible');
    const summary = summarizeUiSignalFrames([frame], { nowMs: Date.parse('2026-06-08T00:00:10.000Z') });
    expect(summary[0]).toMatchObject({ event: 'card.action', component: 'LocalCouncilPanel', action: 'expand-result', ageSeconds: 10 });
  });

  it('summarizes UI behavior as untrusted context rather than action authority', () => {
    const block = buildUiSignalsContextBlock([
      makeUiSignalFrame({ event: 'card.dismissed', component: 'DoctorCard', dwellMs: 4200, createdAt: '2026-06-08T00:00:00.000Z' }),
      makeUiSignalFrame({ event: 'card.error', component: 'SearchCard', message: 'fetch failed', createdAt: '2026-06-08T00:00:01.000Z' }),
    ], { nowMs: Date.parse('2026-06-08T00:00:05.000Z') });

    expect(block).toContain('<noe-ui-signals');
    expect(block).toContain('context-only');
    expect(block).toContain('user dismissed card');
    expect(block).toContain('card error');
    expect(block).not.toContain('authorization');
  });

  it('rejects unknown UI signal events instead of accepting arbitrary commands', () => {
    const frame = makeGatewayFrame({ type: 'event', kind: 'ui', payload: { event: 'card.delete' } });

    expect(validateGatewayFrame(frame).errors).toContain('invalid_ui_signal_event:card.delete');
  });
});
