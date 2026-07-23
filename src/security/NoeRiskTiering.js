// @ts-check
/**
 * NoeRiskTiering — 自改候选 5 维风险分级（ROADMAP P2.3 真风险门）。
 *
 * 背景：现有 NoeEvolutionCandidateGate 是「工程门」(size/growth/structure/tests/holdout)，
 *   ROADMAP P2.3 要的是「风险分级」门(blast/可逆/外部依赖/语义验证/耦合)——两套不同抽象。
 *   本模块【叠加非替换】CandidateGate：给候选打 green/yellow/red 风险标签，供 P3.2「Neo 练手只取绿档」
 *   + P3.1 信任校准用。
 *
 * 设计：纯函数 + DI(isProtectedPath 注入，不直接耦合 PolicyFileGuard，易测)，零执行权、无副作用。
 *   汇总规则：任一维 red → red；任一维 yellow → yellow；全 green → green（就高不就低，保守）。
 *
 * flag：调用方用 NOE_RISK_TIERING 门控；本模块只是纯函数，默认不被任何热路径调用（接 P3 时启用）。
 */

// 触网 / 装包 / 凭据 的命令样式（外部依赖维度）
const NET_INSTALL_CRED_RE = /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|curl|wget|fetch\s*\(|https?:\/\/|api[_-]?key|token|secret|credential|\.env)\b/i;

/**
 * @param {object} candidate
 * @param {string[]} [candidate.changedFiles] 改动文件路径
 * @param {*} [candidate.rollbackRef] 回滚锚（rollback patch/ref/sha）；真值=可逆
 * @param {boolean} [candidate.touchesExternal] 显式标记触外部依赖
 * @param {string} [candidate.command] 候选要跑的命令（检测网/装包/凭据）
 * @param {boolean} [candidate.hasOracle] 有无独立语义验证 oracle（非自验）
 * @param {object} [deps]
 * @param {(p:string)=>boolean} [deps.isProtectedPath] 注入的保护路径判定（PolicyFileGuard.classifyNoePolicyFilePath 包一层）
 * @param {number} [deps.blastFileThreshold] blast 黄档文件数阈值，默认 5
 * @param {number} [deps.couplingModuleThreshold] 耦合黄档模块数阈值，默认 3
 * @returns {{ tier:'green'|'yellow'|'red', dims:{blast:string,reversible:string,external:string,semantic:string,coupling:string}, reasons:string[] }}
 */
export function tierRisk(candidate = {}, { isProtectedPath = () => false, blastFileThreshold = 5, couplingModuleThreshold = 3 } = {}) {
  const files = Array.isArray(candidate.changedFiles) ? candidate.changedFiles.filter(Boolean).map(String) : [];
  const reasons = [];

  // ① blast：触保护路径=red；改动文件数超阈=yellow；否则 green
  const touchesProtected = files.some((f) => { try { return !!isProtectedPath(f); } catch { return false; } });
  let blast;
  if (touchesProtected) { blast = 'red'; reasons.push('blast: 触保护路径(核心禁区)'); }
  else if (files.length > blastFileThreshold) { blast = 'yellow'; reasons.push(`blast: 改动 ${files.length} 文件(>${blastFileThreshold})`); }
  else blast = 'green';

  // ② 可逆：有 rollbackRef=green；无=yellow
  const reversible = candidate.rollbackRef ? 'green' : 'yellow';
  if (reversible !== 'green') reasons.push('可逆: 缺 rollback 锚');

  // ③ 外部依赖：触网/装包/凭据=red；否则 green
  const external = !!candidate.touchesExternal || NET_INSTALL_CRED_RE.test(String(candidate.command || ''));
  const externalTier = external ? 'red' : 'green';
  if (external) reasons.push('外部依赖: 触网/装包/凭据');

  // ④ 语义验证：有独立 oracle=green；无=yellow(仅自验)
  const semantic = candidate.hasOracle ? 'green' : 'yellow';
  if (semantic !== 'green') reasons.push('语义验证: 无独立 oracle(仅自验)');

  // ⑤ 耦合：跨模块(改动文件前 3 段路径去重)数超阈=yellow
  const dirs = new Set(files.map((f) => f.split('/').slice(0, 3).join('/')));
  let coupling;
  if (dirs.size > couplingModuleThreshold) { coupling = 'yellow'; reasons.push(`耦合: 跨 ${dirs.size} 模块(>${couplingModuleThreshold})`); }
  else coupling = 'green';

  const dims = { blast, reversible, external: externalTier, semantic, coupling };
  const vals = Object.values(dims);
  const tier = vals.includes('red') ? 'red' : vals.includes('yellow') ? 'yellow' : 'green';
  return { tier, dims, reasons };
}

/** green 档可供 Neo 自主练手（P3.2）；yellow/red 需主线审/owner kickstart。 */
export function isGreenTier(result) {
  return !!result && result.tier === 'green';
}
