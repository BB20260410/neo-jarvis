// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function getNested(obj, keys, fallback) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return fallback;
    cur = cur[k];
  }
  return cur == null ? fallback : cur;
}
