// 审计 §3.2 P1②：~/.noe-panel 受 freedom hard veto 保护（owner 2026-06-11 选保留作防手滑误删 token 的安全网）
// 注：原 P1① guardLevel 收紧已按 owner「开发者要最大权限」偏好回滚（loose 可跳过 HIGH）。
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { runNoeFreedomAction } from '../../src/runtime/NoeFreedomExecutor.js';

describe('§3.2 P1② ~/.noe-panel 受 freedom hard veto 保护', () => {
  it('rm -rf ~/.noe-panel/owner-token.txt 在 developer 档被 hard veto', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'rm -rf ~/.noe-panel/owner-token.txt' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: { spawn: () => { throw new Error('should not spawn'); } },
    });
    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${homedir()}/.noe-panel`);
  });
});

// B1.6③ 回归：commandDeletesProtectedPath 已具备 $HOME 字面量展开保护（与 ~ 同等），仅补测试锁定覆盖。
// 既有用例只验了 ~ 形式（~/.codex、~/.noe-panel）；这里补 $HOME 字面量形式，防回归（不改逻辑）。
describe('§3.2 P1② $HOME 字面量展开同样被 hard veto 保护（回归锁定）', () => {
  const HOME = homedir();
  async function shellVeto(command) {
    return runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: { spawn: () => { throw new Error('should not spawn'); } },
    });
  }

  it('rm -rf $HOME/.noe-panel/owner-token.txt 被展开并 hard veto', async () => {
    const out = await shellVeto('rm -rf $HOME/.noe-panel/owner-token.txt');
    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${HOME}/.noe-panel`);
  });

  it('rm -rf $HOME/.codex 被展开并 hard veto', async () => {
    const out = await shellVeto('rm -rf $HOME/.codex');
    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${HOME}/.codex`);
  });

  it('$HOME 形式经 AppleScript do shell script 通道一样被 hard veto', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.macos.applescript.run',
      args: { script: 'do shell script "rm -rf $HOME/.agents"' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: { spawn: () => { throw new Error('should not spawn'); } },
    });
    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${HOME}/.agents`);
  });

  // 判别性反例：$HOME 下的非保护子路径不该被 veto——证明该测试真在区分保护路径，而非"凡 $HOME 都拦"。
  it('rm -rf $HOME/Downloads/tmp 不在保护清单内，不被该 hard veto 拦', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'rm -rf $HOME/Downloads/tmp' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      // 该命令不被 hard veto；放行后会进真实执行，注入 spawn 抛错以免真删文件——
      // 只断言它没有命中 protected_delete veto（绕过 hard veto 这一关）。
      deps: { spawn: () => { throw new Error('blocked at spawn (not by hard veto)'); } },
    });
    const protectedVeto = (out.blockers || []).some((b) => String(b).startsWith('developer_hard_veto_protected_delete'));
    expect(protectedVeto).toBe(false);
  });
});
