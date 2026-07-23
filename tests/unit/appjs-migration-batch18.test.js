// @ts-check
// S24 模块化第18批（selectSession + attachSessionWS 会话 WS 总分发 + stderr/partial 流式 + chip/banner → sessions-stream-ui.js
// + Watcher 监视者 UI → watcher-ui.js）结构级防回归
// 第17+18批为会话域强互联体合并 commit（attachSessionWS 是会话域的 handleRoomEvent 等价物，跨文件依赖全走 window 懒解析）
// 风格对齐 appjs-migration-batch12.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const STREAM_FILE = 'public/src/web/sessions-stream-ui.js';
const WATCHER_FILE = 'public/src/web/watcher-ui.js';

const STREAM_FNS = [
  'selectSession', 'attachSessionWS', 'handleStderrChunk', 'finalizeStderrDiv',
  'handlePartialStart', 'handlePartialDelta', 'handlePartialStop',
  'updateStateChip', 'updateCostChip', 'refreshCostSpark',
  'showDangerBanner', 'showLoopGuardBanner', 'showFocusChainBanner',
];
const WATCHER_FNS = ['showWatcherVerdict', 'updateWatcherToggleUI', 'loadWatcherProviders'];

const hasBareState = (src) => /(^|[^.\w$])state\./.test(src.replace(/core\.state\./g, ''));

