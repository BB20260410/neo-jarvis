// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function safeDivide(a, b) {
  if (b === 0) return 0;
  return a / b;
}
