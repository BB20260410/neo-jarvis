// @ts-check
// S24 模块化第6批（知识库/审批中心/委派中心/时间线外迁）结构级防回归
// 风格对齐 server-route-wiring.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MODULES = [
  { file: 'public/src/web/knowledge-ui.js', global: 'window.PanelKnowledge', mustHave: ['openKnowledgeCenterModal', 'knowledgeCenterState', "$('#btnKnowledgeCenter')"] },
  { file: 'public/src/web/approvals-ui.js', global: 'window.PanelApprovals', mustHave: ['openApprovalModal', 'handleApprovalRequired', "$('#btnApprovals')"] },
  { file: 'public/src/web/delegation-ui.js', global: 'window.PanelDelegation', mustHave: ['openDelegationModal', 'executeDelegation', "$('#btnDelegations')"] },
  { file: 'public/src/web/timeline-ui.js', global: 'window.PanelTimeline', mustHave: ['openTimelineModal', 'renderTimeline', "$('#btnTimeline')"] },
];

describe('app.js 模块化第6批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');

  it('四个外迁模块存在、走 PanelCore 桥、暴露各自 window 全局', () => {
    for (const m of MODULES) {
      const src = read(m.file);
      expect(src, m.file).toContain('window.PanelCore');
      expect(src, m.file).toContain(`${m.global} = {`);
      for (const sym of m.mustHave) expect(src, `${m.file} 缺 ${sym}`).toContain(sym);
      // 外迁文件不得直接引用 app.js 闭包内符号 roomState（必须经 core.roomState）
      expect(/[^.]roomState\./.test(src.replace(/core\.roomState\./g, '')), `${m.file} 裸引 roomState`).toBe(false);
    }
  });

  it('main.js 按序 import 第6批四模块', () => {
    for (const m of MODULES) {
      expect(mainJs).toContain(m.file.replace('public/', './'));
    }
  });

  it('app.js 不再保留四节实现，只留外迁标记', () => {
    for (const gone of ['knowledgeCenterState = {', 'const approvalState = {', 'const delegationState = {', 'const timelineState = {']) {
      expect(appJs).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第6批）==========/g)?.length).toBe(4);
  });

  it('PanelCore 桥：审批/委派改懒转发 + 新增 promptModal/shortLineageValue', () => {
    expect(appJs).toContain("openApprovalModal: (...a) => window.PanelApprovals?.openApprovalModal?.(...a)");
    expect(appJs).toContain("openDelegationModal: (...a) => window.PanelDelegation?.openDelegationModal?.(...a)");
    expect(appJs).toContain('get delegationState() { return window.PanelDelegation?.state; }');
    // 第10批起 shortLineageValue 随 rooms-core-ui 出走 → 改 window 懒转发（promptModal 仍直引）
    expect(appJs).toContain('promptModal,');
    expect(appJs).toContain('shortLineageValue: (...a) => window.PanelRoomsCore?.shortLineageValue?.(...a),');
  });

  it('残留调用点全部改经 window.PanelApprovals 安全访问（随批次外迁后跟到新属主文件）', () => {
    // 原 WS 两处 approval_required 推送：会话 WS 一处随第18批迁入 sessions-stream-ui.js、term WS 一处
    // 随第20批迁入 term-ui.js（两处均仍走 window.PanelApprovals 懒解析，见 batch18/batch20 测试）；
    // 审批重试弹窗「打开审批中心」一处（openApprovalModal）随第21批迁入 approval-flow-ui.js，
    // app.js 仅剩 PanelCore 桥懒转发条目（见本文件上一断言），不再有直接调用点
    expect(appJs.match(/window\.PanelApprovals\?\.handleApprovalRequired\?\.\(msg\);/g)).toBeNull();
    expect(read('public/src/web/term-ui.js')).toContain('window.PanelApprovals?.handleApprovalRequired?.(msg);');
    expect(appJs.match(/window\.PanelApprovals\?\.openApprovalModal\?\.\(\)/g)).toBeNull();
    expect(read('public/src/web/approval-flow-ui.js')).toContain('window.PanelApprovals?.openApprovalModal?.();');
    // 不允许再有裸 handleApprovalRequired( 调用（定义已外迁）
    expect(/[^.?]handleApprovalRequired\(/.test(appJs)).toBe(false);
  });
});
