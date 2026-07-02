// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function withDefaults(overrides, defaults) {
  return { ...overrides, ...defaults }; // BUG: defaults 覆盖了 overrides
}
