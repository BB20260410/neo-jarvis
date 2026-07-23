// @ts-check
// 第三波手术 第25批 结构级防回归：activity-ui.js（620 行）拆出 activity-detail-ui.js
// 刀法（照 /tmp/noe-maps3/webMap.json）：
//   ① activity-ui.js 保名：activityState 单一属主+modal 开关/刷新+主渲染与全部绑定+列表渲染+
//      window.PanelActivity（open/close/refresh API 面一字不变）
//   ② activity-detail-ui.js：只读 event 对象的 17 个提取器纯函数+6 个详情面板渲染，挂 window.PanelActivityDetail
//   主文件经 detail() 懒解析访问器取用（调用期实时取，免疫 boot/import 顺序）；详情文件零共享状态（不读 activityState）
// 行为契约（e2e panel-ui-walkthrough 钉）：cluster delivery 真 UI 路径渲染文本与 data-activity-* 属性面不变
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MAIN_FILE = 'public/src/web/activity-ui.js';
const DETAIL_FILE = 'public/src/web/activity-detail-ui.js';
const ENTRY_FILE = 'public/main.js';

// ② 的 API 面：17 提取器 + 6 渲染
const DETAIL_EXTRACTORS = [
  'activityTitle', 'activitySearchText', 'activityScopeLine',
  'activityAsArray', 'activityCollectValues', 'activityUniqueStrings',
  'activityAgentProfileIds', 'activityAgentRunIds',
  'activityApprovalResumeGateIds', 'activityApprovalResumeGateSha256s', 'activityApprovalResumeGateAudit',
  'activitySkillBindings', 'activitySkillNames', 'activityDispatchTags',
  'activityDiagnosticItems', 'activityArtifacts', 'isAgentActivityEvent',
];
const DETAIL_RENDERS = [
  'renderActivityRunButtons', 'renderActivityApprovalResumeGatePanel', 'renderActivityAgentPanel',
  'renderActivityArtifactPanel', 'renderActivityClusterDeliveryPanel', 'renderActivityDetail',
];

describe('activity 拆分第25批（activity-ui 提取器/详情面板外迁 activity-detail-ui）', () => {
  const mainSrc = read(MAIN_FILE);
  const detailSrc = read(DETAIL_FILE);
  const entrySrc = read(ENTRY_FILE);

  it('两文件均 <500 行（工程硬规则）', () => {
    expect(mainSrc.split('\n').length, `${MAIN_FILE} 行数超标`).toBeLessThan(500);
    expect(detailSrc.split('\n').length, `${DETAIL_FILE} 行数超标`).toBeLessThan(500);
  });

  it('window.PanelActivity API 面一字不变（消费者 agent-graph/governance/knowledge/e2e 直调）', () => {
    expect(mainSrc).toContain('window.PanelActivity = { open: openActivityModal, close: closeActivityModal, refresh: refreshActivity };');
  });

  it('detail 文件持有全部 23 个函数定义并整体挂 window.PanelActivityDetail；主文件零残留', () => {
    for (const fn of [...DETAIL_EXTRACTORS, ...DETAIL_RENDERS]) {
      expect(detailSrc, `detail 缺 function ${fn}(`).toContain(`function ${fn}(`);
      expect(detailSrc, `PanelActivityDetail 挂载缺 ${fn}`).toMatch(new RegExp(`window\\.PanelActivityDetail = \\{[\\s\\S]*?\\b${fn},`));
      expect(mainSrc, `主文件残留 function ${fn}(`).not.toContain(`function ${fn}(`);
    }
  });

  it('主文件经 detail() 懒解析取用（调用期实时取，免疫加载顺序）', () => {
    expect(mainSrc).toContain('const detail = () => window.PanelActivityDetail || {};');
    for (const call of [
      "detail().activitySearchText?.(e) || ''",
      'detail().isAgentActivityEvent?.(e)',
      'detail().activityDiagnosticItems?.(e)',
      "detail().renderActivityDetail?.(active) || ''",
      "detail().activityTitle?.(e) || ''",
      "detail().activityScopeLine?.(e) || ''",
    ]) {
      expect(mainSrc, `主文件缺懒调用 ${call}`).toContain(call);
    }
  });

  it('detail 文件零共享状态：不读 activityState/roomState，不绑事件不碰 modal 壳', () => {
    // 只抓代码级访问（activityState.xxx / activityState =），文件头注释提及不算
    expect(detailSrc).not.toMatch(/\bactivityState\s*[.=[]/);
    expect(detailSrc).not.toContain('roomState');
    // 唯一 addEventListener 是 boot 壳的 DOMContentLoaded（装载机制）；UI 事件绑定全部留主文件
    const listeners = detailSrc.match(/addEventListener\('([^']+)'/g) || [];
    expect(listeners).toEqual(["addEventListener('DOMContentLoaded'"]);
    expect(detailSrc).not.toContain('#activityModal');
  });

  it('e2e 行为面留在 detail：面板标题文本与 data-activity-* 属性一字不变', () => {
    for (const pin of [
      '<strong>Cluster Delivery Archive</strong>',
      '<strong>Approval Resume Gate</strong>',
      '<strong>Agent / Skill</strong>',
      '<strong>Archive Artifacts</strong>',
      'data-activity-open-run=',
      'data-activity-artifact-download=',
      'data-activity-artifact-copy=',
      'data-activity-open-room=',
    ]) {
      expect(detailSrc, `detail 缺行为钉 ${pin}`).toContain(pin);
    }
    // run/artifact 跳转保持经 PanelCore 桥（app.js getter→PanelAgentGraph），勿改直引（map 风险钉）
    expect(mainSrc).toContain('window.PanelCore.openAgentRunFromActivity?.(btn.dataset.activityOpenRun)');
    expect(mainSrc).toContain('window.PanelCore.openAgentRunArtifact?.(btn.dataset.activityArtifactRun, btn.dataset.activityArtifactDownload, btn)');
  });

  it('main.js 双 import 带 batch25 缓存串（防新旧混跑）', () => {
    expect(entrySrc).toContain("import './src/web/activity-ui.js?v=appjs-migration-batch25-20260611';");
    expect(entrySrc).toContain("import './src/web/activity-detail-ui.js?v=appjs-migration-batch25-20260611';");
  });
});
