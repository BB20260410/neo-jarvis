import { describe, it, expect } from 'vitest';
import { checkDomainAllowed, classifyBrowserActionRisk, evaluateBrowserAct } from '../../src/capabilities/NoeBrowserActPolicy.js';

describe('checkDomainAllowed（NetworkPolicy 域白名单 opt-in）', () => {
  it('未设白名单 → 开放（owner 最大自由）', () => {
    expect(checkDomainAllowed('https://anything.com', [])).toMatchObject({ allowed: true, reason: 'no_policy' });
  });
  it('设白名单 → 后缀匹配命中放行、非白名单拦', () => {
    expect(checkDomainAllowed('https://www.example.com/x', ['example.com']).allowed).toBe(true);
    expect(checkDomainAllowed('https://evil.com', ['example.com'])).toMatchObject({ allowed: false, reason: 'domain_not_in_allowlist' });
  });
  it('不可解析 url → 拦（有白名单时）', () => {
    expect(checkDomainAllowed('not a url', ['example.com']).allowed).toBe(false);
  });
});

describe('classifyBrowserActionRisk（红线 5 高危分类）', () => {
  it('发布/支付/Merge PR/删除 → destructive highRisk', () => {
    expect(classifyBrowserActionRisk('publish post').highRisk).toBe(true);
    expect(classifyBrowserActionRisk('点击支付按钮').highRisk).toBe(true);
    expect(classifyBrowserActionRisk('merge PR #42').highRisk).toBe(true);
    expect(classifyBrowserActionRisk('删除仓库').highRisk).toBe(true);
  });
  it('登录/密码提交 → destructive highRisk', () => {
    expect(classifyBrowserActionRisk('submit password form').highRisk).toBe(true);
    expect(classifyBrowserActionRisk('登录账号').highRisk).toBe(true);
  });
  it('红队修复：merge/支付变体不再漏判（approve and merge / 购买 / buy now / place order / 转账）', () => {
    for (const a of ['approve and merge', 'squash and merge', 'confirm merge', 'merge pull request',
      '购买', '立即购买', 'buy now', 'place order', 'transfer funds', 'send money', '转账给对方', '合并代码']) {
      expect(classifyBrowserActionRisk(a).highRisk, a).toBe(true);
    }
  });
  it('普通点击/输入 → write 非高危', () => {
    expect(classifyBrowserActionRisk('click search button')).toMatchObject({ tier: 'write', highRisk: false });
    expect(classifyBrowserActionRisk('fill email field')).toMatchObject({ tier: 'write', highRisk: false });
  });
  it('导航/抽取 → read', () => {
    expect(classifyBrowserActionRisk('navigate to page')).toMatchObject({ tier: 'read', highRisk: false });
    expect(classifyBrowserActionRisk('extract title')).toMatchObject({ tier: 'read' });
  });
});

describe('evaluateBrowserAct（综合）', () => {
  it('非白名单域 → 拦（不执行）', () => {
    const r = evaluateBrowserAct({ action: 'navigate', url: 'https://evil.com', allowlist: ['ok.com'] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/network_policy_blocked/);
  });
  it('白名单内 + 高危 → 放行但需二次确认（红线 5）', () => {
    const r = evaluateBrowserAct({ action: 'publish article', url: 'https://blog.ok.com', allowlist: ['ok.com'] });
    expect(r.allowed).toBe(true);
    expect(r.requiresConfirm).toBe(true);
    expect(r.tier).toBe('destructive');
  });
  it('白名单内 + 普通读 → 直接放行', () => {
    const r = evaluateBrowserAct({ action: 'extract headlines', url: 'https://news.ok.com', allowlist: ['ok.com'] });
    expect(r).toMatchObject({ allowed: true, requiresConfirm: false, tier: 'read' });
  });
  it('无白名单 + 普通写 → 放行不确认（owner 自由）', () => {
    expect(evaluateBrowserAct({ action: 'click button', url: 'https://x.com' })).toMatchObject({ allowed: true, requiresConfirm: false });
  });
  it('无白名单 + 高危 → 仍需确认（红线 5 不靠域白名单，恒守）', () => {
    expect(evaluateBrowserAct({ action: '支付订单', url: 'https://shop.com' }).requiresConfirm).toBe(true);
  });
});
