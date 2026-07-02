// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function wordCount(text) {
  if (text === '') return 0;
  return text.split(' ').length; // BUG: 连续空格/首尾空格会多计
}
