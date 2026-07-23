// @ts-check
// S24 收尾第22批（两笔收尾手术）结构级防回归：
// ① star/fork + ctx 警告条归位会话域 sessions-tools-ui.js（F5/F7 message 右键菜单收藏/分叉 + F8 ctx 警告条）
// ② inspector 双实现去重：app.js 内联 IIFE（活实现）删除，main.js 正式接线既有模块 src/web/inspector.js（原死导出）
// 风格对齐 appjs-migration-batch12/19.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const TOOLS_FILE = 'public/src/web/sessions-tools-ui.js';
const INSPECTOR_FILE = 'public/src/web/inspector.js';

const STAR_CTX_FNS = ['toggleStar', 'forkSession', 'updateCtxWarningBar', 'ensureCtxBar', 'showCtxBar', 'hideCtxBar'];

// 裸引 state 检查：剔除 core.state. 后不允许再出现独立的 state.（沿袭批19 纪律）
const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第22批（S24 收尾：star/fork+ctx 归位 + inspector 双实现去重）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const toolsSrc = read(TOOLS_FILE);
  const inspectorSrc = read(INSPECTOR_FILE);

  it('手术①：star/fork+ctx 六函数 + in-flight 去重 + document 级委托 + 5s ctx 轮询全数迁入 sessions-tools-ui', () => {
    for (const sym of STAR_CTX_FNS) expect(toolsSrc, `${TOOLS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(toolsSrc).toContain('const _toggleStarInflight = new Set();');
    // chatOutput ⭐ 点击 + 右键菜单 document 级委托随迁（boot 只跑一次 = 只绑一次）
    expect(toolsSrc).toContain("const star = e.target.closest('.msg-star-btn');");
    expect(toolsSrc).toContain("document.addEventListener('contextmenu', (e) => {");
    expect(toolsSrc).toContain("const msg = e.target.closest('#chatOutput .msg');");
    // ctx 警告条 DOM 注入 + 接力按钮 + 5s document.hidden 感知轮询
    expect(toolsSrc).toContain("bar.id = 'ctxWarningBar';");
    expect(toolsSrc).toContain('id="ctxWarnHandoff"');
    expect(toolsSrc).toContain("$('#btnHandoff')?.click();");
    expect(toolsSrc).toContain('setInterval(() => { if (!document.hidden) updateCtxWarningBar(); }, 5000);');
    expect(hasBareState(toolsSrc), `${TOOLS_FILE} 裸引 state`).toBe(false);
  });

  it('手术①：跨文件全走 window 懒解析 + fallbackCopy 留守 app.js 经桥解构 + star/fork 语义随迁（裸 fetch 不加 api 包装）', () => {
    expect(toolsSrc).toContain('window.PanelSessionsCore?.openContextMenu?.([');
    // fork 成功后刷列表 + 跳新 session（与 handoff 共用既有懒解析样式）
    expect(toolsSrc.match(/window\.PanelSessionsCore\?\.listSessions\?\.\(\);/g)?.length).toBe(2); // handoff + fork
    expect(toolsSrc.match(/window\.PanelSessionsStream\?\.selectSession\?\.\(r\.newSessionId\);/g)?.length).toBe(2); // handoff + fork
    // fallbackCopy 本体留守 app.js（activity/agent-graph 经桥共用），模块经 core 桥解构
    expect(toolsSrc).toMatch(/const \{[^}]*fallbackCopy[^}]*\} = core;/);
    expect(appJs).toContain('function fallbackCopy(');
    // star/fork/ctx 原实现走裸 fetch，随迁不改包装（防 api 包装改变错误处理语义）
    expect(toolsSrc).toContain('await fetch(`/api/sessions/${sessionId}/star`');
    expect(toolsSrc).toContain('await fetch(`/api/sessions/${sessionId}/fork`');
    expect(toolsSrc).toContain('await fetch(`/api/sessions/${core.state.activeId}/ctx`)');
  });

  it('手术①：window.PanelSessionsTools 暴露新增三公开符号；app.js 零残留只剩两处第22批外迁标记', () => {
    for (const sym of ['toggleStar', 'forkSession', 'updateCtxWarningBar']) {
      expect(toolsSrc, `PanelSessionsTools 缺暴露 ${sym}`).toMatch(new RegExp(`window\\.PanelSessionsTools = \\{[\\s\\S]*?\\b${sym},`));
    }
    for (const gone of [
      ...STAR_CTX_FNS.map((f) => `function ${f}(`),
      'const _toggleStarInflight',
      "e.target.closest('.msg-star-btn')",
      "e.target.closest('#chatOutput .msg')",
      "bar.id = 'ctxWarningBar';",
      'ctxWarnHandoff',
      'setInterval(() => { if (!document.hidden) updateCtxWarningBar(); }, 5000);',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
  });

  it('手术②：inspector 双实现去重——app.js 内联 IIFE 删净，模块版四导出健在', () => {
    for (const gone of [
      '(function initInspectorResize()',
      '(function initInspectorToggle()',
      "$('#btnDebateStateClear')?.addEventListener('click'",
      "'panel:inspectorW'",
      "'panel:inspectorHidden'",
    ]) {
      expect(appJs, `app.js 残留 inspector 内联实现 ${gone}`).not.toContain(gone);
    }
    for (const sym of ['initInspectorResize', 'initInspectorToggle', 'initDebateStateClear', 'initInspector']) {
      expect(inspectorSrc, `${INSPECTOR_FILE} 缺导出 ${sym}`).toContain(`export function ${sym}(`);
    }
    // initInspector 聚合三 init（resize+toggle+debateClear），等价覆盖原 app.js 内联双 IIFE 全部行为
    expect(inspectorSrc).toContain('initInspectorResize();');
    expect(inspectorSrc).toContain('initInspectorToggle();');
    expect(inspectorSrc).toContain('initDebateStateClear();');
  });

  it('手术②：main.js 正式接线模块版（唯一 init 点）且 window.PanelInspector 暴露不变（walkthrough 探针依赖）', () => {
    expect(mainJs).toContain("import { initInspector as _initInspector, initInspectorResize as _initInspResize, initInspectorToggle as _initInspToggle, initInspectorAutoCollapse as _initInspAutoCollapse, initDebateStateClear as _initDebateClear } from './src/web/inspector.js';");
    expect(mainJs).toContain('_initInspector();');
    // P1-A UI 整合：PanelInspector 新增 initInspectorAutoCollapse（右栏空态折叠），现有字段全保留（walkthrough 探针依赖不丢）
    expect(mainJs).toContain('window.PanelInspector = { initInspectorResize: _initInspResize, initInspectorToggle: _initInspToggle, initInspectorAutoCollapse: _initInspAutoCollapse, initDebateStateClear: _initDebateClear };');
  });

  it('main.js sessions-tools 缓存串 bump 到 batch22（防 stale 旧版缺 star/ctx），第19批两兄弟模块缓存串不动', () => {
    expect(mainJs).toContain('./src/web/sessions-tools-ui.js?v=appjs-migration-batch22-20260611');
    expect(mainJs).not.toContain('./src/web/sessions-tools-ui.js?v=appjs-migration-batch19-20260611');
    expect(mainJs).toContain('./src/web/safety-ui.js?v=appjs-migration-batch19-20260611');
    expect(mainJs).toContain('./src/web/projects-files-ui.js?v=appjs-migration-batch19-20260611');
  });

  it('文件 <500 行硬规则（迁入后 sessions-tools 仍达标）+ 外迁标记计数', () => {
    expect(toolsSrc.split('\n').length, `${TOOLS_FILE} 超 500 行`).toBeLessThan(500);
    // 3 处「模块化第22批」标记：F5+F7 star/fork、F8 ctx 条、inspector 去重
    expect(appJs.match(/（模块化第22批）==========/g)?.length).toBe(3);
  });
});
