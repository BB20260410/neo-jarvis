import { describe, it, expect } from 'vitest';
import { checkSelfDirectionBudget, resolveSelfDirectionBudget } from '../../src/room/NoeSelfDirectionBudget.js';

// #54 自主定方向的 reward hacking 熔断：自主源连续 N 次产 neutral/失败（刷无价值方向）→ 暂停自主生成。
//   纯函数 + DI（调用方提供 consecutiveNeutral + lastFailureAt），零副作用。默认不限=零回归。

describe('NoeSelfDirectionBudget', () => {
  it('默认(都不限)→ 放行(零回归)', () => {
    expect(checkSelfDirectionBudget({ consecutiveNeutral: 99 }, {}).allowed).toBe(true);
  });

  it('连续 neutral 达上限 → 熔断(reason 含 consecutive_neutral)', () => {
    const r = checkSelfDirectionBudget({ consecutiveNeutral: 3 }, { maxConsecutiveNeutral: 3 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('consecutive_neutral');
  });

  // half-open：打破永久死锁。熔断后不立新 goal → consecutiveNeutral 永 ≥ 上限 → 永不恢复(实测卡 37h)。
  //   修:熔断时若 cooldown 已过 → 放行一次试探(成功则计数自然重置、失败则更新 lastFailureAt 再熔断)。受 cooldownMs 门控。
  it('half-open：连续 neutral 达上限 + cooldown 已过 → 放行试探(打破永久死锁)', () => {
    const r = checkSelfDirectionBudget({ consecutiveNeutral: 3, lastFailureAt: 1000 }, { maxConsecutiveNeutral: 3, cooldownMs: 60_000, now: () => 1000 + 70_000 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('half_open');
  });

  it('half-open：连续 neutral 达上限 + cooldown 未过 → 仍熔断(喘息期)', () => {
    const r = checkSelfDirectionBudget({ consecutiveNeutral: 3, lastFailureAt: 1000 }, { maxConsecutiveNeutral: 3, cooldownMs: 60_000, now: () => 1000 + 1000 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('consecutive_neutral');
  });

  it('half-open 受 cooldownMs 门控：达上限 + cooldownMs=0(默认) → 永久熔断(零回归,无 half-open)', () => {
    const r = checkSelfDirectionBudget({ consecutiveNeutral: 3, lastFailureAt: 1000 }, { maxConsecutiveNeutral: 3, cooldownMs: 0, now: () => 1000 + 999_999 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('consecutive_neutral');
  });

  it('half-open：达上限 + cooldownMs>0 但无 lastFailureAt → 仍熔断(没失败时间锚不试探)', () => {
    const r = checkSelfDirectionBudget({ consecutiveNeutral: 3, lastFailureAt: 0 }, { maxConsecutiveNeutral: 3, cooldownMs: 60_000, now: () => 999_999 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('consecutive_neutral');
  });

  it('连续 neutral 未达上限 → 放行', () => {
    expect(checkSelfDirectionBudget({ consecutiveNeutral: 2 }, { maxConsecutiveNeutral: 3 }).allowed).toBe(true);
  });

  it('失败冷却中 → 拒(reason 含 cooldown)', () => {
    const r = checkSelfDirectionBudget({ lastFailureAt: 1000 }, { cooldownMs: 60_000, now: () => 1000 + 1000 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('cooldown');
  });

  it('失败冷却已过 → 放行', () => {
    const r = checkSelfDirectionBudget({ lastFailureAt: 1000 }, { cooldownMs: 60_000, now: () => 1000 + 70_000 });
    expect(r.allowed).toBe(true);
  });

  it('null/非对象 state → 不崩,放行(fail-open)', () => {
    expect(checkSelfDirectionBudget(null, { maxConsecutiveNeutral: 3 }).allowed).toBe(true);
  });

  it('resolveSelfDirectionBudget 读 env', () => {
    const cfg = resolveSelfDirectionBudget({ NOE_SELF_DIRECTION_MAX_CONSECUTIVE_NEUTRAL: '5', NOE_SELF_DIRECTION_COOLDOWN_MS: '120000' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxConsecutiveNeutral).toBe(5);
    expect(cfg.cooldownMs).toBe(120_000);
  });

  it('resolve 默认(env 未设)→ enabled:false(零回归)', () => {
    const cfg = resolveSelfDirectionBudget({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxConsecutiveNeutral).toBe(0);
    expect(cfg.cooldownMs).toBe(0);
  });
});
