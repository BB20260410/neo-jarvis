// @ts-check
// S24 模块化第14批（跨 session 搜索+跨房搜索+cheatsheet+统一快捷键 → search-ui.js；
// Prompts 模板+浏览器通知+turn_end 轮询 → prompts-notify-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch13.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SEARCH_FILE = 'public/src/web/search-ui.js';
const PROMPTS_FILE = 'public/src/web/prompts-notify-ui.js';

const SEARCH_FNS = [
  'openSearch', 'closeSearch', 'escRegexp', 'runSearch', 'renderSearchResults', 'jumpToSearchHit',
  'openRoomSearch', 'closeRoomSearch', 'runRoomSearch', 'renderRoomSearchResults', 'jumpToRoomSearchHit',
  'openCheatsheet', 'closeCheatsheet',
];
const PROMPTS_FNS = ['notifInit', 'maybeNotify', 'openPrompts', 'closePrompts', 'loadPromptsList'];

describe('app.js 模块化第14批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const searchSrc = read(SEARCH_FILE);
  const promptsSrc = read(PROMPTS_FILE);

  it('search-ui 存在、走 PanelCore 桥、暴露 window.PanelSearch 全部公开符号 + 绑定随迁', () => {
    expect(searchSrc).toContain('window.PanelCore');
    expect(searchSrc).toContain('window.PanelSearch = {');
    for (const sym of SEARCH_FNS) expect(searchSrc, `${SEARCH_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(searchSrc).toContain('get searchState() { return searchState; }');
    expect(searchSrc).toContain('get roomSearchState() { return roomSearchState; }');
    // 输入/键盘/modal/状态条按钮绑定全部随迁，boot 只绑一次
    for (const bind of [
      "$('#searchInput')?.addEventListener('input'",
      "$('#searchInput')?.addEventListener('keydown'",
      "$('#searchModal')?.addEventListener('click'",
      "$('#roomSearchInput')?.addEventListener('input'",
      "$('#roomSearchInclArchived')?.addEventListener('change'",
      "$('#roomSearchInput')?.addEventListener('keydown'",
      "$('#roomSearchModal')?.addEventListener('click'",
      "$('#cheatsheetModal')?.addEventListener('click'",
      "$('#statusKbBtn')?.addEventListener('click', openCheatsheet);",
    ]) {
      expect(searchSrc, `${SEARCH_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // selectSession 仍留 app.js（批18 会话域）：跳转必须经 core 调用时实时取，禁 boot 时解构快照
    expect(searchSrc).toContain('core.selectSession(h.sessionId);');
    expect(searchSrc, 'selectSession 不许 boot 时解构').not.toMatch(/const \{[^}]*selectSession[^}]*\} = core/);
    // 跨房跳转既有 window.PanelRoomsCore 懒解析保持
    expect(searchSrc).toContain('window.PanelRoomsCore?.showRoomArea?.();');
    expect(searchSrc).toContain('window.PanelRoomsCore?.loadRooms?.().then(() => window.PanelRoomsCore?.selectRoom?.(h.roomId));');
  });

  it('统一快捷键 document keydown 随迁 boot 只绑一次，⌘P/Esc-prompts 分支经 window.PanelPromptsNotify 懒解析', () => {
    expect(searchSrc).toContain("document.addEventListener('keydown', (e) => {");
    expect(searchSrc).toContain('const mod = e.metaKey || e.ctrlKey;');
    // ⌘P 与 Esc 关 prompts modal：prompts 在同批另一文件，必须 window 懒解析（禁直引）
    expect(searchSrc).toContain('window.PanelPromptsNotify?.openPrompts?.();');
    expect(searchSrc).toContain("else if ($('#promptsModal').style.display === 'flex') window.PanelPromptsNotify?.closePrompts?.();");
    // Esc 逐 modal 关闭分支齐全
    expect(searchSrc).toContain("if ($('#searchModal').style.display === 'flex') closeSearch();");
    expect(searchSrc).toContain("else if ($('#roomSearchModal')?.style.display === 'flex') closeRoomSearch();");
    expect(searchSrc).toContain("else if ($('#cheatsheetModal').style.display === 'flex') closeCheatsheet();");
  });

  it('prompts-notify-ui 存在、暴露 window.PanelPromptsNotify、notifInit/4s 轮询收进 boot 只跑一次', () => {
    expect(promptsSrc).toContain('window.PanelCore');
    expect(promptsSrc).toContain('window.PanelPromptsNotify = {');
    for (const sym of PROMPTS_FNS) expect(promptsSrc, `${PROMPTS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(promptsSrc).toContain('get notifState() { return notifState; }');
    expect(promptsSrc).toContain('get notifTrack() { return notifTrack; }');
    // 模块加载即执行的副作用收进 boot()：notifInit 调一次 + 4s 轮询起一次
    expect(promptsSrc).toContain('notifInit();');
    expect(promptsSrc.match(/setInterval\(/g)?.length, '4s 轮询只起一次').toBe(1);
    expect(promptsSrc).toContain('}, 4000);');
    // 状态实时取：sessions 列表经 core.state 读，禁解构快照
    expect(promptsSrc).toContain('core.state.sessions');
    expect(promptsSrc, 'state 不许 boot 时解构').not.toMatch(/const \{[^}]*state[^}]*\} = core/);
    // 绑定块随迁
    expect(promptsSrc).toContain("$('#btnPromptAdd')?.addEventListener('click'");
    expect(promptsSrc).toContain("$('#promptsModal')?.addEventListener('click', (e) => { if (e.target.id === 'promptsModal') closePrompts(); });");
  });

  it('新文件 <500 行硬规则', () => {
    expect(searchSrc.split('\n').length, `${SEARCH_FILE} 超 500 行`).toBeLessThan(500);
    expect(promptsSrc.split('\n').length, `${PROMPTS_FILE} 超 500 行`).toBeLessThan(500);
  });

  it('main.js import 第14批两模块（带 cache-bust）', () => {
    expect(mainJs).toContain('./src/web/search-ui.js?v=appjs-migration-batch14-20260611');
    expect(mainJs).toContain('./src/web/prompts-notify-ui.js?v=appjs-migration-batch14-20260611');
  });

  it('app.js 不再保留六区实现与绑定，只留外迁标记', () => {
    for (const gone of [
      ...SEARCH_FNS.map((f) => `function ${f}(`),
      ...PROMPTS_FNS.map((f) => `function ${f}(`),
      'const searchState',
      'const roomSearchState',
      'const notifState',
      'const notifTrack',
      "$('#searchInput')?.addEventListener",
      "$('#roomSearchInput')?.addEventListener",
      "$('#statusKbBtn')?.addEventListener",
      "$('#btnPromptAdd')?.addEventListener",
      'const mod = e.metaKey || e.ctrlKey;',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    // 6 个区块外迁标记 = 6 处「模块化第14批」
    expect(appJs.match(/模块化第14批/g)?.length).toBe(6);
    // star/fork + ctx bar 属会话域 → S24 收尾批22 已归位 sessions-tools-ui.js（详见 appjs-migration-batch22.test.js）
    expect(appJs).not.toContain('function toggleStar(');
    expect(appJs).not.toContain('function forkSession(');
    expect(appJs).not.toContain('function updateCtxWarningBar(');
  });

  it('PanelCore 桥 selectSession 可达（第17+18批起改 window 懒转发指向 PanelSessionsStream），无闭包转发回潮', () => {
    const bridge = appJs.slice(appJs.indexOf('window.PanelCore = {'), appJs.indexOf('// ========== 辩论渲染'));
    // 第14批为直引 `selectSession,`；第18批会话域外迁后按既定计划改 window 懒转发（search-ui 的 core.selectSession 调用不变）
    expect(bridge).toContain('selectSession: (...a) => window.PanelSessionsStream?.selectSession?.(...a),');
    // 桥上不允许出现「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12/13批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
