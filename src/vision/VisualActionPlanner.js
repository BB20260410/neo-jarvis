// @ts-check
// VisualActionPlanner — GUI/浏览器受控操作的“预演层”。
// 只产计划，不执行点击/输入/导航；真实动作后续必须进 ActPipeline + owner approval。

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function actionFor(goal) {
  const g = String(goal || '');
  if (/打开|访问|导航|navigate|url|网页|网站|localhost|http/i.test(g)) return 'browser.navigate';
  if (/点击|点一下|选择|click|press/i.test(g)) return 'browser.click';
  if (/输入|填写|搜索|type|fill/i.test(g)) return 'browser.type';
  if (/下载|保存|download/i.test(g)) return 'browser.download';
  return 'browser.observe';
}

function isDesktopGlobal(goal, surface) {
  return surface === 'desktop' || /桌面全局|系统设置|Finder|菜单栏|全局点击|键盘|鼠标|拖拽/.test(String(goal || ''));
}

/**
 * @param {{goal?:string,screenshotSummary?:string,domSummary?:string,surface?:'browser'|'desktop'|'unknown'}} input
 * @returns {{ok:boolean,status:'planned'|'blocked',execute:false,requiresApproval:boolean,risk:string,actions:Array,evidence:object,error?:string}}
 */
export function planVisualAction(input = {}) {
  const goal = clean(input.goal, 300);
  if (!goal) return { ok: false, status: 'blocked', execute: false, requiresApproval: true, risk: 'missing_goal', actions: [], evidence: {}, error: 'goal required' };
  const surface = ['browser', 'desktop', 'unknown'].includes(input.surface || '') ? input.surface : 'browser';
  const evidence = {
    screenshotSummary: clean(input.screenshotSummary, 500),
    domSummary: clean(input.domSummary, 800),
  };
  if (isDesktopGlobal(goal, surface)) {
    return {
      ok: true,
      status: 'blocked',
      execute: false,
      requiresApproval: true,
      risk: 'desktop_global_action_blocked',
      actions: [],
      evidence,
    };
  }
  const type = actionFor(goal);
  return {
    ok: true,
    status: 'planned',
    execute: false,
    requiresApproval: true,
    risk: type === 'browser.download' ? 'browser_download_requires_review' : 'browser_action_requires_review',
    actions: [{
      type,
      target: clean(goal, 160),
      reason: 'visual_plan_only',
      evidenceNeeded: ['screenshot_or_dom_before', 'owner_approval', 'result_after'],
    }],
    evidence,
  };
}
