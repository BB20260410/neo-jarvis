// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function safeDivide(a, b) {
  return a / b; // BUG: b===0 未处理
}
