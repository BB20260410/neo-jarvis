// @ts-check
// S24 模块化第20批（主题/StatusBar/启动版本号 → theme-statusbar-ui.js + ⌘K 命令面板 → cmdk-ui.js
// + 内嵌真终端 PTY+xterm → term-ui.js）结构级防回归
// 收尾：PanelCore 桥 updateStatusBar 直引改 window 懒转发；window.PanelCmdk 双向 Object.assign 合并挂载
// （main.js 的 BUILTIN_COMMANDS 桥与 cmdk-ui 的运行时键互不覆盖）；版本号 IIFE 并入 theme-statusbar boot；
// 代码块复制/折叠 document 委托批20 留守 app.js → 批21 已随 markdown-ui.js 迁走（属主=markdown 区）
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const THEME_FILE = 'public/src/web/theme-statusbar-ui.js';
const CMDK_FILE = 'public/src/web/cmdk-ui.js';
const TERM_FILE = 'public/src/web/term-ui.js';

const THEME_FNS = ['applyTheme', 'toggleTheme', 'updateStatusBar'];
const CMDK_FNS = ['buildCmdkItems', 'openCmdk', 'closeCmdk', 'renderCmdk'];
const TERM_FNS = ['showTermArea', 'hideTermArea', 'openTerm', 'getXtermTheme', 'closeTerm'];