describe('app.js 模块化第18批接线（sessions-stream/watcher）', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const streamSrc = read(STREAM_FILE);
  const watcherSrc = read(WATCHER_FILE);

  it('sessions-stream-ui 存在、走 PanelCore 桥、暴露 window.PanelSessionsStream 全部公开符号（含 STATE_LABELS）', () => {
    expect(streamSrc).toContain('window.PanelCore');
    expect(streamSrc).toContain('window.PanelSessionsStream = {');
    for (const sym of STREAM_FNS) expect(streamSrc, `${STREAM_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(streamSrc).toContain('const STATE_LABELS = {'); // buildSessionItem 跨文件经 window 取
    expect(streamSrc).toContain('STATE_LABELS,');
    expect(hasBareState(streamSrc), `${STREAM_FILE} 裸引 state`).toBe(false);
  });

  it('attachSessionWS 总分发：跨文件目标全走 window 懒解析，批19 留守经 core 桥调用时实时取', () => {
    // appendMessage：selectSession 回放 + message 事件 + error 事件 = 3 处
    expect(streamSrc.match(/window\.PanelSessionsList\?\.appendMessage\?\.\(/g)?.length).toBe(3);
    expect(streamSrc.match(/window\.PanelSessionsList\?\.renderList\?\.\(\);/g)?.length).toBe(2); // 选中高亮 + 失败回滚
    expect(streamSrc).toContain('window.PanelSessionsList?.showChat?.();');
    expect(streamSrc).toContain('window.PanelSessionsCore?.listSessions?.();'); // busy 事件
    expect(streamSrc).toContain('window.PanelWatcher?.showWatcherVerdict?.(msg);');
    expect(streamSrc).toContain('window.PanelWatcher?.updateWatcherToggleUI?.();');
    expect(streamSrc).toContain('window.PanelApprovals?.handleApprovalRequired?.(msg);');
    // 批19 留守（busy UI/ctx/快照/文件/安全 tab）经 core 桥实时取，迁走时桥改 window 懒转发、本文件零改动
    expect(streamSrc).toContain('core.updateBusyUI?.();');
    expect(streamSrc.match(/core\.refreshCtx\?\.\(\);/g)?.length).toBe(2); // selectSession + busy 沿降
    expect(streamSrc.match(/core\.maybeRefreshSafetyIfOpen\?\.\(\);/g)?.length).toBe(4); // danger×2/approval/loop_guard
    expect(streamSrc).toContain('core.refreshSnapshot?.();');
    expect(streamSrc).toContain('core.startSnapshotPolling?.();');
    expect(streamSrc).toContain("if (core.currentTab === 'files') core.loadFiles?.(s.cwd);");
    // banner dismiss 绑定随迁 boot
    expect(streamSrc).toContain("$('#btnDangerDismiss')?.addEventListener");
    expect(streamSrc).toContain("$('#btnLoopGuardDismiss')?.addEventListener");
  });

  it('watcher-ui 存在、暴露 window.PanelWatcher、加载即拉 providers 收进 boot、绑定全随迁', () => {
    expect(watcherSrc).toContain('window.PanelCore');
    expect(watcherSrc).toContain('window.PanelWatcher = {');
    for (const sym of WATCHER_FNS) expect(watcherSrc, `${WATCHER_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    expect(watcherSrc).toContain('get watcherState() { return watcherState; },');
    expect(watcherSrc).toContain('loadWatcherProviders();'); // boot 内仅一次（原 app.js 模块加载即执行）
    for (const bind of [
      "$('#btnWatcherDismiss')?.addEventListener",
      "$('#btnWatcherReject')?.addEventListener",
      "$('#btnWatcherAccept')?.addEventListener",
      "$('#btnWatcherToggle')?.addEventListener",
      "$('#watcherProviderSelect')?.addEventListener",
    ]) {
      expect(watcherSrc, `${WATCHER_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // listSessions 跨文件经 window 懒解析（toggle + provider 切换）
    expect(watcherSrc.match(/window\.PanelSessionsCore\?\.listSessions\?\.\(\);/g)?.length).toBe(2);
    expect(hasBareState(watcherSrc), `${WATCHER_FILE} 裸引 state`).toBe(false);
  });

  it('main.js import 第18批两模块（带 cache-bust），先于 overlays-ui（Esc 注册序契约随域整体保持）', () => {
    expect(mainJs).toContain('./src/web/sessions-stream-ui.js?v=appjs-migration-batch18-20260611');
    expect(mainJs).toContain('./src/web/watcher-ui.js?v=appjs-migration-batch18-20260611');
    expect(mainJs.indexOf('sessions-stream-ui.js')).toBeLessThan(mainJs.indexOf('overlays-ui.js'));
  });

  it('app.js 不再保留两区实现，只留外迁标记（stream/watcher 域函数定义零残留）', () => {
    for (const gone of [
      ...STREAM_FNS.map((f) => `function ${f}(`),
      ...WATCHER_FNS.map((f) => `function ${f}(`),
      'const STATE_LABELS',
      'const watcherState',
      'let _lastVerdictPrompt',
      "$('#btnDangerDismiss')?.addEventListener",
      "$('#btnWatcherToggle')?.addEventListener",
      "$('#watcherProviderSelect')?.addEventListener",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第18批）==========/g)?.length).toBe(2);
  });

  it('PanelCore 桥：selectSession 改 window 懒转发（search-ui 的 core.selectSession 调用不变）+ 残留调用点全 window 懒解析', () => {
    expect(appJs).toContain('selectSession: (...a) => window.PanelSessionsStream?.selectSession?.(...a),');
    expect(appJs).toContain('get currentTab() { return currentTab; },');
    // 残留消费点：清零（桥懒转发不计入此 pattern，因带 (...a)；
    // 第19批外迁后 handoff→sessions-tools-ui、⌘1-9→projects-files-ui 各带走 1 处；
    // 第20批外迁后 cmdk 会话跳转随 cmdk-ui.js 带走 1 处；第22批 fork 随 star/fork 归位 sessions-tools-ui 带走最后 1 处）
    expect(appJs.match(/window\.PanelSessionsStream\?\.selectSession\?\.\((?!\.\.\.a)/g)).toBeNull();
    expect(read('public/src/web/sessions-tools-ui.js').match(/window\.PanelSessionsStream\?\.selectSession\?\.\(r\.newSessionId\);/g)?.length).toBe(2); // handoff + fork
    expect(read('public/src/web/cmdk-ui.js')).toContain('window.PanelSessionsStream?.selectSession?.(s.id);');
    expect(read('public/src/web/sessions-tools-ui.js')).toContain('window.PanelSessionsStream?.refreshCostSpark?.();'); // startSnapshotPolling 轮询（第19批随迁）
    // search-ui 消费方接线不变（core.selectSession 调用时实时取到懒转发）
    expect(read('public/src/web/search-ui.js')).toContain('core.selectSession(h.sessionId);');
  });
});
