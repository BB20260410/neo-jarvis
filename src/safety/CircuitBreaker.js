// v0.56 Sprint 15-R1 — Circuit Breaker（断路器）
//
// 参考：ruflo @claude-flow/shared/src/resilience/circuit-breaker.ts（MIT）
//
// 三态：CLOSED（正常）→ 失败 N 次 → OPEN（拒绝）→ 等冷却 → HALF_OPEN → 成功 M 次 → CLOSED
//
// 用途：包装 RoomAdapter.chat()。某 adapter 网络挂时快速失败（不再等 30 min timeout）+
//      冷却后自动试探恢复。失败状态对同 adapter 的所有房可见（节省资源）。

export const STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const DEFAULT_OPTS = {
  failureThreshold: 5,        // 连续 N 次失败 → OPEN
  successThreshold: 2,        // HALF_OPEN 成功 M 次 → CLOSED
  cooldownMs: 30_000,          // OPEN 后多久能尝试 HALF_OPEN
  halfOpenMaxConcurrent: 1,   // HALF_OPEN 同时只放 1 个请求试探
};

/**
 * 给一个 key（通常是 adapter.id）维护一个断路器
 */
export class CircuitBreaker {
  constructor(key, opts = {}) {
    this.key = String(key || 'unknown');
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this._validateOpts(opts);
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccessesInHalfOpen = 0;
    this.openedAt = 0;
    this.lastError = null;
    this.halfOpenInflight = 0;
    this.listeners = new Set();
  }

