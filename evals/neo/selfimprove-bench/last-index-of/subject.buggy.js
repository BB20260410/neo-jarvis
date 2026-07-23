// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function lastIndexOf(arr, value) {
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] === value) return i; // BUG: 正向返回首个
  }
  return -1;
}
