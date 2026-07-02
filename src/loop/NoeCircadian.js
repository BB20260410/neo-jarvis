// @ts-check
// NoeCircadian — 时间节律（内在世界·支柱⑦）。
//
// 问题：Noe 的后台行为（反刍/主动陪伴/自我状态）没有昼夜概念——深夜也按白天频率反刍、
//   到点提醒半夜开口。本模块给所有消费方提供统一的「现在是一天的什么时候」纯函数 API：
//   phaseOf(ts) 四相（morning/day/evening/night）+ isQuiet(ts) 静默时段（23:00-08:00）+ 倍率表。
//
// 纪律：纯函数、零副作用、本模块不读 env（门控在各装配点 NOE_CIRCADIAN=1 默认 OFF）；
//   ts 参数即 now 注入位（可测）；时区用本机（new Date(ts).getHours()）；
//   非法时间戳一律按「白天/非静默」处理（fail-open：判不出节律就不调制任何行为）。
//
// 消费方（全部装配点门控 + fail-open，本模块只提供查询）：
//   - 反刍 timer（server.js NOE_INNER_MONOLOGUE 块）：tick 内查 isQuiet，静默时段有效间隔×4
//   - proactiveTick：注入 isQuiet，夜间不开口（到期承诺留店，出静后第一个 tick 自然提起）
//   - NoeSelfModel：注入 { phaseOf, isQuiet }，snapshot.situation 加 timeOfDay + 深夜心境
//   - 梦境升华（支柱②，由其实施者消费）：phaseOf(ts) === 'night' 限定夜里跑

/** 静默时段起点（含）：23:00 起入静。 */
export const QUIET_START_HOUR = 23;
/** 静默时段终点（不含）：08:00 出静。 */
export const QUIET_END_HOUR = 8;

/** 一天四相（按本机时区小时切分，见 phaseOf）。 */
export const PHASES = Object.freeze(['morning', 'day', 'evening', 'night']);

/**
 * 各消费方倍率表（装配点引用，避免魔数散落）。
 */
export const CIRCADIAN_MULTIPLIERS = Object.freeze({
  /** 反刍：静默时段有效间隔×4（tick 内判定，不改 setInterval 周期）。 */
  innerMonologueQuietFactor: 4,
  /** 主动陪伴：静默时段不开口（false=禁声；到期承诺不消费，顺延到出静后第一个 tick）。 */
  proactiveQuietSpeak: false,
});

/**
 * 取本机时区小时；非法时间戳返回 null（调用方据此 fail-open）。
 * @param {number | string | Date | null | undefined} ts
 * @returns {number|null}
 */
function localHourOf(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const h = d.getHours();
  return Number.isFinite(h) ? h : null;
}

/**
 * 此刻属于一天的哪一相（本机时区）：
 *   morning 05:00-10:59 / day 11:00-17:59 / evening 18:00-22:59 / night 23:00-04:59。
 * 非法时间戳 → 'day'（fail-open：判不出就当白天，不触发任何夜间调制）。
 * @param {number} [ts] 时间戳（ms），默认此刻——参数即 now 注入位
 * @returns {'morning'|'day'|'evening'|'night'}
 */
export function phaseOf(ts = Date.now()) {
  const h = localHourOf(ts);
  if (h === null) return 'day';
  if (h >= 23 || h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 18) return 'day';
  return 'evening';
}

/**
 * 是否处于静默时段（23:00-08:00，含 23:00、不含 08:00）。
 * 非法时间戳 → false（fail-open：判不出就当非静默，行为与无节律一致）。
 * @param {number} [ts] 时间戳（ms），默认此刻
 * @returns {boolean}
 */
export function isQuiet(ts = Date.now()) {
  const h = localHourOf(ts);
  if (h === null) return false;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * 判断 now 是否落在某个 [startHour, endHour) 区间内（含 start，不含 end）。
 * 纯函数，支持反向区间（如 23:00-08:00 跨夜：startHour > endHour 时按「startHour 起或 endHour 前」判定）。
 * window 非法（null/undefined、非对象、start/end 不是有限数、或不在 [0,24) 内）→ false（fail-open：判不出就当不在窗口）。
 * 时间戳非法 → false。
 * @param {number} [now] 时间戳（ms），默认此刻——参数即 now 注入位
 * @param {{ startHour: number, endHour: number } | null | undefined} window
 * @returns {boolean}
 */
export function isInActiveWindow(now = Date.now(), window) {
  if (!window || typeof window !== 'object') return false;
  const { startHour, endHour } = window;
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return false;
  if (startHour < 0 || startHour >= 24 || endHour < 0 || endHour >= 24) return false;
  const h = localHourOf(now);
  if (h === null) return false;
  if (startHour <= endHour) {
    return h >= startHour && h < endHour;
  }
  // 反向区间（跨夜，如 23:00-08:00）：startHour 起 或 endHour 前 都算在窗口内
  return h >= startHour || h < endHour;
}

/**
 * 反刍 timer tick 内的节律判定（纯函数，供 server.js 装配点调用）：
 * 非静默时段照常跑；静默时段把有效间隔拉长 factor 倍（不改 setInterval 周期，最小侵入）。
 * 参数非法（intervalMs/nowMs 不是正常数）→ true（fail-open：判不出就照常跑）。
 * @param {object} opts
 * @param {boolean} opts.quiet 此刻是否静默时段（调用方传 isQuiet(now) 结果）
 * @param {number} opts.nowMs 此刻时间戳
 * @param {number} [opts.lastRunAt] 上次真正执行的时间戳（首次为 0 → 允许执行一次）
 * @param {number} opts.intervalMs timer 的固定周期
 * @param {number} [opts.factor] 静默时段间隔倍率（默认倍率表 innerMonologueQuietFactor）
 * @returns {boolean} 本次 tick 是否应执行
 */
export function shouldRunQuietTick({ quiet, nowMs, lastRunAt, intervalMs, factor } = {}) {
  if (quiet !== true) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) return true;
  const f = typeof factor === 'number' && Number.isFinite(factor) && factor > 1 ? factor : CIRCADIAN_MULTIPLIERS.innerMonologueQuietFactor;
  const last = typeof lastRunAt === 'number' && Number.isFinite(lastRunAt) ? lastRunAt : 0;
  return nowMs - last >= intervalMs * f;
}

/** 便捷注入对象（NoeSelfModel 等消费方整体注入用；冻结防被改）。 */
export const defaultCircadian = Object.freeze({ phaseOf, isQuiet });
