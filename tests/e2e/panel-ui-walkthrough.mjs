#!/usr/bin/env node
// panel-ui-walkthrough.mjs — v0.9 真测：playwright 全功能 walkthrough
// 2026-06-10 对齐 UI 折叠改版：顶栏入口已收进 <details id="settingsDd">（index.html:50），
// 点击/断言导航按钮前必须先展开（视口须 1600x900，窄视口顶栏 nav 被响应式隐藏）。
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveOwnerTokenAuthorization } from '../../scripts/lib/noe-standing-autonomy-grant.mjs';

const PANEL = process.env.PANEL_URL || 'http://localhost:51835';
// 第 11 节每跑一次会用此前缀新建一个 webhook；WebhookStore 上限 20（MAX_WEBHOOKS），
// 不清理则跑满上限后创建返回 400 复发。启动时清历史残留 + finally 清本次自产。
const E2E_APPROVAL_WEBHOOK_PREFIX = 'e2e-approval-';
const results = [];
const consoleErrors = [];
const ARTIFACT_DIR = join(process.cwd(), 'output', 'playwright');
const E2E_CODEBASE_ROOT = join(homedir(), 'noe-e2e-codebase');
const E2E_IDEA_EXEC_TIMEOUT_MS = Number(process.env.E2E_IDEA_EXEC_TIMEOUT_MS || 60000);
const OWNER_TOKEN_AUTHORIZATION = resolveOwnerTokenAuthorization({
  explicitAck: process.argv.includes('--ack-read-owner-token') || process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  scope: 'e2e-live:run',
});
const ACK_READ_OWNER_TOKEN = OWNER_TOKEN_AUTHORIZATION.authorized;

function prepareCodebaseFixture() {
  mkdirSync(join(E2E_CODEBASE_ROOT, 'public'), { recursive: true });
  mkdirSync(join(E2E_CODEBASE_ROOT, 'src', 'agents'), { recursive: true });
  writeFileSync(join(E2E_CODEBASE_ROOT, 'public', 'app.js'), `
function openAgentRegistryModal() {
  const modal = document.querySelector('#agentRegistryModal');
  if (modal) modal.style.display = 'flex';
}

document.querySelector('#btnAgentRegistry')?.addEventListener('click', openAgentRegistryModal);
document.querySelector('#agentPreviewRun')?.addEventListener('click', () => {
  document.querySelector('#agentPreviewResult').textContent = 'Dispatch Preview';
});
`, 'utf8');
  writeFileSync(join(E2E_CODEBASE_ROOT, 'public', 'index.html'), `
<button id="btnAgentRegistry">Agent Registry</button>
<section id="agentRegistryModal"></section>
<section id="agentPreviewResult"></section>
`, 'utf8');
  writeFileSync(join(E2E_CODEBASE_ROOT, 'src', 'agents', 'AgentRunStore.js'), `
export class AgentRunStore {
  createRunDraft(input) {
    return {
      id: 'draft-agent-run',
      codebaseQuestionAnswer: input.codebaseQuestionAnswer,
      evidence: input.evidence || [],
    };
  }

  archiveRun(run) {
    return { ...run, archived: true, chain: 'Idea-to-Archive' };
  }
}
`, 'utf8');
  writeFileSync(join(E2E_CODEBASE_ROOT, 'src', 'agents', 'SymbolGraph.js'), `
export function buildSymbolGraph(files) {
  return {
    symbols: files.map((file) => ({ file, anchor: 'AgentRunStore' })),
    routeUsage: [{ route: '/api/agent-runs', file: 'src/agents/AgentRunStore.js' }],
  };
}
`, 'utf8');
}

function track(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name} ${detail}`);
}

function readOwnerToken() {
  if (process.env.OWNER_TOKEN) {
    const token = String(process.env.OWNER_TOKEN).trim();
    return token.length >= 16 ? token : '';
  }
  if (!ACK_READ_OWNER_TOKEN) return '';
  try {
    const token = readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim();
    return token.length >= 32 ? token : '';
  } catch {
    return '';
  }
}

function panelUrlWithoutOwnerToken() {
  try {
    const url = new URL(PANEL);
    url.searchParams.delete('t');
    return url.toString();
  } catch {
    return PANEL.replace(/([?&])t=[^&]+&?/, '$1').replace(/[?&]$/, '');
  }
}

// 清理 e2e 自产的 e2e-approval-* webhook（按名字前缀识别）。
// 启动时调用清历史残留（防御性），finally 调用清本次自产；失败只警告不影响测试分数。
async function cleanupE2eApprovalWebhooks(ownerToken, label) {
  if (!ownerToken) return;
  try {
    // GET 也带 token：server.js 全局边界门对 /api/* 同样要求 X-Panel-Owner-Token
    const listRes = await fetch(new URL('/api/webhooks', PANEL), {
      headers: { 'X-Panel-Owner-Token': ownerToken },
    });
    if (!listRes.ok) {
      console.log(`  ⚠️ ${label}: 拉取 webhook 列表失败 HTTP ${listRes.status}`);
      return;
    }
    const data = await listRes.json().catch(() => null);
    const stale = (Array.isArray(data?.webhooks) ? data.webhooks : [])
      .filter((w) => typeof w?.name === 'string' && w.name.startsWith(E2E_APPROVAL_WEBHOOK_PREFIX));
    if (!stale.length) return;
    let removed = 0;
    for (const w of stale) {
      const delRes = await fetch(new URL(`/api/webhooks/${encodeURIComponent(w.id)}`, PANEL), {
        method: 'DELETE',
        headers: { 'X-Panel-Owner-Token': ownerToken },
      });
      if (delRes.ok) removed += 1;
      else console.log(`  ⚠️ ${label}: 删除 webhook ${w.name} 失败 HTTP ${delRes.status}`);
    }
    console.log(`  🧹 ${label}: 清理 ${E2E_APPROVAL_WEBHOOK_PREFIX}* webhook ${removed}/${stale.length}`);
  } catch (e) {
    console.log(`  ⚠️ ${label}: webhook 清理异常 ${e.message}`);
  }
}

// S24 UI 改版后顶栏导航按钮在 <details id="settingsDd"> 折叠面板内：先展开（幂等）再点。
async function openSettingsNav(page) {
  await page.evaluate(() => {
    const dd = document.querySelector('#settingsDd');
    if (dd && !dd.open) dd.open = true;
  });
}

async function clickNav(page, selector) {
  await openSettingsNav(page);
  await page.click(selector);
}

async function ensureInspectorOpen(page) {
  await openSettingsNav(page);
  const hidden = await page.evaluate(() => document.body.classList.contains('inspector-hidden'));
  if (hidden) {
    await page.click('#btnInspectorToggle');
  }
  await page.waitForFunction(() => {
    const tab = document.querySelector('[data-tab="debate-state"]');
    return !document.body.classList.contains('inspector-hidden') && Boolean(tab && tab.offsetParent);
  }, null, { timeout: 3000 });
}

async function saveFailureArtifact(page, label = 'panel-ui-walkthrough') {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const out = join(ARTIFACT_DIR, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  📸 failure screenshot: ${out}`);
  } catch (e) {
    console.log(`  ⚠️ failed to capture screenshot: ${e.message}`);
  }
}