// 裸引 state 检查：剔除 core.state. 后不允许再出现独立的 state.（cmdkState./termState. 等带词缀的不算）
const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第20批接线（theme-statusbar/cmdk/term）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const themeSrc = read(THEME_FILE);
  const cmdkSrc = read(CMDK_FILE);
  const termSrc = read(TERM_FILE);

  it('theme-statusbar-ui 存在、走 PanelCore 桥、暴露 window.PanelTheme、加载即执行副作用全收进 boot', () => {
    expect(themeSrc).toContain('window.PanelCore');
    expect(themeSrc).toContain('window.PanelTheme = {');
    for (const sym of THEME_FNS) expect(themeSrc, `${THEME_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(themeSrc).toContain("const THEME_NAMES = { light: '☀️ 明亮', dark: '🌙 暗色', scifi: '🛸 科幻' };");
    // 原 app.js 顶层副作用 ×3 收进 boot 只跑一次：恢复保存主题 / 4s 兜底刷新 / 启动版本号拉取
    expect(themeSrc).toContain("const saved = localStorage.getItem('cp-theme');");
    expect(themeSrc).toContain('setInterval(updateStatusBar, 4000);');
    expect(themeSrc).toContain("await api('/api/version');"); // 版本号 IIFE 并入（写 #statusVersion 属 StatusBar UI）
    expect(themeSrc).toContain("$('#statusVersion')");
    // 绑定随迁
    expect(themeSrc).toContain("$('#themeToggle')?.addEventListener('click', toggleTheme);");
    expect(themeSrc).toContain("$('#btnLoginClaude')?.addEventListener('click'");
    expect(hasBareState(themeSrc), `${THEME_FILE} 裸引 state`).toBe(false);
  });

  it('cmdk-ui 合并挂载 window.PanelCmdk（不覆盖 main.js 的 BUILTIN_COMMANDS 桥）、绑定/全局 ⌘K/⌘D 随迁 boot', () => {
    expect(cmdkSrc).toContain('window.PanelCore');
    // 合并挂载：main.js 先占 window.PanelCmdk（BUILTIN_COMMANDS 桥），boot 时 Object.assign 增量挂运行时键
    expect(cmdkSrc).toContain('window.PanelCmdk = Object.assign(window.PanelCmdk || {}, {');
    for (const sym of CMDK_FNS) expect(cmdkSrc, `${CMDK_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(cmdkSrc).toContain('const cmdkState = { activeIdx: 0, items: [] };');
    // BUILTIN_COMMANDS 桥消费 + inline fallback 双路保留
    expect(cmdkSrc).toContain('if (window.PanelCmdk?.BUILTIN_COMMANDS) {');
    expect(cmdkSrc).toContain('// fallback inline');
    for (const bind of [
      "$('#cmdkInput')?.addEventListener('input'",
      "$('#cmdkInput')?.addEventListener('keydown'",
      "$('#cmdkModal')?.addEventListener('click'",
    ]) {
      expect(cmdkSrc, `${CMDK_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // 全局快捷键 ⌘K/⌘D document keydown 随迁 boot 只绑一次
    expect(cmdkSrc.match(/document\.addEventListener\('keydown'/g)?.length).toBe(1);
    expect(cmdkSrc).toContain("(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'");
    expect(cmdkSrc).toContain("(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd'");
    expect(hasBareState(cmdkSrc), `${CMDK_FILE} 裸引 state`).toBe(false);
  });

  it('cmdk-ui 跨文件依赖全走 window 懒解析（openModal/toggleTheme/selectSession/setSessionArchived）', () => {
    // dispatcher + inline fallback 各 1 处
    expect(cmdkSrc.match(/window\.PanelSessionsTools\?\.openModal\?\.\(\);/g)?.length).toBe(2);
    // dispatcher + inline fallback + ⌘D = 3 处
    expect(cmdkSrc.match(/window\.PanelTheme\?\.toggleTheme\?\.\(\);/g)?.length).toBe(3);
    expect(cmdkSrc).toContain('window.PanelSessionsStream?.selectSession?.(s.id);');
    expect(cmdkSrc).toContain('window.PanelSessionsCore?.setSessionArchived?.(s.id, false)?.then(closeCmdk)');
  });

  it('term-ui 存在、暴露 window.PanelTerm、CDN 全局依赖保持、绑定全随迁', () => {
    expect(termSrc).toContain('window.PanelCore');
    expect(termSrc).toContain('window.PanelTerm = {');
    for (const sym of TERM_FNS) expect(termSrc, `${TERM_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(termSrc).toContain('const termState = {');
    // CDN 全局 window.Terminal/FitAddon + createPlainTerminal 降级兜底保持
    expect(termSrc).toContain("typeof window.Terminal === 'function' && typeof window.FitAddon?.FitAddon === 'function'");
    expect(termSrc).toContain('window.createPlainTerminal?.(container)');
    expect(termSrc).toContain('window.PanelApprovals?.handleApprovalRequired?.(msg);');
    expect(termSrc).toContain('wsUrl(`/ws/term/${r.termId}`)');
    for (const bind of [
      "$('#btnTerminal')?.addEventListener('click'",
      "$('#btnTermNew')?.addEventListener('click', () => openTerm(null));",
      "$('#btnTermInCwd')?.addEventListener('click', () => openTerm(core.state.activeCwd || null));",
      "$('#btnTermClose')?.addEventListener('click'",
      "$('#btnTermBack')?.addEventListener('click', hideTermArea);",
    ]) {
      expect(termSrc, `${TERM_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    expect(hasBareState(termSrc), `${TERM_FILE} 裸引 state`).toBe(false);
  });

  it('main.js import 第20批三模块（带 cache-bust）+ PanelCmdk 改双向合并赋值', () => {
    expect(mainJs).toContain('./src/web/theme-statusbar-ui.js?v=appjs-migration-batch20-20260611');
    expect(mainJs).toContain('./src/web/cmdk-ui.js?v=appjs-migration-batch20-20260611');
    expect(mainJs).toContain('./src/web/term-ui.js?v=appjs-migration-batch20-20260611');
    // main.js 侧合并赋值（防 module 体覆盖 cmdk-ui boot 已挂/将挂的运行时键）
    expect(mainJs).toContain('window.PanelCmdk = Object.assign(window.PanelCmdk || {}, { matchCommands: _matchCmdk, resolveAction: _resolveCmdkAction, BUILTIN_COMMANDS: _CMDK_BUILTIN });');
  });

  it('app.js 不再保留四区实现，只留外迁标记；代码块复制/折叠委托已随批21 markdown-ui 迁走', () => {
    for (const gone of [
      ...THEME_FNS.map((f) => `function ${f}(`),
      ...CMDK_FNS.map((f) => `function ${f}(`),
      ...TERM_FNS.map((f) => `function ${f}(`),
      'const THEME_NAMES',
      'const cmdkState',
      'const termState',
      "$('#themeToggle')",
      "$('#btnLoginClaude')",
      "$('#cmdkInput')",
      "$('#cmdkModal')",
      "$('#btnTerminal')",
      "$('#btnTermNew')",
      "$('#btnTermInCwd')",
      "$('#btnTermClose')",
      "$('#btnTermBack')",
      'setInterval(updateStatusBar, 4000);',
      "await api('/api/version');",
      "localStorage.getItem('cp-theme')",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第20批）==========/g)?.length).toBe(4);
    // 代码块复制/折叠 document 委托批21 已随 markdown-ui 迁走（按钮由 renderMarkdown 生成，属主一致）
    expect(appJs).not.toContain("e.target.closest('.code-copy-btn')");
    expect(appJs).not.toContain("e.target.closest('.code-collapse-btn')");
    const markdownSrc = read('public/src/web/markdown-ui.js');
    expect(markdownSrc).toContain("e.target.closest('.code-copy-btn')");
    expect(markdownSrc).toContain("e.target.closest('.code-collapse-btn')");
  });

  it('收尾：PanelCore 桥 updateStatusBar 改 window 懒转发（sessions-core 消费方零改动）+ 闭包转发零残留', () => {
    expect(appJs).toContain('updateStatusBar: (...a) => window.PanelTheme?.updateStatusBar?.(...a),');
    expect(appJs).toContain('persistCollapsedGroups, escapeHtmlEarly,'); // 留守直引
    // sessions-core 消费方接线不变（core.updateStatusBar?.() 调用时实时取到懒转发）
    expect(read('public/src/web/sessions-core-ui.js')).toContain('core.updateStatusBar?.();');
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12-19批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
