// @ts-check
// NoeSelfEvolutionBudget — 自改预算 / 限速（ROADMAP P3.4 信任校准）。
//
// 痛点（Explore 地图实测）：自改链路无任何「次数预算」或「失败冷却」——唯一节流是心跳 cadence
//   （NOE_SELF_EVOLUTION_TICK_MS 默认 5min/拍）。坏 patch 反复尝试 / 失败后立刻重试会 thrashing。
//
// 方案：纯函数 + DI——调用方提供「今日已发起自改数」+「上次失败时间」，本模块判 allowed。
//   零副作用、零执行权。两道闸：① 每日自改次数上限（防量）② 失败冷却（防失败后立刻重试）。
//
// flag 由调用方门控（resolveSelfEvolutionBudgetConfig 读 env）：两项默认都「不限/关」= 现状零回归。
//   对 Neo 保持克制：这是「防伤害的节流」而非「能力限制」，上限设宽松，只挡明显失控（owner 可调）。

/**
 * 判断当前是否允许发起一次自改。
 * @param {object} state
 * @param {number} [state.attemptsToday] 今日已发起自改 cycle 数（调用方从 CycleStore 数）
 * @param {number} [state.lastFailureAt] 上次自改失败时间戳(ms)；falsy/0=无失败
 * @param {object} [opts]
 * @param {number} [opts.maxPerDay] 每日上限；<=0 = 不限
 * @param {number} [opts.failureCooldownMs] 失败后冷却毫秒；<=0 = 关
 * @param {() => number} [opts.now]
 * @returns {{ allowed:boolean, reason:string, retryAfterMs?:number }}
 */
export function checkSelfEvolutionBudget(state = {}, { maxPerDay = 0, failureCooldownMs = 0, now = () => Date.now() } = {}) {
  const s = state && typeof state === 'object' ? state : {}; // null/非对象兜底（默认参数对 null 不生效，防御）
  const attempts = Number.isFinite(Number(s.attemptsToday)) ? Math.max(0, Number(s.attemptsToday)) : 0;

  // ① 每日次数上限（防失控量产坏 patch）
  if (maxPerDay > 0 && attempts >= maxPerDay) {
    return { allowed: false, reason: `当日自改次数达上限（${attempts}/${maxPerDay}）` };
  }

  // ② 失败冷却（失败后强制喘息，避免立刻重试 thrashing）
  const lastFail = Number(s.lastFailureAt);
  if (failureCooldownMs > 0 && Number.isFinite(lastFail) && lastFail > 0) {
    const elapsed = now() - lastFail;
    if (elapsed >= 0 && elapsed < failureCooldownMs) {
      const retryAfterMs = failureCooldownMs - elapsed;
      return { allowed: false, reason: `自改失败冷却中（还需 ${Math.ceil(retryAfterMs / 1000)}s）`, retryAfterMs };
    }
  }

  return { allowed: true, reason: '' };
}

/**
 * 从 env 解析预算配置。非法 / 未设 → 回退「不限/关」（默认零回归）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ maxPerDay:number, failureCooldownMs:number, enabled:boolean }}
 */
export function resolveSelfEvolutionBudgetConfig(env = process.env) {
  const rawMax = Number.parseInt(env.NOE_SELF_EVOLUTION_MAX_CYCLES_PER_DAY ?? '', 10);
  const rawCooldown = Number.parseInt(env.NOE_SELF_EVOLUTION_FAILURE_COOLDOWN_MS ?? '', 10);
  const maxPerDay = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;
  const failureCooldownMs = Number.isFinite(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0;
  return { maxPerDay, failureCooldownMs, enabled: maxPerDay > 0 || failureCooldownMs > 0 };
}

/**
 * 判定一拍 tick 是否算「自改失败」（供冷却闸用）。tick 顶层 ok:true 仍可能内层 act/autodrive 失败
 *   （codex 审核坐实：actResult.ok===false / autodrive.ok===false 会被包在顶层成功结果里）——
 *   故覆盖三种失败形态，避免真实失败逃过冷却继续 thrashing。
 * @param {object|null} result tick 返回
 * @returns {boolean}
 */
export function isSelfEvolutionTickFailure(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.ok === false) return true;
  if (result.actResult && result.actResult.ok === false) return true;
  if (result.autodrive && result.autodrive.ok === false) return true;
  return false;
}

// 冷却 EXEMPT：implementer 没产出 patch（尤其诗性目标产空 operations）不是「自改失败」——它没改任何代码。
const COOLDOWN_EXEMPT_REASON_RE = /no_patch_plan|non_usable|implementer_no_adapter|implementer_unavailable|implementer_not_wired/i;

/**
 * 判定一拍 tick 是否算「值得冷却的真自改失败」（供冷却闸用，比 isSelfEvolutionTickFailure 更窄）。
 * 冷却的目的是「改了代码但 apply/verify 坏了 → 退避防反复撞坏」。但 no_patch_plan / non_usable
 *   （implementer 没产出 patch，尤其诗性目标产空 operations）根本没改代码，冷却它只会拖累就位的真信号目标
 *   （实测根因：诗性目标产空触发 28min 自改冷却，把高优先真信号目标全卡死，飞轮空转）。故这类失败不冷却。
 * @param {object|null} result tick 返回
 * @returns {boolean}
 */
export function isSelfEvolutionCooldownFailure(result) {
  if (!isSelfEvolutionTickFailure(result)) return false;
  const reason = String(
    (result && (result.reason
      || (result.actResult && (result.actResult.reason || result.actResult.error))
      || (result.autodrive && (result.autodrive.reason || result.autodrive.error)))) || '',
  );
  return !COOLDOWN_EXEMPT_REASON_RE.test(reason);
}
