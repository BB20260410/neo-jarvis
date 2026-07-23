// @ts-check
// 第三波手术 第27批 结构级防回归：agent-graph-ui.js（2324 行）拆 6 文件
// 刀法（照 /tmp/noe-maps3/webMap.json，行数超估部分按"消费者属主"最小再平衡）：
//   ① agent-graph-ui.js 保名做壳：agentRegistryState 单一属主 + modal 壳/tab 路由 +
//      bindAgentRegistryModalEvents/setAgentRegistryTab + saveAgentPolicy/resetAgentPolicy +
//      openAgentRunFromActivity（均调壳内 refreshAgentRegistry，留壳免 API 面加内部通道）+
//      window.PanelAgentGraph 聚合暴露（API 面 9 成员一字不改，batch15/e2e/app.js 桥 getter 全钉）
//   ② models：Model/Skill Center + Profiles 卡片/策略编辑器 + AGENT_POLICY_OPTIONS（唯一消费者随属主）
//   ③ runs-view：Runs tab/run 详情/idea 工作流渲染 + refreshAgentRuns/loadAgentRunDetail
//   ④ run-actions：bindAgentRunsEvents + replay/archive/idea manifest 动作群
//   ⑤ dispatch：Dispatch Preview 流 + workflow 步骤条 + sanitize/parse（壳 (...a)=> 转发）
//   ⑥ evidence：classification/代码证据渲染 + archives/artifacts/gate 渲染 + session/gate 归档 + artifact
// 铁律：共享可写状态 agentRegistryState 留壳，子模块经 agState()=window.PanelAgentGraph.state 调用期实时取，
//   禁解构/浅拷贝（静默断写回）；子模块 import 全在 rooms-core/members 之后（boot getter 快照时序，批10 契约）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SHELL = 'public/src/web/agent-graph-ui.js';
const SUBMODULES = {
  models: 'public/src/web/agent-graph-models-ui.js',
  runs: 'public/src/web/agent-graph-runs-view-ui.js',
  actions: 'public/src/web/agent-graph-run-actions-ui.js',
  dispatch: 'public/src/web/agent-graph-dispatch-ui.js',
  evidence: 'public/src/web/agent-graph-evidence-ui.js',
};
const ENTRY_FILE = 'public/main.js';

// 函数属主表：拆分后每个 function 名在 6 文件里必须恰好一处定义（防双实现/漏迁）
const OWNERS = {
  [SHELL]: [
    'openAgentRegistryModal', 'closeAgentRegistryModal', 'refreshAgentRegistry',
    'renderAgentRegistryModal', 'renderAgentRegistrySummary', 'renderAgentRegistryTabs',
    'renderAgentRegistryActiveTab', 'renderAgentProfilesTab', 'renderAgentDispatchTab',
    'renderAgentPoliciesTab', 'renderAgentRule', 'bindAgentRegistryModalEvents',
    'setAgentRegistryTab', 'saveAgentPolicy', 'resetAgentPolicy', 'openAgentRunFromActivity',
  ],
  [SUBMODULES.models]: [
    'modelSkillProviderRole', 'renderModelOptionChips', 'modelSkillModelCount',
    'modelSkillPreferredModel', 'modelSkillPickProvider', 'buildModelSkillRecommendations',
    'buildSkillSourceRows', 'skillSourceRiskLabels', 'renderAgentModelSkillCenterTab',
    'renderSkillSourceRiskRow', 'renderAgentSkillMatrixRow', 'renderAgentProfileCard',
    'renderAgentGovernance', 'renderAgentPolicyEditor', 'getAgentPolicyEditor', 'readAgentPolicyEditor',
  ],
  [SUBMODULES.runs]: [
    'renderAgentRunsTab', 'agentRunMetricText', 'agentRunDiagnosticsCount', 'renderAgentRunRow',
    'latestIdeaRunStage', 'latestIdeaRunArchive', 'ideaRunArchiveSummary', 'ideaRunWorkflowState',
    'ideaRunWorkflowActions', 'renderAgentWorkflowButton', 'renderIdeaRunWorkflow',
    'renderAgentRunDetail', 'renderAgentRunSessionSummary', 'renderAgentRunLineage',
    'renderAgentRunMessage', 'renderAgentRunToolResult', 'renderAgentRunActivity',
    'latestIdeaRunManifestDraft', 'refreshAgentRuns', 'loadAgentRunDetail',
  ],
  [SUBMODULES.actions]: [
    'bindAgentRunsEvents', 'focusAgentRunBlock', 'openGovernanceCenterForAgentRun',
    'planAgentRunReplay', 'archiveAgentRunReplayResult', 'archiveAgentRun',
    'completeIdeaRunExecution', 'autoVerifyIdeaRun', 'generateIdeaRunManifest',
    'generateIdeaRunPatchManifest', 'defaultIdeaRunManifestText', 'parseIdeaRunManifestText',
    'editIdeaRunManifest',
  ],
  [SUBMODULES.dispatch]: [
    'renderWorkflowStep', 'renderAgentDispatchWorkflow', 'refreshAgentDispatchWorkflow',
    'runAgentPreview', 'createAgentRunFromIdea', 'agentPreviewCwd', 'renderAgentChangedFilesInfo',
    'sanitizeCodebaseQuestionAnswer', 'renderAgentCodebaseQuestionAnswer',
    'loadAgentChangedFiles', 'loadAgentCodebaseMap', 'parseAgentPreviewFiles',
  ],
  [SUBMODULES.evidence]: [
    'renderAgentRunArchives', 'renderAgentRunArtifacts', 'renderAgentRunApprovalResumeGate',
    'openAgentRunSessionExport', 'archiveAgentRunSessionEvidence', 'openAgentRunGateAuditReport',
    'archiveAgentRunGateAuditReport', 'openAgentRunArtifact', 'renderAgentClassification',
    'renderAgentMatchEvidence', 'renderAgentCodeContext', 'renderAgentCodebaseMap',
    'renderAgentSymbolGraph', 'renderAgentCodeEvidence', 'renderAgentSkillBindingPills',
    'renderAgentSkillDiagnostics',
  ],
};

