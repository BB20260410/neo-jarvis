// @ts-check
// S24 模块化第8批（cluster 工具/formatter/操作群外迁 rooms-cluster-tools-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch7.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MODULE_FILE = 'public/src/web/rooms-cluster-tools-ui.js';
const PUBLIC_FNS = [
  'openClusterDeliveryPackage',
  'currentRoomTopicDraft',
  'formatClusterPreflightMarkdown',
  'formatClusterLiveCheckMarkdown',
  'formatClusterConcurrencyBudgetMarkdown',
  'formatClusterDiagnosticsMarkdown',
  'clusterStartErrorSummary',
  'showClusterStartFailure',
  'runClusterPreflight',
  'showClusterConcurrencyBudget',
  'showClusterDiagnostics',
  'repairClusterRuntime',
  'archiveClusterDeliveryPackage',
];

describe('app.js 模块化第8批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const src = read(MODULE_FILE);

  it('外迁模块存在、走 PanelCore 桥、暴露 window.PanelRoomsClusterTools 全部公开函数', () => {
    expect(src).toContain('window.PanelCore');
    expect(src).toContain('window.PanelRoomsClusterTools = {');
    for (const sym of PUBLIC_FNS) expect(src, `${MODULE_FILE} 缺 ${sym}`).toContain(sym);
    // 外迁文件不得直接引用 app.js 闭包内符号 roomState（必须经 core.roomState）
    expect(/[^.]roomState\./.test(src.replace(/core\.roomState\./g, '')), `${MODULE_FILE} 裸引 roomState`).toBe(false);
  });

  it('main.js import 第8批模块（带 cache-bust）', () => {
    expect(mainJs).toContain("./src/web/rooms-cluster-tools-ui.js?v=appjs-migration-batch8-20260610");
  });

  it('app.js 不再保留 cluster 工具实现，只留外迁标记', () => {
    for (const gone of [
      'async function openClusterDeliveryPackage',
      'function currentRoomTopicDraft',
      'function formatClusterPreflightMarkdown',
      'function formatClusterLiveCheckMarkdown',
      'function formatClusterConcurrencyBudgetMarkdown',
      'function formatClusterDiagnosticsMarkdown',
      'function clusterStartErrorSummary',
      'async function showClusterStartFailure',
      'async function runClusterPreflight',
      'async function showClusterConcurrencyBudget',
      'async function showClusterDiagnostics',
      'async function repairClusterRuntime',
      'async function archiveClusterDeliveryPackage',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第8批）==========/g)?.length).toBe(1);
  });

  it('外迁调用点全部改经 window.PanelRoomsClusterTools 安全访问（第12批起 startDebate/绑定块在 rooms-actions-ui）', () => {
    const actionsSrc = read('public/src/web/rooms-actions-ui.js');
    // startDebate 启动失败分支：弹窗 + 错误摘要 toast
    expect(actionsSrc).toContain('await window.PanelRoomsClusterTools?.showClusterStartFailure?.(r);');
    expect(actionsSrc).toContain("(window.PanelRoomsClusterTools?.clusterStartErrorSummary?.(r) ?? 'unknown')");
    // 绑定块（第12批随 rooms-actions-ui 出走）：6 个按钮全改懒解析箭头
    for (const [btn, fn] of [
      ['#btnRoomClusterPreflight', 'runClusterPreflight'],
      ['#btnRoomClusterConcurrency', 'showClusterConcurrencyBudget'],
      ['#btnRoomClusterDiagnostics', 'showClusterDiagnostics'],
      ['#btnRoomClusterRepair', 'repairClusterRuntime'],
      ['#btnRoomDeliveryPackage', 'openClusterDeliveryPackage'],
      ['#btnRoomArchiveDeliveryPackage', 'archiveClusterDeliveryPackage'],
    ]) {
      expect(actionsSrc).toContain(`$('${btn}')?.addEventListener('click', () => window.PanelRoomsClusterTools?.${fn}?.());`);
    }
    // 定义已外迁，不允许残留裸调用（前缀必须是 . 或 ?.）
    for (const fn of PUBLIC_FNS) {
      expect(new RegExp(`[^.?]${fn}\\(`).test(appJs), `app.js 裸调用 ${fn}(`).toBe(false);
    }
  });

  it('__noeClusterTest 测试钩子：formatClusterDiagnosticsMarkdown 改懒解析仍可调（e2e 消费）', () => {
    expect(appJs).toContain('formatClusterDiagnosticsMarkdown: (...a) => window.PanelRoomsClusterTools?.formatClusterDiagnosticsMarkdown?.(...a),');
  });

  it('PanelCore 桥：renderRoomDebate 转发供模块归档后刷新房态（第11批本体随 rooms-debate-ui 出走改 window 懒转发）', () => {
    expect(appJs).toContain('renderRoomDebate: (...a) => window.PanelRoomsDebate?.renderRoomDebate?.(...a),');
    expect(src).toContain('renderRoomDebate(result.room);');
  });
});