  _validateOpts(userOpts) {
    // Guard: null/undefined opts means "use all defaults" — no per-key
    // validation needed. Without this, `'failureThreshold' in null` /
    // `in undefined` would raise a cryptic TypeError and crash the
    // constructor before the spread-cloned defaults could be used.
    if (userOpts == null) return;
    const positiveInts = ['failureThreshold', 'successThreshold', 'halfOpenMaxConcurrent'];
    for (const k of positiveInts) {
      if (k in userOpts) {
        const v = userOpts[k];
        // Reject non-finite (NaN / ±Infinity) explicitly first so the error
        // message is meaningful instead of falling through to "positive integer".
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new TypeError(`[CircuitBreaker:${this.key}] ${k} must be a finite positive integer, got ${JSON.stringify(v)}`);
        }
        // failureThreshold < 1 → 钳为 1（非正整数仍按原逻辑抛错，跳过钳制分支由下方 catch）
        if (k === 'failureThreshold' && Number.isInteger(v) && v < 1) {
          this.opts[k] = 1;
          continue;
        }
        if (!Number.isInteger(v) || v <= 0) {
          throw new TypeError(`[CircuitBreaker:${this.key}] ${k} must be a positive integer, got ${JSON.stringify(v)}`);
        }
      }
    }
    if ('cooldownMs' in userOpts) {
      const v = userOpts.cooldownMs;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new TypeError(`[CircuitBreaker:${this.key}] cooldownMs must be a positive finite number, got ${JSON.stringify(v)}`);
      }
    }
    if ('shouldTrip' in userOpts && userOpts.shouldTrip != null && typeof userOpts.shouldTrip !== 'function') {
      throw new TypeError(`[CircuitBreaker:${this.key}] shouldTrip must be a function, got ${typeof userOpts.shouldTrip}`);
    }
  }

  /** 决定是否允许调用通过；若不允许直接抛 */
  beforeCall() {
    const now = Date.now();
    if (this.state === STATE.OPEN) {
      // Defensive: if cooldownMs got mutated to a non-finite / non-positive
      // value, `now - this.openedAt >= Infinity` would silently keep the
      // circuit OPEN forever and `Math.ceil((Infinity)/1000)` would lie.
      // Fail loud rather than hang.
      if (typeof this.opts.cooldownMs !== 'number' || !Number.isFinite(this.opts.cooldownMs) || this.opts.cooldownMs <= 0) {
        const err = new Error(`[CircuitBreaker:${this.key}] OPEN — cooldownMs is non-finite or non-positive (${JSON.stringify(this.opts.cooldownMs)}); cannot evaluate recovery`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
      if (now - this.openedAt >= this.opts.cooldownMs) {
        // 转 HALF_OPEN 试探
        this._setState(STATE.HALF_OPEN);
        this.halfOpenInflight = 0;
      } else {
        const wait = this.opts.cooldownMs - (now - this.openedAt);
        const err = new Error(`[CircuitBreaker:${this.key}] OPEN — 还有 ${Math.ceil(wait / 1000)}s 才能再试；上次错: ${this.lastError || 'n/a'}`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }
    if (this.state === STATE.HALF_OPEN) {
      // Defensive guard for the HALF_OPEN probe-concurrency limiter.
      // If halfOpenMaxConcurrent got mutated to a non-finite / non-positive
      // value after construction, `halfOpenInflight >= NaN` evaluates to
      // false silently, over-allowing concurrent probes and breaking the
      // single-probe invariant of HALF_OPEN. Fail loud rather than hang
      // or silently misbehave — mirrors the cooldownMs guard above.
      if (typeof this.opts.halfOpenMaxConcurrent !== 'number' || !Number.isFinite(this.opts.halfOpenMaxConcurrent) || this.opts.halfOpenMaxConcurrent <= 0) {
        const err = new Error(`[CircuitBreaker:${this.key}] HALF_OPEN — halfOpenMaxConcurrent is non-finite or non-positive (${JSON.stringify(this.opts.halfOpenMaxConcurrent)}); cannot evaluate probe concurrency`);
        err.code = 'CIRCUIT_HALF_OPEN_BUSY';
        throw err;
      }
      if (this.halfOpenInflight >= this.opts.halfOpenMaxConcurrent) {
        const err = new Error(`[CircuitBreaker:${this.key}] HALF_OPEN 试探中（${this.halfOpenInflight} in-flight），稍后重试`);
        err.code = 'CIRCUIT_HALF_OPEN_BUSY';
        throw err;
      }
      this.halfOpenInflight++;
    }
  }

  /** 调用成功后调 */
  onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      this.consecutiveSuccessesInHalfOpen++;
      if (this.consecutiveSuccessesInHalfOpen >= this.opts.successThreshold) {
        // HALF_OPEN→CLOSED：完整清零 failures/successes 计数与 halfOpenInflight/openedAt，
        // 避免残留计数让 CLOSED 状态下首次失败就误触发 OPEN。
        this.consecutiveFailures = 0;
        this.consecutiveSuccessesInHalfOpen = 0;
        this.halfOpenInflight = 0;
        this.openedAt = 0;
        this.lastError = null;
        this._setState(STATE.CLOSED);
      }
    } else if (this.state === STATE.CLOSED) {
      this.consecutiveFailures = 0;
    } else if (this.state === STATE.OPEN) {
      // Defensive: beforeCall() should have thrown CIRCUIT_OPEN, so reaching
      // onSuccess() while OPEN is a programmer error / race. Keep the state
      // machine valid by intentionally no-op'ing here: do NOT flip to CLOSED,
      // do NOT reset openedAt / consecutiveFailures, do NOT touch halfOpen
      // counters. Callers can use snapshot() to detect the inconsistency.
    }
  }

  /** 调用失败后调 */
  onFailure(err) {
    this.lastError = err?.message || String(err || 'error');
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      // HALF_OPEN 失败立即回 OPEN；递增 consecutiveFailures 并刷新 openedAt
      // 让 cooldown 计时从本次失败重新开始，并保留失败计数以便后续审计
      this._setState(STATE.OPEN);
      this.openedAt = Date.now();
      this.consecutiveFailures++;
      this.consecutiveSuccessesInHalfOpen = 0;
    } else if (this.state === STATE.CLOSED) {
      this._recordFailureInClosed(err);
    }
  }

  /**
   * CLOSED 状态下记录一次失败：递增连续失败计数、评估 trip 判定、
   * 必要时翻 OPEN。
   *
   * 从 onFailure 抽出，专职处理失败窗口簿记 —— 后续若引入 windowMs
   * 时间窗（剪除 prune failures older than windowMs 的旧时间戳），
   * 只需在方法内增量扩展，不会牵动 onFailure 的 HALF_OPEN 分支或
   * 打乱状态机主流程。
   */
  _recordFailureInClosed(err) {
    this.consecutiveFailures++;
    const shouldTrip = typeof this.opts.shouldTrip === 'function'
      ? this.opts.shouldTrip(this.consecutiveFailures, err, this)
      : this.consecutiveFailures >= this.opts.failureThreshold;
    if (shouldTrip) {
      this._setState(STATE.OPEN);
      this.openedAt = Date.now();
    }
  }

  /** 用户主动 reset（前端"立即恢复"按钮） */
  reset() {
    this._setState(STATE.CLOSED);
    this.consecutiveFailures = 0;
    this.consecutiveSuccessesInHalfOpen = 0;
    this.halfOpenInflight = 0;
    this.lastError = null;
  }

  snapshot() {
    return {
      key: this.key,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccessesInHalfOpen: this.consecutiveSuccessesInHalfOpen,
      openedAt: this.openedAt || null,
      cooldownRemaining: this.state === STATE.OPEN
        ? Math.max(0, this.opts.cooldownMs - (Date.now() - this.openedAt))
        : 0,
      lastError: this.lastError,
      halfOpenInflight: this.halfOpenInflight,
    };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _setState(newState) {
    if (this.state === newState) return;
    const old = this.state;
    this.state = newState;
    for (const fn of this.listeners) {
      try { fn({ key: this.key, from: old, to: newState }); } catch {}
    }
  }
}

/** 进程级管理：每个 key 一个 breaker（懒加载） */
class CircuitBreakerRegistry {
  constructor() {
    this.map = new Map();
    this.broadcast = null;
  }
  attachBroadcast(fn) { this.broadcast = typeof fn === 'function' ? fn : null; }
  get(key, opts) {
    if (!this.map.has(key)) {
      const cb = new CircuitBreaker(key, opts);
      cb.on((evt) => {
        if (this.broadcast) try { this.broadcast({ type: 'circuit_state', ...evt }); } catch {}
      });
      this.map.set(key, cb);
    }
    return this.map.get(key);
  }
  all() {
    return Array.from(this.map.values()).map((cb) => cb.snapshot());
  }
  reset(key) {
    const cb = this.map.get(key);
    if (cb) { cb.reset(); return true; }
    return false;
  }
}

export const breakers = new CircuitBreakerRegistry();
