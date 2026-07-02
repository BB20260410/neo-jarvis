// agent-graph-ui.js — 智能体图谱（Agent Graph）UI 壳模块（从 app.js 外迁第5批；第三波批27 2026-06-11 拆 6 文件）
// 原 2324 行超 <500 约束 → 壳保名，只留：agentRegistryState 单一属主 + modal 壳/tab 路由 +
// bindAgentRegistryModalEvents/setAgentRegistryTab + saveAgentPolicy/resetAgentPolicy（调壳内
// refreshAgentRegistry，留壳免 API 面加内部通道）+ openAgentRunFromActivity（同理，且 e2e 直调最稳）。
// 五个子模块（boot FIFO=import 顺序，全在本壳 import 之后，main.js 同批接线）：
//   agent-graph-models-ui.js     Models/Skills Center + Profiles 卡片/策略编辑器 → window.PanelAgentGraphModels
//   agent-graph-runs-view-ui.js  Runs tab 渲染 + refreshAgentRuns/loadAgentRunDetail → window.PanelAgentGraphRuns
//   agent-graph-run-actions-ui.js bindAgentRunsEvents + replay/archive/idea 动作群 → window.PanelAgentGraphRunActions
//   agent-graph-dispatch-ui.js   Dispatch Preview 流 + workflow 条 + sanitize/parse → window.PanelAgentGraphDispatch
//   agent-graph-evidence-ui.js   classification/证据渲染 + session/gate 归档 + artifact → window.PanelAgentGraphEvidence
// ⚠️ window.PanelAgentGraph API 面 9 成员一字不改（batch15 钉 codebase-center 5 个懒调用字面量 + state getter；
//   app.js 桥 getter 437/438/447；e2e 直调 openAgentRunFromActivity）。agentRegistryState 是共享可写对象：
//   单一属主在本壳，子模块经 window.PanelAgentGraph.state 调用期实时取（禁解构/浅拷贝——会静默断写回）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      $, toast, escapeHtml, api,
      refreshRoomProviders, refreshRoomSkills,
    } = window.PanelCore;

    const agentRegistryState = {
  activeTab: 'dispatch',
  snapshot: null,
  classification: null,
  text: '重构多 Agent 架构，并用浏览器测试预算治理和审批流程。',
  affectedFiles: 'src/agents/AgentSkillRegistry.js\npublic/app.js\ntests/unit/agent-skill-registry.test.js',
  lastNonEmptyAffectedFiles: 'src/agents/AgentSkillRegistry.js\npublic/app.js\ntests/unit/agent-skill-registry.test.js',
  previewFilesRevision: 0,
  previewFilesRequestSeq: 0,
  previewFilesClearedByUser: false,
  changedFilesInfo: null,
  codeContextEvidence: [],
  codeContextGraph: null,
  codebaseMap: null,
  codebaseQuestionAnswer: null,
  memberRole: 'dev',
  runs: [],
  runsLoading: false,
  runTimeline: null,
  runError: '',
  activeRunId: '',
  runFilters: {
    status: '',
    roomId: '',
    sessionId: '',
    agentProfileId: '',
    sourceType: '',
    approvalId: '',
    delegationId: '',
    budgetIncidentId: '',
    deferReason: '',
    approvalResumeGateId: '',
    approvalResumeGateSha256: '',
    hasGovernance: false,
  },
  modelSkillCenter: {
    providersLoaded: false,
    skillsLoaded: false,
  },
};

async function openAgentRegistryModal() {
  $('#agentRegistryModal').style.display = 'flex';
  await refreshAgentRegistry();
}
function closeAgentRegistryModal() { $('#agentRegistryModal').style.display = 'none'; }

