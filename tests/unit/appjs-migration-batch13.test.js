// @ts-check
// S24 模块化第13批（Plugin 中心 → plugin-ui.js + 房间模板 modal → room-templates-ui.js + 散落属主绑定迁回 mcp/webhook/rooms-actions）结构级防回归
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const PLUGIN_FILE = 'public/src/web/plugin-ui.js';
const TEMPLATES_FILE = 'public/src/web/room-templates-ui.js';

const PLUGIN_FNS = [
  'showPluginArea', 'hidePluginArea', 'loadPluginList', 'renderPluginList',
  'renderPluginDetail', 'runPluginCommand', 'installPluginFromFile',
];
const TEMPLATE_FNS = [
  'modeChip', 'openRoomTemplateModal', 'closeRoomTemplateModal', 'renderRoomTemplateList',
  'renderRoomTemplateItem', 'selectRoomTemplate', 'createRoomFromTemplate', 'deleteRoomTemplate',
];

describe('app.js 模块化第13批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const pluginSrc = read(PLUGIN_FILE);
  const templatesSrc = read(TEMPLATES_FILE);

  it('plugin-ui 存在、走 PanelCore 桥、暴露 window.PanelPlugin 全部公开符号 + #btnPlugin* 绑定随迁', () => {
    expect(pluginSrc).toContain('window.PanelCore');
    expect(pluginSrc).toContain('window.PanelPlugin = {');
    for (const sym of PLUGIN_FNS) expect(pluginSrc, `${PLUGIN_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(pluginSrc).toContain('get pluginState() { return pluginState; }');
    // pluginState SSOT mirror 保持
    expect(pluginSrc).toContain("createPanelMirroredState('plugin', _pluginStateRaw)");
    // 绑定块全部随迁，boot 只绑一次
    for (const bind of [
      "$('#btnPlugins')?.addEventListener('click', showPluginArea);",
      "$('#btnPluginBack')?.addEventListener('click', hidePluginArea);",
      "$('#btnPluginInstall')?.addEventListener('click'",
      "$('#pluginInstallFile')?.addEventListener('change'",
      "$('#btnPluginReload')?.addEventListener('click'",
    ]) {
      expect(pluginSrc, `${PLUGIN_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // 状态实时取：hidePluginArea 经 core.state 读 activeId，禁解构快照裸引 state
    expect(pluginSrc).toContain('if (core.state.activeId)');
    // hidePluginArea/showPluginArea 区外 DOM 耦合保持原样（#roomArea 等互相隐藏约定）
    expect(pluginSrc).toContain("$('#roomArea') && ($('#roomArea').style.display = 'none');");
    // 审批基建经桥取（uninstall/exec/install/reload 四处走 requestWithApproval+handleApprovalFlow）
    expect(pluginSrc.match(/await requestWithApproval\(path, opts\);/g)?.length).toBe(4);
    expect(pluginSrc.match(/await handleApprovalFlow\(result, path, opts, \{/g)?.length).toBe(4);
  });

  it('room-templates-ui 存在、暴露 window.PanelRoomTemplates、建房后经 window.PanelRoomsCore 懒解析', () => {
    expect(templatesSrc).toContain('window.PanelCore');
    expect(templatesSrc).toContain('window.PanelRoomTemplates = {');
    for (const sym of TEMPLATE_FNS) expect(templatesSrc, `${TEMPLATES_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(templatesSrc).toContain('get roomTemplateState() { return roomTemplateState; }');
    // createRoomFromTemplate 既有懒解析保持
    expect(templatesSrc).toContain('await window.PanelRoomsCore?.loadRooms?.();');
    expect(templatesSrc).toContain('window.PanelRoomsCore?.selectRoom?.(r.room.id);');
    // 绑定块随迁
    expect(templatesSrc).toContain("$('#btnRoomNewFromTemplate')?.addEventListener('click', openRoomTemplateModal);");
    expect(templatesSrc).toContain("document.querySelectorAll('[data-close-room-template]').forEach(el => {");
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(templatesSrc.replace(/core\.roomState\./g, '')), `${TEMPLATES_FILE} 裸引 roomState`).toBe(false);
  });

  it('新文件 <500 行硬规则', () => {
    expect(pluginSrc.split('\n').length, `${PLUGIN_FILE} 超 500 行`).toBeLessThan(500);
    expect(templatesSrc.split('\n').length, `${TEMPLATES_FILE} 超 500 行`).toBeLessThan(500);
  });

  it('散落属主绑定迁回属主模块 boot()：#btnMcpNew→mcp-ui / #btnWebhookNew→webhook-ui / #btnArchiveNow→rooms-actions-ui', () => {
    const mcpSrc = read('public/src/web/mcp-ui.js');
    expect(mcpSrc).toContain("$('#btnMcpNew')?.addEventListener('click', () => {");
    expect(mcpSrc).toContain("renderMcpDetail({ name: '', type: 'stdio', command: '', args: [], env: {}, enabled: true });");
    const webhookSrc = read('public/src/web/webhook-ui.js');
    expect(webhookSrc).toContain("$('#btnWebhookNew')?.addEventListener('click', () => {");
    expect(webhookSrc).toContain("events: ['room_done', 'room_error', 'room_auto_paused'],");
    const actionsSrc = read('public/src/web/rooms-actions-ui.js');
    expect(actionsSrc).toContain("$('#btnArchiveNow')?.addEventListener('click', async () => {");
    expect(actionsSrc).toContain('/api/archive/rooms/');
    // rooms-actions-ui 加绑定后仍 <500 行
    expect(actionsSrc.split('\n').length, 'rooms-actions-ui.js 超 500 行').toBeLessThan(500);
  });

  it('main.js import 第13批两模块（带 cache-bust）', () => {
    expect(mainJs).toContain('./src/web/plugin-ui.js?v=appjs-migration-batch13-20260611');
    expect(mainJs).toContain('./src/web/room-templates-ui.js?v=appjs-migration-batch13-20260611');
  });

  it('app.js 不再保留两区实现与三处散落绑定，只留外迁标记', () => {
    for (const gone of [
      ...PLUGIN_FNS.map((f) => `function ${f}(`),
      ...TEMPLATE_FNS.map((f) => `function ${f}(`),
      'const pluginState',
      'const roomTemplateState',
      "$('#btnPlugins')?.addEventListener",
      "$('#btnPluginBack')?.addEventListener",
      "$('#btnPluginReload')?.addEventListener",
      "$('#btnRoomNewFromTemplate')?.addEventListener",
      "$('#btnMcpNew')?.addEventListener",
      "$('#btnArchiveNow')?.addEventListener",
      "$('#btnWebhookNew')?.addEventListener",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    // 2 个区块标记 + 3 个散落绑定标记 = 5 处「模块化第13批」
    expect(appJs.match(/模块化第13批/g)?.length).toBe(5);
  });

  it('PanelCore 桥本批零改动：plugin/模板区无桥直引，不允许出现指向两区符号的桥键', () => {
    const bridge = appJs.slice(appJs.indexOf('window.PanelCore = {'), appJs.indexOf('// ========== 辩论渲染'));
    for (const sym of [...PLUGIN_FNS, ...TEMPLATE_FNS, 'pluginState', 'roomTemplateState']) {
      expect(bridge, `PanelCore 桥意外引用 ${sym}`).not.toContain(sym);
    }
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（沿袭第12批纪律）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
