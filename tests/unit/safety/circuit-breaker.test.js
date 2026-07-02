// CircuitBreaker 单元测试
//
// 覆盖：
//   CLOSED → OPEN（连续失败达到阈值）
//   OPEN 状态拒绝调用并抛出 CIRCUIT_OPEN
//   OPEN → HALF_OPEN（冷却期满后 beforeCall 自动转态）
//   HALF_OPEN → CLOSED（成功次数达到 successThreshold）
//   HALF_OPEN → OPEN（失败后回退）
//   HALF_OPEN 并发限制（halfOpenMaxConcurrent）
//   reset() 强制回到 CLOSED
//   snapshot() 返回正确字段
//   on() 监听状态变化事件
//   CircuitBreakerRegistry.get/all/reset
//   CLOSED 成功时重置 consecutiveFailures

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, STATE, breakers } from '../../../src/safety/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 基础初始状态 ────────────────────────────────────────────────────────
  it('初始状态为 CLOSED，consecutiveFailures = 0', () => {
    const cb = new CircuitBreaker('test-init', { failureThreshold: 3 });
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.lastError).toBeNull();
  });

  // ── CLOSED → OPEN ───────────────────────────────────────────────────────
  it('连续失败 N 次后状态变为 OPEN', () => {
    const cb = new CircuitBreaker('test-open', { failureThreshold: 3, cooldownMs: 5000 });
    cb.beforeCall();
    cb.onFailure(new Error('err1'));
    expect(cb.state).toBe(STATE.CLOSED); // 未达阈值

    cb.beforeCall();
    cb.onFailure(new Error('err2'));
    expect(cb.state).toBe(STATE.CLOSED); // 未达阈值

    cb.beforeCall();
    cb.onFailure(new Error('err3'));
    expect(cb.state).toBe(STATE.OPEN); // 到达阈值
    expect(cb.consecutiveFailures).toBe(3);
    expect(cb.lastError).toBe('err3');
  });

  // ── OPEN 拒绝调用 ────────────────────────────────────────────────────────
  it('OPEN 状态时 beforeCall 抛出 CIRCUIT_OPEN 错误', () => {
    const cb = new CircuitBreaker('test-reject', { failureThreshold: 2, cooldownMs: 10_000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    expect(cb.state).toBe(STATE.OPEN);

    // 冷却期内应抛错
    const err = (() => {
      try { cb.beforeCall(); return null; }
      catch (e) { return e; }
    })();
    expect(err).not.toBeNull();
    expect(err.code).toBe('CIRCUIT_OPEN');
    expect(err.message).toMatch(/OPEN/);
  });

  // ── OPEN → HALF_OPEN（冷却期满）────────────────────────────────────────
  it('冷却期满后 beforeCall 自动切换到 HALF_OPEN', () => {
    const cb = new CircuitBreaker('test-half', { failureThreshold: 2, cooldownMs: 5000 });
    cb.beforeCall(); cb.onFailure(new Error('a'));
    cb.beforeCall(); cb.onFailure(new Error('b'));
    expect(cb.state).toBe(STATE.OPEN);

    // 推进时间超过冷却期
    vi.advanceTimersByTime(5001);

    // beforeCall 不应抛，并转换到 HALF_OPEN
    expect(() => cb.beforeCall()).not.toThrow();
    expect(cb.state).toBe(STATE.HALF_OPEN);
    expect(cb.halfOpenInflight).toBe(1);
  });

  // ── HALF_OPEN → CLOSED（成功达到阈值）──────────────────────────────────
  it('HALF_OPEN 成功 M 次后恢复 CLOSED', () => {
    const cb = new CircuitBreaker('test-recover', {
      failureThreshold: 2,
      successThreshold: 2,
      cooldownMs: 5000,
    });
    // 进入 OPEN
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    // 冷却后进入 HALF_OPEN
    vi.advanceTimersByTime(6000);
    cb.beforeCall(); // state → HALF_OPEN, inflight = 1
    cb.onSuccess();  // successesInHalfOpen = 1，未达阈值
    expect(cb.state).toBe(STATE.HALF_OPEN);

    // 第二次试探
    cb.beforeCall();
    cb.onSuccess();  // successesInHalfOpen = 2，达到 successThreshold → CLOSED
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
    expect(cb.lastError).toBeNull();
  });

  // ── HALF_OPEN → OPEN（失败回退）────────────────────────────────────────
  it('HALF_OPEN 失败立即回到 OPEN', () => {
    const cb = new CircuitBreaker('test-halfopen-fail', {
      failureThreshold: 2,
      cooldownMs: 5000,
    });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    vi.advanceTimersByTime(6000);

    cb.beforeCall(); // → HALF_OPEN
    expect(cb.state).toBe(STATE.HALF_OPEN);
    cb.onFailure(new Error('probe-fail'));
    expect(cb.state).toBe(STATE.OPEN);
    expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
  });

  // ── HALF_OPEN 并发限制 ──────────────────────────────────────────────────
  it('HALF_OPEN 已有 inflight 时再次 beforeCall 抛出 CIRCUIT_HALF_OPEN_BUSY', () => {
    const cb = new CircuitBreaker('test-busy', {
      failureThreshold: 2,
      cooldownMs: 5000,
      halfOpenMaxConcurrent: 1,
    });
    cb.beforeCall(); cb.onFailure(new Error('a'));
    cb.beforeCall(); cb.onFailure(new Error('b'));
    vi.advanceTimersByTime(6000);

    cb.beforeCall(); // → HALF_OPEN, inflight = 1
    expect(cb.halfOpenInflight).toBe(1);

    // 再来一次应该被阻止
    const err = (() => {
      try { cb.beforeCall(); return null; }
      catch (e) { return e; }
    })();
    expect(err).not.toBeNull();
    expect(err.code).toBe('CIRCUIT_HALF_OPEN_BUSY');
  });

  // ── reset() ──────────────────────────────────────────────────────────────
  it('reset() 强制恢复为 CLOSED 并清空所有计数器', () => {
    const cb = new CircuitBreaker('test-reset', { failureThreshold: 2, cooldownMs: 5000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    expect(cb.state).toBe(STATE.OPEN);

    cb.reset();
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.consecutiveSuccessesInHalfOpen).toBe(0);
    expect(cb.halfOpenInflight).toBe(0);
    expect(cb.lastError).toBeNull();

    // reset 后正常调用不应抛
    expect(() => cb.beforeCall()).not.toThrow();
  });

  // ── snapshot() ───────────────────────────────────────────────────────────
  it('snapshot() 返回包含正确字段的对象', () => {
    const cb = new CircuitBreaker('snap-key', { failureThreshold: 3, cooldownMs: 8000 });
    cb.beforeCall(); cb.onFailure(new Error('snap-err'));

    const snap = cb.snapshot();
    expect(snap.key).toBe('snap-key');
    expect(snap.state).toBe(STATE.CLOSED);
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastError).toBe('snap-err');
    expect(snap.cooldownRemaining).toBe(0); // CLOSED 状态冷却为 0
  });

  it('snapshot() OPEN 状态时 cooldownRemaining > 0', () => {
    const cb = new CircuitBreaker('snap-open', { failureThreshold: 2, cooldownMs: 10_000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    expect(cb.state).toBe(STATE.OPEN);

    // 推进 3 秒
    vi.advanceTimersByTime(3000);
    const snap = cb.snapshot();
    expect(snap.cooldownRemaining).toBeGreaterThan(0);
    expect(snap.cooldownRemaining).toBeLessThanOrEqual(10_000);
  });

  // ── CLOSED 成功重置 consecutiveFailures ─────────────────────────────────
  it('CLOSED 状态成功后重置 consecutiveFailures', () => {
    const cb = new CircuitBreaker('test-success-reset', { failureThreshold: 5 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    expect(cb.consecutiveFailures).toBe(2);

    cb.beforeCall(); cb.onSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  // ── on() 监听事件 ─────────────────────────────────────────────────────────
  it('on() 监听器在状态转换时被调用', () => {
    const cb = new CircuitBreaker('test-listener', { failureThreshold: 2, cooldownMs: 5000 });
    const events = [];
    cb.on((evt) => events.push({ ...evt }));

    cb.beforeCall(); cb.onFailure(new Error('a'));
    cb.beforeCall(); cb.onFailure(new Error('b')); // → OPEN
    expect(events).toHaveLength(1);
    expect(events[0].from).toBe(STATE.CLOSED);
    expect(events[0].to).toBe(STATE.OPEN);
    expect(events[0].key).toBe('test-listener');
  });

  it('on() 返回的函数可以取消监听', () => {
    const cb = new CircuitBreaker('test-unlisten', { failureThreshold: 2, cooldownMs: 5000 });
    const events = [];
    const off = cb.on((evt) => events.push(evt));
    off(); // 取消监听

    cb.beforeCall(); cb.onFailure(new Error('a'));
    cb.beforeCall(); cb.onFailure(new Error('b')); // → OPEN
    expect(events).toHaveLength(0); // 已取消，不应收到事件
  });

  // ── 冷却期内持续拒绝 ──────────────────────────────────────────────────────
  it('冷却期内多次调用 beforeCall 均抛 CIRCUIT_OPEN', () => {
    const cb = new CircuitBreaker('test-multi-reject', { failureThreshold: 2, cooldownMs: 10_000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));

    vi.advanceTimersByTime(3000); // 只过了 3 秒，还在冷却期

    for (let i = 0; i < 3; i++) {
      const err = (() => { try { cb.beforeCall(); return null; } catch (e) { return e; } })();
      expect(err?.code).toBe('CIRCUIT_OPEN');
    }
  });

  // ── lastError 字段 ────────────────────────────────────────────────────────
  it('onFailure 记录 lastError 字符串', () => {
    const cb = new CircuitBreaker('test-last-error', { failureThreshold: 5 });
    cb.beforeCall(); cb.onFailure(new Error('something broke'));
    expect(cb.lastError).toBe('something broke');
  });

  it('onFailure 接受非 Error 对象', () => {
    const cb = new CircuitBreaker('test-last-error-str', { failureThreshold: 5 });
    cb.beforeCall(); cb.onFailure('raw string error');
    expect(cb.lastError).toBe('raw string error');
  });
});

// ── CircuitBreakerRegistry ────────────────────────────────────────────────────
describe('CircuitBreakerRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 清理 registry 确保测试隔离
    breakers.map.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    breakers.map.clear();
  });

  it('get() 相同 key 返回同一实例', () => {
    const a = breakers.get('adapter-1');
    const b = breakers.get('adapter-1');
    expect(a).toBe(b);
  });

  it('get() 不同 key 返回不同实例', () => {
    const a = breakers.get('adapter-x');
    const b = breakers.get('adapter-y');
    expect(a).not.toBe(b);
  });

  it('all() 返回所有 snapshot 数组', () => {
    breakers.get('reg-a');
    breakers.get('reg-b');
    const all = breakers.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const keys = all.map((s) => s.key);
    expect(keys).toContain('reg-a');
    expect(keys).toContain('reg-b');
  });

  it('reset(key) 将对应 breaker 恢复 CLOSED', () => {
    const cb = breakers.get('reg-reset', { failureThreshold: 2, cooldownMs: 5000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y'));
    expect(cb.state).toBe(STATE.OPEN);

    const result = breakers.reset('reg-reset');
    expect(result).toBe(true);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('reset() 对不存在的 key 返回 false', () => {
    const result = breakers.reset('nonexistent-key-xyz');
    expect(result).toBe(false);
  });

  it('attachBroadcast 在状态变化时被调用', () => {
    const broadcasts = [];
    breakers.attachBroadcast((evt) => broadcasts.push({ ...evt }));

    const cb = breakers.get('reg-broadcast', { failureThreshold: 2, cooldownMs: 5000 });
    cb.beforeCall(); cb.onFailure(new Error('x'));
    cb.beforeCall(); cb.onFailure(new Error('y')); // → OPEN

    expect(broadcasts.length).toBeGreaterThan(0);
    const lastEvt = broadcasts[broadcasts.length - 1];
    expect(lastEvt.type).toBe('circuit_state');
    expect(lastEvt.to).toBe(STATE.OPEN);

    // 清理 broadcast
    breakers.attachBroadcast(null);
  });
});
