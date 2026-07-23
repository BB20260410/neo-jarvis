// @ts-check
// NoeProactiveGate — 第三阶段·更智能的活动陪伴:懂什么时候该安静。
//
// 现状(NoeCircadian)只按时钟判静默(23:00-08:00)。真正的陪伴要懂「主人此刻需不需要」:
//   - 主人正在专注工作(刚还在活动)→ 别打断,即使白天;
//   - 没有真值得说的 → 别为开口而开口(克制);
//   - 紧急事 → 压过一切;
//   - 非静默 + 主人离开一阵 + 有真话 → 好时机。
// 纯函数、fail-open(信息不足倾向安静,宁可少打扰)。供 proactiveTick 门控(flag NOE_PROACTIVE_SMART_GATE)。

/**
 * @param {object} [ctx]
 * @param {boolean} [ctx.isQuiet] 时钟静默时段(NoeCircadian.isQuiet)
 * @param {number} [ctx.msSinceOwnerActivity] 距主人上次活动毫秒(越小=越可能在专注)
 * @param {number} [ctx.focusWindowMs] 专注窗口:此窗口内有活动视为在专注,别打断(默认 5min)
 * @param {boolean} [ctx.hasGenuineReason] 有没有真值得说的(承诺到期/牵挂/重要提醒),默认 true
 * @param {boolean} [ctx.urgent] 紧急(压过一切)
 * @returns {{ speak: boolean, reason: string }}
 */
export function shouldSpeakProactively({
  isQuiet = false,
  msSinceOwnerActivity = Infinity,
  focusWindowMs = 300_000,
  hasGenuineReason = true,
  urgent = false,
} = {}) {
  if (urgent === true) return { speak: true, reason: 'urgent' };
  if (isQuiet === true) return { speak: false, reason: 'quiet_hours' };
  const since = Number(msSinceOwnerActivity);
  if (Number.isFinite(since) && since < Math.max(0, Number(focusWindowMs) || 0)) {
    return { speak: false, reason: 'owner_focused' }; // 正在专注工作,别打断
  }
  if (hasGenuineReason !== true) return { speak: false, reason: 'nothing_worth_saying' };
  return { speak: true, reason: 'good_moment' };
}
