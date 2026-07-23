// @ts-check
// NoeSelfDirectionBudget — #54 自主定方向的 reward hacking 熔断。
//
// 痛点：放开 P5 advisory-only 墙后，飞轮自主生成进化方向。残留风险=飞轮反复刷「无真价值的方向」
//   （生成 → 走安全网 → 产 neutral/被回滚 → 再生成…）空转刷分。价值锚（生成阶段质量闸/引用性/expectedVerdict）
//   拦不住「预期 logic_changed 但实际产 neutral」的方向——需要事后熔断。
//
// 方案：纯函数 + DI——调用方提供「自主方向连续 neutral/失败次数」+「上次失败时间」，本模块判 allowed。
//   零副作用、零执行权。两道闸：① 连续 neutral 上限（reward hacking 主信号：刷无价值方向）② 失败冷却。
//
// flag 由调用方门控（resolveSelfDirectionBudget 读 env）：两项默认都「不限/关」= 现状零回归。

/**
 * 判断当前是否允许发起一次自主方向生成。
 * @param {object} state
 * @param {number} [state.consecutiveNeutral] 自主方向连续产 neutral/失败的次数（调用方追踪 outcome）
 * @param {number} [state.lastFailureAt] 上次自主方向失败时间戳(ms)；falsy/0=无失败
 * @param {object} [opts]
 * @param {number} [opts.maxConsecutiveNeutral] 连续 neutral 上限；<=0 = 不限
 * @param {number} [opts.cooldownMs] 失败后冷却毫秒；<=0 = 关
 * @param {() => number} [opts.now]
 * @returns {{ allowed:boolean, reason:string, retryAfterMs?:number }}
 */
export function checkSelfDirectionBudget(state = {}, { maxConsecutiveNeutral = 0, cooldownMs = 0, now = () => Date.now() } = {}) {
  const s = state && typeof state === 'object' ? state : {}; // null/非对象兜底（默认参数对 null 不生效）
  const neutral = Number.isFinite(Number(s.consecutiveNeutral)) ? Math.max(0, Number(s.consecutiveNeutral)) : 0;

  // ① 连续 neutral 熔断（reward hacking 主信号：反复刷无价值方向 → 暂停自主生成）
  if (maxConsecutiveNeutral > 0 && neutral >= maxConsecutiveNeutral) {
    // half-open（CircuitBreaker 模式）：熔断后不立新 goal → consecutiveNeutral 永 ≥ 上限 → 永久死锁(实测卡 37h)。
    //   cooldown 已过则放行一次试探：成功(遇 done)下轮 consecutiveNeutral 自然重置、失败则 lastFailureAt 更新后再 cooldown。
    //   受 cooldownMs 门控——cooldownMs<=0(默认) 时不试探，行为逐字同原(永久熔断)，零回归。
    const lf = Number(s.lastFailureAt);
    if (cooldownMs > 0 && Number.isFinite(lf) && lf > 0 && (now() - lf) >= cooldownMs) {
      return { allowed: true, reason: 'half_open_probe' };
    }
    return { allowed: false, reason: `自主方向连续 ${neutral} 次无价值(consecutive_neutral)，已熔断暂停生成` };
  }

  // ② 失败冷却（失败后强制喘息）
  const lastFail = Number(s.lastFailureAt);
  if (cooldownMs > 0 && Number.isFinite(lastFail) && lastFail > 0) {
    const elapsed = now() - lastFail;
    if (elapsed >= 0 && elapsed < cooldownMs) {
      const retryAfterMs = cooldownMs - elapsed;
      return { allowed: false, reason: `自主方向失败冷却中(cooldown，还需 ${Math.ceil(retryAfterMs / 1000)}s)`, retryAfterMs };
    }
  }

  return { allowed: true, reason: '' };
}

/**
 * 从 env 解析自主方向熔断配置。非法 / 未设 → 回退「不限/关」（默认零回归）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ maxConsecutiveNeutral:number, cooldownMs:number, enabled:boolean }}
 */
export function resolveSelfDirectionBudget(env = process.env) {
  const rawMax = Number.parseInt(env.NOE_SELF_DIRECTION_MAX_CONSECUTIVE_NEUTRAL ?? '', 10);
  const rawCooldown = Number.parseInt(env.NOE_SELF_DIRECTION_COOLDOWN_MS ?? '', 10);
  const maxConsecutiveNeutral = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;
  const cooldownMs = Number.isFinite(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0;
  return { maxConsecutiveNeutral, cooldownMs, enabled: maxConsecutiveNeutral > 0 || cooldownMs > 0 };
}
