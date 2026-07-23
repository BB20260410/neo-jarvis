// @ts-check
// 飞轮健壮性(2026-06-30):runtimeVerify 绝对绿判定 → 相对 baseline。
//   根因教训:别窗/已有 fail 测试(如曾拖垮飞轮 20h 的 untracked output-quality-gate.test.js)让 verify 判"不绿"→
//   每个 self_evolution goal 都 verify_failed 回滚 → 飞轮整体停摆。绝对绿把"别窗已有 fail"误算成"飞轮破坏"。
//   修:flag ON 时,verify 不绿但 apply 后 fail 数没超 apply 前 baseline(非飞轮新增)→ 不回滚、放行。
//   默认 OFF = 绝对绿(零回归);owner 点火 NOE_EVOLUTION_RELATIVE_BASELINE 后才相对化。纯函数无依赖,便于单测。

/**
 * 边界鲁棒性(baseline 缺/空基线/NaN/Infinity/null):fail 数一律用 Number.isFinite 规约为"可信且非负数"。
 *   baseline ≤ 0(空基线 / 别窗零 fail)  → 无可比较的基线 → 保守回滚(fail-closed,避免被 0 baseline 误放行)。
 *   verify.numFailedTests 不可信(NaN / Infinity / null / undefined)→ 视为报告不可信 → 保守回滚。
 *   原 typeof === 'number' 检查无法拒 NaN/Infinity(NaN 比较恒为 false 会被静默判回滚,但 Infinity 会让 ≤ 恒为 true 误放行)→ 改用 Number.isFinite。
 * @param {{ verify?: { ok?: boolean, numFailedTests?: number } | null, baselineFailedTests?: number | null, relativeEnabled?: boolean }} [input]
 * @returns {boolean} true=回滚(飞轮真破坏 / baseline缺失或不可信 / 报告不可信,保守) / false=放行(verify 绿,或相对 baseline 不变差)
 */
export function shouldRollbackVerify(input = {}) {
  const { verify, baselineFailedTests, relativeEnabled = false } = input;
  // 把 fail 数规约为"可信且非负的有限数":NaN / Infinity / null / undefined 一律视为不可信。
  // 可选链 + Number.isFinite 同时处理 verify=null 与 verify.numFailedTests 缺失。
  const verifyFails = verify?.numFailedTests;
  const verifyFailsOk = typeof verifyFails === 'number'
    && Number.isFinite(verifyFails)
    && /** @type {number} */ (verifyFails) >= 0;
  // baseline 必须 >0:0 等价于"空基线 / 别窗零 fail",没有可比较的参照,不放行(保守回滚)。
  const baselineOk = typeof baselineFailedTests === 'number'
    && Number.isFinite(baselineFailedTests)
    && /** @type {number} */ (baselineFailedTests) > 0;

  if (verify && verify.ok === true) return false; // verify 绿 → 不回滚
  // 绝对不绿。相对 baseline 放行需全部满足:flag ON + apply后fail数可信 + baseline可信且>0 + fail没超baseline。
  if (relativeEnabled
      && verifyFailsOk
      && baselineOk
      && /** @type {number} */ (verifyFails) <= /** @type {number} */ (baselineFailedTests)) {
    return false; // 相对 baseline 不变差(别窗已有 fail、飞轮没新增)→ 放行
  }
  return true; // 飞轮新增 fail(真破坏)/ baseline 缺失/空/0/不可信(NaN/Infinity/null) → 保守回滚(fail-closed)
}
