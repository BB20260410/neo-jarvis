// @ts-check
// S24 模块化第9批（cluster runtime 实时渲染群外迁 rooms-cluster-live-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch8.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MODULE_FILE = 'public/src/web/rooms-cluster-live-ui.js';
const PUBLIC_FNS = [
  'crossVerifyStageBadges',
  'formatClusterRuntimeTime',
  'formatClusterDurationMs',
  'renderClusterRuntimeHeartbeatLine',
  'renderClusterRuntimeRecoveryLine',
  'renderClusterRuntimeResumePolicyLine',
  'currentClusterTask',
  'cleanClusterRuntimeOutputContent',
  'renderClusterRuntimeOutputRows',
  'renderClusterRuntimeLivePanel',
  'renderCrossVerifyConsensusMarkdown',
];

describe('app.js 模块化第9批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const src = read(MODULE_FILE);

  it('外迁模块存在、走 PanelCore 桥、暴露 window.PanelRoomsClusterLive 全部公开函数', () => {
    expect(src).toContain('window.PanelCore');
    expect(src).toContain('window.PanelRoomsClusterLive = {');
    for (const sym of PUBLIC_FNS) expect(src, `${MODULE_FILE} 缺 ${sym}`).toContain(sym);
    // 外迁文件不得直接引用 app.js 闭包内符号 roomState（必须经 core.roomState）
    expect(/[^.]roomState\./.test(src.replace(/core\.roomState\./g, '')), `${MODULE_FILE} 裸引 roomState`).toBe(false);
  });

  it('main.js import 第9批模块（带 cache-bust）', () => {
    expect(mainJs).toContain("./src/web/rooms-cluster-live-ui.js?v=appjs-migration-batch9-20260610");
  });

  it('app.js 不再保留 cluster runtime 实时渲染实现，只留外迁标记', () => {
    for (const gone of [
      'function crossVerifyStageBadges',
      'function formatClusterRuntimeTime',
      'function formatClusterDurationMs',
      'function renderClusterRuntimeHeartbeatLine',
      'function renderClusterRuntimeRecoveryLine',
      'function renderClusterRuntimeResumePolicyLine',
      'function currentClusterTask',
      'function cleanClusterRuntimeOutputContent',
      'function renderClusterRuntimeOutputRows',
      'function renderClusterRuntimeLivePanel',
      'function renderCrossVerifyConsensusMarkdown',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第9批）==========/g)?.length).toBe(1);
  });

  it('app.js 残留调用点全部改经 window.PanelRoomsClusterLive 安全访问', () => {
    // renderRoomDebate 第11批随 rooms-debate-ui 出走 → 两处调用点跟着进新模块（仍 window 懒解析）
    const debateSrc = read('public/src/web/rooms-debate-ui.js');
    expect(debateSrc).toContain("(window.PanelRoomsClusterLive?.renderCrossVerifyConsensusMarkdown?.(room) ?? '')");
    expect(debateSrc).toContain('if (isCrossVerify) window.PanelRoomsClusterLive?.renderClusterRuntimeLivePanel?.(room);');
    // handleRoomEvent 内：cluster_runtime_output 事件刷新输出行（第12批b 随 handleClusterEvent 落 rooms-events-collab-ui，仍 window 懒解析）
    const eventsSrc = read('public/src/web/rooms-events-collab-ui.js');
    expect(eventsSrc).toContain("window.PanelRoomsClusterLive?.renderClusterRuntimeOutputRows?.(window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput) ?? ''");
    // 定义已外迁，不允许残留裸调用（前缀必须是 . 或 ?.）
    for (const fn of PUBLIC_FNS) {
      expect(new RegExp(`[^.?]${fn}\\(`).test(appJs), `app.js 裸调用 ${fn}(`).toBe(false);
    }
  });

  it('__noeClusterTest 测试钩子：5 个外迁函数改懒解析仍可调（e2e 消费）', () => {
    for (const fn of [
      'crossVerifyStageBadges',
      'renderClusterRuntimeHeartbeatLine',
      'renderClusterRuntimeRecoveryLine',
      'renderClusterRuntimeResumePolicyLine',
      'renderCrossVerifyConsensusMarkdown',
    ]) {
      expect(appJs).toContain(`${fn}: (...a) => window.PanelRoomsClusterLive?.${fn}?.(...a),`);
    }
    // handleRoomEvent 第12批随 rooms-events-ui 出走 → 钩子改懒解析
    expect(appJs).toContain('handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),');
  });

  it('PanelCore 桥：statusLabel / isRoomRunningLike 转发供模块调用（第10批起本体随 rooms-core-ui 出走改 window 懒转发）', () => {
    expect(appJs).toContain('statusLabel: (...a) => window.PanelRoomsCore?.statusLabel?.(...a),');
    expect(appJs).toContain('isRoomRunningLike: (...a) => window.PanelRoomsCore?.isRoomRunningLike?.(...a),');
    expect(src).toContain('const { $, escapeHtml, statusLabel, isRoomRunningLike } = core;');
  });
});
