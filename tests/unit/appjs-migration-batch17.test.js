// @ts-check
// S24 模块化第17批（会话 CRUD/右键菜单/重命名 → sessions-core-ui.js + 会话列表/归档/appendMessage → sessions-list-ui.js）结构级防回归
// 第17+18批为会话域强互联体合并 commit（仿房间域第12批：同批多文件+跨文件全走 window 懒解析，禁半迁状态跨 commit）
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const CORE_FILE = 'public/src/web/sessions-core-ui.js';
const LIST_FILE = 'public/src/web/sessions-list-ui.js';

const CORE_FNS = [
  'listSessions', 'setSessionArchived', 'renameSession', 'closeContextMenu',
  'openContextMenu', 'startRenameSession', 'createSession', 'deleteSession',
];
const LIST_FNS = ['renderList', 'buildSessionItem', 'renderArchived', 'showEmpty', 'showChat', 'appendMessage'];

// 裸引 state 检查：剔除 core.state. 后不允许再出现独立的 state.（watcherState./cmdkState. 等带词缀的不算）
const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第17批接线（sessions-core/list）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const coreSrc = read(CORE_FILE);
  const listSrc = read(LIST_FILE);

  it('sessions-core-ui 存在、走 PanelCore 桥、暴露 window.PanelSessionsCore 全部公开符号', () => {
    expect(coreSrc).toContain('window.PanelCore');
    expect(coreSrc).toContain('window.PanelSessionsCore = {');
    for (const sym of CORE_FNS) expect(coreSrc, `${CORE_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(hasBareState(coreSrc), `${CORE_FILE} 裸引 state`).toBe(false);
  });

  it('sessions-core-ui：启动初拉 + 4s 轮询 + visibilitychange + document 全局 click/keydown(Esc) 全收进 boot 只起一次', () => {
    // 原 app.js 启动块副作用随域迁入 boot（防双轮询/双绑）
    expect(coreSrc).toContain("setInterval(() => { if (!document.hidden && hasOwnerToken()) listSessions(); }, 4000);");
    expect(coreSrc).toContain("document.addEventListener('visibilitychange'");
    expect(coreSrc).toContain("document.addEventListener('click', closeContextMenu);");
    expect(coreSrc).toContain("document.addEventListener('keydown'");
    // Esc 中断 turn：批19 留守的 interruptCurrentTurn 经 core 桥调用时实时取（禁 boot 解构快照）
    expect(coreSrc).toContain('core.interruptCurrentTurn?.();');
    expect(coreSrc, 'interruptCurrentTurn 不许 boot 时解构').not.toMatch(/const \{[^}]*interruptCurrentTurn[^}]*\} = core/);
  });

  it('sessions-core-ui：跨文件依赖全走 window 懒解析（list 渲染/stream 选中），批19/20 留守经 core 桥', () => {
    expect(coreSrc).toContain('window.PanelSessionsList?.renderList?.();');
    expect(coreSrc).toContain('window.PanelSessionsList?.renderArchived?.();');
    expect(coreSrc.match(/window\.PanelSessionsList\?\.showEmpty\?\.\(\);/g)?.length).toBe(2); // setSessionArchived + deleteSession
    expect(coreSrc).toContain('window.PanelSessionsStream?.selectSession?.(s.id);'); // createSession 后选中
    expect(coreSrc).toContain('core.updateBusyUI?.();');
    expect(coreSrc).toContain('core.updateStatusBar?.();');
  });

  it('sessions-list-ui 存在、暴露 window.PanelSessionsList 全部公开符号、boot 初始 showEmpty + #archivedToggle 绑定', () => {
    expect(listSrc).toContain('window.PanelCore');
    expect(listSrc).toContain('window.PanelSessionsList = {');
    for (const sym of LIST_FNS) expect(listSrc, `${LIST_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(listSrc).toContain("$('#archivedToggle')?.addEventListener('click'");
    expect(listSrc).toContain('showEmpty();'); // boot 初始空态（原 app.js 启动块）
    expect(hasBareState(listSrc), `${LIST_FILE} 裸引 state`).toBe(false);
  });

  it('sessions-list-ui：跨文件依赖全走 window 懒解析（CRUD/右键菜单/重命名经 PanelSessionsCore；选中/STATE_LABELS 经 PanelSessionsStream）', () => {
    expect(listSrc).toContain('window.PanelSessionsStream?.selectSession?.(s.id)');
    expect(listSrc).toContain('window.PanelSessionsStream?.STATE_LABELS?.[rs] || rs');
    expect(listSrc).toContain('window.PanelSessionsCore?.openContextMenu?.([');
    expect(listSrc.match(/window\.PanelSessionsCore\?\.startRenameSession\?\.\(/g)?.length).toBe(3); // 右键菜单 + 双击 + ✏️ 按钮
    expect(listSrc.match(/window\.PanelSessionsCore\?\.setSessionArchived\?\.\(/g)?.length).toBe(3); // 右键归档 + 📦 按钮 + 归档区恢复
    expect(listSrc.match(/window\.PanelSessionsCore\?\.deleteSession\?\.\(/g)?.length).toBe(2); // 右键删除 + 归档区删除
    expect(listSrc).toContain('window.PanelSessionsCore?.listSessions?.();'); // 编辑主目标后刷新
    // persistCollapsedGroups/escapeHtmlEarly 留守 app.js 工具层，经桥解构
    expect(listSrc).toMatch(/const \{[^}]*persistCollapsedGroups[^}]*\} = core;/);
    expect(listSrc).toMatch(/const \{[^}]*escapeHtmlEarly[^}]*\} = core;/);
  });

  it('main.js import 第17批两模块（带 cache-bust）且 sessions-core 先于 overlays-ui（document Esc 注册序契约）', () => {
    expect(mainJs).toContain('./src/web/sessions-core-ui.js?v=appjs-migration-batch17-20260611');
    expect(mainJs).toContain('./src/web/sessions-list-ui.js?v=appjs-migration-batch17-20260611');
    expect(mainJs.indexOf('sessions-core-ui.js')).toBeLessThan(mainJs.indexOf('overlays-ui.js'));
    expect(mainJs.indexOf('sessions-core-ui.js')).toBeLessThan(mainJs.indexOf('composer-ui.js'));
  });

  it('app.js 不再保留两区实现，只留外迁标记（会话 CRUD/列表域函数定义零残留）', () => {
    for (const gone of [
      ...CORE_FNS.map((f) => `function ${f}(`),
      ...LIST_FNS.map((f) => `function ${f}(`),
      'let activeContextMenu',
      "$('#archivedToggle')?.addEventListener",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第17批）==========/g)?.length).toBe(2);
    // 启动块不再直接调 listSessions()/showEmpty()（已收进各模块 boot，防双轮询）
    expect(appJs).not.toMatch(/^listSessions\(\);$/m);
    expect(appJs).not.toMatch(/^showEmpty\(\);$/m);
    expect(appJs).not.toContain("setInterval(() => { if (!document.hidden && hasOwnerToken()) listSessions(); }, 4000);");
  });

  it('app.js 残留调用点全部改 window 懒解析 + PanelCore 桥懒转发/留守直引', () => {
    // #btnCreateConfirm 第19批随 sessions-tools-ui 出走，createSession 调用点改在新模块
    expect(read('public/src/web/sessions-tools-ui.js')).toContain('window.PanelSessionsCore?.createSession?.(name, cwd, mainGoal)');
    // 第20批外迁：cmdk 归档恢复调用点随 cmdk-ui.js 出走
    expect(read('public/src/web/cmdk-ui.js')).toContain('window.PanelSessionsCore?.setSessionArchived?.(s.id, false)?.then(closeCmdk)');
    // 第22批（S24 收尾）：消息右键菜单随 star/fork 归位 sessions-tools-ui，app.js 调用点清零
    expect(appJs).not.toContain('window.PanelSessionsCore?.openContextMenu?.([');
    expect(read('public/src/web/sessions-tools-ui.js')).toContain('window.PanelSessionsCore?.openContextMenu?.(['); // 消息右键菜单
    // 第19批外迁后 handoff 调用点随 sessions-tools-ui 出走；第22批 fork 也随迁 → app.js 清零、sessions-tools ×2
    expect(appJs.match(/window\.PanelSessionsCore\?\.listSessions\?\.\(\);/g)).toBeNull();
    expect(read('public/src/web/sessions-tools-ui.js').match(/window\.PanelSessionsCore\?\.listSessions\?\.\(\);/g)?.length).toBe(2); // handoff + fork
    // 桥：已迁符号 window 懒转发；留守符号直引（hoist）供模块经桥实时取
    expect(appJs).toContain('listSessions: (...a) => window.PanelSessionsCore?.listSessions?.(...a),');
    expect(appJs).toContain('openContextMenu: (...a) => window.PanelSessionsCore?.openContextMenu?.(...a),');
    // 第19批外迁：批17/18 留守直引已按既定计划改 window 懒转发（sessions-core/stream 的 core.X?.() 调用点零改动）
    expect(appJs).toContain('updateBusyUI: (...a) => window.PanelSessionsTools?.updateBusyUI?.(...a),');
    expect(appJs).toContain('interruptCurrentTurn: (...a) => window.PanelSessionsTools?.interruptCurrentTurn?.(...a),');
    // 第20批外迁：updateStatusBar 已按既定计划改 window 懒转发（sessions-core 的 core.updateStatusBar?.() 调用点零改动）
    expect(appJs).toContain('updateStatusBar: (...a) => window.PanelTheme?.updateStatusBar?.(...a),');
    expect(appJs).toContain('persistCollapsedGroups, escapeHtmlEarly,'); // 留守直引
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12-16批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
