// @ts-check
// S24 模块化第21批（基建收尾：D6 apiCall + P2 审批后重试基础设施 → approval-flow-ui.js
// + markdown 渲染（marked+DOMPurify 定制 renderer）→ markdown-ui.js）结构级防回归
// 收尾：PanelCore 桥 apiCall/requestWithApproval/handleApprovalFlow/renderMarkdown 四键直引改 window 懒转发
// （消费方 webhook/mcp/plugin/safety/room-adapter/rooms-actions/sessions-* boot 解构拿到转发器，调用时实时解析）；
// 代码块复制/折叠 document 委托随迁 markdown-ui boot（按钮由 renderMarkdown 生成，属主一致）；
// 铁律钉死：_markedConfigured 幂等 + CDN 缺失 Path B regex fallback 降级路径原样保留。
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const APPROVAL_FILE = 'public/src/web/approval-flow-ui.js';
const MARKDOWN_FILE = 'public/src/web/markdown-ui.js';

const APPROVAL_FNS = ['apiCall', 'requestWithApproval', 'approveAndRetryRequest', 'maskUrlForDisplay', 'openApprovalRetryModal', 'handleApprovalFlow'];
const MARKDOWN_FNS = ['ensureMarkedConfigured', 'renderMarkdown'];

// 裸引 state 检查：剔除 core.state. 后不允许再出现独立的 state.
const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第21批接线（approval-flow/markdown 基建收尾）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const approvalSrc = read(APPROVAL_FILE);
  const markdownSrc = read(MARKDOWN_FILE);

  it('approval-flow-ui 存在、走 PanelCore 桥、暴露 window.PanelApprovalFlow、六函数全迁、协议语义保留', () => {
    expect(approvalSrc).toContain('window.PanelCore');
    expect(approvalSrc).toContain('window.PanelApprovalFlow = {');
    for (const sym of APPROVAL_FNS) expect(approvalSrc, `${APPROVAL_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 后端审批协议语义钉死：202 approval_required / 403 permission_denied / 重试 header / 链式 maxSteps
    expect(approvalSrc).toContain("r.status === 202 && body && body.error === 'approval_required'");
    expect(approvalSrc).toContain("r.status === 403 && body && body.error === 'permission_denied'");
    expect(approvalSrc).toContain("'X-Panel-Approval-Id': ids.join(',')");
    expect(approvalSrc).toContain("headers['X-Panel-Owner-Token'] = token;");
    expect(approvalSrc).toContain('const { actionLabel = \'\', onOk, onDenied, onError, maxSteps = 5 } = handlers;');
    // 弹窗 DOM 契约（e2e walkthrough 步骤 11-16 依赖这些选择器）
    expect(approvalSrc).toContain("overlay.setAttribute('data-approval-retry-modal', approvalId || '');");
    expect(approvalSrc).toContain('data-approval-retry-confirm');
    expect(approvalSrc).toContain('data-approval-retry-cancel');
    // 跨文件依赖走 window 懒解析（审批中心可能未加载）
    expect(approvalSrc).toContain('window.PanelApprovals?.openApprovalModal?.();');
    expect(hasBareState(approvalSrc), `${APPROVAL_FILE} 裸引 state`).toBe(false);
  });

  it('markdown-ui 存在、暴露 window.PanelMarkdown、幂等+降级铁律原样保留、代码块委托随迁 boot 只绑一次', () => {
    expect(markdownSrc).toContain('window.PanelCore');
    expect(markdownSrc).toContain('window.PanelMarkdown = {');
    for (const sym of MARKDOWN_FNS) expect(markdownSrc, `${MARKDOWN_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 铁律①：_markedConfigured 幂等（marked.use 只配置一次）
    expect(markdownSrc).toContain('let _markedConfigured = false;');
    expect(markdownSrc).toContain('if (_markedConfigured || !window.marked) return;');
    expect(markdownSrc).toContain('_markedConfigured = true;');
    // 铁律②：CDN 全局缺失/解析失败 → Path B 手写 regex fallback 降级路径原样保留
    expect(markdownSrc).toContain('if (typeof window !== \'undefined\' && window.marked && window.DOMPurify) {');
    expect(markdownSrc).toContain('// Path B: fallback 手写 regex（CDN 没加载时）');
    expect(markdownSrc).toContain('let html = escapeHtml(text);');
    expect(markdownSrc).toContain("html = html.replace(/\\n/g, '<br>');");
    // 安全配置钉死：DOMPurify 白名单 + URI 协议限制 + Reverse Tabnabbing hook + img 本地缓存 proxy
    expect(markdownSrc).toContain('ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:|#|\\/)/i,');
    expect(markdownSrc).toContain("window.DOMPurify.addHook('afterSanitizeAttributes'");
    expect(markdownSrc).toContain("node.setAttribute('rel', 'noopener noreferrer');");
    expect(markdownSrc).toContain('/api/img-cache?url=');
    expect(markdownSrc).toContain('data-noe-img-cache-url');
    expect(markdownSrc).toContain("'X-Panel-Owner-Token'");
    expect(markdownSrc).toContain('MutationObserver');
    // 代码块复制/折叠 document 委托随迁（按钮由 renderMarkdown 生成，属主一致），boot 内只绑一次
    expect(markdownSrc).toContain("e.target.closest('.code-copy-btn')");
    expect(markdownSrc).toContain("e.target.closest('.code-collapse-btn')");
    expect(markdownSrc.match(/document\.addEventListener\('click'/g)?.length).toBe(1);
    expect(hasBareState(markdownSrc), `${MARKDOWN_FILE} 裸引 state`).toBe(false);
  });

  it('新文件 <500 行硬规则', () => {
    expect(approvalSrc.split('\n').length, `${APPROVAL_FILE} 超 500 行`).toBeLessThan(500);
    expect(markdownSrc.split('\n').length, `${MARKDOWN_FILE} 超 500 行`).toBeLessThan(500);
  });

  it('main.js import 第21批两模块（带 cache-bust）', () => {
    expect(mainJs).toContain('./src/web/approval-flow-ui.js?v=appjs-migration-batch21-20260611');
    expect(mainJs).toContain('./src/web/markdown-ui.js?v=appjs-migration-batch21-20260611');
  });

  it('app.js 不再保留两区实现，只留外迁标记（含代码块委托随迁）', () => {
    for (const gone of [
      ...APPROVAL_FNS.map((f) => `function ${f}(`),
      ...MARKDOWN_FNS.map((f) => `function ${f}(`),
      'let _markedConfigured',
      'approval_required',
      'X-Panel-Approval-Id',
      'data-approval-retry-confirm',
      'window.marked.parse',
      'window.DOMPurify.sanitize',
      "e.target.closest('.code-copy-btn')",
      "e.target.closest('.code-collapse-btn')",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第21批）==========/g)?.length).toBe(3);
  });

  it('收尾：PanelCore 桥四键改 window 懒转发 + 闭包转发零残留（沿袭第12-20批纪律）', () => {
    expect(appJs).toContain('requestWithApproval: (...a) => window.PanelApprovalFlow?.requestWithApproval?.(...a),');
    expect(appJs).toContain('handleApprovalFlow: (...a) => window.PanelApprovalFlow?.handleApprovalFlow?.(...a),');
    expect(appJs).toContain('apiCall: (...a) => window.PanelApprovalFlow?.apiCall?.(...a),');
    expect(appJs).toContain('renderMarkdown: (...a) => window.PanelMarkdown?.renderMarkdown?.(...a),');
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（全部应解析到 window.* 模块全局）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });

  it('消费方接线零改动：经桥解构拿到的即懒转发器（调用时实时解析）', () => {
    // 审批基建消费方（第2/13/19批先例：boot 解构纯工具）
    expect(read('public/src/web/webhook-ui.js')).toContain('requestWithApproval, handleApprovalFlow } = window.PanelCore;');
    expect(read('public/src/web/safety-ui.js')).toContain('requestWithApproval, handleApprovalFlow } = core;');
    expect(read('public/src/web/rooms-actions-ui.js')).toContain('const { $, toast, confirmModal, promptModal, api, apiCall } = core;');
    // markdown 消费方（消息渲染热路径）
    expect(read('public/src/web/sessions-list-ui.js')).toContain('renderMarkdown');
    expect(read('public/src/web/sessions-stream-ui.js')).toContain('renderMarkdown');
    // e2e walkthrough 步骤 14-16 改经模块全局触发审批链（app.js 顶层函数隐式 window 挂载已随外迁消失）
    const walkthrough = read('tests/e2e/panel-ui-walkthrough.mjs');
    expect(walkthrough).toContain('window.PanelApprovalFlow.requestWithApproval');
    expect(walkthrough).toContain('window.PanelApprovalFlow.handleApprovalFlow');
    expect(walkthrough).not.toContain('await window.requestWithApproval(');
  });
});