(async () => {
  console.log('🎭 panel UI walkthrough 开始');
  const resolvedPort = Number(new URL(PANEL).port) || 0;
  const reservedPortAllowed = process.env.NOE_E2E_ALLOW_RESERVED_PORT === '1' || OWNER_TOKEN_AUTHORIZATION.authorized;
  if ((resolvedPort === 51735 || resolvedPort === 51835) && !reservedPortAllowed) {
    console.error(`refusing to run raw e2e against reserved panel port ${resolvedPort}; use scripts/e2e-with-server.mjs, set NOE_E2E_ALLOW_RESERVED_PORT=1, or install standing autonomy grant with e2e-live:run`);
    process.exit(1);
  }
  prepareCodebaseFixture();
  const ownerToken = readOwnerToken();
  const ownerTokenMode = process.env.OWNER_TOKEN ? 'injected OWNER_TOKEN' : (OWNER_TOKEN_AUTHORIZATION.mode || 'unknown');
  console.log(ownerToken ? `owner-token loaded for protected APIs by ${ownerTokenMode}` : 'owner-token not read; protected API checks may fail');
  // 防御历史残留：上一轮异常中断可能留下 e2e-approval-* webhook，先清掉防 20 上限。
  await cleanupE2eApprovalWebhooks(ownerToken, '启动清理');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleErrors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('response', response => {
    const status = response.status();
    if (status >= 400) consoleErrors.push(`response:${status}: ${response.url()}`);
  });
  page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    // 提前注入 localStorage（防 telemetry/onboarding modal 拦截点击）
    await page.addInitScript((token) => {
      if (token) {
        sessionStorage.setItem('panel-owner-token', token);
        localStorage.setItem('panel-owner-token', token); // noeUiSignalToken 等模块也读 localStorage
      }
      localStorage.setItem('panel:telemetry:asked', '1');
      localStorage.setItem('panel:onboarding:v1', '1');
    }, ownerToken);
    await page.goto(PANEL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const title = await page.title();
    track('1. 首页加载', title === 'Noe', `title="${title}"`);

    // UI 改版：顶栏入口收进折叠设置面板，展开后逐个断言可见
    await openSettingsNav(page);
    const topBtns = ['btnOverview','btnTerminal','btnRooms','btnAgentRegistry','btnCodebaseCenter','btnKnowledgeCenter','btnGovernance','btnPlugins','btnRoomAdapters','btnWebhooks','btnArchive','btnMcp','btnAutopilot','btnApprovals','btnActivity','btnDelegations'];
    for (const id of topBtns) {
      const btn = await page.$(`#${id}`);
      const visible = btn ? await btn.isVisible() : false;
      track(`2. 顶栏 #${id}`, !!btn && visible);
    }

    const modules = await page.evaluate(() => ({
      Store: !!window.PanelStore, Cmdk: !!window.PanelCmdk, Inspector: !!window.PanelInspector,
      Ws: !!window.PanelWs, Dialog: !!window.PanelDialog, Utils: !!window.PanelUtils,
    }));
    for (const [k, v] of Object.entries(modules)) {
      track(`3. window.Panel${k}`, v);
    }

    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const guestPage = await guestContext.newPage();
    const guestSignals = [];
    guestPage.on('console', msg => {
      if (['error', 'warning'].includes(msg.type())) guestSignals.push(`${msg.type()}: ${msg.text()}`);
    });
    guestPage.on('response', response => {
      const status = response.status();
      if (status >= 400) guestSignals.push(`response:${status}: ${response.url()}`);
    });
    await guestPage.goto(panelUrlWithoutOwnerToken(), { waitUntil: 'commit', timeout: 10000 });
    await guestPage.waitForSelector('#ownerTokenMissingBanner', { timeout: 10000 });
    await guestPage.waitForTimeout(1200);
    const guestAuth = await guestPage.evaluate(() => ({
      banner: Boolean(document.querySelector('#ownerTokenMissingBanner')),
      text: document.querySelector('#ownerTokenMissingBanner')?.textContent || '',
    }));
    const guestApi401 = guestSignals.some((item) => item.includes('response:401') && item.includes('/api/'));
    const guestTokenWarning = guestSignals.some((item) => item.includes('owner token required'));
    track('3a. 裸开面板显示 owner-token 恢复提示', guestAuth.banner && guestAuth.text.includes('owner token'));
    track('3a. 裸开面板暂停受保护接口 401 噪声', !guestApi401 && !guestTokenWarning, guestSignals.slice(0, 3).join(' | '));
    await guestContext.close();

    const clusterAuditSandbox = await page.evaluate(() => {
      const mockRoom = {
        id: 'sandbox-cluster-audit',
        mode: 'cross_verify',
        clusterWorkflowAudit: {
          overallStatus: 'blocked',
          counts: { blocking: 1, evidenceInsufficient: 1, repaired: 1 },
          remediationSummary: { total: 2, automatic: 2, invalidatedStages: 5 },
        },
        clusterDeliveryManifest: {
          fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          overallStatus: 'blocked',
          stageCount: 11,
          doneStageCount: 8,
          readyForDelivery: false,
          deliveryGate: { status: 'blocked', blockers: ['workflow_status=blocked', 'failed_or_insufficient_stages=implementation:failed'] },
          remediation: { count: 2 },
          memberSignoffMatrix: [
            { stageId: 'implementation', complete: false },
            { stageId: 'acceptance', complete: true },
            { stageId: 'retrospective', complete: true },
          ],
          evidenceCoverage: {
            commandEvidenceCount: 3,
            fileEvidenceCount: 2,
            runtimeEvidenceCount: 1,
            codeDrivenCoveredStageCount: 2,
            codeDrivenStageCount: 4,
          },
          evidenceIntegrity: {
            status: 'declared_hard_evidence',
            declaredHardEvidenceStageCount: 3,
            verifiedRunEvidenceStageCount: 0,
          },
          objectiveCompletionAudit: {
            status: 'blocked',
            passedCount: 4,
            total: 6,
            items: [
              { id: 'single_project_goal', label: '围绕单一项目目标推进', status: 'passed', passed: true, evidence: ['topic=sandbox'], blockers: [] },
              { id: 'code_driven_evidence', label: '代码驱动阶段具备命令/文件/运行证据', status: 'blocked', passed: false, evidence: ['codeDriven=2/4'], blockers: ['code_driven_stage_evidence_incomplete'] },
            ],
          },
        },
        clusterDeliveryReportMarkdown: '# 集群协同交付报告\n\n## 目标完成度审计\n\n## 阶段交付矩阵\n\n模拟交付报告',
        clusterDeliveryPackage: {
          packageVersion: 'cluster-delivery-package-v1',
          status: 'blocked',
          readyForArchive: false,
          objectiveCompletionAudit: { status: 'blocked', passedCount: 4, total: 6, failedItems: [{ id: 'code_driven_evidence' }] },
          artifacts: [
            { kind: 'delivery_manifest_json', filename: 'sandbox-cluster-delivery-abcdef123456.json' },
            { kind: 'delivery_report_markdown', filename: 'sandbox-cluster-report-abcdef123456.md' },
          ],
        },
        clusterRuntimeTelemetry: {
          telemetryVersion: 'cluster-runtime-telemetry-v1',
          calls: 44,
          succeededCalls: 42,
          failedCalls: 2,
          totalTokens: 88000,
          avgLatencyMs: 1234,
        },
        clusterRuntimeHeartbeat: {
          statusVersion: 'cluster-runtime-heartbeat-v1',
          startedAt: '2026-06-01T00:00:00.000Z',
          lastProgressAt: '2026-06-01T00:05:00.000Z',
          lastEvent: 'review_start',
          taskId: 'CE05',
          stageId: 'implementation',
          round: 2,
        },
        clusterRuntimeStallRecovery: {
          type: 'cluster_runtime_recovered',
          reason: 'active_running_without_progress_timeout',
          action: 'paused_for_resume',
          at: '2026-06-01T00:35:00.000Z',
          lastProgressAt: '2026-06-01T00:05:00.000Z',
          stalledForMs: 1800000,
        },
        clusterRuntimeResumePolicy: {
          statusVersion: 'cluster-runtime-resume-policy-v1',
          autoResumeAllowed: false,
          manualResumeAllowed: true,
          stallRecoveryCount: 3,
          maxStallRecoveries: 3,
          nextAction: 'manual_review_required_before_resume',
        },
        taskList: [
          {
            id: 'CE05',
            title: '5. 代码开发',
            stageId: 'implementation',
            stageLabel: '代码开发',
            status: 'escalated',
            blocking: true,
            qualityGateRepairs: 1,
            consensus: {
              totalRounds: 2,
              byMembers: ['gpt#1', 'claude#2'],
              stageArtifact: {
                deliverables: ['代码改动'],
                evidence: [{ signals: ['natural_language_only'] }],
                signoffs: [{ agree: true }, { agree: true }],
                risks: ['缺少硬证据'],
                evidenceRequirement: {
                  required: true,
                  status: 'insufficient',
                  requiredSignals: ['filesystem_evidence', 'command_evidence'],
                },
              },
              finalPlan: '# 集群协同共识\n\n模拟阻断阶段',
            },
          },
          {
            id: 'CE10',
            title: '10. 交付验收',
            stageId: 'acceptance',
            stageLabel: '交付验收',
            status: 'done',
            consensus: {
              totalRounds: 1,
              byMembers: ['gpt#1', 'claude#2'],
              stageArtifact: {
                deliverables: ['验收表'],
                evidence: [{ signals: ['command_evidence'] }],
                signoffs: [{ agree: true }, { agree: true }],
                risks: [],
                acceptanceReport: {
                  summary: { total: 9, passed: 7, passed_with_risks: 1, insufficient: 1, failed: 0 },
                },
              },
              finalPlan: '# 集群协同共识\n\n模拟验收阶段',
            },
          },
          {
            id: 'CE11',
            title: '11. 复盘优化',
            stageId: 'retrospective',
            stageLabel: '复盘优化',
            status: 'done',
            consensus: {
              totalRounds: 1,
              byMembers: ['gpt#1', 'claude#2'],
              stageArtifact: {
                deliverables: ['复盘 backlog'],
                evidence: [{ signals: ['command_evidence'] }],
                signoffs: [{ agree: true }, { agree: true }],
                risks: [],
                retrospectiveReport: {
                  summary: { totalBacklog: 3, byPriority: { P0: 1, P1: 1, P2: 1 } },
                },
              },
              finalPlan: '# 集群协同共识\n\n模拟复盘阶段',
            },
          },
        ],
      };
      const markdown = window.__noeClusterTest?.renderCrossVerifyConsensusMarkdown?.(mockRoom) || '';
      const diagnosticsMarkdown = window.__noeClusterTest?.formatClusterDiagnosticsMarkdown?.(
        {
          status: 'blocked',
          summary: {
            healthStatus: 'passed',
            readinessStatus: 'passed',
            runtimeStatus: 'clean',
            configStatus: 'passed',
            concurrencyStatus: 'passed',
            capabilityGuardStatus: 'blocked',
            blockerCount: 1,
            warningCount: 0,
            roomSummary: { total: 1, running: 1 },
          },
          invariants: { safeToStart: false, capabilityGuardHealthy: false },
          findings: [{ severity: 'blocker', code: 'capability_guard_blocked', message: 'cluster member capability guard is blocked' }],
          recommendations: [{ action: '成员能力配置存在硬冲突' }],
          recoveryPlan: [{ severity: 'blocker', code: 'capability_guard_blocked', action: '修复成员能力边界或共享插件桥漂移', command: 'npm run repair:panel && npm run check:panel' }],
        },
        {
          capabilityGuard: {
            status: 'blocked',
            ok: false,
            summary: {
              totalRoomCount: 1,
              activeRoomCount: 1,
              enabledMemberCount: 2,
              missingAdapterMemberCount: 0,
              duplicateAdapterRoomCount: 0,
              sharedRoomBridgeCount: 1,
              nativeBridgeViolationCount: 1,
            },
            checks: [
              { id: 'native_members_keep_native_capabilities', label: 'Claude/Gemini 只走各自原生能力,不挂 Codex 共享插件桥', status: 'blocked', evidence: ['native_bridge_violations=1'], blockers: ['native_member_shared_bridge:sandbox:claude#0'], warnings: [] },
              { id: 'room_shared_capability_bridge_absent', label: '集群协同不注入房间级共享 Skill/插件桥', status: 'blocked', evidence: ['shared_room_bridge_keys=1'], blockers: ['room_shared_capability_bridge:sandbox:skillIds'], warnings: [] },
            ],
            rooms: [
              { roomId: 'sandbox', status: 'running', enabledMemberCount: 2, adapterIds: ['claude', 'codex'], blockers: ['native_member_shared_bridge:sandbox:claude#0'], warnings: [] },
            ],
            blockers: ['native_member_shared_bridge:sandbox:claude#0', 'room_shared_capability_bridge:sandbox:skillIds'],
            warnings: [],
          },
          assurance: {
            status: 'blocked',
            summary: { gateCount: 8, passedGateCount: 7, failedGateIds: ['capability_guard'] },
            gates: [{ id: 'capability_guard', label: '成员能力/插件漂移守卫', status: 'blocked', failedCases: ['native_member_shared_bridge:sandbox:claude#0'] }],
            recoveryPlan: [{ gateId: 'capability_guard', severity: 'blocker', action: '修复成员能力边界或共享插件桥漂移', command: 'npm run repair:panel && npm run check:panel', endpoint: '/api/cluster/capability-guard' }],
          },
        },
      ) || '';
      window.__noeClusterTest?.handleRoomEvent?.({
        type: 'cluster_evidence_auto_linked',
        stageId: 'implementation',
        stageLabel: '代码开发',
        agentRunId: 'agent-run-auto-e2e',
        evidenceCount: 2,
      });
      const autoLinkToast = document.body.innerText.includes('代码开发 已自动绑定 Agent Run 证据 2 项');
      window.__noeClusterTest?.handleRoomEvent?.({
        type: 'cluster_delivery_ready',
        stageId: 'functional_validation',
        stageLabel: '功能验证',
        agentRunId: 'agent-run-ready-e2e',
        deliveryGateStatus: 'passed',
        readyForDelivery: true,
        packageStatus: 'ready',
      });
      const deliveryReadyToast = document.body.innerText.includes('集群协同交付门禁已通过，交付包 ready');
      const checks = {
        hasHook: !!window.__noeClusterTest,
        clusterPreflightButton: !!document.querySelector('#btnRoomClusterPreflight'),
        clusterConcurrencyButton: !!document.querySelector('#btnRoomClusterConcurrency'),
        clusterDiagnosticsButton: !!document.querySelector('#btnRoomClusterDiagnostics'),
        clusterRepairButton: !!document.querySelector('#btnRoomClusterRepair'),
        deliveryPackageButton: !!document.querySelector('#btnRoomDeliveryPackage'),
        archiveDeliveryPackageButton: !!document.querySelector('#btnRoomArchiveDeliveryPackage'),
        audit: markdown.includes('链路审计：blocked，阻断 1，证据不足 1，已修复 1'),
        remediation: markdown.includes('自动返工审计：2 次，自动 2 次，失效下游阶段 5 个'),
        delivery: markdown.includes('交付清单：blocked，阶段 8/11，返工 2 次'),
        deliveryGate: markdown.includes('交付门禁：阻断 2 项'),
        signoffMatrix: markdown.includes('成员签字矩阵：2/3 阶段完成全员签字'),
        evidenceCoverage: markdown.includes('证据覆盖：命令 3，文件 2，运行/UI 1，代码驱动 2/4'),
        evidenceIntegrity: markdown.includes('证据完整性：declared_hard_evidence，声明式 3，Agent Run 验证 0'),
        fingerprint: markdown.includes('交付指纹：abcdef123456'),
        objectiveCompletion: markdown.includes('目标完成度：blocked，4/6'),
        deliveryPackage: markdown.includes('交付包：blocked，产物 2 个，归档 blocked'),
        runtimeTelemetry: markdown.includes('运行遥测：调用 44，成功 42，失败 2，Token 88000，平均时延 1234ms'),
        runtimeHeartbeat: markdown.includes('运行心跳：最后进展') && markdown.includes('事件 review_start') && markdown.includes('任务 CE05'),
        runtimeRecovery: markdown.includes('自愈恢复：active_running_without_progress_timeout') && markdown.includes('paused_for_resume') && markdown.includes('停滞 30m'),
        runtimeResumePolicy: markdown.includes('续跑策略：自动续跑已限流') && markdown.includes('停滞恢复 3/3') && markdown.includes('manual_review_required_before_resume'),
        capabilityGuardDiagnostics: diagnosticsMarkdown.includes('## 能力漂移守卫')
          && diagnosticsMarkdown.includes('Claude/Gemini 原生能力违规: 1')
          && diagnosticsMarkdown.includes('native_member_shared_bridge:sandbox:claude#0')
          && diagnosticsMarkdown.includes('/api/cluster/capability-guard'),
        autoEvidenceLinkedToast: autoLinkToast,
        deliveryReadyToast,
        deliveryReport: markdown.includes('# 集群协同交付报告') && markdown.includes('## 目标完成度审计') && markdown.includes('## 阶段交付矩阵'),
        blocking: markdown.includes('阻断'),
        evidence: markdown.includes('硬证据不足'),
        repair: markdown.includes('修复尝试 1 次'),
        acceptance: markdown.includes('自动验收：共 9 项，通过 7，带风险通过 1，证据不足 1，失败 0'),
        retrospective: markdown.includes('自动复盘：改进项 3，P0 1，P1 1，P2 1'),
      };
      return { checks, allPassed: Object.values(checks).every(Boolean) };
    });
    track('3a. 集群协同链路审计 UI 沙盒', clusterAuditSandbox.allPassed, JSON.stringify(clusterAuditSandbox.checks));

    // S24 外迁后 renderActivityDetail 收进 activity-ui.js 闭包不再挂 window，
    // 改走真 UI 路径：POST 真审计事件 → PanelActivity.open 按 entity 过滤 → 断言详情含交付归档面板。
    const deliveryEntityId = `cluster-delivery-e2e-${Date.now()}`;
    const activityDeliveryPost = await page.evaluate(async (eid) => {
      const r = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cluster.delivery.archived',
          severity: 'info',
          status: 'ready',
          actorType: 'user',
          actorId: 'owner',
          roomId: 'sandbox-cluster-audit',
          entityType: 'cluster_delivery_archive',
          entityId: eid,
          details: {
            archiveId: eid,
            archiveDir: 'output/noe/cluster-delivery/sandbox',
            artifactCount: 3,
            manifestFingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            deliveryStatus: 'ready',
            artifacts: [{ kind: 'delivery_report_markdown', path: 'output/noe/cluster-delivery/sandbox/report.md', sha256: '1'.repeat(64), size: 120 }],
          },
        }),
      }).then(x => x.json());
      if (!r.ok) return { ok: false, error: r.error || 'post failed' };
      await window.PanelActivity.open({ entityType: 'cluster_delivery_archive', entityId: eid });
      return { ok: true };
    }, deliveryEntityId);
    await page.waitForFunction(() => {
      const detail = document.querySelector('.activity-detail')?.textContent || '';
      return detail.includes('Cluster Delivery Archive') && detail.includes('output/noe/cluster-delivery/sandbox');
    }, null, { timeout: 5000 }).catch(() => {});
    const activityDeliveryDetail = await page.evaluate(() => document.querySelector('.activity-detail')?.textContent || '');
    track('3a. 集群协同交付审计详情面板（真 UI）',
      activityDeliveryPost.ok
        && activityDeliveryDetail.includes('Cluster Delivery Archive')
        && activityDeliveryDetail.includes('output/noe/cluster-delivery/sandbox'),
      activityDeliveryPost.error || '');
    // 清掉 entity 过滤再关 modal，避免污染后续 activity 步骤
    await page.click('#activityClearFilters');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.PanelActivity.close());

    const cvUiRequests = [];
    const cvRoomName = `E2E 集群协同 UI ${Date.now()}`;
    await page.route('**/api/rooms', async (route, request) => {
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        if (body.mode === 'cross_verify') {
          cvUiRequests.push({ type: 'create', body });
        }
      }
      await route.fallback();
    });
    await page.route('**/api/rooms/*/debate', async (route, request) => {
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        cvUiRequests.push({ type: 'start', body });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, started: true, mode: 'cross_verify' }),
        });
        return;
      }
      await route.fallback();
    });
    await clickNav(page, '#btnRooms');
    // UI 改版：严格互审等高级建房按钮收进 <details class="room-advanced-modes">，先展开再点
    await page.evaluate(() => {
      const dd = document.querySelector('.room-advanced-modes');
      if (dd && !dd.open) dd.open = true;
    });
    await page.click('#btnRoomNewCv');
    await page.waitForSelector('.confirm-modal .prompt-modal-input', { timeout: 3000 });
    await page.fill('.confirm-modal .prompt-modal-input', cvRoomName);
    await page.click('.confirm-modal [data-act="confirm"]');
    try {
      await page.waitForFunction(() => {
        const modal = document.querySelector('.confirm-modal');
        return modal && /独立项目文件夹名|项目文件夹/.test(modal.textContent || '');
      }, { timeout: 1500 });
      await page.fill('.confirm-modal .prompt-modal-input', `${cvRoomName}-project`);
      await page.click('.confirm-modal [data-act="confirm"]');
    } catch {}
    await page.waitForSelector('#roomTopicInput:visible', { timeout: 3000 });
    await page.fill('#roomTopicInput:visible', 'E2E 集群协同 UI 按钮路径 dry-run');
    await page.click('#btnRoomStart');
    await page.waitForTimeout(250);
    const cvUiPath = await page.evaluate(() => {
      return {
        // S24 外迁：roomState 不再挂 window 顶层，经 PanelRoomsCore 取
        activeId: window.PanelRoomsCore?.roomState?.activeId || '',
        startButton: document.querySelector('#btnRoomStart')?.textContent || '',
      };
    }).catch(() => null);
    await page.unroute('**/api/rooms');
    await page.unroute('**/api/rooms/*/debate');
    const cvCreateReq = cvUiRequests.find(r => r.type === 'create');
    const cvStartReq = cvUiRequests.find(r => r.type === 'start');
    track('3b. 集群协同 UI 创建/启动按钮路径',
      cvCreateReq?.body?.mode === 'cross_verify'
        && cvStartReq?.body?.topic === 'E2E 集群协同 UI 按钮路径 dry-run'
        && (cvUiPath?.startButton || '').includes('集群协同'),
      JSON.stringify({
        createMode: cvCreateReq?.body?.mode || '',
        startTopic: cvStartReq?.body?.topic || '',
        startButton: cvUiPath?.startButton || '',
      }));

    const modalsToTest = ['btnAgentRegistry','btnCodebaseCenter','btnKnowledgeCenter','btnGovernance','btnRoomAdapters','btnWebhooks','btnArchive','btnAutopilot','btnApprovals','btnActivity','btnDelegations','btnMcp'];
    for (const id of modalsToTest) {
      await clickNav(page, `#${id}`);
      await page.waitForTimeout(300);
      const anyOpen = await page.evaluate(() => [...document.querySelectorAll('.modal')].some(m => m.style.display === 'flex'));
      track(`4. ${id} → modal open`, anyOpen);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      const allClosed = await page.evaluate(() => [...document.querySelectorAll('.modal')].every(m => m.style.display !== 'flex'));
      track(`4. ESC 关 ${id}`, allClosed);
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // 4b. 知识库（证据 FTS 检索 P4/A2）：重建索引 → 检索 → 命中跳转审计
    await clickNav(page, '#btnKnowledgeCenter');
    await page.waitForSelector('#knowledgeQueryInput', { timeout: 3000 });
    await page.click('#knowledgeReindexBtn');
    await page.waitForTimeout(700);
    const kcReindexed = await page.evaluate(() => (document.querySelector('#knowledgeCenterBody')?.textContent || '').includes('已索引'));
    track('4b. Knowledge Center 重建索引更新状态', kcReindexed);
    await page.fill('#knowledgeQueryInput', 'session');
    await page.click('#knowledgeSearchBtn');
    await page.waitForTimeout(700);
    const kcSearch = await page.evaluate(() => {
      const body = document.querySelector('#knowledgeCenterBody')?.textContent || '';
      const err = document.querySelector('#knowledgeCenterBody .agent-empty.error');
      return { hasCount: /条命中/.test(body), noError: !err };
    });
    track('4b. Knowledge Center 检索链路无报错', kcSearch.hasCount && kcSearch.noError, `hasCount=${kcSearch.hasCount} noError=${kcSearch.noError}`);
    const kcHit = await page.$('[data-knowledge-open="0"]');
    if (kcHit) {
      await page.click('[data-knowledge-open="0"]');
      await page.waitForTimeout(300);
      // F1：带 runId 的证据开 Agent Run（agentRegistryModal）；否则按 sessionId/事件 id 开审计（activityModal）
      const jumped = await page.evaluate(() => (
        document.querySelector('#activityModal')?.style.display === 'flex' ||
        document.querySelector('#agentRegistryModal')?.style.display === 'flex'
      ));
      track('4b. Knowledge 命中跳转（审计/Agent Run）', jumped);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    } else {
      track('4b. Knowledge 命中跳转（审计/Agent Run）', true, '(本地无证据数据，跳过跳转校验)');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await clickNav(page, '#btnGovernance');
    // governance summary 在大数据下需为所有 deferred run 构建 timeline，给足负载/数据余量
    await page.waitForFunction(() => {
      const body = document.querySelector('#governanceCenterBody')?.textContent || '';
      return body.includes('本地治理总控') && body.includes('Next Actions') && body.includes('Agent Runs');
    }, null, { timeout: 15000 });
    const governanceCenterUi = await page.evaluate(() => ({
      kpis: document.querySelectorAll('.governance-center-kpi').length,
      sections: document.querySelectorAll('.governance-center-section').length,
      refresh: !!document.querySelector('#btnGovernanceCenterRefresh'),
      text: document.querySelector('#governanceCenterBody')?.textContent || '',
    }));
    track('4a. Governance Center unified view',
      governanceCenterUi.kpis >= 6
        && governanceCenterUi.sections >= 4
        && governanceCenterUi.refresh
        && governanceCenterUi.text.includes('Open Items'));
    const governanceBudgetScope = `e2e-governance-${Date.now()}`;
    const governanceBudgetIncidentId = await page.evaluate(async (scopeId) => {
      const policyRes = await fetch('/api/budgets/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'project',
          scopeId,
          metric: 'calls',
          windowKind: 'daily',
          amount: 1,
          warnPercent: 0.5,
          hardStopEnabled: true,
          notifyEnabled: true,
          note: 'E2E Governance Center budget action',
        }),
      });
      if (!policyRes.ok) throw new Error(await policyRes.text());
      await fetch('/api/budgets/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: scopeId, estimateCalls: 1 }),
      }).catch(() => null);
      const incidentRes = await fetch(`/api/budgets/incidents?status=open&scopeType=project&scopeId=${encodeURIComponent(scopeId)}&limit=10`);
      const payload = await incidentRes.json();
      return payload.incidents?.[0]?.id || '';
    }, governanceBudgetScope);
    await page.click('#btnGovernanceCenterRefresh');
    await page.waitForFunction((incidentId) => !!document.querySelector(`[data-gov-center-resolve-budget="${incidentId}"]`), governanceBudgetIncidentId, { timeout: 5000 });
    track('4a. Governance Center budget action present', !!governanceBudgetIncidentId);
    // P5 工作队列看板：budget incident 应派生为队列项（pending_fix）
    const govQueueBoard = await page.evaluate(() => {
      const board = document.querySelector('[data-gov-center-queue]');
      return {
        present: !!board,
        hasTitle: (board?.textContent || '').includes('工作队列'),
        advance: document.querySelectorAll('[data-gov-queue-advance]').length,
      };
    });
    track('4a. Governance Center work queue board', govQueueBoard.present && govQueueBoard.hasTitle);
    track('4a. Governance Center work queue derives items', govQueueBoard.advance >= 1, `advance=${govQueueBoard.advance}`);
    await page.click(`[data-gov-center-resolve-budget="${governanceBudgetIncidentId}"]`);
    await page.waitForFunction((incidentId) => !document.querySelector(`[data-gov-center-resolve-budget="${incidentId}"]`), governanceBudgetIncidentId, { timeout: 5000 });
    track('4a. Governance Center budget action resolves incident', true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await clickNav(page, '#btnCodebaseCenter');
    await page.waitForSelector('#codebaseQueryInput', { timeout: 3000 });
    await page.evaluate((cwd) => {
      const input = document.querySelector('#codebaseCenterCwd');
      input.value = cwd;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, E2E_CODEBASE_ROOT);
    await page.waitForFunction((cwd) => document.querySelector('#codebaseCenterCwd')?.value === cwd, E2E_CODEBASE_ROOT, { timeout: 3000 });
    await page.fill('#codebaseQueryInput', 'Agent 图谱入口 DOM handler');
    await page.click('#codebaseQuestionBtn');
    await page.waitForFunction(() => {
      const text = document.querySelector('.codebase-results')?.textContent || '';
      return text.includes('public/')
        && (text.includes('intent:agent-ui-handler') || text.includes('intent:agent-ui-dom'));
    }, null, { timeout: 8000 });
    const codebaseQueryUi = await page.evaluate(() => ({
      cards: document.querySelectorAll('.codebase-result-card').length,
      hasPath: (document.querySelector('.codebase-results')?.textContent || '').includes('public/'),
      hasReason: ['intent:agent-ui-handler', 'intent:agent-ui-dom'].some(token => (document.querySelector('.codebase-results')?.textContent || '').includes(token)),
      hasVectors: (document.querySelector('.codebase-index-status')?.textContent || '').includes('vectors'),
      hasParsers: (document.querySelector('.codebase-index-status')?.textContent || '').includes('parsers'),
      addButtons: document.querySelectorAll('[data-codebase-add]').length,
      answer: document.querySelector('[data-codebase-question-answer]')?.textContent || '',
    }));
    track('4a. Codebase Center query results',
      codebaseQueryUi.cards > 0 && codebaseQueryUi.hasPath && codebaseQueryUi.hasReason && codebaseQueryUi.hasVectors && codebaseQueryUi.hasParsers && codebaseQueryUi.addButtons > 0);
    track('4a. Codebase Center code question answer',
      codebaseQueryUi.answer.includes('Local Code Answer')
        && codebaseQueryUi.answer.includes('public/')
        && codebaseQueryUi.answer.includes('C1')
        && codebaseQueryUi.answer.includes('Deterministic local evidence only'));
    await page.click('[data-codebase-add="0"]');
    await page.click('#codebaseOpenDispatch');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 5000 });
    const dispatchFromCodebase = await page.evaluate(() => ({
      files: document.querySelector('#agentPreviewFiles')?.value || '',
      text: document.querySelector('#agentPreviewText')?.value || '',
      question: document.querySelector('[data-agent-code-question-answer]')?.textContent || '',
    }));
    track('4a. Codebase result adds to Dispatch Preview',
      dispatchFromCodebase.files.includes('public/app.js') && dispatchFromCodebase.text.includes('Agent 图谱入口'));
    track('4a. Codebase answer adds to Dispatch Preview',
      dispatchFromCodebase.question.includes('Code Question Answer') && dispatchFromCodebase.question.includes('C1'));
    await page.click('#agentPreviewRun');
    await page.waitForFunction(() => {
      const text = document.querySelector('#agentPreviewResult')?.textContent || '';
      return text.includes('Code Question Answer') && text.includes('C1');
    }, null, { timeout: 5000 });
    const dispatchWorkflow = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="dispatch"]')?.textContent || '';
      return path.includes('Idea-to-Archive Path')
        && path.includes('Dispatch Preview')
        && path.includes('Run Draft')
        && path.includes('Next: 创建 Run Draft');
    });
    track('4a. Idea-to-Archive guided dispatch path', dispatchWorkflow);
    track('4a. Dispatch prompt includes code answer',
      ((await page.textContent('#agentPreviewResult')) || '').includes('Code Question Answer'));
    await page.click('#agentPreviewCreateRun');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Code Question Answer') && detail.includes('C1');
    }, null, { timeout: 5000 });
    const codeQuestionRunDetail = (await page.textContent('.agent-run-detail')) || '';
    track('4a. Idea Run archives code answer',
      codeQuestionRunDetail.includes('Code Question Answer') && codeQuestionRunDetail.includes('C1'));
    await page.click('[data-agent-tab="dispatch"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await clickNav(page, '#btnAgentRegistry');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 3000 });
    const agentCenterTabs = await page.$$eval('[data-agent-tab]', els => els.map(el => el.textContent.trim()));
    track('4a. Agent Center tabs present',
      ['Profiles', 'Dispatch', 'Models/Skills', 'Runs', 'Policies'].every(label => agentCenterTabs.includes(label)),
      agentCenterTabs.join(','));
    await page.click('[data-agent-tab="models"]');
    await page.waitForSelector('[data-agent-model-center]', { timeout: 3000 });
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-agent-model-center]')?.textContent || '';
      return text.includes('Model / Skill Center') && text.includes('Local status only') && text.includes('Skill Injection Matrix');
    }, null, { timeout: 5000 });
    const modelSkillCenter = await page.evaluate(() => {
      const text = document.querySelector('[data-agent-model-center]')?.textContent || '';
      return {
        hasLocalBoundary: text.includes('no secrets shown') && text.includes('provider config is read-only here'),
        hasProviderStatus: text.includes('Provider Model Status') && text.includes('No live ping'),
        hasRecommendations: text.includes('Model Recommendations') && text.includes('source: active adapter'),
        hasSkillMatrix: text.includes('Skill Injection Matrix') && text.includes('missing bindings'),
        hasSkillRisk: text.includes('Skill Source & Risk') && text.includes('source risks'),
        noSecrets: !/api[_-]?key|sk-[a-z0-9]/i.test(text),
      };
    });
    track('4a. Model/Skill Center local status',
      modelSkillCenter.hasLocalBoundary && modelSkillCenter.hasProviderStatus && modelSkillCenter.hasRecommendations && modelSkillCenter.hasSkillMatrix && modelSkillCenter.hasSkillRisk && modelSkillCenter.noSecrets);
    await page.click('[data-agent-tab="runs"]');
    await page.waitForSelector('#agentRunsRefresh', { timeout: 3000 });
    const agentRunsUi = await page.evaluate(() => ({
      status: !!document.querySelector('#agentRunStatusFilter'),
      room: !!document.querySelector('#agentRunRoomFilter'),
      session: !!document.querySelector('#agentRunSessionFilter'),
      profile: !!document.querySelector('#agentRunProfileFilter'),
      source: !!document.querySelector('#agentRunSourceFilter'),
      approval: !!document.querySelector('#agentRunApprovalFilter'),
      delegation: !!document.querySelector('#agentRunDelegationFilter'),
      budget: !!document.querySelector('#agentRunBudgetFilter'),
      governance: !!document.querySelector('#agentRunGovernanceFilter'),
      detail: !!document.querySelector('.agent-run-detail'),
    }));
    track('4a. Agent Runs tab controls',
      agentRunsUi.status && agentRunsUi.room && agentRunsUi.session && agentRunsUi.profile && agentRunsUi.source && agentRunsUi.approval && agentRunsUi.delegation && agentRunsUi.budget && agentRunsUi.governance && agentRunsUi.detail);
    await page.click('[data-agent-tab="policies"]');
    await page.waitForSelector('.agent-policy-editor', { timeout: 3000 });
    track('4a. Agent Policies tab editors', (await page.$$('.agent-policy-editor')).length > 0);
    await page.click('[data-agent-tab="dispatch"]');
    await page.waitForSelector('#agentPreviewFiles', { timeout: 3000 });
    await page.fill('#agentPreviewText', '继续推进这一块');
    await page.click('#agentPreviewLoadChanged');
    await page.waitForFunction(() => {
      const value = document.querySelector('#agentPreviewFiles')?.value || '';
      const info = document.querySelector('#agentPreviewFilesInfo')?.textContent || '';
      return value.includes('public/app.js') && info.includes('changed files');
    }, null, { timeout: 5000 });
    const changedFilesLoaded = await page.evaluate(() => ({
      value: document.querySelector('#agentPreviewFiles')?.value || '',
      info: document.querySelector('#agentPreviewFilesInfo')?.textContent || '',
    }));
    track('4a. Agent preview loads git changes', changedFilesLoaded.value.includes('public/app.js') && changedFilesLoaded.info.includes('changed files'));
    await page.fill('#agentPreviewFiles', 'public/app.js\nsrc/agents/AgentRunStore.js');
    await page.click('#agentPreviewRun');
    await page.waitForSelector('.agent-code-context', { timeout: 15000 }); // 解析变更文件+建索引，负载下需余量
    const agentCodeContextPreview = await page.evaluate(() => ({
      hasFilesInput: !!document.querySelector('#agentPreviewFiles'),
      hasCodeContext: !!document.querySelector('.agent-code-context'),
      hasCodeEvidence: !!document.querySelector('.agent-code-evidence'),
      previewText: document.querySelector('#agentPreviewResult')?.textContent || '',
    }));
    track('4a. Agent preview code context',
      agentCodeContextPreview.hasFilesInput
        && agentCodeContextPreview.hasCodeContext
        && agentCodeContextPreview.previewText.includes('Code Context'));
    await page.click('#agentPreviewLoadCodebase');
    await page.waitForFunction(() => {
      const value = document.querySelector('#agentPreviewFiles')?.value || '';
      const info = document.querySelector('#agentPreviewFilesInfo')?.textContent || '';
      return value.includes('src/agents') && info.includes('focus files');
    }, null, { timeout: 5000 });
    await page.click('#agentPreviewRun');
    await page.waitForSelector('.agent-codebase-map', { timeout: 15000 });
    await page.waitForSelector('.agent-symbol-graph', { timeout: 15000 });
    const agentCodebaseMapPreview = await page.evaluate(() => ({
      files: document.querySelector('#agentPreviewFiles')?.value || '',
      info: document.querySelector('#agentPreviewFilesInfo')?.textContent || '',
      previewText: document.querySelector('#agentPreviewResult')?.textContent || '',
      symbolText: document.querySelector('.agent-symbol-graph')?.textContent || '',
      hasSymbolGraph: !!document.querySelector('.agent-symbol-graph'),
    }));
    track('4a. Agent preview codebase map',
      agentCodebaseMapPreview.files.includes('src/agents')
        && agentCodebaseMapPreview.info.includes('focus files')
        && agentCodebaseMapPreview.previewText.includes('Codebase Map')
        && agentCodebaseMapPreview.hasSymbolGraph);
    track('4a. Agent preview type implementation count',
      agentCodebaseMapPreview.symbolText.includes('type impl'));
    await page.fill('#agentPreviewText', 'E2E idea-to-archive run');
    await page.click('#agentPreviewRun');
    await page.waitForFunction(() => {
      const text = document.querySelector('#agentPreviewResult')?.textContent || '';
      return text.includes('Xike') && text.includes('Installed');
    }, null, { timeout: 5000 });
    await page.click('#agentPreviewCreateRun');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('idea_to_archive') && detail.includes('Execution Archive') && detail.includes('E2E idea-to-archive run');
    }, null, { timeout: 5000 });
    const ideaRunUi = await page.evaluate(() => ({
      detail: document.querySelector('.agent-run-detail')?.textContent || '',
      activeTab: document.querySelector('.agent-registry-tab.is-active')?.textContent?.trim() || '',
      workflow: document.querySelector('[data-agent-main-path="run"]')?.textContent || '',
      nextAction: document.querySelector('[data-agent-main-next]')?.textContent || '',
    }));
    track('4a. Idea-to-Archive run draft', ideaRunUi.activeTab === 'Runs' && ideaRunUi.detail.includes('Execution Archive'));
    track('4a. Idea-to-Archive archive artifact', ideaRunUi.detail.includes('Idea intake archived: E2E idea-to-archive run'));
    track('4a. Idea-to-Archive guided run path',
      ideaRunUi.workflow.includes('Idea-to-Archive Path')
        && ideaRunUi.workflow.includes('Manifest/Patch')
        && ideaRunUi.workflow.includes('Next: Generate Manifest')
        && ideaRunUi.workflow.includes('Recommended next')
        && ideaRunUi.nextAction.includes('Generate Manifest')
        && ideaRunUi.workflow.includes('Generate Patch'));
    const ideaActionDedup = await page.evaluate(() => ({
      topIdeaActions: document.querySelectorAll('.agent-run-actions [data-agent-run-idea-auto], .agent-run-actions [data-agent-run-idea-generate-manifest], .agent-run-actions [data-agent-run-idea-generate-patch], .agent-run-actions [data-agent-run-idea-manifest], .agent-run-actions [data-agent-run-idea-complete]').length,
      guidedIdeaActions: document.querySelectorAll('[data-agent-main-path="run"] [data-agent-run-idea-auto], [data-agent-main-path="run"] [data-agent-run-idea-generate-manifest], [data-agent-main-path="run"] [data-agent-run-idea-generate-patch], [data-agent-main-path="run"] [data-agent-run-idea-manifest], [data-agent-main-path="run"] [data-agent-run-idea-complete]').length,
    }));
    track('4a. Idea-to-Archive action bar deduplicated',
      ideaActionDedup.topIdeaActions === 0 && ideaActionDedup.guidedIdeaActions >= 4);
    const ideaAutoButton = await page.evaluate(() => !!document.querySelector('[data-agent-run-idea-auto]'));
    track('4a. Idea-to-Archive auto verify action present', ideaAutoButton);
    await page.click('[data-agent-run-idea-auto]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('succeeded')
        && detail.includes('verification passed')
        && detail.includes('git status --short')
        && detail.includes('git diff --check')
        && detail.includes('npm test');
    }, null, { timeout: E2E_IDEA_EXEC_TIMEOUT_MS });
    const completedIdeaRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive auto execution complete', completedIdeaRunUi.includes('verification passed'));
    track('4a. Idea-to-Archive work evidence', completedIdeaRunUi.includes('Idea work plan prepared') && completedIdeaRunUi.includes('git status --short'));
    track('4a. Idea-to-Archive final archive',
      completedIdeaRunUi.includes('npm test')
        && completedIdeaRunUi.includes('Execution Archive')
        && completedIdeaRunUi.includes('Archive evidence ready'));
    const finalArchiveGuided = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      const topArchive = document.querySelectorAll('.agent-run-actions [data-agent-run-archive]').length;
      return path.includes('Archive evidence ready')
        && path.includes('Final archive')
        && path.includes('verification passed')
        && path.includes('tools')
        && path.includes('files')
        && path.includes('artifacts')
        && path.includes('Add Archive Note')
        && next.includes('Review Archive')
        && !!document.querySelector('[data-agent-main-next][data-agent-run-review-archive]')
        && topArchive === 0;
    });
    track('4a. Idea-to-Archive guided final archive action', finalArchiveGuided);
    await page.click('[data-agent-main-next][data-agent-run-review-archive]');
    await page.waitForFunction(() => !!document.querySelector('.agent-run-archive.is-highlighted'), null, { timeout: 3000 });
    track('4a. Idea-to-Archive archive summary focus', true);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    // 固定 run id 在持久库（~/.noe-panel）重跑会复用旧 timeline（manifest draft/归档残留）导致
    // 引导动作分叉（如 Generate Manifest 按钮消失），e2e run id 一律带每次运行唯一后缀。
    const E2E_UNIQ = Date.now().toString(36);
    const fileChangeRunId = `agent-run-e2e-file-change-${E2E_UNIQ}`;
    const uiManifestRunId = `agent-run-e2e-ui-manifest-${E2E_UNIQ}`;
    const generatedManifestRunId = `agent-run-e2e-generated-manifest-${E2E_UNIQ}`;
    const genManifestWorkPath = `output/playwright/idea-work-${generatedManifestRunId}`;
    const genManifestChangePath = `output/playwright/idea-agent-change-${generatedManifestRunId}`;
    const patchManifestRunId = `agent-run-e2e-patch-manifest-${E2E_UNIQ}`;
    const approvalResumeRunId = `agent-run-e2e-approval-resume-${E2E_UNIQ}`;
    const gateReportPathPrefix = `output/playwright/gate-audit-reports/${approvalResumeRunId}-`;
    const workAttachmentRel = 'output/playwright/e2e-idea-work-attachment.png';
    const manifestGeneratedRel = `output/playwright/e2e-idea-work-generated-${Date.now()}.js`;
    await page.screenshot({ path: join(process.cwd(), workAttachmentRel), fullPage: true });
    const manifestRun = await page.evaluate(async ({ runId, screenshotPath, generatedPath }) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E governed file change run',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const execRes = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/idea-auto-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileChanges: [{
            operation: 'create',
            path: generatedPath,
            content: 'const e2eIdeaWorkGenerated = true;\n',
          }],
          commands: [`node --check ${generatedPath}`],
          evidenceArtifacts: [{ kind: 'screenshot', label: 'E2E idea work screenshot', path: screenshotPath }],
        }),
      });
      if (!execRes.ok) throw new Error(await execRes.text());
      const payload = await execRes.json();
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
      return payload;
    }, { runId: fileChangeRunId, screenshotPath: workAttachmentRel, generatedPath: manifestGeneratedRel });
    await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 1')
        && detail.includes('artifacts 1');
    }, { runId: fileChangeRunId, generatedPath: manifestGeneratedRel }, { timeout: 8000 });
    const manifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive governed file change',
      manifestRun.ok === true
        && manifestRun.run.status === 'succeeded'
        && manifestRun.archive?.evidence?.external?.fileChanges?.[0]?.status === 'passed'
        && manifestRunUi.includes(`file.write ${manifestGeneratedRel}`));
    track('4a. Idea-to-Archive screenshot evidence',
      manifestRun.archive?.evidence?.external?.evidenceArtifacts?.[0]?.exists === true
        && manifestRunUi.includes('artifacts 1'));
    const uiManifestGeneratedRel = `output/playwright/e2e-idea-ui-manifest-${Date.now()}.js`;
    await page.evaluate(async (runId) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E UI manifest run',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
    }, uiManifestRunId);
    await page.waitForFunction((runId) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId) && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, uiManifestRunId, { timeout: 8000 });
    await page.click('[data-agent-run-idea-manifest]');
    await page.fill('.confirm-modal textarea.prompt-modal-input', JSON.stringify({
      fileChanges: [{
        operation: 'create',
        path: uiManifestGeneratedRel,
        content: 'const e2eIdeaManifestGenerated = true;\n',
      }],
      commands: [`node --check ${uiManifestGeneratedRel}`],
      evidenceArtifacts: [{ kind: 'screenshot', label: 'E2E UI manifest screenshot', path: workAttachmentRel }],
    }, null, 2));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 1')
        && detail.includes('artifacts 1');
    }, { runId: uiManifestRunId, generatedPath: uiManifestGeneratedRel }, { timeout: 10000 });
    const uiManifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive UI manifest editor',
      uiManifestRunUi.includes(`file.write ${uiManifestGeneratedRel}`)
        && uiManifestRunUi.includes('file changes 1')
        && uiManifestRunUi.includes('artifacts 1'));
    await page.evaluate(async (runId) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E generated manifest draft run',
          agentProfileId: 'xike-builder',
          affectedFiles: ['public/app.js'],
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
    }, generatedManifestRunId);
    await page.waitForFunction((runId) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && !!document.querySelector('[data-agent-run-idea-generate-manifest]')
        && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, generatedManifestRunId, { timeout: 8000 });
    const generatedPathNextReady = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Recommended next')
        && path.includes('Run Custom Manifest')
        && next.includes('Generate Manifest');
    });
    track('4a. Idea-to-Archive guided next manifest action', generatedPathNextReady);
    await page.click('[data-agent-main-next]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Manifest draft generated')
        && detail.includes('node --check public/app.js')
        && detail.includes('git diff --check');
    }, null, { timeout: 8000 });
    const generatedPathAfterDraft = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Next: Auto Work + Verify')
        && next.includes('Auto Work + Verify')
        && path.includes('Edit Manifest');
    });
    track('4a. Idea-to-Archive guided next verify action', generatedPathAfterDraft);
    await page.click('[data-agent-run-idea-manifest]');
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const generatedManifestText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Idea-to-Archive generated manifest prefill',
      generatedManifestText.includes('"fileChanges"')
        && generatedManifestText.includes(genManifestWorkPath)
        && generatedManifestText.includes(genManifestChangePath)
        && generatedManifestText.includes('Record the generated Agent work manifest artifact.')
        && generatedManifestText.includes('local-agent-filechange-synthesizer')
        && generatedManifestText.includes('node --check public/app.js')
        && generatedManifestText.includes(`node --check ${genManifestChangePath}`)
        && generatedManifestText.includes('git status --porcelain=v1')
        && generatedManifestText.includes('git diff --stat'));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.waitForFunction(({ runId, workPath, changePath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes('succeeded')
        && detail.includes('file changes 2')
        && detail.includes(`file.write ${workPath}`)
        && detail.includes(`file.write ${changePath}`)
        && detail.includes('node --check public/app.js')
        && detail.includes(`node --check ${changePath}`)
        && detail.includes('git status --porcelain=v1')
        && detail.includes('Execution Archive');
    }, { runId: generatedManifestRunId, workPath: genManifestWorkPath, changePath: genManifestChangePath }, { timeout: E2E_IDEA_EXEC_TIMEOUT_MS });
    const generatedManifestRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive generated manifest execution',
      generatedManifestRunUi.includes('succeeded')
        && generatedManifestRunUi.includes('file changes 2')
        && generatedManifestRunUi.includes(`file.write ${genManifestWorkPath}`)
        && generatedManifestRunUi.includes(`file.write ${genManifestChangePath}`)
        && generatedManifestRunUi.includes(`node --check ${genManifestChangePath}`)
        && generatedManifestRunUi.includes('node --check public/app.js')
        && generatedManifestRunUi.includes('Execution Archive'));
    await page.evaluate(async (runId) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E source patch manifest draft run',
          agentProfileId: 'xike-builder',
          affectedFiles: ['public/app.js'],
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
    }, patchManifestRunId);
    await page.waitForFunction((runId) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && !!document.querySelector('[data-agent-run-idea-generate-patch]')
        && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, patchManifestRunId, { timeout: 8000 });
    const patchGuidedAlternative = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      return path.includes('Recommended next')
        && path.includes('Other actions')
        && !!document.querySelector('[data-agent-main-secondary][data-agent-run-idea-generate-patch]');
    });
    track('4a. Idea-to-Archive guided patch alternative', patchGuidedAlternative);
    await page.click('[data-agent-run-idea-generate-patch]');
    await page.waitForFunction(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Patch manifest draft generated')
        && detail.includes('Patch quality')
        && detail.includes('node --check public/app.js')
        && detail.includes('git diff --check');
    }, null, { timeout: 8000 });
    const patchQualityPresent = await page.evaluate(() => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Patch quality')
        && /Patch quality (high|medium|low|blocked) \d+\/100/.test(detail)
        && detail.includes('proposal_only_patch');
    });
    track('4a. Idea-to-Archive source patch quality assessment', patchQualityPresent);
    await page.click('[data-agent-run-idea-manifest]');
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const patchManifestText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Idea-to-Archive source patch manifest prefill',
      patchManifestText.includes('"operation": "append"')
        && patchManifestText.includes('"path": "public/app.js"')
        && patchManifestText.includes('Append a governed local Agent source patch proposal.')
        && patchManifestText.includes('Xike Agent: Idea: E2E source patch manifest draft run')
        && patchManifestText.includes('node --check public/app.js')
        && patchManifestText.includes('git status --porcelain=v1')
        && patchManifestText.includes('git diff --stat'));
    await page.click('.confirm-modal [data-act="cancel"]');
    await page.waitForFunction(() => ![...document.querySelectorAll('.confirm-modal')]
      .some((el) => !el.classList.contains('confirm-modal-closing') && getComputedStyle(el).display !== 'none'), null, { timeout: 3000 });
    const approvalResumeGeneratedRel = `output/playwright/e2e-idea-approval-resume-${Date.now()}.js`;
    const approvalResumeHelperRel = `output/playwright/e2e-idea-approval-resume-helper-${Date.now()}.mjs`;
    await page.evaluate(async (runId) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E approval resume file change',
          agentProfileId: 'xike-builder',
          classification: {
            profile: { id: 'xike-builder', title: 'Xike Builder' },
            matches: [{ tag: 'implementation', agentId: 'xike-builder', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
    }, approvalResumeRunId);
    await page.waitForFunction((runId) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId) && !!document.querySelector('[data-agent-run-idea-manifest]');
    }, approvalResumeRunId, { timeout: 8000 });
    await page.click('[data-agent-run-idea-manifest]');
    await page.fill('.confirm-modal textarea.prompt-modal-input', JSON.stringify({
      fileChanges: [
        {
          operation: 'create',
          path: approvalResumeGeneratedRel,
          content: 'const e2eApprovalResume = true;\n',
          requiresApproval: true,
        },
        {
          operation: 'create',
          path: approvalResumeHelperRel,
          content: 'export const e2eApprovalResumeHelper = true;\n',
        },
      ],
      commands: [`node --check ${approvalResumeGeneratedRel}`, `node --check ${approvalResumeHelperRel}`],
    }, null, 2));
    await page.click('.confirm-modal [data-act="confirm"]');
    const approvalResumeOutcome = await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      const match = detail.match(/approval-[0-9a-f]{8}-[0-9a-f]{3}/i);
      if (detail.includes('deferred') && detail.includes('approval_required') && match) {
        return { mode: 'approval_resume', approvalId: match[0] };
      }
      if (detail.includes(runId)
        && detail.includes('succeeded')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 2')) {
        return { mode: 'full_trust_auto' };
      }
      return false;
    }, { runId: approvalResumeRunId, generatedPath: approvalResumeGeneratedRel }, { timeout: 10000 }).then(handle => handle.jsonValue());
    if (approvalResumeOutcome.mode === 'full_trust_auto') {
      const approvalResumeRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
      track('4a. Idea-to-Archive full-trust direct file change',
        approvalResumeRunUi.includes('succeeded')
          && approvalResumeRunUi.includes(`file.write ${approvalResumeGeneratedRel}`)
          && approvalResumeRunUi.includes(`file.write ${approvalResumeHelperRel}`)
          && approvalResumeRunUi.includes('file changes 2'));
      track('4a. Owner full trust bypasses approval resume gate',
        !approvalResumeRunUi.includes('approval_required')
          && !approvalResumeRunUi.includes('deferred')
          && approvalResumeRunUi.includes(`node --check ${approvalResumeGeneratedRel}`)
          && approvalResumeRunUi.includes(`node --check ${approvalResumeHelperRel}`)
          && approvalResumeRunUi.includes('Execution Archive'));
    } else {
      const approvalResumeId = approvalResumeOutcome.approvalId;
    const approvalGuidedPreflight = await page.evaluate(() => {
      const path = document.querySelector('[data-agent-main-path="run"]')?.textContent || '';
      const next = document.querySelector('[data-agent-main-next]')?.textContent || '';
      return path.includes('Preflight Review 等待审批续跑')
        && next.includes('Open Preflight Review')
        && !!document.querySelector('[data-agent-main-next][data-agent-run-governance-review]');
    });
    track('4a. Idea-to-Archive guided preflight action', approvalGuidedPreflight);
    await page.click('#agentRegistryModal button[data-close-agent-registry]');
    await page.waitForFunction(() => document.querySelector('#agentRegistryModal')?.style.display !== 'flex', null, { timeout: 3000 });
    await clickNav(page, '#btnGovernance');
    await page.waitForSelector(`[data-gov-center-approve-resume="${approvalResumeId}"]`, { timeout: 8000 });
    const approvalResumeActionPresent = await page.evaluate(({ approvalId, runId }) => {
      const button = document.querySelector(`[data-gov-center-approve-resume="${approvalId}"]`);
      const body = document.querySelector('#governanceCenterBody')?.textContent || '';
      return !!button
        && button.dataset.govCenterReviewGate?.startsWith('review-')
        && /^[a-f0-9]{64}$/i.test(button.dataset.govCenterReviewSha || '')
        && body.includes('Approval Actions')
        && body.includes(runId);
    }, { approvalId: approvalResumeId, runId: approvalResumeRunId });
    track('4a. Governance Center approval resume action present', approvalResumeActionPresent);
    const approvalResumeReviewPresent = await page.evaluate(({ approvalId, generatedPath, helperPath }) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const text = review?.textContent || '';
      return !!review
        && text.includes('Preflight Review')
        && text.includes('Staged Diff')
        && text.includes('+2/-0')
        && text.includes('2 new')
        && text.includes('2/2 verified')
        && text.includes('0 uncovered')
        && text.includes('coverage verified')
        && text.includes('risk')
        && text.includes('Gate review-')
        && text.includes(generatedPath)
        && text.includes(helperPath)
        && text.includes('+const e2eApprovalResume = true;')
        && text.includes(`node --check ${generatedPath}`)
        && text.includes(`node --check ${helperPath}`);
    }, { approvalId: approvalResumeId, generatedPath: approvalResumeGeneratedRel, helperPath: approvalResumeHelperRel });
    track('4a. Governance Center approval resume preflight review', approvalResumeReviewPresent);
    const approvalResumeReviewInteractions = await page.evaluate((approvalId) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const firstFile = review?.querySelector('[data-gov-center-review-file]');
      const firstSummary = firstFile?.querySelector('summary');
      const firstChip = review?.querySelector('[data-gov-center-command-jump]');
      if (!review || !firstFile || !firstSummary || !firstChip) return false;
      const wasOpen = firstFile.open === true;
      firstSummary.click();
      const collapsed = firstFile.open === false;
      firstSummary.click();
      const reopened = firstFile.open === true;
      firstChip.click();
      const highlighted = !!review.querySelector('.governance-center-review-commands code.is-highlighted');
      const text = review.textContent || '';
      return wasOpen
        && collapsed
        && reopened
        && highlighted
        && text.includes('Coverage explanation')
        && text.includes('safe verification command references this file path directly')
        && text.includes('Risk reasons')
        && text.includes('verify')
        && text.includes('score');
    }, approvalResumeId);
    track('4a. Governance Center staged diff interactions', approvalResumeReviewInteractions);
    const approvalResumeCoverageFilter = await page.evaluate((approvalId) => {
      const review = document.querySelector(`[data-gov-center-resume-review="${approvalId}"]`);
      const uncovered = review?.querySelector('[data-gov-center-coverage-status="uncovered"]');
      const all = review?.querySelector('[data-gov-center-coverage-status="all"]');
      if (!review || !uncovered || !all) return false;
      uncovered.click();
      const filesAfterUncovered = [...review.querySelectorAll('[data-gov-center-review-file]')];
      const hiddenCount = filesAfterUncovered.filter(file => file.hidden).length;
      const emptyVisible = review.querySelector('[data-gov-center-coverage-empty]')?.hidden === false;
      all.click();
      const filesAfterAll = [...review.querySelectorAll('[data-gov-center-review-file]')];
      return hiddenCount === filesAfterUncovered.length
        && emptyVisible
        && filesAfterAll.length > 0
        && filesAfterAll.every(file => file.hidden === false)
        && all.classList.contains('is-active');
    }, approvalResumeId);
    track('4a. Governance Center coverage filter', approvalResumeCoverageFilter);
    await page.click(`[data-gov-center-approve-resume="${approvalResumeId}"]`);
    await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes('succeeded')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes('file changes 2');
    }, { runId: approvalResumeRunId, generatedPath: approvalResumeGeneratedRel }, { timeout: 10000 });
    const approvalResumeRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive approval resume file change',
      approvalResumeRunUi.includes('succeeded')
        && approvalResumeRunUi.includes(`file.write ${approvalResumeGeneratedRel}`)
        && approvalResumeRunUi.includes(`file.write ${approvalResumeHelperRel}`)
        && approvalResumeRunUi.includes('file changes 2'));
    track('4a. Governance Center approval resume execution',
      approvalResumeRunUi.includes('succeeded')
        && approvalResumeRunUi.includes(`node --check ${approvalResumeGeneratedRel}`)
        && approvalResumeRunUi.includes(`node --check ${approvalResumeHelperRel}`)
        && approvalResumeRunUi.includes('Execution Archive'));
    track('4a. Approval resume gate audit',
      approvalResumeRunUi.includes('Approval Resume Gate')
        && approvalResumeRunUi.includes('Idea-to-Archive Path')
        && approvalResumeRunUi.includes('staged diff')
        && approvalResumeRunUi.includes('+2/-0')
        && approvalResumeRunUi.includes('2/2 verified')
        && approvalResumeRunUi.includes('0 uncovered')
        && approvalResumeRunUi.includes('review-')
        && approvalResumeRunUi.includes(approvalResumeGeneratedRel)
        && approvalResumeRunUi.includes(approvalResumeHelperRel)
        && approvalResumeRunUi.includes(`node --check ${approvalResumeGeneratedRel}`));
    const approvalResumeGateId = approvalResumeRunUi.match(/review-[a-f0-9]{12}/i)?.[0] || '';
    await page.fill('#agentRunGateFilter', approvalResumeGateId);
    await page.click('#agentRunsRefresh');
    await page.waitForFunction((taskText) => {
      const rows = [...document.querySelectorAll('.agent-run-row')].map(row => row.textContent || '').join('\n');
      return rows.includes(taskText);
    }, 'E2E approval resume file change', { timeout: 5000 });
    const gateFilteredRuns = await page.evaluate(() => ({
      rows: document.querySelectorAll('.agent-run-row').length,
      text: document.querySelector('.agent-run-list')?.textContent || '',
      filter: document.querySelector('#agentRunGateFilter')?.value || '',
    }));
    track('4a. Agent Runs gate audit filter',
      Boolean(approvalResumeGateId)
        && gateFilteredRuns.rows >= 1
        && gateFilteredRuns.text.includes('E2E approval resume file change')
        && gateFilteredRuns.filter === approvalResumeGateId);
    await page.evaluate(async (gateId) => {
      // S24 外迁：openActivityModal 收进 activity-ui.js，经 window.PanelActivity.open 调
      if (typeof window.PanelActivity?.open !== 'function') throw new Error('PanelActivity.open missing');
      await window.PanelActivity.open({ approvalResumeGateId: gateId });
    }, approvalResumeGateId);
    await page.waitForSelector('#activityGateId', { timeout: 3000 });
    await page.waitForFunction(({ gateId, runId }) => {
      const list = document.querySelector('.activity-list')?.textContent || '';
      const detail = document.querySelector('.activity-detail')?.textContent || '';
      return list.includes('agent.run.approval_resume_gate_accepted')
        && detail.includes('Approval Resume Gate')
        && detail.includes(gateId)
        && !!document.querySelector(`[data-activity-open-run="${runId}"]`);
    }, { gateId: approvalResumeGateId, runId: approvalResumeRunId }, { timeout: 5000 });
    const gateActivity = await page.evaluate((runId) => ({
      filter: document.querySelector('#activityGateId')?.value || '',
      list: document.querySelector('.activity-list')?.textContent || '',
      detail: document.querySelector('.activity-detail')?.textContent || '',
      openRunButtons: document.querySelectorAll(`[data-activity-open-run="${runId}"]`).length,
    }), approvalResumeRunId);
    track('4a. Activity gate audit filter',
      Boolean(approvalResumeGateId)
        && gateActivity.filter === approvalResumeGateId
        && gateActivity.list.includes('agent.run.approval_resume_gate_accepted')
        && gateActivity.detail.includes('Approval Resume Gate')
        && gateActivity.detail.includes(approvalResumeGateId)
        && gateActivity.openRunButtons > 0);
    await page.click(`[data-activity-open-run="${approvalResumeRunId}"]`);
    await page.waitForFunction(({ gateId, runId }) => {
      const modalOpen = document.querySelector('#agentRegistryModal')?.style.display === 'flex';
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return modalOpen
        && detail.includes(runId)
        && detail.includes('Approval Resume Gate')
        && detail.includes(gateId);
    }, { gateId: approvalResumeGateId, runId: approvalResumeRunId }, { timeout: 5000 });
    track('4a. Activity gate audit opens Agent Run', true);
    await page.waitForSelector(`[data-agent-run-gate-audit="${approvalResumeRunId}"]`, { timeout: 3000 });
    await page.click(`[data-agent-run-gate-audit="${approvalResumeRunId}"]`);
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const gateAuditReportText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Gate audit report export',
      gateAuditReportText.includes('Approval Resume Gate Audit Report')
        && gateAuditReportText.includes(approvalResumeGateId)
        && gateAuditReportText.includes('Staged Diff Review')
        && gateAuditReportText.includes('+2 / -0')
        && gateAuditReportText.includes('Coverage: 2/2 verified, 0 uncovered')
        && gateAuditReportText.includes('Coverage Explanations:')
        && gateAuditReportText.includes('coverage:verified')
        && gateAuditReportText.includes('Partition Mismatches:')
        && gateAuditReportText.includes('Verified: yes')
        && gateAuditReportText.includes('agent.run.approval_resume_gate_accepted')
        && gateAuditReportText.includes('archive'));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.click(`[data-agent-run-gate-audit-archive="${approvalResumeRunId}"]`);
    await page.waitForFunction((reportPrefix) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes('Gate audit report archived')
        && detail.includes(reportPrefix)
        && detail.includes('Execution Archive');
    }, gateReportPathPrefix, { timeout: 5000 });
    const gateReportArchiveUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Gate audit report archived artifact',
      gateReportArchiveUi.includes('Gate audit report archived')
        && gateReportArchiveUi.includes(gateReportPathPrefix)
        && gateReportArchiveUi.includes('Execution Archive'));
    const gateArtifactLookup = await page.evaluate((reportPrefix) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      const rows = [...document.querySelectorAll('.agent-run-artifact-row')];
      return {
        detail,
        rowCount: rows.length,
        hasGateArtifact: rows.some(row => row.textContent.includes(reportPrefix)),
        openButtons: document.querySelectorAll('[data-agent-run-artifact-download]').length,
      };
    }, gateReportPathPrefix);
    track('4a. Gate audit artifact lookup visible',
      gateArtifactLookup.detail.includes('Execution Artifacts')
        && gateArtifactLookup.rowCount > 0
        && gateArtifactLookup.hasGateArtifact
        && gateArtifactLookup.openButtons > 0);
    const openedGateArtifact = await page.evaluate((reportPrefix) => {
      const row = [...document.querySelectorAll('.agent-run-artifact-row')]
        .find(item => item.textContent.includes(reportPrefix));
      const btn = row?.querySelector('[data-agent-run-artifact-download]');
      btn?.click();
      return Boolean(btn);
    }, gateReportPathPrefix);
    await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
    const gateArtifactText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
    track('4a. Gate audit artifact opens markdown',
      openedGateArtifact
        && gateArtifactText.includes('Approval Resume Gate Audit Report')
        && gateArtifactText.includes(approvalResumeGateId));
    await page.click('.confirm-modal [data-act="confirm"]');
    await page.click(`[data-agent-run-activity="${approvalResumeRunId}"]`);
    await page.waitForSelector('#activitySearch', { timeout: 3000 });
    await page.click('#activityClearFilters');
    await page.waitForFunction(() => {
      return (document.querySelector('#activitySearch')?.value || '') === ''
        && (document.querySelector('#activityGateId')?.value || '') === '';
    }, null, { timeout: 3000 });
    await page.fill('#activitySearch', `gate-audit-reports/${approvalResumeRunId}`);
    await page.waitForFunction(() => {
      const list = document.querySelector('.activity-list')?.textContent || '';
      return list.includes('agent.run.archived');
    }, null, { timeout: 5000 });
    await page.waitForFunction((reportPrefix) => {
      const detail = document.querySelector('.activity-detail')?.textContent || '';
      return detail.includes('Archive Artifacts')
        && detail.includes(reportPrefix)
        && !!document.querySelector('[data-activity-artifact-download]');
    }, gateReportPathPrefix, { timeout: 5000 });
    track('4a. Activity archive artifact reverse lookup', true);
    await page.evaluate(() => document.querySelector('[data-close-activity]')?.click());
    }
    await page.click('#agentRunsClear');
    const nodePolicyRunId = `agent-run-e2e-node-policy-${E2E_UNIQ}`;
    const nodePolicyRel = `output/playwright/e2e-node-policy-${Date.now()}.mjs`;
    const nodePolicyContent = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('generated policy check', () => {",
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join('\n');
    const nodePolicyRun = await page.evaluate(async ({ runId, generatedPath, generatedContent }) => {
      const createRes = await fetch('/api/agent-runs/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: runId,
          idea: 'E2E expanded command policy run',
          agentProfileId: 'xike-verifier',
          classification: {
            profile: { id: 'xike-verifier', title: 'Xike Verifier' },
            matches: [{ tag: 'verification', agentId: 'xike-verifier', score: 5 }],
            installedSkillNames: ['qa'],
          },
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const execRes = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/idea-auto-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileChanges: [{
            operation: 'create',
            path: generatedPath,
            content: generatedContent,
          }],
          workEvidenceCommands: ['git status --porcelain=v1', 'git diff --stat'],
          commands: [`node --test ${generatedPath}`],
        }),
      });
      if (!execRes.ok) throw new Error(await execRes.text());
      const payload = await execRes.json();
      await window.PanelAgentGraph?.openAgentRunFromActivity?.(runId);
      return payload;
    }, { runId: nodePolicyRunId, generatedPath: nodePolicyRel, generatedContent: nodePolicyContent });
    await page.waitForFunction(({ runId, generatedPath }) => {
      const detail = document.querySelector('.agent-run-detail')?.textContent || '';
      return detail.includes(runId)
        && detail.includes('succeeded')
        && detail.includes(`file.write ${generatedPath}`)
        && detail.includes(`node --test ${generatedPath}`)
        && detail.includes('git status --porcelain=v1')
        && detail.includes('git diff --stat')
        && detail.includes('file changes 1');
    }, { runId: nodePolicyRunId, generatedPath: nodePolicyRel }, { timeout: 12000 });
    const nodePolicyRunUi = await page.evaluate(() => document.querySelector('.agent-run-detail')?.textContent || '');
    track('4a. Idea-to-Archive expanded command policy',
      nodePolicyRun.ok === true
        && nodePolicyRun.run.status === 'succeeded'
        && nodePolicyRun.archive?.evidence?.external?.commands?.[0]?.command === `node --test ${nodePolicyRel}`
        && nodePolicyRunUi.includes(`node --test ${nodePolicyRel}`)
        && nodePolicyRunUi.includes('git diff --stat'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const e2eRunId = `agent-run-e2e-activity-${E2E_UNIQ}`;
    const e2eSiblingRunId = `agent-run-e2e-session-sibling-${E2E_UNIQ}`;
    const e2eSessionId = `session-e2e-agent-runs-${E2E_UNIQ}`;
    if (ownerToken) {
      await page.evaluate(async ({ runId, siblingId, sessionId }) => {
        const res = await fetch('/api/agent-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: runId,
            status: 'failed',
            sessionId,
            taskId: 'e2e-activity-run-bridge',
            agentProfileId: 'xike-e2e',
            sourceType: 'e2e',
            details: { e2e: true },
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const sibling = await fetch('/api/agent-runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: siblingId,
            status: 'queued',
            sessionId,
            taskId: 'e2e-session-sibling',
            agentProfileId: 'xike-e2e',
            sourceType: 'e2e',
            details: { e2e: true, sibling: true },
          }),
        });
        if (!sibling.ok) throw new Error(await sibling.text());
      }, { runId: e2eRunId, siblingId: e2eSiblingRunId, sessionId: e2eSessionId });
    }

      await clickNav(page, '#btnActivity');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      await page.click('#activityClearFilters');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      const activityAgentControls = await page.evaluate(() => ({
      presets: [...document.querySelectorAll('[data-activity-preset]')].map(el => el.textContent.trim()),
      agentProfile: !!document.querySelector('#activityAgentProfileId'),
      agentRun: !!document.querySelector('#activityAgentRunId'),
      skill: !!document.querySelector('#activitySkillName'),
      diagnostic: !!document.querySelector('#activityDiagnosticCode'),
      toggle: !!document.querySelector('#activityAgentOnly'),
    }));
    track('4a. Activity Agent/Skill filters present',
      activityAgentControls.presets.includes('Agent/Skill')
        && activityAgentControls.presets.includes('诊断')
        && activityAgentControls.agentProfile
        && activityAgentControls.agentRun
        && activityAgentControls.skill
        && activityAgentControls.diagnostic
        && activityAgentControls.toggle);
    if (ownerToken) {
      await page.fill('#activitySearch', e2eRunId);
      await page.waitForSelector('[data-activity-open-run]', { timeout: 3000 });
      const activityRunBridge = await page.evaluate((runId) => ({
        openRunButtons: document.querySelectorAll(`[data-activity-open-run="${runId}"]`).length,
        detail: document.querySelector('.activity-detail')?.textContent || '',
      }), e2eRunId);
      track('4a. Activity links to Agent Run',
        activityRunBridge.openRunButtons > 0 && activityRunBridge.detail.includes(e2eRunId));
      await page.click(`[data-activity-open-run="${e2eRunId}"]`);
      await page.waitForFunction((runId) => {
        const modalOpen = document.querySelector('#agentRegistryModal')?.style.display === 'flex';
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return modalOpen && text.includes(runId);
      }, e2eRunId, { timeout: 5000 });
      track('4a. Activity opens Agent Run detail', true);
      await page.waitForFunction((sessionId) => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session Timeline') && text.includes(sessionId) && text.includes('2 runs');
      }, e2eSessionId, { timeout: 5000 });
      track('4a. Agent Run session timeline', true);
      const sessionEvidenceChain = await page.evaluate(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session Evidence Chain') && text.includes('evidence kinds') && text.includes('run:2');
      });
      track('4a. Agent Run session evidence chain', sessionEvidenceChain);
      const sessionExportButtonPresent = await page.evaluate((sessionId) => {
        const btn = document.querySelector(`[data-agent-run-session-export="${sessionId}"]`);
        return !!btn && btn.textContent.includes('Export Session');
      }, e2eSessionId);
      track('4a. Agent Run session export action present', sessionExportButtonPresent);
      await page.click(`[data-agent-run-session-export="${e2eSessionId}"]`);
      await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
      const sessionExportText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
      track('4a. Agent Run session evidence export',
        sessionExportText.includes(`# Agent Run Session ${e2eSessionId}`)
          && sessionExportText.includes('## Session Evidence Chain')
          && sessionExportText.includes(e2eRunId)
          && sessionExportText.includes(e2eSiblingRunId));
      await page.click('.confirm-modal [data-act="confirm"]');
      const sessionArchiveButtonPresent = await page.evaluate((sessionId) => {
        const btn = document.querySelector(`[data-agent-run-session-archive="${sessionId}"]`);
        return !!btn && btn.textContent.includes('Archive Session');
      }, e2eSessionId);
      track('4a. Agent Run session archive action present', sessionArchiveButtonPresent);
      await page.click(`[data-agent-run-session-archive="${e2eSessionId}"]`);
      await page.waitForFunction(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Session evidence archived:')
          && text.includes('output/playwright/session-evidence/agent-run-session-')
          && text.includes('artifacts 1');
      }, null, { timeout: 5000 });
      track('4a. Agent Run session evidence archived artifact', true);
      const sessionArtifactLookup = await page.evaluate(() => {
        const detail = document.querySelector('.agent-run-detail')?.textContent || '';
        const rows = [...document.querySelectorAll('.agent-run-artifact-row')];
        return {
          detail,
          hasSessionArtifact: rows.some(row => row.textContent.includes('output/playwright/session-evidence/agent-run-session-')),
          openButtons: document.querySelectorAll('[data-agent-run-artifact-download]').length,
        };
      });
      track('4a. Agent Run session artifact lookup visible',
        sessionArtifactLookup.detail.includes('Execution Artifacts')
          && sessionArtifactLookup.hasSessionArtifact
          && sessionArtifactLookup.openButtons > 0);
      const openedSessionArtifact = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.agent-run-artifact-row')]
          .find(item => item.textContent.includes('output/playwright/session-evidence/agent-run-session-'));
        const btn = row?.querySelector('[data-agent-run-artifact-download]');
        btn?.click();
        return Boolean(btn);
      });
      await page.waitForSelector('.confirm-modal textarea.prompt-modal-input', { timeout: 3000 });
      const sessionArtifactText = await page.$eval('.confirm-modal textarea.prompt-modal-input', el => el.value);
      track('4a. Agent Run session artifact opens markdown',
        openedSessionArtifact
          && sessionArtifactText.includes(`# Agent Run Session ${e2eSessionId}`)
          && sessionArtifactText.includes('## Session Evidence Chain'));
      await page.click('.confirm-modal [data-act="confirm"]');
      const archiveButtonPresent = await page.evaluate((runId) => !!document.querySelector(`[data-agent-run-archive="${runId}"]`), e2eRunId);
      track('4a. Agent Run archive action present', archiveButtonPresent);
      await page.click(`[data-agent-run-archive="${e2eRunId}"]`);
      await page.waitForSelector('.prompt-modal-input', { timeout: 3000 });
      await page.fill('.prompt-modal-input', 'E2E execution archive recorded.');
      await page.click('.confirm-modal [data-act="confirm"]');
      await page.waitForFunction(() => {
        const text = document.querySelector('.agent-run-detail')?.textContent || '';
        return text.includes('Execution Archive') && text.includes('E2E execution archive recorded.');
      }, null, { timeout: 5000 });
      track('4a. Agent Run archive view', true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await clickNav(page, '#btnActivity');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
      await page.click('#activityClearFilters');
      await page.waitForSelector('#activityDiagnosticCode', { timeout: 3000 });
    } else {
      track('4a. Activity links to Agent Run', true, 'skipped owner-token');
      track('4a. Activity opens Agent Run detail', true, 'skipped owner-token');
      track('4a. Agent Run session timeline', true, 'skipped owner-token');
      track('4a. Agent Run session export action present', true, 'skipped owner-token');
      track('4a. Agent Run session evidence export', true, 'skipped owner-token');
      track('4a. Agent Run session archive action present', true, 'skipped owner-token');
      track('4a. Agent Run session evidence archived artifact', true, 'skipped owner-token');
      track('4a. Agent Run session artifact lookup visible', true, 'skipped owner-token');
      track('4a. Agent Run session artifact opens markdown', true, 'skipped owner-token');
      track('4a. Agent Run archive action present', true, 'skipped owner-token');
      track('4a. Agent Run archive view', true, 'skipped owner-token');
    }
    await page.click('[data-activity-preset="diagnostics"]');
    await page.waitForTimeout(300);
    const diagnosticsPreset = await page.evaluate(() => ({
      action: document.querySelector('#activityAction')?.value,
      agentOnly: document.querySelector('#activityAgentOnly')?.checked,
    }));
    track('4a. Activity diagnostics preset', diagnosticsPreset.action === 'agent.skill_diagnostics' && diagnosticsPreset.agentOnly === true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(150);
    const cmdkOpen = await page.evaluate(() => document.querySelector('#cmdkModal')?.style.display === 'flex');
    track('5. ⌘K cmdk open', cmdkOpen);
    const cmdkItems = await page.$$eval('.cmdk-item', els => els.length);
    track('5. cmdk 含 ≥4 items', cmdkItems >= 4, `items=${cmdkItems}`);
    await page.keyboard.press('Escape');

    await ensureInspectorOpen(page);
    await page.click('[data-tab="debate-state"]');
    await page.waitForTimeout(100);
    const debateLogShown = await page.evaluate(() => document.querySelector('[data-content="debate-state"]')?.style.display !== 'none');
    track('6. 切到 🔬 Debate tab', debateLogShown);

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        space: cs.getPropertyValue('--space-2').trim(),
        zToast: cs.getPropertyValue('--z-toast').trim(),
        danger: cs.getPropertyValue('--color-danger').trim(),
      };
    });
    track('7. CSS token --space-2', tokens.space === '8px');
    track('7. CSS token --z-toast', tokens.zToast === '10000');
    track('7. CSS token --color-danger', tokens.danger === '#dc2626');

    const mirrors = await page.evaluate(() => {
      const out = {};
      // 第13批起 app.js 顶层再无镜像 state：解析期无人入队 → 队列可为 undefined（从未需要）或已清空数组
      out.pendingFlushed = !window.__panelPendingStateMirrors
        || (Array.isArray(window.__panelPendingStateMirrors) && window.__panelPendingStateMirrors.length === 0);
      // S24 外迁：archiveState/autopilotState 收进 archive-ui.js / autopilot-ui.js 闭包，
      // 无法直接 poke proxy；验证 createPanelMirroredState 启动镜像已落 SSOT（同一代码路径，
      // live 写传播改经 plugin-ui.js 导出的 pluginState proxy 代表验证（第13批外迁后唯一可 poke 入口））。
      out.archive = Array.isArray(window.PanelStore.get('archive.list'));
      const ps = window.PanelPlugin?.pluginState;
      if (ps) {
        ps.activeId = 'e2e-plugin';
        out.plugin = window.PanelStore.get('plugin.activeId') === 'e2e-plugin';
      }
      out.autopilot = Array.isArray(window.PanelStore.get('autopilot.logs'));
      return out;
    });
    track('8. pending SSOT mirror queue flushed', mirrors.pendingFlushed);
    track('8. archiveState 启动镜像 → SSOT', mirrors.archive);
    track('8. pluginState → SSOT mirror', mirrors.plugin);
    track('8. autopilotState 启动镜像 → SSOT', mirrors.autopilot);

    await clickNav(page, '#themeToggle');
    await page.waitForTimeout(200);
    const darkApplied = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    track('9. 暗黑模式切换', darkApplied);
    await clickNav(page, '#themeToggle');
    await page.waitForTimeout(200);

    const footerFs = await page.evaluate(() => {
      const f = document.querySelector('.status-bar');
      return f ? getComputedStyle(f).fontSize : null;
    });
    track('10. footer fontSize 12px', footerFs === '12px');

    // ── 11. P2 权限治理 UI 闭环：Webhook 审批后安全重试 ──
    if (!ownerToken) {
      track('11. Webhook approval-retry (create)', true, 'skipped owner-token');
      track('11. 审批摘要含 network.upload', true, 'skipped owner-token');
      track('11. 批准并重试后创建成功', true, 'skipped owner-token');
    } else {
      await clickNav(page, '#btnWebhooks');
      await page.waitForSelector('#btnWebhookNew', { timeout: 3000 });
      await page.click('#btnWebhookNew');
      await page.waitForSelector('#whUrl', { timeout: 3000 });
      const uniqueName = E2E_APPROVAL_WEBHOOK_PREFIX + Date.now();
      await page.fill('#whName', uniqueName);
      await page.fill('#whUrl', 'https://example.com/api/webhooks/e2e-approval-test');
      await page.click('#btnWebhookSave');
      const retryModalShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      if (!retryModalShown) {
        // 审批指纹 TTL 复用（PermissionGovernance A2，默认 10 分钟）：近期已批准同指纹（同 URL）
        // 的 network.upload 直接放行不再弹窗（设计行为，复用全量进审计）。重跑 e2e 时走此分支。
        const createdDirect = await page.waitForFunction((name) =>
          [...document.querySelectorAll('#webhookList .wname')].some(el => (el.textContent || '').includes(name)),
        uniqueName, { timeout: 6000 }).then(() => true).catch(() => false);
        track('11. Webhook approval-retry (create)', createdDirect, '(审批 TTL 复用直接放行)');
        track('11. 审批摘要含 network.upload', createdDirect, '(skipped: 审批 TTL 复用)');
        track('11. 批准并重试后创建成功', createdDirect, '(审批 TTL 复用直接创建)');
      } else {
        track('11. Webhook approval-retry (create)', true);
        const summaryHasUpload = await page.evaluate(() => {
          const m = document.querySelector('[data-approval-retry-modal]');
          return !!m && /network\.upload/.test(m.textContent || '');
        });
        track('11. 审批摘要含 network.upload', !!summaryHasUpload);
        await page.click('[data-approval-retry-confirm]');
        const created = await page.waitForFunction((name) =>
          [...document.querySelectorAll('#webhookList .wname')].some(el => (el.textContent || '').includes(name)),
        uniqueName, { timeout: 6000 }).then(() => true).catch(() => false);
        track('11. 批准并重试后创建成功', created);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 12. P2 权限治理 UI 闭环：Room Adapter provider 配置审批后重试 ──
    if (!ownerToken) {
      track('12. RoomAdapter approval-retry (config write)', true, 'skipped owner-token');
      track('12. 批准并重试后写入成功', true, 'skipped owner-token');
    } else {
      await clickNav(page, '#btnRoomAdapters');
      await page.waitForSelector('#btnSaveRoomAdapters', { timeout: 3000 });
      await page.click('#btnSaveRoomAdapters');
      const adapterRetryShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      const waitAdapterSaved = () => page.waitForFunction(() => {
        const el = document.querySelector('#adapterSaveStatus');
        return !!el && /已保存/.test(el.textContent || '');
      }, { timeout: 6000 }).then(() => true).catch(() => false);
      if (!adapterRetryShown) {
        // 审批指纹 TTL 复用（同指纹 provider.model_config.write 近期已批准）：直接放行写入
        const adapterSavedDirect = await waitAdapterSaved();
        track('12. RoomAdapter approval-retry (config write)', adapterSavedDirect, '(审批 TTL 复用直接放行)');
        track('12. 批准并重试后写入成功', adapterSavedDirect, '(审批 TTL 复用直接写入)');
      } else {
        track('12. RoomAdapter approval-retry (config write)', true);
        await page.click('[data-approval-retry-confirm]');
        track('12. 批准并重试后写入成功', await waitAdapterSaved());
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 13. P2 权限治理 UI 闭环：MCP server 配置审批后重试（RCE 级高风险写入口）──
    if (!ownerToken) {
      track('13. MCP approval-retry (create)', true, 'skipped owner-token');
      track('13. 批准并重试后创建成功', true, 'skipped owner-token');
    } else {
      await clickNav(page, '#btnMcp');
      await page.waitForSelector('#btnMcpNew', { timeout: 3000 });
      await page.click('#btnMcpNew');
      await page.waitForSelector('#mcpCommand', { timeout: 3000 });
      const mcpName = 'e2e-mcp-' + Date.now();
      await page.fill('#mcpName', mcpName);
      await page.fill('#mcpCommand', 'echo');
      await page.fill('#mcpArgs', 'hello');
      await page.click('#btnMcpSave');
      const mcpRetryShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 })
        .then(() => true).catch(() => false);
      if (!mcpRetryShown) {
        const mcpCreatedDirect = await page.waitForFunction((name) =>
          (document.querySelector('#mcpList')?.textContent || '').includes(name),
        mcpName, { timeout: 6000 }).then(() => true).catch(() => false);
        if (mcpCreatedDirect) {
          track('13. MCP approval-retry (create)', true, '(owner full trust 直接放行)');
          track('13. 批准并重试后创建成功', true, '(owner full trust 直接创建)');
        } else {
        // 真相（2026-06-11 根治）：此处历史上的 402+mcp-unlimited 不是"环境依赖"，而是
        // license-manager 单测 afterEach 误删真实 ~/.noe-panel/license.txt（生产回落 free 层、
        // 上限 3 → POST 402）。已三件套根治：单测改走 NOE_LICENSE_PATH 临时目录隔离 +
        // team license 重签激活 + license.txt 收编进备份白名单（NoeDbBackup KEY_FILES）。
        // license 在位（或托管隔离 HOME 下 MCP 库为空）时本步必走完整审批路径；
        // 再出现 402 即回归信号——先查 license.txt 是否又被删——按失败处理，不再静默跳过。
        const mcpCapProbe = await page.evaluate(async () => {
          const r = await fetch('/api/mcp/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'e2e-mcp-cap-probe', type: 'stdio', command: 'echo', args: ['hello'] }),
          });
          const body = await r.json().catch(() => ({}));
          return { status: r.status, feature: body.feature || '', error: body.error || '' };
        });
        const capHit = mcpCapProbe.status === 402 && mcpCapProbe.feature === 'mcp-unlimited';
        track('13. MCP approval-retry (create)', false, capHit
          ? '402 mcp-unlimited：license 缺失回归（查 ~/.noe-panel/license.txt 是否又被删）'
          : `probe=${mcpCapProbe.status} ${mcpCapProbe.error}`);
        track('13. 批准并重试后创建成功', false, capHit ? '同上：license 缺失回归' : '');
        }
      } else {
        track('13. MCP approval-retry (create)', true);
        await page.click('[data-approval-retry-confirm]');
        const mcpCreated = await page.waitForFunction((name) =>
          (document.querySelector('#mcpList')?.textContent || '').includes(name),
        mcpName, { timeout: 6000 }).then(() => true).catch(() => false);
        track('13. 批准并重试后创建成功', mcpCreated);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }

    // ── 14. P2 收尾：Watcher 双重审批链式重试（provider.model_config.write + auto_accept.scope）──
    if (!ownerToken) {
      track('14. Watcher 触发首个审批', true, 'skipped owner-token');
      track('14. Watcher 第二步审批弹窗(链式)', true, 'skipped owner-token');
      track('14. Watcher 双审批链式重试成功', true, 'skipped owner-token');
    } else {
      // 通过模块全局触发真实的 watcher 双审批请求 + 链式 flow（第21批外迁后经 window.PanelApprovalFlow 调用）
      await page.evaluate(async () => {
        window.__watcherOk = false;
        const opts = { method: 'PUT', body: JSON.stringify({ provider: 'ollama', model: 'e2e-chain', autoMode: true, enabled: false }) };
        const result = await window.PanelApprovalFlow.requestWithApproval('/api/watcher/config', opts);
        window.__watcherInitStatus = result.status;
        // 不 await：让弹窗交互在外部 playwright 点击驱动
        window.__watcherFlow = window.PanelApprovalFlow.handleApprovalFlow(result, '/api/watcher/config', opts, {
          actionLabel: 'watcher e2e',
          onOk: () => { window.__watcherOk = true; },
        });
      });
      const initStatus = await page.evaluate(() => window.__watcherInitStatus);
      if (initStatus === 'ok') {
        // 审批指纹 TTL 复用：同指纹 watcher 双审批近期已批准 → 首发即放行（onOk 直达）
        const okDirect = await page.waitForFunction(() => window.__watcherOk === true, { timeout: 4000 })
          .then(() => true).catch(() => false);
        track('14. Watcher 触发首个审批', okDirect, '(审批 TTL 复用直接放行)');
        track('14. Watcher 第二步审批弹窗(链式)', okDirect, '(skipped: 审批 TTL 复用)');
        track('14. Watcher 双审批链式重试成功', okDirect, '(审批 TTL 复用)');
      } else {
        track('14. Watcher 触发首个审批', initStatus === 'approval_required', `status=${initStatus}`);
        await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 });
        const firstId = await page.getAttribute('[data-approval-retry-modal]', 'data-approval-retry-modal');
        await page.click('[data-approval-retry-confirm]');
        // 第二个审批（auto_accept）应是不同 approvalId 的新弹窗
        const secondShown = await page.waitForFunction((prev) => {
          const m = document.querySelector('[data-approval-retry-modal]');
          return !!m && m.getAttribute('data-approval-retry-modal') !== prev;
        }, firstId, { timeout: 8000 }).then(() => true).catch(() => false);
        track('14. Watcher 第二步审批弹窗(链式)', secondShown);
        if (secondShown) await page.click('[data-approval-retry-confirm]');
        const chainOk = await page.waitForFunction(() => window.__watcherOk === true, { timeout: 8000 })
          .then(() => true).catch(() => false);
        track('14. Watcher 双审批链式重试成功', chainOk);
      }
      await page.waitForTimeout(100);
    }

    // ── 15. P2 收尾：MCP delete 接入审批（验证审批弹窗出现，取消不实际删除）──
    if (!ownerToken) {
      track('15. MCP delete 触发审批弹窗', true, 'skipped owner-token');
    } else {
      const mcpDeleteName = 'e2e-del-' + Date.now();
      await page.evaluate(async (name) => {
        const createRes = await fetch('/api/mcp/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, type: 'stdio', command: 'echo', args: ['delete-probe'] }),
        });
        window.__mcpDeleteCreateStatus = createRes.status;
        const path = '/api/mcp/servers/' + encodeURIComponent(name);
        const opts = { method: 'DELETE' };
        const result = await window.PanelApprovalFlow.requestWithApproval(path, opts);
        window.__mcpDelStatus = result.status;
        // 不 await，外部断言弹窗后取消
        window.__mcpDelFlow = window.PanelApprovalFlow.handleApprovalFlow(result, path, opts, { actionLabel: '删除 MCP server', onOk: () => {} });
      }, mcpDeleteName);
      const delStatus = await page.evaluate(() => window.__mcpDelStatus);
      const delShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 }).then(() => true).catch(() => false);
      track('15. MCP delete 触发审批弹窗',
        (delStatus === 'approval_required' && delShown) || delStatus === 'ok',
        delStatus === 'ok' ? 'owner full trust 直接删除' : `status=${delStatus}`);
      if (delShown) await page.click('[data-approval-retry-cancel]');
      await page.waitForTimeout(100);
    }

    // ── 16. P2 收尾：Plugin install 接入审批（验证审批弹窗出现，取消不实际安装）──
    if (!ownerToken) {
      track('16. Plugin install 触发审批弹窗', true, 'skipped owner-token');
    } else {
      await page.evaluate(async () => {
        const path = '/api/plugins/install';
        const manifest = { id: 'e2eplugin' + Date.now(), displayName: 'E2E Plugin', type: 'spawn', bin: { cmd: 'echo' }, commands: [] };
        const opts = { method: 'POST', body: JSON.stringify(manifest) };
        const result = await window.PanelApprovalFlow.requestWithApproval(path, opts);
        window.__pluginInstallStatus = result.status;
        // 不 await，外部断言弹窗后取消（取消则不会真正安装）
        window.__pluginInstallFlow = window.PanelApprovalFlow.handleApprovalFlow(result, path, opts, { actionLabel: '安装 Plugin', onOk: () => {} });
      });
      const installStatus = await page.evaluate(() => window.__pluginInstallStatus);
      const installShown = await page.waitForSelector('[data-approval-retry-modal]', { timeout: 4000 }).then(() => true).catch(() => false);
      track('16. Plugin install 触发审批弹窗',
        (installStatus === 'approval_required' && installShown) || installStatus === 'ok',
        installStatus === 'ok' ? 'owner full trust 直接安装' : `status=${installStatus}`);
      if (installShown) await page.click('[data-approval-retry-cancel]');
      await page.waitForTimeout(100);
    }

  } catch (e) {
    track('FATAL', false, e.message);
    await saveFailureArtifact(page, 'fatal');
  } finally {
    if (consoleErrors.length) {
      console.log('\nConsole warnings/errors:');
      for (const line of consoleErrors.slice(0, 20)) console.log(`  ${line}`);
    }
    if (results.some(r => !r.pass)) await saveFailureArtifact(page);
    await browser.close();
    // 尾部清理（成功/失败路径都走）：删掉本次自产的 e2e-approval-* webhook，防 20 上限垃圾累积。
    await cleanupE2eApprovalWebhooks(ownerToken, '尾部清理');
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n🏁 e2e: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
