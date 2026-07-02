// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function truncate(text, max) {
  return text.slice(0, max) + '…'; // BUG: 未判断是否真的超长
}
