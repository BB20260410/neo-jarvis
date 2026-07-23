// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function sumPositive(nums) {
  let total = 0;
  for (const n of nums) {
    total += n; // BUG: 未过滤非正数
  }
  return total;
}
