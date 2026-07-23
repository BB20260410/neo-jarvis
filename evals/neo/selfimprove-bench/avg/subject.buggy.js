// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function average(nums) {
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length; // BUG: 空数组 => NaN
}
