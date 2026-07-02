import { describe, expect, it } from 'vitest';
import { planVisualAction } from '../../src/vision/VisualActionPlanner.js';

describe('VisualActionPlanner', () => {
  it('浏览器目标只生成计划，不执行，并要求审批', () => {
    const plan = planVisualAction({
      goal: '打开 localhost:51835/mind.html 看目标卡',
      screenshotSummary: '浏览器在 Noe 面板',
      domSummary: '<a href="/mind.html">内心透视</a>',
      surface: 'browser',
    });
    expect(plan).toMatchObject({ ok: true, status: 'planned', execute: false, requiresApproval: true });
    expect(plan.actions[0].type).toBe('browser.navigate');
    expect(plan.actions[0].evidenceNeeded).toContain('owner_approval');
    expect(plan.evidence.domSummary).toContain('mind.html');
  });

  it('点击/输入/下载只分类为 proposal，不直接操作', () => {
    expect(planVisualAction({ goal: '点击登录按钮' }).actions[0].type).toBe('browser.click');
    expect(planVisualAction({ goal: '输入搜索词 Noe' }).actions[0].type).toBe('browser.type');
    const download = planVisualAction({ goal: '下载报告' });
    expect(download.actions[0].type).toBe('browser.download');
    expect(download.risk).toBe('browser_download_requires_review');
  });

  it('桌面全局动作默认 blocked', () => {
    const plan = planVisualAction({ goal: '在系统设置里全局点击授权', surface: 'desktop' });
    expect(plan).toMatchObject({ ok: true, status: 'blocked', execute: false, requiresApproval: true, risk: 'desktop_global_action_blocked' });
    expect(plan.actions).toEqual([]);
  });

  it('缺 goal 安全阻断', () => {
    const plan = planVisualAction({});
    expect(plan.ok).toBe(false);
    expect(plan.error).toBe('goal required');
  });
});
