// @ts-check
// agent-graph-models-ui.js — 智能体图谱 Models/Skills Center + Profiles 卡片/策略编辑器子模块
// （从 agent-graph-ui.js 分文件；第三波批27 2026-06-11；纯机械搬移零逻辑改动）
// 持有：Model/Skill Center tab 全部渲染（modelSkillProviderRole→renderAgentSkillMatrixRow 整块）
//   + renderAgentProfileCard/renderAgentGovernance/renderAgentPolicyEditor/readAgentPolicyEditor
//   + AGENT_POLICY_OPTIONS（唯一消费者 renderAgentPolicyEditor 随属主迁入）。
// 注：renderAgentGovernance 被本卡片与 evidence.renderAgentClassification 双消费，统一收本文件经
//   window.PanelAgentGraphModels 懒解析；Profiles/Policies 卡片归此（evidence 行数预算，<500 硬规则）。
// 共享状态 agentRegistryState 经 agState() 调用期实时取（单一属主在壳，禁解构/浅拷贝快照）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const { escapeHtml, refreshRoomProviders, refreshRoomSkills, MODEL_OPTIONS } = window.PanelCore;
    const agState = () => window.PanelAgentGraph.state;

    const AGENT_POLICY_OPTIONS = {
  budgetTier: ['low', 'standard', 'high', 'restricted'],
  commandGuard: ['standard', 'strict'],
  approvalPolicy: [
    'read_only',
    'plan_changes_only',
    'dangerous_commands',
    'architecture_changes',
    'final_decision',
    'release_and_destructive_actions',
    'asset_export_changes',
  ],
  auditLevel: ['standard', 'full'],
};

function modelSkillProviderRole(providerId = '') {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('codex')) return 'implementation / verification';
  if (id.includes('claude') || id === 'ccr') return 'planning / architecture review';
  if (id.includes('ollama')) return 'local privacy / offline checks';
  if (id.includes('gemini')) return 'research / large context';
  if (id.includes('minimax')) return 'Chinese writing / draft review';
  return 'custom local adapter';
}

function renderModelOptionChips(providerId = '') {
  const options = (MODEL_OPTIONS[providerId] || [])
    .filter(Boolean)
    .slice(0, 5);
  if (options.length === 0) return '<span class="missing">custom model</span>';
  return options.map(option => `<span>${escapeHtml(option)}</span>`).join('');
}

function modelSkillModelCount(providerId = '') {
  return (MODEL_OPTIONS[providerId] || []).filter(Boolean).length;
}

function modelSkillPreferredModel(providerId = '') {
  return (MODEL_OPTIONS[providerId] || []).find(Boolean) || 'adapter default';
}

function modelSkillPickProvider(providers = [], preferred = []) {
  for (const key of preferred) {
    const found = providers.find(provider => String(provider.id || '').toLowerCase().includes(key));
    if (found) return found;
  }
  return providers[0] || null;
}

function buildModelSkillRecommendations(providers = []) {
  const cases = [
    ['implementation', ['codex', 'claude'], 'source changes and local verification'],
    ['verification', ['codex', 'gemini-cli', 'ollama'], 'tests, diff checks and repeatable evidence'],
    ['architecture', ['claude', 'codex'], 'cross-file design review and tradeoffs'],
    ['governance', ['codex', 'claude'], 'approval, budget, audit and gate reasoning'],
    ['research', ['gemini-cli', 'gemini', 'claude'], 'large-context local research support'],
    ['privacy/local', ['ollama'], 'offline or local-only checks when configured'],
  ];
  return cases.map(([label, preferred, reason]) => {
    const provider = modelSkillPickProvider(providers, preferred);
    return {
      label,
      provider,
      model: provider ? modelSkillPreferredModel(provider.id) : 'no active provider',
      reason,
      source: provider ? 'active adapter + local model list' : 'no matching active adapter',
    };
  });
}

function buildSkillSourceRows(profiles = [], rules = []) {
  const installed = new Map((window.PanelCore.roomSkillsCache || []).map(skill => [skill.name, skill]));
  const rows = new Map();
  function ensure(name) {
    if (!rows.has(name)) {
      const skill = installed.get(name) || {};
      rows.set(name, {
        name,
        displayName: skill.displayName || name,
        bodyLen: Number(skill.bodyLen || 0),
        updatedAt: skill.updatedAt || '',
        installed: installed.has(name),
        profileIds: [],
        dispatchTags: [],
      });
    }
    return rows.get(name);
  }
  for (const profile of profiles) {
    for (const skill of profile.skillCoverage || []) {
      ensure(skill.name).profileIds.push(profile.id);
    }
  }
  for (const rule of rules) {
    for (const name of rule.skillHints || []) {
      ensure(name).dispatchTags.push(rule.tag);
    }
  }
  for (const skill of window.PanelCore.roomSkillsCache || []) ensure(skill.name);
  return [...rows.values()].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? 1 : -1;
    const ar = a.profileIds.length + a.dispatchTags.length;
    const br = b.profileIds.length + b.dispatchTags.length;
    return br - ar || a.name.localeCompare(b.name);
  });
}