async function refreshAgentRegistry() {
  const root = $('#agentRegistryModalBody');
  if (!root) return;
  root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
  try {
    agentRegistryState.snapshot = await api('/api/agent-registry');
    renderAgentRegistryModal();
  } catch (e) {
    root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderAgentRegistryModal() {
  const root = $('#agentRegistryModalBody');
  const snapshot = agentRegistryState.snapshot;
  if (!root || !snapshot) return;
  root.innerHTML = `
    ${renderAgentRegistrySummary(snapshot)}
    ${renderAgentRegistryTabs()}
    <div class="agent-registry-panel">
      ${renderAgentRegistryActiveTab(snapshot)}
    </div>
  `;
  bindAgentRegistryModalEvents();
}

function renderAgentRegistrySummary(snapshot) {
  const missing = snapshot.missingSkillNames || [];
  return `<div class="agent-registry-summary">
    <span><strong>${snapshot.counts?.profiles || 0}</strong> profiles</span>
    <span><strong>${snapshot.counts?.rules || 0}</strong> dispatch rules</span>
    <span><strong>${snapshot.counts?.installedSkills || 0}</strong> installed skills</span>
    <span class="${missing.length ? 'is-warn' : ''}"><strong>${missing.length}</strong> missing bindings</span>
    <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentRegistryRefresh">刷新</button>
  </div>`;
}

function renderAgentRegistryTabs() {
  const tabs = [
    ['profiles', 'Profiles'],
    ['dispatch', 'Dispatch'],
    ['models', 'Models/Skills'],
    ['runs', 'Runs'],
    ['policies', 'Policies'],
  ];
  return `<div class="agent-registry-tabs" role="tablist">
    ${tabs.map(([id, label]) => `<button class="agent-registry-tab ${agentRegistryState.activeTab === id ? 'is-active' : ''}" data-agent-tab="${id}" type="button">${label}</button>`).join('')}
  </div>`;
}

function renderAgentRegistryActiveTab(snapshot) {
  if (agentRegistryState.activeTab === 'profiles') return renderAgentProfilesTab(snapshot);
  if (agentRegistryState.activeTab === 'models') return window.PanelAgentGraphModels?.renderAgentModelSkillCenterTab?.(snapshot) || '';
  if (agentRegistryState.activeTab === 'runs') return window.PanelAgentGraphRuns?.renderAgentRunsTab?.() || '';
  if (agentRegistryState.activeTab === 'policies') return renderAgentPoliciesTab(snapshot);
  return renderAgentDispatchTab(snapshot);
}

function renderAgentProfilesTab(snapshot) {
  const profiles = snapshot.profiles || [];
  return `<section class="agent-registry-section">
    <h3>Profiles</h3>
    <div class="agent-profile-grid">
      ${profiles.map(profile => window.PanelAgentGraphModels?.renderAgentProfileCard?.(profile, { showPolicyEditor: false }) || '').join('') || '<div class="agent-empty">No profiles.</div>'}
    </div>
  </section>`;
}

function renderAgentDispatchTab(snapshot) {
  const rules = snapshot.rules || [];
  return `<div class="agent-registry-layout agent-registry-layout-dispatch">
    <section class="agent-registry-rules">
      <h3>Dispatch Rules</h3>
      <div class="agent-rule-list">
        ${rules.map(renderAgentRule).join('') || '<div class="agent-empty">No dispatch rules.</div>'}
      </div>
    </section>
    <section class="agent-registry-lab">
      <h3>Dispatch Preview</h3>
      ${window.PanelAgentGraphDispatch?.renderAgentDispatchWorkflow?.() || ''}
      <div class="agent-preview-form">
        <select id="agentPreviewRole" aria-label="预演角色">
          ${['pm', 'dev', 'qa', 'architect', 'judge', 'shipper', 'designer', 'observer'].map(role => `<option value="${role}" ${agentRegistryState.memberRole === role ? 'selected' : ''}>${role}</option>`).join('')}
        </select>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewLoadChanged">当前变更</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewLoadCodebase">工程地图</button>
        <button class="cxbtn cxbtn-primary cxbtn-sm" id="agentPreviewRun">预演分派</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentPreviewCreateRun">创建 Run Draft</button>
      </div>
      <textarea id="agentPreviewText" rows="5" placeholder="输入一个任务，查看会命中哪些 tag、profile 和 skill">${escapeHtml(agentRegistryState.text)}</textarea>
      <textarea id="agentPreviewFiles" rows="4" placeholder="可选：粘贴受影响文件路径，每行一个；用于观察工程上下文如何影响分派">${escapeHtml(agentRegistryState.affectedFiles)}</textarea>
      <div id="agentPreviewFilesInfo" class="agent-preview-files-info">${window.PanelAgentGraphDispatch?.renderAgentChangedFilesInfo?.(agentRegistryState.changedFilesInfo) || ''}</div>
      <div id="agentPreviewQuestionInfo">${window.PanelAgentGraphDispatch?.renderAgentCodebaseQuestionAnswer?.(agentRegistryState.codebaseQuestionAnswer) || ''}</div>
      <div id="agentPreviewResult" class="agent-preview-result">
        ${agentRegistryState.classification ? (window.PanelAgentGraphEvidence?.renderAgentClassification?.(agentRegistryState.classification) || '') : '<div class="agent-empty">输入任务后点击预演。</div>'}
      </div>
    </section>
  </div>`;
}

function renderAgentPoliciesTab(snapshot) {
  const profiles = snapshot.profiles || [];
  return `<section class="agent-registry-section">
    <h3>Policies</h3>
    <div class="agent-profile-grid">
      ${profiles.map(profile => window.PanelAgentGraphModels?.renderAgentProfileCard?.(profile, { showPolicyEditor: true }) || '').join('') || '<div class="agent-empty">No policies.</div>'}
    </div>
  </section>`;
}

function renderAgentRule(rule) {
  return `
    <div class="agent-rule-row">
      <div>
        <strong>${escapeHtml(rule.tag)}</strong>
        <span>${escapeHtml(rule.agentId)}</span>
      </div>
      <div class="agent-rule-keywords">${(rule.keywords || []).slice(0, 10).map(k => `<span>${escapeHtml(k)}</span>`).join('')}</div>
    </div>
  `;
}

function bindAgentRegistryModalEvents() {
  const root = $('#agentRegistryModalBody');
  $('#agentRegistryRefresh')?.addEventListener('click', refreshAgentRegistry);
  $('#agentModelSkillRefresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '刷新中…';
    agentRegistryState.modelSkillCenter.providersLoaded = true;
    agentRegistryState.modelSkillCenter.skillsLoaded = true;
    window.PanelCore.roomSkillsLoaded = false;
    await Promise.all([refreshRoomProviders(), refreshRoomSkills()]);
    renderAgentRegistryModal();
  });
  document.querySelectorAll('[data-agent-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setAgentRegistryTab(btn.dataset.agentTab));
  });
  $('#agentPreviewRole')?.addEventListener('change', (e) => {
    agentRegistryState.memberRole = e.target.value;
    agentRegistryState.classification = null;
    window.PanelAgentGraphDispatch?.refreshAgentDispatchWorkflow?.();
  });
  $('#agentPreviewText')?.addEventListener('input', (e) => {
    agentRegistryState.text = e.target.value;
    agentRegistryState.classification = null;
    window.PanelAgentGraphDispatch?.refreshAgentDispatchWorkflow?.();
  });
  $('#agentPreviewFiles')?.addEventListener('input', (e) => {
    agentRegistryState.affectedFiles = e.target.value;
    agentRegistryState.previewFilesRevision += 1;
    const files = window.PanelAgentGraphDispatch?.parseAgentPreviewFiles?.(e.target.value) || [];
    if (files.length > 0) {
      agentRegistryState.lastNonEmptyAffectedFiles = e.target.value;
      agentRegistryState.previewFilesClearedByUser = false;
    } else {
      agentRegistryState.previewFilesClearedByUser = true;
    }
    agentRegistryState.changedFilesInfo = null;
    agentRegistryState.codeContextEvidence = [];
    agentRegistryState.codeContextGraph = null;
    agentRegistryState.codebaseMap = null;
    agentRegistryState.codebaseQuestionAnswer = null;
    agentRegistryState.classification = null;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = '';
    const questionInfo = $('#agentPreviewQuestionInfo');
    if (questionInfo) questionInfo.innerHTML = '';
    window.PanelAgentGraphDispatch?.refreshAgentDispatchWorkflow?.();
  });
  $('#agentPreviewLoadChanged')?.addEventListener('click', (e) => window.PanelAgentGraphDispatch?.loadAgentChangedFiles?.(e.currentTarget));
  $('#agentPreviewLoadCodebase')?.addEventListener('click', (e) => window.PanelAgentGraphDispatch?.loadAgentCodebaseMap?.(e.currentTarget));
  $('#agentPreviewRun')?.addEventListener('click', () => window.PanelAgentGraphDispatch?.runAgentPreview?.());
  $('#agentPreviewCreateRun')?.addEventListener('click', (e) => window.PanelAgentGraphDispatch?.createAgentRunFromIdea?.(e.currentTarget));
  root.querySelectorAll('[data-agent-policy-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveAgentPolicy(btn.dataset.agentPolicySave, btn));
  });
  root.querySelectorAll('[data-agent-policy-reset]').forEach((btn) => {
    btn.addEventListener('click', () => resetAgentPolicy(btn.dataset.agentPolicyReset, btn));
  });
  window.PanelAgentGraphRunActions?.bindAgentRunsEvents?.(root);
}

