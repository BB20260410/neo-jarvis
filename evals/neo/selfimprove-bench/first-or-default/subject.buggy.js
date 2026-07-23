// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function firstOrDefault(arr, fallback) {
  return arr[0]; // BUG: 空数组/非数组未回退
}
