// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function initials(name) {
  return name[0].toUpperCase(); // BUG: 只取了第一个字母
}
