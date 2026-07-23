// @ts-check
// _protectedPathGuard — Noe freedom 危险命令的「删保护路径」安全闸（单一来源）。
//
// 背景：commandDeletesProtectedPath 此前在 NoeFreedomAdapters.js（marketplace entrypoint 校验，
//   原 line 81）与 NoeFreedomExecutor.js（developer hard veto，原 line 47）各有一份【字节级完全
//   一致】的副本。两份重复意味着任一方改了 protectedPaths 清单或 destructiveVerb 正则、另一方忘改，
//   就会让"防手滑误删 owner-token / ~/.codex / ~/.noe-panel"这道 owner 明确选择保留的安全网
//   （审计 §3.2 P1②，2026-06-11）在两条执行路径上 drift、保护不一致。抽到这里成单一来源消除该风险。
//
// 注意：这【不是】新增护栏（owner 偏好开发自由、不加新拦截）——而是把【已存在且 owner 选择保留】的
//   护栏去重，让它在两条路径上恒一致、更可靠。行为逐字不变（同一函数体、同一 protectedPaths 清单、
//   同一 destructiveVerb 正则、同一 $HOME/~ 展开与匹配逻辑）。纯函数，零网络/时钟/RNG。

import { homedir } from 'node:os';

/**
 * 判断一条 shell 命令是否会删除受保护路径（系统目录 + Codex/agents/noe-panel 运行时目录）。
 * 先要求命令含破坏性动词（rm/rmdir/unlink/trash，含 sudo 前缀），再逐个匹配受保护路径。
 * 命中返回被保护的目标路径字符串；未命中返回 ''（空串）。与抽取前两处内联实现逐字等价。
 * @param {string} [command]
 * @returns {string} 命中的受保护路径，未命中为 ''
 */
export function commandDeletesProtectedPath(command = '') {
  const text = String(command || '')
    .replace(/\$HOME/g, homedir())
    .replace(/~/g, homedir());
  const protectedPaths = [
    '/',
    '/System',
    '/Library',
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/var',
    '/Applications/Codex.app',
    `${homedir()}/.codex`,
    `${homedir()}/.agents`,
    `${homedir()}/.noe-panel`, // 审计 §3.2 P1②：保护 owner-token/exec-policy/域名白名单不被 freedom 删除切断会话
  ];
  const destructiveVerb = /(^|[;&|]\s*|['"])(sudo\s+)?(rm\s+(-[^\s]*[rRfF][^\s]*\s+)*|rmdir\s+|unlink\s+|trash\s+)/i;
  if (!destructiveVerb.test(text)) return '';
  for (const target of protectedPaths) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffix = target === '/' ? `([\\s'"*]|$)` : `([/\\s'"]|$)`;
    const pathPattern = new RegExp(`(^|\\s|['"])${escaped}${suffix}`);
    if (pathPattern.test(text)) return target;
  }
  return '';
}
