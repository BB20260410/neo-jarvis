// v0.56 Sprint 15-R1 — CircuitBreaker 单元测试
// 覆盖：正常通过触发 open、open 状态拦截、open→half_open 冷却转换、
//      half_open 探测成功/失败分支、custom shouldTrip、reset/listener/snapshot、
//      CircuitBreakerRegistry
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, STATE, breakers } from '../../src/safety/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state & normal pass-through', () => {
    it('starts in CLOSED state with zero counters', () => {
      const cb = new CircuitBreaker('adapter-A');
      expect(cb.state).toBe(STATE.CLOSED);
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
      expect(cb.openedAt).toBe(0);
      expect(cb.lastError).toBe(null);
    });

    it('allows calls to pass through in CLOSED state', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 3 });
      expect(() => cb.beforeCall()).not.toThrow();
      expect(() => cb.beforeCall()).not.toThrow();
    });

    it('resets failure counter on success in CLOSED state', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 3 });
      cb.onFailure(new Error('e1'));
      cb.onFailure(new Error('e2'));
      expect(cb.consecutiveFailures).toBe(2);
      cb.onSuccess();
      expect(cb.consecutiveFailures).toBe(0);
    });
  });

  describe('CLOSED → OPEN triggering', () => {
    it('opens circuit after failureThreshold consecutive failures', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 3 });
      cb.onFailure(new Error('e1'));
      expect(cb.state).toBe(STATE.CLOSED);
      cb.onFailure(new Error('e2'));
      expect(cb.state).toBe(STATE.CLOSED);
      cb.onFailure(new Error('e3'));
      expect(cb.state).toBe(STATE.OPEN);
      expect(cb.openedAt).toBeGreaterThan(0);
    });

    it('records the last error message for diagnostics', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 2 });
      cb.onFailure(new Error('boom'));
      cb.onFailure(new Error('shattered'));
      expect(cb.lastError).toBe('shattered');
    });

    it('does not open if failures are non-consecutive', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 3 });
      cb.onFailure(new Error('e1'));
      cb.onSuccess();
      cb.onFailure(new Error('e2'));
      cb.onSuccess();
      cb.onFailure(new Error('e3'));
      expect(cb.state).toBe(STATE.CLOSED);
    });
  });

  describe('OPEN state interception', () => {
    it('throws CIRCUIT_OPEN on beforeCall during cooldown', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 30_000 });
      cb.onFailure(new Error('network down'));
      expect(cb.state).toBe(STATE.OPEN);
      let caught;
      try { cb.beforeCall(); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('CIRCUIT_OPEN');
      expect(caught.message).toContain('adapter-A');
      expect(caught.message).toContain('network down');
    });

    it('reports remaining cooldown seconds in the error message', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 10_000 });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(3_000);
      let caught;
      try { cb.beforeCall(); } catch (e) { caught = e; }
      expect(caught.message).toMatch(/7s/);
    });
  });

  describe('OPEN → HALF_OPEN cooldown transition', () => {
    it('transitions to HALF_OPEN after cooldownMs elapses', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 5_000 });
      cb.onFailure(new Error('e1'));
      expect(cb.state).toBe(STATE.OPEN);
      vi.advanceTimersByTime(5_000);
      expect(() => cb.beforeCall()).not.toThrow();
      expect(cb.state).toBe(STATE.HALF_OPEN);
    });

    it('remains OPEN if cooldown has not fully elapsed', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 5_000 });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(4_999);
      let caught;
      try { cb.beforeCall(); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(cb.state).toBe(STATE.OPEN);
    });

    it('resets halfOpenInflight when re-entering HALF_OPEN from another OPEN', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        cooldownMs: 1_000,
        halfOpenMaxConcurrent: 1,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      expect(cb.halfOpenInflight).toBe(1);
      cb.onFailure(new Error('still broken'));
      expect(cb.state).toBe(STATE.OPEN);
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      expect(cb.state).toBe(STATE.HALF_OPEN);
      expect(cb.halfOpenInflight).toBe(1);
    });
  });

  describe('HALF_OPEN probe success branch', () => {
    it('transitions to CLOSED after successThreshold successes and clears state', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        successThreshold: 2,
        cooldownMs: 1_000,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      cb.onSuccess();
      expect(cb.state).toBe(STATE.HALF_OPEN);
      cb.beforeCall();
      cb.onSuccess();
      expect(cb.state).toBe(STATE.CLOSED);
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
      expect(cb.lastError).toBe(null);
    });

    it('does not close prematurely below successThreshold', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        successThreshold: 3,
        cooldownMs: 1_000,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      cb.onSuccess();
      cb.beforeCall();
      cb.onSuccess();
      expect(cb.state).toBe(STATE.HALF_OPEN);
    });

    it('decrements halfOpenInflight on each successful probe', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        successThreshold: 2,
        cooldownMs: 1_000,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      expect(cb.halfOpenInflight).toBe(1);
      cb.onSuccess();
      expect(cb.halfOpenInflight).toBe(0);
      expect(cb.state).toBe(STATE.HALF_OPEN);
    });
  });

  describe('HALF_OPEN probe failure branch', () => {
    it('returns to OPEN immediately on a single failure', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        successThreshold: 2,
        cooldownMs: 1_000,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      expect(cb.state).toBe(STATE.HALF_OPEN);
      cb.onFailure(new Error('still broken'));
      expect(cb.state).toBe(STATE.OPEN);
      expect(cb.openedAt).toBeGreaterThan(0);
      expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
    });

    it('decrements halfOpenInflight on failure', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        cooldownMs: 1_000,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      expect(cb.halfOpenInflight).toBe(1);
      cb.onFailure(new Error('e2'));
      expect(cb.halfOpenInflight).toBe(0);
    });
  });

  describe('HALF_OPEN concurrency limit', () => {
    it('throws CIRCUIT_HALF_OPEN_BUSY when inflight exceeds halfOpenMaxConcurrent', () => {
      const cb = new CircuitBreaker('adapter-A', {
        failureThreshold: 1,
        cooldownMs: 1_000,
        halfOpenMaxConcurrent: 1,
      });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(1_000);
      cb.beforeCall();
      let caught;
      try { cb.beforeCall(); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('CIRCUIT_HALF_OPEN_BUSY');
    });
  });

  describe('custom shouldTrip predicate', () => {
    it('uses custom predicate instead of default threshold', () => {
      const shouldTrip = vi.fn().mockReturnValue(true);
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 100, shouldTrip });
      cb.onFailure(new Error('e1'));
      expect(shouldTrip).toHaveBeenCalledTimes(1);
      expect(shouldTrip).toHaveBeenCalledWith(1, expect.any(Error), cb);
      expect(cb.state).toBe(STATE.OPEN);
    });

    it('does not trip when custom predicate returns false (overrides threshold)', () => {
      const shouldTrip = vi.fn().mockReturnValue(false);
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, shouldTrip });
      cb.onFailure(new Error('e1'));
      cb.onFailure(new Error('e2'));
      expect(cb.state).toBe(STATE.CLOSED);
    });

    it('passes consecutiveFailures count and the original error to predicate', () => {
      const shouldTrip = vi.fn().mockReturnValue(false);
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 10, shouldTrip });
      const err1 = new Error('one');
      const err2 = new Error('two');
      const err3 = new Error('three');
      cb.onFailure(err1);
      cb.onFailure(err2);
      cb.onFailure(err3);
      expect(shouldTrip).toHaveBeenNthCalledWith(1, 1, err1, cb);
      expect(shouldTrip).toHaveBeenNthCalledWith(2, 2, err2, cb);
      expect(shouldTrip).toHaveBeenNthCalledWith(3, 3, err3, cb);
    });

    it('falls back to default threshold check when shouldTrip is not provided', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 2 });
      cb.onFailure(new Error('e1'));
      expect(cb.state).toBe(STATE.CLOSED);
      cb.onFailure(new Error('e2'));
      expect(cb.state).toBe(STATE.OPEN);
    });
  });

  describe('reset()', () => {
    it('forces state back to CLOSED and clears all counters', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 30_000 });
      cb.onFailure(new Error('e1'));
      expect(cb.state).toBe(STATE.OPEN);
      cb.reset();
      expect(cb.state).toBe(STATE.CLOSED);
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
      expect(cb.lastError).toBe(null);
      expect(cb.halfOpenInflight).toBe(0);
    });

    it('allows calls to pass through immediately after reset', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1 });
      cb.onFailure(new Error('e1'));
      cb.reset();
      expect(() => cb.beforeCall()).not.toThrow();
    });
  });

  describe('listener events', () => {
    it('emits state transition events with key/from/to', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1 });
      const events = [];
      const unsub = cb.on((e) => events.push(e));
      cb.onFailure(new Error('e1'));
      expect(events).toEqual([{ key: 'adapter-A', from: 'CLOSED', to: 'OPEN' }]);
      unsub();
    });

    it('does not emit when state is unchanged', () => {
      const cb = new CircuitBreaker('adapter-A');
      const events = [];
      cb.on((e) => events.push(e));
      cb.reset();
      expect(events).toEqual([]);
    });

    it('returned unsubscribe function detaches the listener', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1 });
      const events = [];
      const unsub = cb.on((e) => events.push(e));
      unsub();
      cb.onFailure(new Error('e1'));
      expect(events).toEqual([]);
    });

    it('listener exceptions do not break the breaker', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1 });
      cb.on(() => { throw new Error('listener bad'); });
      expect(() => cb.onFailure(new Error('e1'))).not.toThrow();
      expect(cb.state).toBe(STATE.OPEN);
    });
  });

  describe('snapshot()', () => {
    it('returns a structured view of breaker state in CLOSED', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 5, cooldownMs: 10_000 });
      cb.onFailure(new Error('partial'));
      const snap = cb.snapshot();
      expect(snap).toMatchObject({
        key: 'adapter-A',
        state: STATE.CLOSED,
        consecutiveFailures: 1,
        consecutiveSuccessesInHalfOpen: 0,
        lastError: 'partial',
        halfOpenInflight: 0,
      });
    });

    it('reports cooldownRemaining in OPEN state and decays over time', () => {
      const cb = new CircuitBreaker('adapter-A', { failureThreshold: 1, cooldownMs: 5_000 });
      cb.onFailure(new Error('e1'));
      vi.advanceTimersByTime(2_000);
      const snap = cb.snapshot();
      expect(snap.state).toBe(STATE.OPEN);
      expect(snap.cooldownRemaining).toBeGreaterThan(0);
      expect(snap.cooldownRemaining).toBeLessThanOrEqual(3_000);
    });
  });
});

