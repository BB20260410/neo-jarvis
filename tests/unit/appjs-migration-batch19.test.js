// @ts-check
// S24 模块化第19批（busy/中断/send + snapshot/ctx/handoff + 新建弹窗 → sessions-tools-ui.js
// + 安全历史 tab → safety-ui.js + 项目监控/接力链 history/文件浏览器/全局 ⌘N/⌘1-9 → projects-files-ui.js）结构级防回归
// 收尾：批17/18 留守在 PanelCore 桥的 7 个直引改 window 懒转发；inspector tab 分发 hub（B 类留守）4 目标改 window 懒调
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const TOOLS_FILE = 'public/src/web/sessions-tools-ui.js';
const SAFETY_FILE = 'public/src/web/safety-ui.js';
const PROJECTS_FILE = 'public/src/web/projects-files-ui.js';

const TOOLS_FNS = [
  'updateBusyUI', 'interruptCurrentTurn', 'send', 'refreshSnapshot',
  'startSnapshotPolling', 'refreshCtx', 'openModal', 'closeModal', 'loadQuickCwd',
];
const SAFETY_FNS = [
  'refreshSafety', 'renderWatcherSection', 'renderHookEventsSection',
  'attachWatcherSectionHandlers', 'maybeRefreshSafetyIfOpen',
];
const PROJECTS_FNS = [
  'loadProjects', 'openProjectModal', 'closeProjectModal', 'openHistoryModal',
  'loadHistoryArchive', 'closeHistoryModal', 'loadFiles', 'formatSize', 'openFileInChat',
];

