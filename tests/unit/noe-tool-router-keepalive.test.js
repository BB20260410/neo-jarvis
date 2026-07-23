import { describe, expect, it } from 'vitest';
import { routeNoeTools } from '../../src/capabilities/NoeToolRouter.js';

describe('NoeToolRouter L6 保活', () => {
  it('最近用过的工具强制保留，本轮 goal 关键词未命中也不丢', () => {
    const surface = { commands: [{ id: 'noe.shell.exec', capability: 'shell.exec', title: 'Shell 执行命令', riskLevel: 'low' }] };
    // 无 recentActions：goal 不匹配 → 不注入
    const noRecent = routeNoeTools({ goal: 'zzz_unrelated_topic', commandSurface: surface });
    expect(noRecent.injected.some((c) => c.id === 'noe.shell.exec')).toBe(false);
    // 有 recentActions（上轮用过 shell.exec）：保活强制保留
    const withRecent = routeNoeTools({ goal: 'zzz_unrelated_topic', commandSurface: surface, recentActions: [{ action: 'shell.exec' }] });
    expect(withRecent.keepAlive.some((c) => c.id === 'noe.shell.exec')).toBe(true);
    expect(withRecent.injected.some((c) => c.id === 'noe.shell.exec')).toBe(true);
  });

  it('保活按 command.id / capability / action 任一匹配 recentActions', () => {
    const surface = { commands: [{ id: 'noe.git.commit', capability: 'git.commit', title: 'Git 提交', riskLevel: 'low' }] };
    const byId = routeNoeTools({ goal: 'zzz', commandSurface: surface, recentActions: [{ toolName: 'noe.git.commit' }] });
    expect(byId.injected.some((c) => c.id === 'noe.git.commit')).toBe(true);
    const byCap = routeNoeTools({ goal: 'zzz', commandSurface: surface, recentActions: [{ action: 'git.commit' }] });
    expect(byCap.injected.some((c) => c.id === 'noe.git.commit')).toBe(true);
  });

  it('保活不被 maxCommands 预算挤掉', () => {
    const commands = [{ id: 'noe.shell.exec', capability: 'shell.exec', title: 'Shell', riskLevel: 'low' }];
    for (let i = 0; i < 10; i += 1) commands.push({ id: `fill.${i}`, title: `填充工具 zzz ${i}`, riskLevel: 'low' });
    const out = routeNoeTools({ goal: 'zzz', commandSurface: { commands }, recentActions: [{ action: 'shell.exec' }], maxCommands: 3 });
    expect(out.injected.some((c) => c.id === 'noe.shell.exec')).toBe(true); // 即便预算只 3，保活仍在
  });

  it('无 recentActions 时行为与原逻辑一致（keepAlive 为空）', () => {
    const surface = { commands: [{ id: 'noe.shell.exec', capability: 'shell.exec', title: 'Shell', riskLevel: 'low' }] };
    const out = routeNoeTools({ goal: 'zzz', commandSurface: surface });
    expect(out.keepAlive).toEqual([]);
  });
});
