// @ts-check
// S24 模块化第16批（composer 输入增强 → composer-ui.js；
// 全局 overlay 管理 Esc 逐层关/focus-trap/modal-bg 点关/[data-cta] → overlays-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch14.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const COMPOSER_FILE = 'public/src/web/composer-ui.js';
const OVERLAYS_FILE = 'public/src/web/overlays-ui.js';

describe('app.js 模块化第16批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const composerSrc = read(COMPOSER_FILE);
  const overlaysSrc = read(OVERLAYS_FILE);

  it('composer-ui 存在、走 PanelCore 桥、三 init 收进 boot 只跑一次 + 绑定随迁', () => {
    expect(composerSrc).toContain('window.PanelCore');
    expect(composerSrc).toContain('window.PanelComposer = {');
    for (const sym of ['initAutoResize', 'initSelectionPopover', 'initTopicAttachments']) {
      expect(composerSrc, `${COMPOSER_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
      expect(composerSrc, `boot 内须调用 ${sym}()`).toContain(`${sym}();`);
    }
    // boot 防重入（一次性绑定，重复 boot 会双绑监听）
    expect(composerSrc).toContain('let booted = false;');
    expect(composerSrc).toContain('if (booted) return;');
    // document 级监听三件随迁（selectionchange / mousedown 隐浮层 / keydown-Esc 隐浮层）
    expect(composerSrc).toContain("document.addEventListener('selectionchange'");
    expect(composerSrc).toContain("document.addEventListener('mousedown', (e) => {");
    expect(composerSrc).toContain("if (e.key === 'Escape') hide();");
    // topic 展开/收起 + turn-card 委托随迁
    expect(composerSrc).toContain("$('#btnTopicExpand')?.addEventListener('click'");
    expect(composerSrc).toContain("$('#roomRounds')?.addEventListener('click'");
    // 划词浮层落输入框后必须 dispatch input（auto-resize/字数统计靠它联动）
    expect(composerSrc).toContain("ta.dispatchEvent(new Event('input', { bubbles: true }));");
  });

  it('overlays-ui 存在、closeTopOverlay 六层顺序齐全、Esc stopPropagation 保持、focus-trap/bg 点关/[data-cta] 随迁', () => {
    expect(overlaysSrc).toContain('window.PanelCore');
    expect(overlaysSrc).toContain('window.PanelOverlays = {');
    expect(overlaysSrc).toContain('function closeTopOverlay() {');
    // 六层逐层关顺序钉死：confirmModal → cmdk → 普通 modal → turn-card → topic 展开 → drawer
    const order = [
      '.confirm-modal:not(.confirm-modal-closing)',
      '.cmdk-modal',
      "document.querySelectorAll('.modal')",
      '.room-turn-card.is-expanded',
      "classList.contains('is-expanded')",
      '.squad-task-detail-overlay.open, .drawer.open, [data-overlay-open="1"]',
    ];
    let last = -1;
    for (const probe of order) {
      const idx = overlaysSrc.indexOf(probe);
      expect(idx, `overlays-ui 缺逐层关探针 ${probe}`).toBeGreaterThan(last);
      last = idx;
    }
    // Esc 命中即 stopPropagation（外迁前 app.js:3402 原话）
    expect(overlaysSrc).toContain('if (closeTopOverlay()) e.stopPropagation();');
    // 注册过 Modal 的层走 Modal.close（onClose hook/focus 归位），未注册才裸藏
    expect(overlaysSrc.match(/window\.Modal\.close\(/g)?.length, 'Esc 与 bg 点关都须走 Modal.close').toBe(2);
    // focus-trap：仅 Tab 介入
    expect(overlaysSrc).toContain("if (e.key !== 'Tab') return;");
    // bg 点关：mousedown+mouseup 都在 bg 上才算（防拖选误关）
    expect(overlaysSrc).toContain('let _bgMouseDownTarget = null;');
    expect(overlaysSrc).toContain("document.addEventListener('mouseup', (e) => {");
    // 欢迎页 CTA 入口
    expect(overlaysSrc).toContain("document.querySelectorAll('[data-cta]')");
    expect(overlaysSrc).toContain("$('#btnRooms')?.click();");
    // boot 防重入
    expect(overlaysSrc).toContain('let booted = false;');
    expect(overlaysSrc).toContain('if (booted) return;');
  });

  it('main.js import 第16批两模块（带 cache-bust），且必须先于 rooms-debate-ui/search-ui（Esc 注册顺序契约）', () => {
    const composerIdx = mainJs.indexOf('./src/web/composer-ui.js?v=appjs-migration-batch16-20260611');
    const overlaysIdx = mainJs.indexOf('./src/web/overlays-ui.js?v=appjs-migration-batch16-20260611');
    expect(composerIdx, 'main.js 缺 composer-ui import').toBeGreaterThan(-1);
    expect(overlaysIdx, 'main.js 缺 overlays-ui import').toBeGreaterThan(-1);
    // 外迁前划词浮层 Esc(app.js:3218) 先于 closeTopOverlay Esc(app.js:3400)：composer 须先 import
    expect(composerIdx, 'composer-ui 须先于 overlays-ui').toBeLessThan(overlaysIdx);
    // 外迁前两者均为 app.js 同步注册，先于一切模块 boot：必须 import 在两个同样绑 document Esc 的模块之前
    const debateIdx = mainJs.indexOf('./src/web/rooms-debate-ui.js');
    const searchIdx = mainJs.indexOf('./src/web/search-ui.js');
    expect(debateIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(overlaysIdx, 'overlays-ui 必须 import 在 rooms-debate-ui 之前').toBeLessThan(debateIdx);
    expect(overlaysIdx, 'overlays-ui 必须 import 在 search-ui 之前').toBeLessThan(searchIdx);
  });

  it('app.js 不再保留两区实现与绑定，只留 2 处外迁标记', () => {
    for (const gone of [
      'function closeTopOverlay(',
      '(function initAutoResize()',
      '(function initSelectionPopover()',
      '(function initTopicAttachments()',
      '_bgMouseDownTarget',
      "addEventListener('selectionchange'",
      "$('#btnTopicExpand')?.addEventListener",
      "$('#roomRounds')?.addEventListener",
      "querySelectorAll('[data-cta]')",
      'selection-popover',
      'attach-chip',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/模块化第16批/g)?.length).toBe(2);
  });

  it('inspector 双实现已去重（S24 收尾批22）：app.js 内联 IIFE 删除、main.js 正式接线模块版（详见 appjs-migration-batch22.test.js）', () => {
    expect(appJs).not.toContain('(function initInspectorResize()');
    expect(appJs).not.toContain('(function initInspectorToggle()');
    expect(appJs).not.toContain("$('#btnDebateStateClear')?.addEventListener('click'");
    expect(mainJs).toContain('_initInspector();');
  });

  it('新文件 <500 行硬规则', () => {
    expect(composerSrc.split('\n').length, `${COMPOSER_FILE} 超 500 行`).toBeLessThan(500);
    expect(overlaysSrc.split('\n').length, `${OVERLAYS_FILE} 超 500 行`).toBeLessThan(500);
  });

  it('PanelCore 桥无需改动：closeTopOverlay 从不在桥上，且不许闭包转发回潮', () => {
    const bridge = appJs.slice(appJs.indexOf('window.PanelCore = {'), appJs.indexOf('// ========== 辩论渲染'));
    expect(bridge).not.toContain('closeTopOverlay');
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });
});
