// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { checkSelfEvolutionBudget, resolveSelfEvolutionBudgetConfig, isSelfEvolutionTickFailure, isSelfEvolutionCooldownFailure } from '../../src/room/NoeSelfEvolutionBudget.js';

describe('NoeSelfEvolutionBudget 自改预算/限速（P3.4）', () => {
  it('默认不限不冷却 → allowed（零回归）', () => {
    expect(checkSelfEvolutionBudget({ attemptsToday: 999 }, {}).allowed).toBe(true);
  });
  it('每日上限：达到 → 拒', () => {
    const r = checkSelfEvolutionBudget({ attemptsToday: 5 }, { maxPerDay: 5 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('上限');
  });
  it('每日上限：未达 → allowed', () => {
    expect(checkSelfEvolutionBudget({ attemptsToday: 4 }, { maxPerDay: 5 }).allowed).toBe(true);
  });
  it('失败冷却中 → 拒 + retryAfterMs', () => {
    const r = checkSelfEvolutionBudget({ lastFailureAt: 1000 }, { failureCooldownMs: 5000, now: () => 3000 });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(3000); // 5000-(3000-1000)
  });
  it('失败冷却已过 → allowed', () => {
    expect(checkSelfEvolutionBudget({ lastFailureAt: 1000 }, { failureCooldownMs: 5000, now: () => 7000 }).allowed).toBe(true);
  });
  it('无 lastFailureAt → 不冷却', () => {
    expect(checkSelfEvolutionBudget({}, { failureCooldownMs: 5000, now: () => 3000 }).allowed).toBe(true);
  });
  it('反向 probe：attemptsToday 负/NaN → 当 0 处理', () => {
    expect(checkSelfEvolutionBudget({ attemptsToday: -5 }, { maxPerDay: 1 }).allowed).toBe(true);
    expect(checkSelfEvolutionBudget({ attemptsToday: NaN }, { maxPerDay: 1 }).allowed).toBe(true);
  });
  it('反向 probe：lastFailureAt 在未来（时钟漂移 elapsed<0）→ 不误锁', () => {
    expect(checkSelfEvolutionBudget({ lastFailureAt: 9999 }, { failureCooldownMs: 5000, now: () => 1000 }).allowed).toBe(true);
  });
  it('两道闸同时命中：优先报次数上限', () => {
    const r = checkSelfEvolutionBudget({ attemptsToday: 10, lastFailureAt: 1000 }, { maxPerDay: 5, failureCooldownMs: 5000, now: () => 2000 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('上限');
  });
  it('resolveConfig：env 设置正确解析', () => {
    const c = resolveSelfEvolutionBudgetConfig({ NOE_SELF_EVOLUTION_MAX_CYCLES_PER_DAY: '8', NOE_SELF_EVOLUTION_FAILURE_COOLDOWN_MS: '60000' });
    expect(c).toEqual({ maxPerDay: 8, failureCooldownMs: 60000, enabled: true });
  });
  it('resolveConfig：未设/非法 → 不限不冷却（enabled false）', () => {
    expect(resolveSelfEvolutionBudgetConfig({})).toEqual({ maxPerDay: 0, failureCooldownMs: 0, enabled: false });
    expect(resolveSelfEvolutionBudgetConfig({ NOE_SELF_EVOLUTION_MAX_CYCLES_PER_DAY: 'abc', NOE_SELF_EVOLUTION_FAILURE_COOLDOWN_MS: '-5' })).toEqual({ maxPerDay: 0, failureCooldownMs: 0, enabled: false });
  });
  it('反向 probe：checkSelfEvolutionBudget(null) 不抛（防御兜底，nit 修复）', () => {
    expect(() => checkSelfEvolutionBudget(null, { maxPerDay: 1 })).not.toThrow();
    expect(checkSelfEvolutionBudget(null, {}).allowed).toBe(true);
  });
  it('isSelfEvolutionTickFailure：覆盖顶层/actResult/autodrive 三种失败（codex 审核坐实）', () => {
    expect(isSelfEvolutionTickFailure({ ok: false })).toBe(true);
    expect(isSelfEvolutionTickFailure({ ok: true, actResult: { ok: false } })).toBe(true); // 顶层成功但 act 失败
    expect(isSelfEvolutionTickFailure({ ok: true, autodrive: { ok: false } })).toBe(true);
    expect(isSelfEvolutionTickFailure({ ok: true, proposed: true })).toBe(false);
    expect(isSelfEvolutionTickFailure(null)).toBe(false);
  });
  it('isSelfEvolutionCooldownFailure：no_patch_plan/non_usable 不冷却(诗性产空非真自改失败,防拖累真信号)', () => {
    // 真自改失败(改了代码但 apply/verify 坏了)→ 冷却
    expect(isSelfEvolutionCooldownFailure({ ok: false, reason: 'self_evolution_verify_failed_rolled_back_needs_self_repair' })).toBe(true);
    expect(isSelfEvolutionCooldownFailure({ ok: true, actResult: { ok: false, reason: 'needs_self_repair' } })).toBe(true);
    // no_patch_plan / non_usable(implementer 没产出/诗性产空)→ 不冷却
    expect(isSelfEvolutionCooldownFailure({ ok: false, reason: 'self_evolution_no_patch_plan_in_reply' })).toBe(false);
    expect(isSelfEvolutionCooldownFailure({ ok: true, actResult: { ok: false, error: 'self_evolution_no_patch_plan_in_reply' } })).toBe(false);
    expect(isSelfEvolutionCooldownFailure({ ok: true, actResult: { ok: false, reason: 'non_usable_patch_plan' } })).toBe(false);
    // 非失败 → 不冷却
    expect(isSelfEvolutionCooldownFailure({ ok: true, proposed: true })).toBe(false);
    expect(isSelfEvolutionCooldownFailure(null)).toBe(false);
  });
});