describe('agent-graph 拆分第27批（2324 行壳+五子模块）', () => {
  const sources = Object.fromEntries(
    [SHELL, ...Object.values(SUBMODULES)].map((file) => [file, read(file)]),
  );
  const entrySrc = read(ENTRY_FILE);

  it('六文件全部 <500 行（工程硬规则）', () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src.split('\n').length, `${file} 行数超标`).toBeLessThan(500);
    }
  });

  it('每个函数在六文件中恰好一处定义（防双实现/漏迁）', () => {
    const allFiles = Object.keys(sources);
    for (const [owner, fns] of Object.entries(OWNERS)) {
      for (const fn of fns) {
        const needle = new RegExp(`(?:async )?function ${fn}\\(`);
        expect(sources[owner], `${owner} 缺 function ${fn}(`).toMatch(needle);
        for (const other of allFiles) {
          if (other === owner) continue;
          expect(sources[other], `${other} 不应再定义 function ${fn}(`).not.toMatch(needle);
        }
      }
    }
  });

  it('壳 window.PanelAgentGraph API 面 9 成员一字不改（batch15 字面量+app.js 桥 getter+e2e 直调全钉）', () => {
    const shell = sources[SHELL];
    expect(shell).toContain('open: openAgentRegistryModal,');
    expect(shell).toContain('openAgentRegistryModal, renderAgentRegistryModal,');
    expect(shell).toContain('openAgentRunFromActivity,');
    expect(shell).toContain('openAgentRunArtifact: (...a) => window.PanelAgentGraphEvidence?.openAgentRunArtifact?.(...a),');
    expect(shell).toContain('agentPreviewCwd: (...a) => window.PanelAgentGraphDispatch?.agentPreviewCwd?.(...a),');
    expect(shell).toContain('sanitizeCodebaseQuestionAnswer: (...a) => window.PanelAgentGraphDispatch?.sanitizeCodebaseQuestionAnswer?.(...a),');
    expect(shell).toContain('parseAgentPreviewFiles: (...a) => window.PanelAgentGraphDispatch?.parseAgentPreviewFiles?.(...a),');
    expect(shell).toContain('get state() { return agentRegistryState; },');
  });

  it('agentRegistryState 单一属主在壳；子模块经 agState() 调用期实时取且零解构快照', () => {
    expect(sources[SHELL]).toContain('const agentRegistryState = {');
    for (const [name, file] of Object.entries(SUBMODULES)) {
      const src = sources[file];
      expect(src, `${name} 不应自建 agentRegistryState`).not.toContain('const agentRegistryState = {');
      expect(src, `${name} 缺 agState() 实时取`).toContain('const agState = () => window.PanelAgentGraph.state;');
      expect(src, `${name} 禁对 PanelAgentGraph/state 解构（断写回）`).not.toMatch(/const \{[^}]*\}\s*=\s*window\.PanelAgentGraph/);
      expect(src, `${name} 禁 boot 期快照 state 对象`).not.toMatch(/const \w+\s*=\s*window\.PanelAgentGraph\.state;/);
    }
  });

  it('五子模块各自挂 window.PanelAgentGraph* 命名空间（smoke SMOKE_EXPECT_GLOBALS 钉 6 全局）', () => {
    expect(sources[SUBMODULES.models]).toContain('window.PanelAgentGraphModels = {');
    expect(sources[SUBMODULES.runs]).toContain('window.PanelAgentGraphRuns = {');
    expect(sources[SUBMODULES.actions]).toContain('window.PanelAgentGraphRunActions = {');
    expect(sources[SUBMODULES.dispatch]).toContain('window.PanelAgentGraphDispatch = {');
    expect(sources[SUBMODULES.evidence]).toContain('window.PanelAgentGraphEvidence = {');
  });

  it('跨模块互调全走 window 懒解析（抽查关键链路字面量）', () => {
    const shell = sources[SHELL];
    // 壳 → 子模块
    expect(shell).toContain("window.PanelAgentGraphModels?.renderAgentModelSkillCenterTab?.(snapshot) || ''");
    expect(shell).toContain("window.PanelAgentGraphRuns?.renderAgentRunsTab?.() || ''");
    expect(shell).toContain('window.PanelAgentGraphRunActions?.bindAgentRunsEvents?.(root);');
    expect(shell).toContain('window.PanelAgentGraphRuns?.refreshAgentRuns?.();');
    expect(shell).toContain('window.PanelAgentGraphModels?.readAgentPolicyEditor?.(profileId)');
    // runs-view → dispatch/evidence/壳
    expect(sources[SUBMODULES.runs]).toContain('window.PanelAgentGraphDispatch?.renderWorkflowStep?.(step.label, step.status, step.meta)');
    expect(sources[SUBMODULES.runs]).toContain('window.PanelAgentGraphEvidence?.renderAgentRunApprovalResumeGate?.(run.details?.approvalResumeGateAudit, run.id)');
    expect(sources[SUBMODULES.runs]).toContain('window.PanelAgentGraph?.renderAgentRegistryModal?.();');
    // run-actions → runs-view/evidence
    expect(sources[SUBMODULES.actions]).toContain('window.PanelAgentGraphRuns?.refreshAgentRuns?.()');
    expect(sources[SUBMODULES.actions]).toContain('window.PanelAgentGraphRuns?.loadAgentRunDetail?.(id)');
    expect(sources[SUBMODULES.actions]).toContain('window.PanelAgentGraphEvidence?.openAgentRunArtifact?.(btn.dataset.agentRunArtifactRun, btn.dataset.agentRunArtifactDownload, btn)');
    // dispatch → evidence/壳；evidence → models/dispatch
    expect(sources[SUBMODULES.dispatch]).toContain("window.PanelAgentGraphEvidence?.renderAgentClassification?.(result) || ''");
    expect(sources[SUBMODULES.evidence]).toContain('window.PanelAgentGraphModels?.renderAgentGovernance?.(result.governance || result.profile?.governance');
    expect(sources[SUBMODULES.evidence]).toContain('window.PanelAgentGraphDispatch?.renderAgentCodebaseQuestionAnswer?.(result.codebaseQuestionAnswer || agState().codebaseQuestionAnswer)');
  });

  it('main.js 六 import 全带 batch27 缓存串，壳在前、五子模块紧随，且全在 rooms-core/members 之后（批10 时序契约）', () => {
    const imports = [
      './src/web/agent-graph-ui.js?v=appjs-migration-batch27-20260611',
      './src/web/agent-graph-models-ui.js?v=appjs-migration-batch27-20260611',
      './src/web/agent-graph-runs-view-ui.js?v=appjs-migration-batch27-20260611',
      './src/web/agent-graph-run-actions-ui.js?v=appjs-migration-batch27-20260611',
      './src/web/agent-graph-dispatch-ui.js?v=appjs-migration-batch27-20260611',
      './src/web/agent-graph-evidence-ui.js?v=appjs-migration-batch27-20260611',
    ];
    let last = -1;
    for (const spec of imports) {
      const idx = entrySrc.indexOf(`import '${spec}';`);
      expect(idx, `main.js 缺 import ${spec}`).toBeGreaterThan(-1);
      expect(idx, `${spec} import 顺序错（壳须最先，子模块紧随）`).toBeGreaterThan(last);
      last = idx;
    }
    const coreIdx = entrySrc.indexOf('rooms-core-ui.js');
    const membersIdx = entrySrc.indexOf('rooms-members-ui.js');
    const shellIdx = entrySrc.indexOf('agent-graph-ui.js');
    expect(coreIdx).toBeLessThan(shellIdx);
    expect(membersIdx).toBeLessThan(shellIdx);
    // batch10 钉 indexOf('agent-graph-ui.js')：首个命中必须就是壳 import 行（新文件名不含该精确子串）
    expect(entrySrc.slice(shellIdx, shellIdx + 'agent-graph-ui.js?v=appjs-migration-batch27-20260611'.length))
      .toBe('agent-graph-ui.js?v=appjs-migration-batch27-20260611');
  });

  it('AGENT_POLICY_OPTIONS 随唯一消费者 renderAgentPolicyEditor 归 models，壳零残留', () => {
    expect(sources[SUBMODULES.models]).toContain('const AGENT_POLICY_OPTIONS = {');
    expect(sources[SHELL]).not.toContain('AGENT_POLICY_OPTIONS');
  });

  it('壳保留 boot 入口绑定与 e2e 探针 DOM 契约（#btnAgentRegistry/[data-close-agent-registry]）', () => {
    expect(sources[SHELL]).toContain("$('#btnAgentRegistry')?.addEventListener('click', openAgentRegistryModal);");
    expect(sources[SHELL]).toContain("document.querySelectorAll('[data-close-agent-registry]')");
  });
});
