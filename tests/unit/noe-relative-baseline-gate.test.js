import { describe, it, expect } from 'vitest';
import { shouldRollbackVerify } from '../../src/loop/NoeRelativeBaselineGate.js';

// 飞轮健壮性(2026-06-30):runtimeVerify 绝对绿判定→相对 baseline。
//   根因:别窗/已有 fail 测试(如曾拖垮飞轮20h的 untracked output-quality-gate)让 verify 判不绿→每个 goal 都回滚。
//   修:flag ON 时,verify 不绿但 fail 数没超 apply 前 baseline(非飞轮新增)→ 不回滚放行。默认 OFF=绝对绿(零回归)。
describe('shouldRollbackVerify', () => {
  it('verify 绿 → 不回滚', () => {
    expect(shouldRollbackVerify({ verify: { ok: true }, baselineFailedTests: 0, relativeEnabled: true })).toBe(false);
  });

  it('flag OFF + verify 不绿 → 回滚(绝对绿模式,零回归)', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 2 }, baselineFailedTests: 2, relativeEnabled: false })).toBe(true);
  });

  it('flag ON + 不绿但fail数=baseline(别窗已有fail,飞轮没新增) → 不回滚放行', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 2 }, baselineFailedTests: 2, relativeEnabled: true })).toBe(false);
  });

  it('flag ON + 不绿但fail数<baseline(飞轮还修好了一个) → 不回滚放行', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 1 }, baselineFailedTests: 2, relativeEnabled: true })).toBe(false);
  });

  it('flag ON + fail数>baseline(飞轮新增fail=真破坏) → 回滚', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 3 }, baselineFailedTests: 2, relativeEnabled: true })).toBe(true);
  });

  it('flag ON + baseline全绿(0)但apply后有fail(飞轮引入) → 回滚', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 1 }, baselineFailedTests: 0, relativeEnabled: true })).toBe(true);
  });

  it('flag ON + baseline缺失(null,探针失败/LOGIC OFF) → 保守回滚', () => {
    expect(shouldRollbackVerify({ verify: { ok: false, numFailedTests: 1 }, baselineFailedTests: null, relativeEnabled: true })).toBe(true);
  });

  it('flag ON + verify缺numFailedTests(报告不可信) → 保守回滚', () => {
    expect(shouldRollbackVerify({ verify: { ok: false }, baselineFailedTests: 2, relativeEnabled: true })).toBe(true);
  });
});
