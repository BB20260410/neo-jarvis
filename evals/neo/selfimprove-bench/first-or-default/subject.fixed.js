// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function firstOrDefault(arr, fallback) {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr[0];
}
