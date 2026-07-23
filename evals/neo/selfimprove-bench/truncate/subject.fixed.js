// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
