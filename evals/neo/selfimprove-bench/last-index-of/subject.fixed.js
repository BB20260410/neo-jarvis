// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function lastIndexOf(arr, value) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] === value) return i;
  }
  return -1;
}
