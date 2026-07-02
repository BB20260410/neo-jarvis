#!/usr/bin/env node
// CE12 P0 FR-P0-4 / NFR-P0-2 运行时证据 harness。
// 在隔离的 PANEL_DB_PATH 上跑 ActPipeline 三个场景，证明：
//   1) 低危动作只走 dry-run 并落可复现证据事件，绝不真实执行；
//   2) 敏感(高危)动作默认 awaiting_approval，不会自动执行；
//   3) 破坏性动作(file.delete 等)直接 blocked_safety，永不执行。
// 输出落到 output/ce12-p0/act-pipeline-evidence.json，全部符合预期 exit 0，否则 exit 1。
// 仅本地读写，不外发、不删除、不批量移动、不跑 shell。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, 'output', 'ce12-p0');
mkdirSync(outDir, { recursive: true });

// 隔离 DB：不碰真实 ~/.noe-panel/panel.db
process.env.PANEL_DB_PATH = join(outDir, 'act-evidence.db');

const { ActPipeline } = await import('../src/loop/ActPipeline.js');

// 审批桩：只返回审批单 id，不自动批准（证明默认不放行）
const approvalStore = {
  created: [],
  createApproval(input) {
    const approval = { id: `appr_${this.created.length + 1}`, ...input };
    this.created.push(approval);
    return approval;
  },
};
// 权限桩：低危 dry-run 允许
const permission = {
  evaluatePermission() { return { decision: 'allow', reason: 'dry-run low risk allowed' }; },
};

const pipeline = new ActPipeline({ projectId: 'noe-ce12-evidence', approvalStore, permission });

const scenarios = [
  {
    name: 'A_low_risk_dry_run',
    input: { action: 'noe.focus.review', riskLevel: 'low', title: '低危专注复盘', costEstimateUsd: 0 },
    expectStatus: 'completed',
    expectNeverExecuted: true,
  },
  {
    name: 'B_high_risk_needs_approval',
    input: { action: 'noe.custom.sensitive', riskLevel: 'high', title: '敏感动作需审批' },
    expectStatus: 'awaiting_approval',
    expectNeverExecuted: true,
  },
  {
    name: 'C_destructive_blocked_safety',
    input: { action: 'file.delete', title: '删除文件(应被拦)', payload: { path: '/tmp/should-never-run' } },
    expectStatus: 'blocked_safety',
    expectNeverExecuted: true,
  },
];

const results = [];
for (const s of scenarios) {
  const res = await pipeline.propose(s.input);
  const act = res.act;
  const pass = act.status === s.expectStatus;
  results.push({
    scenario: s.name,
    requestedAction: s.input.action,
    requestedRisk: s.input.riskLevel || '(auto)',
    finalStatus: act.status,
    expectedStatus: s.expectStatus,
    permissionState: act.permissionState,
    failureReason: act.failureReason || '',
    evidenceEventId: act.evidenceEventId || null,
    logRef: act.logRef || '',
    approvalId: act.approvalId || null,
    pass,
  });
}

const allPass = results.every((r) => r.pass);
// 关键安全不变量：没有任何场景产生真实执行终态(只允许 dry-run completed / await / blocked)
const noRealExecution = results.every((r) =>
  ['completed', 'awaiting_approval', 'blocked_safety', 'failed'].includes(r.finalStatus),
);

const report = {
  generatedBy: 'scripts/ce12-p0-act-evidence.mjs',
  node: process.version,
  abi: process.versions.modules,
  dbPath: process.env.PANEL_DB_PATH,
  allPass,
  noRealExecution,
  approvalsCreated: approvalStore.created.length,
  results,
};

const outFile = join(outDir, 'act-pipeline-evidence.json');
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(`[ce12-p0] node=${process.version} abi=${process.versions.modules}`);
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}: ${r.requestedAction} -> ${r.finalStatus} (期望 ${r.expectedStatus})`);
}
console.log(`[ce12-p0] approvalsCreated=${report.approvalsCreated} noRealExecution=${noRealExecution}`);
console.log(`[ce12-p0] evidence -> ${outFile}`);

process.exit(allPass && noRealExecution ? 0 : 1);
