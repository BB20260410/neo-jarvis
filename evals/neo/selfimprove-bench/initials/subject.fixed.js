// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
export function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('');
}