describe('CircuitBreakerRegistry (breakers)', () => {
  beforeEach(() => {
    breakers.map.clear();
    breakers.broadcast = null;
  });

  it('returns the same instance for the same key', () => {
    const a = breakers.get('adapter-X');
    const b = breakers.get('adapter-X');
    expect(a).toBe(b);
  });

  it('returns distinct instances for distinct keys', () => {
    const a = breakers.get('adapter-X');
    const b = breakers.get('adapter-Y');
    expect(a).not.toBe(b);
    expect(a.key).toBe('adapter-X');
    expect(b.key).toBe('adapter-Y');
  });

  it('all() returns snapshots for every registered breaker', () => {
    breakers.get('a');
    breakers.get('b');
    const all = breakers.all();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.key).sort()).toEqual(['a', 'b']);
  });

  it('reset(key) resets that breaker and returns true', () => {
    const cb = breakers.get('adapter-Z', { failureThreshold: 1 });
    cb.onFailure(new Error('e1'));
    expect(cb.state).toBe(STATE.OPEN);
    expect(breakers.reset('adapter-Z')).toBe(true);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('reset(unknown-key) returns false', () => {
    expect(breakers.reset('never-registered')).toBe(false);
  });

  it('attachBroadcast wires state events to a custom function', () => {
    const received = [];
    breakers.attachBroadcast((msg) => received.push(msg));
    const cb = breakers.get('broadcast-key', { failureThreshold: 1 });
    cb.onFailure(new Error('e1'));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'circuit_state',
      key: 'broadcast-key',
      from: STATE.CLOSED,
      to: STATE.OPEN,
    });
  });

  it('attachBroadcast(null) clears the broadcast target', () => {
    const received = [];
    breakers.attachBroadcast((msg) => received.push(msg));
    breakers.attachBroadcast(null);
    breakers.get('clear-key', { failureThreshold: 1 }).onFailure(new Error('e1'));
    expect(received).toHaveLength(0);
  });
});
