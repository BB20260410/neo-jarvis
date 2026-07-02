// @ts-check
// 飞轮健壮性(2026-06-30):runtimeVerify 绝对绿判定 → 相对 baseline。
//   根因教训:别窗/已有 fail 测试(如曾拖垮飞轮 20h 的 untracked output-quality-gate.test.js)让 verify 判"不绿"→
//   每个 self_evolution goal 都 verify_failed 回滚 → 飞轮整体停摆。绝对绿把"别窗已有 fail"误算成"飞轮破坏"。
//   修:flag ON 时,verify 不绿但 apply 后 fail 数没超 apply 前 baseline(非飞轮新增)→ 不回滚、放行。
//   默认 OFF = 绝对绿(零回归);owner 点火 NOE_EVOLUTION_RELATIVE_BASELINE 后才相对化。纯函数无依赖,便于单测。

/**
 * @param {{ verify?: { ok?: boolean, numFailedTests?: number } | null, baselineFailedTests?: number | null, relativeEnabled?: boolean }} [input]
 * @returns {boolean} true=回滚(飞轮真破坏/baseline缺失/报告不可信,保守) / false=放行(verify绿,或相对baseline不变差)
 */
export function shouldRollbackVerify(input = {}) {
  const { verify, baselineFailedTests, relativeEnabled = false } = input;
  if (verify && verify.ok === true) return false; // verify 绿 → 不回滚
  // 绝对不绿。相对 baseline 放行需全部满足:flag ON + apply后fail数可信 + baseline可信且>0(本就有别窗fail) + fail没超baseline。
  if (relativeEnabled
      && verify && typeof verify.numFailedTests === 'number'
      && typeof baselineFailedTests === 'number' && baselineFailedTests > 0
      && verify.numFailedTests <= baselineFailedTests) {
    return false; // 相对 baseline 不变差(别窗已有 fail、飞轮没新增)→ 放行
  }
  return true; // 飞轮新增 fail(真破坏)/ baseline 缺失 / 报告不可信 → 保守回滚(fail-closed)
}
