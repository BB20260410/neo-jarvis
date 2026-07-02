// @ts-check
// NoeEvolutionLogicGate — P3 受控逻辑改进门：把「改逻辑」从无门 apply → 受控。
//
// 背景：P0 度量证实当前进化全是 doc_only（只补 JSDoc，verdict='doc_only'，浅）。P2 刚打开 high_complexity/test_gap
//   信号源 → 飞轮开始产「改逻辑」patch。但本地 35b 改逻辑能力未验证，无门直接 apply（仅 runtime verify 兜底）风险高。
// 这道门按 P0 的 verdict 分流：
//   - doc_only / neutral（codeChanged===0）→ 放行（当前行为零回归）。
//   - logic_changed（改了代码行）→ 默认拒（flag NOE_EVOLUTION_LOGIC OFF）；flag ON 时需「双绿门」：
//       改前 baseline 测试绿（证明行为基线可信）+ 改后 verify 测试绿（证明行为不变）。两者皆绿才允许保留重构。
//   - test_only（patch 只动 tests/，纯增量补测试）→ 豁免改逻辑限制（零行为风险），只需改后 verify 绿。
// preCheck 在 runtime verify 前早拒（flag OFF 的改逻辑不必浪费一次全量 verify）；postCheck 是 verify 后的双绿门终判。
// 纯函数 + DI（logicEnabled/isTestPath）+ fail-open（缺 summary/度量不阻断闭环；logicEnabled 抛错保守视为 OFF）。

function defaultIsTestPath(rel) {
  const p = String(rel || '');
  return p.endsWith('.test.js') || p.startsWith('tests/') || p.includes('/tests/');
}

/**
 * @param {object} [deps]
 * @param {() => boolean} [deps.logicEnabled] flag NOE_EVOLUTION_LOGIC（默认 OFF=拒改逻辑）
 * @param {(rel: string) => boolean} [deps.isTestPath] 判路径是否测试文件（test_only 豁免用）
 */
export function createEvolutionLogicGate({
  logicEnabled = () => false,
  isTestPath = defaultIsTestPath,
} = {}) {
  // 抛错保守视为 OFF（缺判据时拒改逻辑，安全优先）。
  function enabled() {
    try { return logicEnabled() === true; } catch { return false; }
  }

  // 全部路径都是测试文件 → test_only（纯增量补测试）；空或含 src → src（保守）。
  function classify(paths) {
    const arr = Array.isArray(paths) ? paths : [];
    if (!arr.length) return 'src';
    return arr.every((p) => isTestPath(p)) ? 'test_only' : 'src';
  }

  function isLogicChange(summary) {
    return !!(summary && summary.verdict === 'logic_changed');
  }

  // verify 前早拒：flag OFF 的改 src 逻辑直接 block（省一次全量 verify）。doc/neutral/test_only 放行。
  function preCheck({ summary, paths } = {}) {
    if (!isLogicChange(summary)) return { block: false };
    if (classify(paths) === 'test_only') return { block: false, note: 'test_increment' };
    if (!enabled()) return { block: true, reason: 'logic_change_disabled' };
    return { block: false }; // flag ON → 留给 postCheck 双绿门
  }

  // verify 后终判（双绿门）。doc/neutral 放行；test_only 只需 verify 绿；改 src 逻辑需 baseline+verify 双绿。
  function postCheck({ summary, paths, baselineGreen, verifyGreen } = {}) {
    if (!isLogicChange(summary)) return { allow: true, reason: 'non_logic' };
    if (classify(paths) === 'test_only') {
      return verifyGreen === true
        ? { allow: true, reason: 'test_increment' }
        : { allow: false, reason: 'verify_not_green' };
    }
    if (!enabled()) return { allow: false, reason: 'logic_change_disabled' };
    if (baselineGreen !== true) return { allow: false, reason: 'baseline_not_green' };
    if (verifyGreen !== true) return { allow: false, reason: 'verify_not_green' };
    return { allow: true, reason: 'logic_change_verified' };
  }

  return { classify, preCheck, postCheck, enabled };
}
