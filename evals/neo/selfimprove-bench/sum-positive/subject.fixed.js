// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function sumPositive(nums) {
  let total = 0;
  for (const n of nums) {
    if (n > 0) total += n;
  }
  return total;
}
