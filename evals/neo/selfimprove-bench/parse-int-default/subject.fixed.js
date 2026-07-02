// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}
