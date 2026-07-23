// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function parseIntOr(value, fallback) {
  return parseInt(value, 10); // BUG: NaN 未兜底
}
