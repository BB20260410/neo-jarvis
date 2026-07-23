import { describe, expect, it } from 'vitest';
import { detectTaskIntent, formatTaskIntentReply } from '../../src/room/TaskIntentRouter.js';

describe('TaskIntentRouter', () => {
  it('detects Codex delegation requests as confirm-only task plans', () => {
    const plan = detectTaskIntent('让 Codex 帮我修复登录页 bug');
    expect(plan).toMatchObject({
      intent: 'delegate_task',
      targetAdapter: 'codex',
      targetMode: 'chat',
      approvalRequired: true,
      dryRunOnly: true,
    });
    expect(plan.instructions).toContain('修复登录页 bug');
    expect(formatTaskIntentReply(plan)).toContain('未启动 CLI');
  });

  it('detects multi-AI team requests as squad plans', () => {
    const plan = detectTaskIntent('开个多AI团队开发一个导出功能');
    expect(plan).toMatchObject({ targetAdapter: 'squad', targetMode: 'squad' });
  });

  it('ignores ordinary chat without work delegation intent', () => {
    expect(detectTaskIntent('今天聊聊天')).toBe(null);
  });
});
