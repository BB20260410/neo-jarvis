// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