// 裸引 state 检查：剔除 core.state. 后不允许再出现独立的 state.（stateHist. 等带词缀的不算）
const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第19批接线（sessions-tools/safety/projects-files）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const toolsSrc = read(TOOLS_FILE);
  const safetySrc = read(SAFETY_FILE);
  const projectsSrc = read(PROJECTS_FILE);

  it('sessions-tools-ui 存在、走 PanelCore 桥、暴露 window.PanelSessionsTools 全部公开符号、绑定全随迁', () => {
    expect(toolsSrc).toContain('window.PanelCore');
    expect(toolsSrc).toContain('window.PanelSessionsTools = {');
    for (const sym of TOOLS_FNS) expect(toolsSrc, `${TOOLS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    for (const bind of [
      "$('#btnInterrupt')?.addEventListener('click', interruptCurrentTurn);",
      "$('#btnSnapRefresh')?.addEventListener('click', refreshSnapshot);",
      "$('#btnHandoff')?.addEventListener('click'",
      "$('#btnExternal')?.addEventListener('click'",
      "$('#btnSpawnAll')?.addEventListener('click'",
      "$('#btnSend')?.addEventListener('click', send);",
      "$('#chatInput')?.addEventListener('keydown'",
      "$('#btnNew')?.addEventListener('click', openModal);",
      "$$('[data-close]').forEach(el => el.addEventListener('click', closeModal));",
      "$('#btnCreateConfirm')?.addEventListener('click'",
    ]) {
      expect(toolsSrc, `${TOOLS_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    expect(hasBareState(toolsSrc), `${TOOLS_FILE} 裸引 state`).toBe(false);
  });

  it('sessions-tools-ui：5s snapshot 轮询 document.hidden 感知 + clearInterval 防双轮询 + 跨文件全走 window 懒解析', () => {
    expect(toolsSrc).toContain('if (core.state.snapshotTimer) clearInterval(core.state.snapshotTimer);');
    expect(toolsSrc).toContain('if (document.hidden) return;');
    expect(toolsSrc).toContain('}, 5000);');
    // 跨文件：appendMessage（send 失败/handoff/external/spawn-batch = 4 处）
    expect(toolsSrc.match(/window\.PanelSessionsList\?\.appendMessage\?\.\(/g)?.length).toBe(4);
    expect(toolsSrc).toContain('window.PanelSessionsCore?.listSessions?.();'); // handoff 后刷新
    expect(toolsSrc).toContain('window.PanelSessionsStream?.selectSession?.(r.newSessionId);'); // handoff 跳新 session
    expect(toolsSrc).toContain('window.PanelSessionsStream?.refreshCostSpark?.();'); // 轮询带跑成本火花线
    expect(toolsSrc).toContain('window.PanelSessionsCore?.createSession?.(name, cwd, mainGoal)'); // #btnCreateConfirm
  });

  it('safety-ui 存在、暴露 window.PanelSafety、审批基建经 core 桥解构、#btnSafetyRefresh 绑定随迁', () => {
    expect(safetySrc).toContain('window.PanelCore');
    expect(safetySrc).toContain('window.PanelSafety = {');
    for (const sym of SAFETY_FNS) expect(safetySrc, `${SAFETY_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(safetySrc).toContain("$('#btnSafetyRefresh')?.addEventListener('click', refreshSafety);");
    // 审批基建（requestWithApproval/handleApprovalFlow/apiCall 留守 app.js 至批21，桥直引稳定可解构）
    expect(safetySrc).toMatch(/const \{[^}]*requestWithApproval[^}]*\} = core;/);
    expect(safetySrc).toContain('await requestWithApproval(path, opts);');
    expect(safetySrc).toContain('await handleApprovalFlow(result, path, opts, {');
    expect(safetySrc).toContain("await apiCall('/api/watcher/test'");
    expect(hasBareState(safetySrc), `${SAFETY_FILE} 裸引 state`).toBe(false);
  });

  it('projects-files-ui 存在、暴露 window.PanelProjectsFiles、绑定+全局快捷键随迁、跨文件全走 window 懒解析', () => {
    expect(projectsSrc).toContain('window.PanelCore');
    expect(projectsSrc).toContain('window.PanelProjectsFiles = {');
    for (const sym of PROJECTS_FNS) expect(projectsSrc, `${PROJECTS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    for (const bind of [
      "$$('[data-close-project]').forEach(el => el.addEventListener('click', closeProjectModal));",
      "$$('[data-close-history]').forEach(el => el.addEventListener('click', closeHistoryModal));",
      "$('#btnProjectsRefresh')?.addEventListener('click', loadProjects);",
      "$('#chainBadge')?.addEventListener('click', openHistoryModal);",
    ]) {
      expect(projectsSrc, `${PROJECTS_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // document keydown ×2：Esc 关 project/history modal + ⌘N/Esc 新建弹窗/⌘1-9（openModal/closeModal/selectSession 跨文件懒解析）
    expect(projectsSrc.match(/document\.addEventListener\('keydown'/g)?.length).toBe(2);
    expect(projectsSrc).toContain('window.PanelSessionsTools?.openModal?.();'); // ⌘N
    expect(projectsSrc).toContain('window.PanelSessionsTools?.closeModal?.();'); // Esc 关新建弹窗
    expect(projectsSrc).toContain('window.PanelSessionsStream?.selectSession?.(core.state.sessions[idx].id);'); // ⌘1-9
    // formatSize wrapper 随迁：主实现委托 PanelUtils + inline fallback（main.js 加载失败兜底）
    expect(projectsSrc).toContain('if (window.PanelUtils && window.PanelUtils.formatSize) return window.PanelUtils.formatSize(b);');
    expect(hasBareState(projectsSrc), `${PROJECTS_FILE} 裸引 state`).toBe(false);
  });

  it('main.js import 第19批三模块（带 cache-bust），先于 composer/overlays（document keydown 注册序契约）', () => {
    // S24 收尾批22：star/fork+ctx 归位 sessions-tools，缓存串随之 bump 到 batch22
    expect(mainJs).toContain('./src/web/sessions-tools-ui.js?v=appjs-migration-batch22-20260611');
    expect(mainJs).toContain('./src/web/safety-ui.js?v=appjs-migration-batch19-20260611');
    expect(mainJs).toContain('./src/web/projects-files-ui.js?v=appjs-migration-batch19-20260611');
    expect(mainJs.indexOf('sessions-tools-ui.js')).toBeLessThan(mainJs.indexOf('composer-ui.js'));
    expect(mainJs.indexOf('projects-files-ui.js')).toBeLessThan(mainJs.indexOf('overlays-ui.js'));
  });

  it('app.js 不再保留三区实现，只留外迁标记（函数定义/绑定零残留）', () => {
    for (const gone of [
      ...TOOLS_FNS.map((f) => `function ${f}(`),
      ...SAFETY_FNS.map((f) => `function ${f}(`),
      ...PROJECTS_FNS.map((f) => `function ${f}(`),
      'let lastInterruptClickTs',
      "$('#btnInterrupt')?.addEventListener",
      "$('#btnSafetyRefresh')?.addEventListener",
      "$('#btnSend').addEventListener",
      "$('#btnNew').addEventListener",
      "$$('[data-close-project]')",
      "$$('[data-close-history]')",
      "$('#chainBadge').addEventListener",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第19批）==========/g)?.length).toBe(3);
  });

  it('收尾：PanelCore 桥 7 直引改 window 懒转发 + inspector hub 4 分发目标改 window 懒调 + cmdk openModal 懒调', () => {
    // 桥：批17/18 留守闭包直引 → window 懒转发（sessions-core/stream 的 core.X?.() 调用点零改动）
    expect(appJs).toContain('updateBusyUI: (...a) => window.PanelSessionsTools?.updateBusyUI?.(...a),');
    expect(appJs).toContain('interruptCurrentTurn: (...a) => window.PanelSessionsTools?.interruptCurrentTurn?.(...a),');
    expect(appJs).toContain('refreshSnapshot: (...a) => window.PanelSessionsTools?.refreshSnapshot?.(...a),');
    expect(appJs).toContain('startSnapshotPolling: (...a) => window.PanelSessionsTools?.startSnapshotPolling?.(...a),');
    expect(appJs).toContain('refreshCtx: (...a) => window.PanelSessionsTools?.refreshCtx?.(...a),');
    expect(appJs).toContain('loadFiles: (...a) => window.PanelProjectsFiles?.loadFiles?.(...a),');
    expect(appJs).toContain('maybeRefreshSafetyIfOpen: (...a) => window.PanelSafety?.maybeRefreshSafetyIfOpen?.(...a),');
    // 第20批外迁：updateStatusBar 改 window 懒转发；currentTab hub 仍在 app.js（B 类留守 14 行）
    expect(appJs).toContain('updateStatusBar: (...a) => window.PanelTheme?.updateStatusBar?.(...a),');
    expect(appJs).toContain('persistCollapsedGroups, escapeHtmlEarly,');
    expect(appJs).toContain('get currentTab() { return currentTab; },');
    expect(appJs).toContain("let currentTab = 'info';");
    // inspector tab 分发 hub：4 目标 window 懒调
    expect(appJs).toContain("if (tab === 'files' && state.activeCwd) window.PanelProjectsFiles?.loadFiles?.(state.activeCwd);");
    expect(appJs).toContain("if (tab === 'snapshot') window.PanelSessionsTools?.refreshSnapshot?.();");
    expect(appJs).toContain("if (tab === 'projects') window.PanelProjectsFiles?.loadProjects?.();");
    expect(appJs).toContain("if (tab === 'safety') window.PanelSafety?.refreshSafety?.();");
    // cmdk 残留调用点（dispatcher + inline fallback）第20批随 cmdk-ui.js 出走：app.js 零残留，cmdk-ui 内 ×2
    expect(appJs.match(/window\.PanelSessionsTools\?\.openModal\?\.\(\);/g)).toBeNull();
    expect(read('public/src/web/cmdk-ui.js').match(/window\.PanelSessionsTools\?\.openModal\?\.\(\);/g)?.length).toBe(2);
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12-18批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
