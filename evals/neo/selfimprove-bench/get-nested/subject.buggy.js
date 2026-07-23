// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function getNested(obj, keys, fallback) {
  let cur = obj;
  for (const k of keys) {
    cur = cur[k]; // BUG: cur 为 null/undefined 时抛 TypeError
  }
  return cur;
}