function skillSourceRiskLabels(row = {}) {
  const risks = [];
  const sourceCount = (row.profileIds || []).length + (row.dispatchTags || []).length;
  if (!row.installed) risks.push(['missing', 'missing']);
  if (sourceCount === 0) risks.push(['missing', 'not injected']);
  if (sourceCount >= 5) risks.push(['missing', 'multi-source']);
  if (Number(row.bodyLen || 0) > 50_000) risks.push(['missing', 'large prompt']);
  if (risks.length === 0) risks.push(['ok', 'ok']);
  return risks;
}

function renderAgentModelSkillCenterTab(snapshot) {
  if (!agState().modelSkillCenter.providersLoaded) {
    agState().modelSkillCenter.providersLoaded = true;
    refreshRoomProviders().then(() => {
      if (agState().activeTab === 'models') window.PanelAgentGraph?.renderAgentRegistryModal?.();
    });
  }
  if (!agState().modelSkillCenter.skillsLoaded) {
    agState().modelSkillCenter.skillsLoaded = true;
    refreshRoomSkills().then(() => {
      if (agState().activeTab === 'models') window.PanelAgentGraph?.renderAgentRegistryModal?.();
    });
  }

  const profiles = snapshot.profiles || [];
  const rules = snapshot.rules || [];
  const providers = window.PanelCore.roomProvidersCache || [];
  const activeProviderIds = new Set(providers.map(provider => provider.id).filter(Boolean));
  const knownProviders = Object.keys(MODEL_OPTIONS);
  const availableProviderIds = knownProviders.filter(id => !activeProviderIds.has(id));
  const installedSkillNames = new Set((window.PanelCore.roomSkillsCache || []).map(skill => skill.name));
  const missingSkillNames = snapshot.missingSkillNames || [];
  const dispatchSkillHints = [...new Set(rules.flatMap(rule => rule.skillHints || []))].sort();
  const missingDispatchHints = dispatchSkillHints.filter(name => !installedSkillNames.has(name));
  const boundSkillCount = profiles.reduce((sum, profile) => sum + (profile.skillCoverage || []).length, 0);
  const installedBoundSkillCount = profiles.reduce(
    (sum, profile) => sum + (profile.skillCoverage || []).filter(skill => skill.installed && skill.enabled).length,
    0,
  );
  const recommendations = buildModelSkillRecommendations(providers);
  const skillSourceRows = buildSkillSourceRows(profiles, rules);
  const sourceRiskCount = skillSourceRows.filter(row => skillSourceRiskLabels(row).some(([cls]) => cls === 'missing')).length;

  return `<section class="agent-registry-section agent-model-skill-center" data-agent-model-center>
    <div class="agent-model-center-head">
      <div>
        <h3>Model / Skill Center</h3>
        <p>Local status only · no secrets shown · provider config is read-only here</p>
      </div>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentModelSkillRefresh" type="button">刷新状态</button>
    </div>
    <div class="agent-model-kpis">
      <span><strong>${providers.length}</strong> active providers</span>
      <span><strong>${knownProviders.length}</strong> local model lists</span>
      <span><strong>${(window.PanelCore.roomSkillsCache || []).length}</strong> enabled skills</span>
      <span class="${missingSkillNames.length ? 'is-warn' : ''}"><strong>${missingSkillNames.length}</strong> missing bindings</span>
      <span class="${missingDispatchHints.length ? 'is-warn' : ''}"><strong>${missingDispatchHints.length}</strong> missing dispatch hints</span>
      <span class="${sourceRiskCount ? 'is-warn' : ''}"><strong>${sourceRiskCount}</strong> skill source risks</span>
    </div>
    <div class="agent-model-grid">
      <section class="agent-model-panel">
        <h4>Provider Model Status</h4>
        <div class="agent-provider-list">
          ${providers.length ? providers.map(provider => `
            <article class="agent-provider-row is-active">
              <div class="agent-provider-head">
                <strong>${escapeHtml(provider.displayName || provider.id)}</strong>
                <code>${escapeHtml(provider.id)}</code>
              </div>
              <div class="agent-provider-meta">
                <span>active local adapter</span>
                <span>${escapeHtml(modelSkillProviderRole(provider.id))}</span>
                <span>${modelSkillModelCount(provider.id)} local model hints</span>
                <span>No live ping</span>
              </div>
              <div class="agent-model-chip-list">${renderModelOptionChips(provider.id)}</div>
            </article>
          `).join('') : '<div class="agent-empty">No active providers reported by local room adapter pool.</div>'}
        </div>
        ${availableProviderIds.length ? `
          <div class="agent-provider-available">
            <h5>Configured option lists</h5>
            <div class="agent-model-chip-list">
              ${availableProviderIds.map(id => `<span title="${escapeHtml(modelSkillProviderRole(id))}">${escapeHtml(id)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </section>
      <section class="agent-model-panel">
        <h4>Model Recommendations</h4>
        <div class="agent-model-recommendation-list">
          ${recommendations.map(item => `
            <article class="agent-model-recommendation-row ${item.provider ? '' : 'is-missing'}">
              <div class="agent-provider-head">
                <strong>${escapeHtml(item.label)}</strong>
                <code>${escapeHtml(item.provider?.id || 'inactive')}</code>
              </div>
              <div class="agent-provider-meta">
                <span>${escapeHtml(item.provider?.displayName || 'no active provider')}</span>
                <span>${escapeHtml(item.model)}</span>
                <span>source: ${escapeHtml(item.source)}</span>
              </div>
              <p>${escapeHtml(item.reason)}</p>
            </article>
          `).join('')}
        </div>
      </section>
      <section class="agent-model-panel">
        <h4>Skill Injection Matrix</h4>
        <div class="agent-skill-matrix-summary">
          <span>${installedBoundSkillCount}/${boundSkillCount} bound skills installed</span>
          <span>${dispatchSkillHints.length} dispatch hints</span>
        </div>
        <div class="agent-skill-matrix">
          ${profiles.map(profile => renderAgentSkillMatrixRow(profile)).join('') || '<div class="agent-empty">No profiles.</div>'}
        </div>
        <div class="agent-skill-gap-list">
          <h5>Missing bindings</h5>
          <div class="agent-model-chip-list">
            ${missingSkillNames.length ? missingSkillNames.map(name => `<span class="missing">${escapeHtml(name)}</span>`).join('') : '<span class="ok">none</span>'}
          </div>
          <h5>Missing dispatch hints</h5>
          <div class="agent-model-chip-list">
            ${missingDispatchHints.length ? missingDispatchHints.map(name => `<span class="missing">${escapeHtml(name)}</span>`).join('') : '<span class="ok">none</span>'}
          </div>
        </div>
      </section>
      <section class="agent-model-panel agent-skill-source-panel">
        <h4>Skill Source & Risk</h4>
        <div class="agent-skill-matrix-summary">
          <span>${skillSourceRows.length} tracked skills</span>
          <span>${sourceRiskCount} source risks</span>
          <span>explicit conflict metadata not exposed by list API</span>
        </div>
        <div class="agent-skill-source-list">
          ${skillSourceRows.map(row => renderSkillSourceRiskRow(row)).join('') || '<div class="agent-empty">No skills reported by local registry.</div>'}
        </div>
      </section>
    </div>
  </section>`;
}

function renderSkillSourceRiskRow(row) {
  const profileText = (row.profileIds || []).slice(0, 6).join(', ') || 'none';
  const tagText = (row.dispatchTags || []).slice(0, 8).join(', ') || 'none';
  return `<article class="agent-skill-source-row" data-agent-skill-source="${escapeHtml(row.name)}">
    <div class="agent-skill-matrix-head">
      <strong>${escapeHtml(row.displayName || row.name)}</strong>
      <code>${escapeHtml(row.name)}</code>
    </div>
    <div class="agent-provider-meta">
      <span>profiles: ${escapeHtml(profileText)}</span>
      <span>dispatch: ${escapeHtml(tagText)}</span>
      <span>${Number(row.bodyLen || 0)} chars</span>
    </div>
    <div class="agent-model-chip-list">
      ${skillSourceRiskLabels(row).map(([cls, label]) => `<span class="${cls}">${escapeHtml(label)}</span>`).join('')}
    </div>
  </article>`;
}

function renderAgentSkillMatrixRow(profile) {
  const coverage = profile.skillCoverage || [];
  const installed = coverage.filter(skill => skill.installed && skill.enabled).length;
  const missing = coverage.filter(skill => !skill.installed || !skill.enabled);
  const policy = profile.governance || {};
  return `<article class="agent-skill-matrix-row" data-agent-skill-profile="${escapeHtml(profile.id)}">
    <div class="agent-skill-matrix-head">
      <strong>${escapeHtml(profile.title || profile.id)}</strong>
      <code>${escapeHtml(profile.id)}</code>
    </div>
    <div class="agent-provider-meta">
      ${(profile.roles || []).map(role => `<span>${escapeHtml(role)}</span>`).join('') || '<span>role fallback</span>'}
      <span>${installed}/${coverage.length} skills</span>
      <span>${escapeHtml(policy.approvalPolicy || 'approval inherited')}</span>
    </div>
    <div class="agent-model-chip-list">
      ${coverage.length ? coverage.map(skill => `<span class="${skill.installed && skill.enabled ? 'ok' : 'missing'}">${escapeHtml(skill.name)}</span>`).join('') : '<span class="missing">no bound skills</span>'}
    </div>
    ${missing.length ? `<div class="agent-skill-matrix-note">${missing.length} missing or disabled skill bindings need local registry attention.</div>` : ''}
  </article>`;
}

function renderAgentProfileCard(profile, { showPolicyEditor = false } = {}) {
  const coverage = profile.skillCoverage || [];
  const installed = coverage.filter(skill => skill.installed && skill.enabled).length;
  return `
    <article class="agent-profile-card ${profile.governanceOverridden ? 'is-policy-overridden' : ''}" data-agent-profile-id="${escapeHtml(profile.id)}">
      <div class="agent-profile-head">
        <strong>${escapeHtml(profile.title || profile.id)}</strong>
        <code>${escapeHtml(profile.id)}</code>
      </div>
      <div class="agent-profile-meta">${(profile.roles || []).map(role => `<span>${escapeHtml(role)}</span>`).join('')}</div>
      ${renderAgentGovernance(profile.governance, { overridden: profile.governanceOverridden })}
      ${showPolicyEditor ? renderAgentPolicyEditor(profile) : ''}
      <p>${escapeHtml(profile.mission || '')}</p>
      <div class="agent-skill-strip" title="${installed}/${coverage.length} bound skills installed">
        ${coverage.map(skill => `<span class="${skill.installed && skill.enabled ? 'ok' : 'missing'}">${escapeHtml(skill.name)}</span>`).join('') || '<span class="missing">no skills</span>'}
      </div>
    </article>
  `;
}

function renderAgentGovernance(policy, options = {}) {
  if (!policy) return '';
  return `<div class="agent-governance-strip">
    ${options.overridden ? '<span class="agent-policy-override">local override</span>' : ''}
    <span>budget ${escapeHtml(policy.budgetTier || 'standard')}</span>
    <span>guard ${escapeHtml(policy.commandGuard || 'standard')}</span>
    <span>approval ${escapeHtml(policy.approvalPolicy || 'dangerous_commands')}</span>
    <span>audit ${escapeHtml(policy.auditLevel || 'standard')}</span>
  </div>`;
}

function renderAgentPolicyEditor(profile) {
  const policy = profile.governance || {};
  const select = (field, label) => `
    <label>
      <span>${label}</span>
      <select data-agent-policy-field="${field}">
        ${(AGENT_POLICY_OPTIONS[field] || []).map(value => `<option value="${escapeHtml(value)}" ${(policy[field] || '') === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
      </select>
    </label>
  `;
  return `
    <div class="agent-policy-editor" data-agent-policy-editor="${escapeHtml(profile.id)}">
      ${select('budgetTier', 'Budget')}
      ${select('commandGuard', 'Guard')}
      ${select('approvalPolicy', 'Approval')}
      ${select('auditLevel', 'Audit')}
      <div class="agent-policy-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-policy-reset="${escapeHtml(profile.id)}" ${profile.governanceOverridden ? '' : 'disabled'}>重置</button>
        <button class="cxbtn cxbtn-primary cxbtn-sm" data-agent-policy-save="${escapeHtml(profile.id)}">保存策略</button>
      </div>
    </div>
  `;
}

function getAgentPolicyEditor(profileId) {
  const id = window.CSS?.escape ? CSS.escape(profileId) : String(profileId).replace(/["\\]/g, '\\$&');
  return document.querySelector(`[data-agent-policy-editor="${id}"]`);
}

function readAgentPolicyEditor(profileId) {
  const editor = getAgentPolicyEditor(profileId);
  if (!editor) throw new Error('policy editor not found');
  const governance = {};
  editor.querySelectorAll('[data-agent-policy-field]').forEach((field) => {
    governance[field.dataset.agentPolicyField] = field.value;
  });
  governance.budgetScope = 'agent_profile';
  return governance;
}

    window.PanelAgentGraphModels = {
      renderAgentModelSkillCenterTab,
      renderAgentProfileCard, renderAgentGovernance, readAgentPolicyEditor,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
