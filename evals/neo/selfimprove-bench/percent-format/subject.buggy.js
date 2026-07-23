// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function toPercent(ratio) {
  return ratio + '%'; // BUG: 忘记 *100
}
