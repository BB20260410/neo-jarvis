// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function classifySign(n) {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'zero';
}
