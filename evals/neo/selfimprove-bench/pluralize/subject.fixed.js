// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function pluralize(count, word) {
  return count + ' ' + (count === 1 ? word : word + 's');
}
