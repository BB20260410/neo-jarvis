import { describe, expect, it } from 'vitest';
import { createGenerationFence, resolveFenceKey } from '../../src/loop/NoeGenerationFence.js';

describe('resolveFenceKey', () => {
  it('builds a stable key from session/channel/target/account', () => {
    const k = resolveFenceKey({ sessionKey: 's1', channel: 'telegram', to: 'u9', accountId: 'a1' });
    expect(k).toBe('s1::telegram::u9::a1');
  });

  it('defaults account and tolerates partial parts', () => {
    expect(resolveFenceKey({ sessionKey: 's1', channel: 'discord' })).toBe('s1::discord::-::default');
  });

  it('returns empty when no identifying dimension is present', () => {
    expect(resolveFenceKey({})).toBe('');
    expect(resolveFenceKey({ accountId: 'only-account' })).toBe('');
  });

  it('accepts alias field names', () => {
    expect(resolveFenceKey({ conversationId: 'c', provider: 'wechat', peer: 'p' }))
      .toBe('c::wechat::p::default');
  });
});

describe('createGenerationFence', () => {
  it('returns null snapshot for empty key and never suppresses it', () => {
    const fence = createGenerationFence();
    const snap = fence.begin('');
    expect(snap).toBeNull();
    expect(fence.shouldSuppress(null)).toBe(false);
    expect(fence.shouldSuppress(undefined)).toBe(false);
    expect(fence.markDelivered(null)).toBe(false);
  });

  it('increments generation per key and isolates keys', () => {
    const fence = createGenerationFence();
    expect(fence.begin('k1').generation).toBe(1);
    expect(fence.begin('k1').generation).toBe(2);
    expect(fence.begin('k2').generation).toBe(1);
  });

  it('does not suppress a lone latest generation', () => {
    const fence = createGenerationFence();
    const g1 = fence.begin('k');
    expect(fence.shouldSuppress(g1)).toBe(false);
  });

  it('suppresses a stale generation once a newer one begins (core race)', () => {
    const fence = createGenerationFence();
    const g1 = fence.begin('k'); // user msg 1 → reply A
    const g2 = fence.begin('k'); // user msg 2 → reply B (newer)
    expect(fence.shouldSuppress(g1)).toBe(true); // reply A is now stale
    expect(fence.shouldSuppress(g2)).toBe(false); // reply B is latest
  });

  it('marks the latest delivered and then suppresses the older one', () => {
    const fence = createGenerationFence();
    const g1 = fence.begin('k');
    const g2 = fence.begin('k');
    expect(fence.markDelivered(g2)).toBe(true); // newest delivers
    expect(fence.shouldSuppress(g1)).toBe(true); // older now below visible delivery
    expect(fence.markDelivered(g1)).toBe(false); // older delivery is rejected
  });

  it('release decrements active without advancing visible delivery', () => {
    const fence = createGenerationFence();
    const g1 = fence.begin('k');
    const g2 = fence.begin('k');
    fence.release(g2); // newer aborted/errored
    // g1 is now the only active and nothing newer delivered → may deliver
    expect(fence.shouldSuppress(g1)).toBe(false);
    expect(fence.markDelivered(g1)).toBe(true);
  });

  it('tracks active count and cleans up when idle', () => {
    const fence = createGenerationFence();
    const g1 = fence.begin('k');
    const g2 = fence.begin('k');
    expect(fence.activeCount('k')).toBe(2);
    fence.markDelivered(g2);
    expect(fence.activeCount('k')).toBe(1);
    fence.release(g1);
    expect(fence.activeCount('k')).toBe(0);
    expect(fence.size()).toBe(0); // record removed when no in-flight generations remain
  });

  it('handles three rapid messages: only the newest stays deliverable', () => {
    const fence = createGenerationFence();
    const a = fence.begin('k');
    const b = fence.begin('k');
    const c = fence.begin('k');
    expect(fence.shouldSuppress(a)).toBe(true);
    expect(fence.shouldSuppress(b)).toBe(true);
    expect(fence.shouldSuppress(c)).toBe(false);
    expect(fence.markDelivered(c)).toBe(true);
    expect(fence.markDelivered(a)).toBe(false);
    expect(fence.markDelivered(b)).toBe(false);
  });

  it('reset clears all state', () => {
    const fence = createGenerationFence();
    fence.begin('k');
    expect(fence.size()).toBe(1);
    fence.reset();
    expect(fence.size()).toBe(0);
  });
});
