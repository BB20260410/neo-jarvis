// @ts-check
// S24 模块化第15批（Codebase Center → codebase-center-ui.js；cleanOldMetrics → 语义属主 overview-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch14.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const CODEBASE_FILE = 'public/src/web/codebase-center-ui.js';
const OVERVIEW_FILE = 'public/src/web/overview-ui.js';

const CODEBASE_FNS = [
  'codebaseCenterCwd', 'openCodebaseCenterModal', 'closeCodebaseCenterModal', 'codebaseStatusText',
  'renderCodebaseCenter', 'renderCodebaseResult', 'renderCodebaseQuestionAnswer', 'bindCodebaseCenterEvents',
  'refreshCodebaseStatus', 'rebuildCodebaseIndex', 'runCodebaseQuery', 'runCodebaseQuestion',
  'codebaseResultToEvidence', 'addCodebaseResultsToDispatch', 'openDispatchPreviewFromCodebase',
];

describe('app.js 模块化第15批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const codebaseSrc = read(CODEBASE_FILE);
  const overviewSrc = read(OVERVIEW_FILE);

  it('codebase-center-ui 存在、走 PanelCore 桥、暴露 window.PanelCodebase 全部公开符号 + 绑定随迁', () => {
    expect(codebaseSrc).toContain('window.PanelCore');
    expect(codebaseSrc).toContain('window.PanelCodebase = {');
    for (const sym of CODEBASE_FNS) expect(codebaseSrc, `${CODEBASE_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(codebaseSrc).toContain('get state() { return codebaseCenterState; }');
    // 入口按钮 + 关闭遮罩绑定随迁，boot 只绑一次
    expect(codebaseSrc).toContain("$('#btnCodebaseCenter')?.addEventListener('click', openCodebaseCenterModal);");
    expect(codebaseSrc).toContain("document.querySelectorAll('[data-close-codebase-center]').forEach(el => el.addEventListener('click', closeCodebaseCenterModal));");
  });

  it('codebase-center-ui 状态实时取 + Agent 图谱依赖全 window 懒解析（禁 boot 时解构快照）', () => {
    // state.activeCwd 必须经 core.state 实时取
    expect(codebaseSrc).toContain('core.state.activeCwd');
    expect(codebaseSrc, 'state 不许 boot 时解构').not.toMatch(/const \{[^}]*\bstate\b[^}]*\} = core/);
    // agentRegistryState 是桥 getter（指向 PanelAgentGraph），必须调用时取
    expect(codebaseSrc).toContain('window.PanelCore.agentRegistryState');
    expect(codebaseSrc, 'agentRegistryState 不许解构').not.toMatch(/const \{[^}]*agentRegistryState[^}]*\}/);
    // PanelAgentGraph 全部懒调用
    for (const lazy of [
      'window.PanelAgentGraph?.agentPreviewCwd()',
      'window.PanelAgentGraph?.sanitizeCodebaseQuestionAnswer(',
      'window.PanelAgentGraph?.parseAgentPreviewFiles(',
      'window.PanelAgentGraph?.renderAgentRegistryModal()',
      'window.PanelAgentGraph?.open()',
    ]) {
      expect(codebaseSrc, `${CODEBASE_FILE} 缺懒调用 ${lazy}`).toContain(lazy);
    }
  });

  it('cleanOldMetrics 本体迁入 overview-ui（语义属主），不再经桥解构，refreshOverview 直调', () => {
    expect(overviewSrc).toContain('async function cleanOldMetrics(');
    // 不再从 PanelCore 解构 cleanOldMetrics（旧第4批接线）
    expect(overviewSrc, '不许再从桥解构 cleanOldMetrics').not.toMatch(/const \{[^}]*cleanOldMetrics[^}]*\} = window\.PanelCore/);
    // promptModal/confirmModal 经桥解构（B 类 wrapper 留守 app.js，直引 hoist 安全）
    expect(overviewSrc).toMatch(/const \{[^}]*promptModal[^}]*confirmModal[^}]*\} = window\.PanelCore/);
    // 模块内直调 refreshOverview，不再绕 window.PanelOverview
    expect(overviewSrc).not.toContain('window.PanelOverview?.refreshOverview');
    // retention 清理按钮绑定仍指向（现已是本地的）cleanOldMetrics
    expect(overviewSrc).toContain("$('#btnRetentionClean')?.addEventListener('click', cleanOldMetrics);");
    // 导出补上 cleanOldMetrics（PanelCore 桥 getter 反向懒取）
    expect(overviewSrc).toContain('cleanOldMetrics,');
  });

  it('PanelCore 桥：cleanOldMetrics getter 改 window.PanelOverview 懒取，无闭包转发回潮', () => {
    expect(appJs).toContain('get cleanOldMetrics() { return window.PanelOverview?.cleanOldMetrics; },');
    // 桥上不允许出现「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12/13/14批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });

  it('app.js 不再保留 Codebase Center 与 cleanOldMetrics 实现，只留外迁标记', () => {
    for (const gone of [
      ...CODEBASE_FNS.map((f) => `function ${f}(`),
      'const codebaseCenterState',
      'async function cleanOldMetrics',
      "$('#btnCodebaseCenter')?.addEventListener",
      'data-close-codebase-center]\').forEach',
      '/api/codebase-index/',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    // 2 个外迁标记 = 2 处「模块化第15批」（Codebase Center + cleanOldMetrics）
    expect(appJs.match(/模块化第15批/g)?.length).toBe(2);
    // Codebase Center 依赖的 B 类留守工具不许被顺手带走
    expect(appJs).toContain('function activityTime(');
    expect(appJs).toContain('function safeClassToken(');
  });

  it('main.js import 第15批模块 + overview-ui 缓存串 bump（带 cache-bust）', () => {
    expect(mainJs).toContain('./src/web/codebase-center-ui.js?v=appjs-migration-batch15-20260611');
    expect(mainJs).toContain('./src/web/overview-ui.js?v=appjs-migration-batch15-20260611');
    expect(mainJs, 'overview-ui 旧缓存串应被替换').not.toContain('./src/web/overview-ui.js?v=appjs-migration-batch3-20260603');
  });

  it('新/改文件 <500 行硬规则', () => {
    expect(codebaseSrc.split('\n').length, `${CODEBASE_FILE} 超 500 行`).toBeLessThan(500);
    expect(overviewSrc.split('\n').length, `${OVERVIEW_FILE} 超 500 行`).toBeLessThan(500);
  });
});
