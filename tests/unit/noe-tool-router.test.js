import { describe, expect, it } from 'vitest';
import { buildNoeCommandSurface } from '../../src/capabilities/NoeCommandSurface.js';
import { routeNoeTools } from '../../src/capabilities/NoeToolRouter.js';

describe('NoeToolRouter', () => {
  it('always injects safe core commands', () => {
    const out = routeNoeTools({ goal: '继续任务' });

    expect(out.injected.map((item) => item.id)).toEqual(expect.arrayContaining([
      'noe.find_tool',
      'noe.recall_memory',
      'noe.show_current_task',
      'noe.explain_next_action',
    ]));
  });

  it('selects relevant readonly tools by goal and context tags', () => {
    const out = routeNoeTools({
      goal: '帮我检索项目文件和记忆',
      contextTags: ['files', 'memory'],
      maxCommands: 10,
    });

    expect(out.injected.map((item) => item.id)).toContain('noe.fs.search');
    expect(out.injected.map((item) => item.id)).toContain('noe.memory.recall');
    expect(out.injectionBudget.injectedCount).toBeLessThanOrEqual(10);
  });

  it('does not inject high-risk tools without permission', () => {
    const surface = buildNoeCommandSurface({
      extraCommands: [{
        id: 'noe.shell.exec',
        title: '运行 shell',
        description: '执行命令',
        riskLevel: 'critical',
        capabilityTags: ['shell', 'exec'],
      }],
    });
    const out = routeNoeTools({
      goal: '需要 shell exec',
      commandSurface: surface,
      maxCommands: 10,
    });

    expect(out.injected.map((item) => item.id)).not.toContain('noe.shell.exec');
    expect(out.hidden.map((item) => item.id)).toContain('noe.shell.exec');
    expect(out.warnings).toContain('high_risk_or_permissioned_tools_hidden');
  });

  it('can route approved high-risk tools with explicit permission state', () => {
    const surface = buildNoeCommandSurface({
      permissionState: { consensusApproved: true },
      extraCommands: [{
        id: 'noe.shell.exec',
        title: '运行 shell',
        description: '执行命令',
        riskLevel: 'critical',
        capabilityTags: ['shell', 'exec'],
      }],
    });
    const out = routeNoeTools({
      goal: '需要 shell exec',
      commandSurface: surface,
      permissionState: { consensusApproved: true },
      maxCommands: 10,
    });

    expect(out.injected.map((item) => item.id)).toContain('noe.shell.exec');
  });
});