function setAgentRegistryTab(tab) {
  agentRegistryState.activeTab = tab || 'dispatch';
  renderAgentRegistryModal();
  if (agentRegistryState.activeTab === 'runs' && !agentRegistryState.runsLoading && agentRegistryState.runs.length === 0) {
    window.PanelAgentGraphRuns?.refreshAgentRuns?.();
  }
}

async function saveAgentPolicy(profileId, button = null) {
  try {
    if (button) button.disabled = true;
    const governance = window.PanelAgentGraphModels?.readAgentPolicyEditor?.(profileId);
    if (!governance) throw new Error('policy editor not found');
    await api(`/api/agent-registry/profiles/${encodeURIComponent(profileId)}/governance`, {
      method: 'PUT',
      body: JSON.stringify({ governance }),
    });
    agentRegistryState.classification = null;
    toast('Agent 治理策略已保存', 'success', 1600);
    await refreshAgentRegistry();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function resetAgentPolicy(profileId, button = null) {
  try {
    if (button) button.disabled = true;
    await api(`/api/agent-registry/profiles/${encodeURIComponent(profileId)}/governance`, {
      method: 'DELETE',
    });
    agentRegistryState.classification = null;
    toast('Agent 治理策略已重置', 'success', 1600);
    await refreshAgentRegistry();
  } catch (e) {
    toast('重置失败：' + e.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function openAgentRunFromActivity(id) {
  if (!id) return;
  window.PanelActivity.close();
  agentRegistryState.activeTab = 'runs';
  agentRegistryState.activeRunId = id;
  $('#agentRegistryModal').style.display = 'flex';
  if (!agentRegistryState.snapshot) {
    await refreshAgentRegistry();
  } else {
    renderAgentRegistryModal();
  }
  await window.PanelAgentGraphRuns?.loadAgentRunDetail?.(id);
}

$('#btnAgentRegistry')?.addEventListener('click', openAgentRegistryModal);
document.querySelectorAll('[data-close-agent-registry]').forEach(el => el.addEventListener('click', closeAgentRegistryModal));


    window.PanelAgentGraph = {
      open: openAgentRegistryModal,
      openAgentRegistryModal, renderAgentRegistryModal,
      openAgentRunFromActivity,
      openAgentRunArtifact: (...a) => window.PanelAgentGraphEvidence?.openAgentRunArtifact?.(...a),
      agentPreviewCwd: (...a) => window.PanelAgentGraphDispatch?.agentPreviewCwd?.(...a),
      sanitizeCodebaseQuestionAnswer: (...a) => window.PanelAgentGraphDispatch?.sanitizeCodebaseQuestionAnswer?.(...a),
      parseAgentPreviewFiles: (...a) => window.PanelAgentGraphDispatch?.parseAgentPreviewFiles?.(...a),
      get state() { return agentRegistryState; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
