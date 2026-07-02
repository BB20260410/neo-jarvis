// @ts-check
// agent-graph-runs-view-ui.js — 智能体图谱 Runs tab 渲染 + run 数据装载子模块
// （从 agent-graph-ui.js 分文件；第三波批27 2026-06-11；纯机械搬移零逻辑改动）
// 持有：renderAgentRunsTab/run 行/run 详情/Idea-to-Archive run 工作流/Session Timeline/Lineage 渲染
//   + latestIdeaRunManifestDraft（本文件 ideaRunWorkflowState 是主消费者，run-actions 懒取）
//   + refreshAgentRuns/loadAgentRunDetail（写 runs/runTimeline/activeRunId 后回壳重渲）。
// 注：workflow 步骤条（renderWorkflowStep 等）按消费属主归 dispatch 文件；archives/artifacts/gate
//   渲染与 message/tool 之外的证据渲染归 evidence 文件——均经 window.PanelAgentGraph* 懒解析（<500 硬规则）。
// 共享状态 agentRegistryState 经 agState() 调用期实时取（单一属主在壳，禁解构/浅拷贝快照）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const { escapeHtml, api, activityTime } = window.PanelCore;
    const agState = () => window.PanelAgentGraph.state;

function renderAgentRunsTab() {
  const f = agState().runFilters;
  const runs = agState().runs || [];
  const active = agState().runTimeline?.run || runs.find(run => run.id === agState().activeRunId) || null;
  return `<section class="agent-registry-section agent-runs-section">
    <div class="agent-runs-toolbar">
      <select id="agentRunStatusFilter" aria-label="Run status">
        ${['', 'queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'].map(status => `<option value="${status}" ${f.status === status ? 'selected' : ''}>${status || 'all status'}</option>`).join('')}
      </select>
      <input id="agentRunRoomFilter" type="text" placeholder="roomId" value="${escapeHtml(f.roomId)}" />
      <input id="agentRunSessionFilter" type="text" placeholder="sessionId" value="${escapeHtml(f.sessionId)}" />
      <input id="agentRunProfileFilter" type="text" placeholder="agentProfileId" value="${escapeHtml(f.agentProfileId)}" />
      <input id="agentRunSourceFilter" type="text" placeholder="sourceType" value="${escapeHtml(f.sourceType)}" />
      <input id="agentRunApprovalFilter" type="text" placeholder="approvalId" value="${escapeHtml(f.approvalId)}" />
      <input id="agentRunDelegationFilter" type="text" placeholder="delegationId" value="${escapeHtml(f.delegationId)}" />
      <input id="agentRunBudgetFilter" type="text" placeholder="budgetIncidentId" value="${escapeHtml(f.budgetIncidentId)}" />
      <input id="agentRunDeferFilter" type="text" placeholder="deferReason" value="${escapeHtml(f.deferReason)}" />
      <input id="agentRunGateFilter" type="text" placeholder="reviewGateId" value="${escapeHtml(f.approvalResumeGateId)}" />
      <input id="agentRunGateShaFilter" type="text" placeholder="reviewSha256" value="${escapeHtml(f.approvalResumeGateSha256)}" />
      <label class="agent-run-toggle"><input id="agentRunGovernanceFilter" type="checkbox" ${f.hasGovernance ? 'checked' : ''} /><span>治理链</span></label>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="agentRunsClear">清空</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="agentRunsRefresh">${agState().runsLoading ? '加载中…' : '刷新 Runs'}</button>
    </div>
    ${agState().runError ? `<div class="agent-empty error">${escapeHtml(agState().runError)}</div>` : ''}
    <div class="agent-runs-layout">
      <div class="agent-run-list">
        ${runs.length ? runs.map(renderAgentRunRow).join('') : `<div class="agent-empty">${agState().runsLoading ? '加载中…' : '暂无 Agent Run。'}</div>`}
      </div>
      <div class="agent-run-detail">
        ${active ? renderAgentRunDetail(active, agState().runTimeline) : '<div class="agent-empty">选择一个 run 查看 timeline、messages 和 tool results。</div>'}
      </div>
    </div>
  </section>`;
}

function agentRunMetricText(run = {}) {
  const d = run.details || {};
  const tokens = (Number(d.tokensIn) || 0) + (Number(d.tokensOut) || 0);
  const parts = [];
  if (tokens) parts.push(`${window.BudgetUtils.fmtBigInt(tokens)} tok`);
  if (Number(d.estCostUSD)) parts.push(window.BudgetUtils.fmtUSD(Number(d.estCostUSD)));
  if (Number(d.latencyMs)) parts.push(window.BudgetUtils.fmtMs(Number(d.latencyMs)));
  return parts.join(' · ') || '-';
}

function agentRunDiagnosticsCount(run = {}) {
  return Array.isArray(run.details?.diagnostics) ? run.details.diagnostics.length : 0;
}

function renderAgentRunRow(run) {
  const active = agState().activeRunId === run.id;
  const diagnostics = agentRunDiagnosticsCount(run);
  const lineage = run.lineageSummary || {};
  const governanceParts = [
    lineage.approvalCount ? `${lineage.approvalCount} approval` : '',
    lineage.delegationCount ? `${lineage.delegationCount} delegation` : '',
    lineage.budgetIncidentCount ? `${lineage.budgetIncidentCount} budget` : '',
    lineage.blockerCount ? `${lineage.blockerCount} blocker` : '',
  ].filter(Boolean).join(' · ');
  return `<button class="agent-run-row ${active ? 'is-active' : ''}" data-agent-run-id="${escapeHtml(run.id)}" type="button">
    <span class="agent-run-status status-${escapeHtml(run.status || 'unknown')}">${escapeHtml(run.status || '-')}</span>
    <strong>${escapeHtml(run.taskId || run.sourceType || run.id)}</strong>
    <em>${escapeHtml(run.agentProfileId || '-')} · ${escapeHtml(run.roomId || '-')}</em>
    <span>${escapeHtml(agentRunMetricText(run))}${diagnostics ? ` · ${diagnostics} diagnostics` : ''}${governanceParts ? ` · ${escapeHtml(governanceParts)}` : ''}</span>
    <small>${activityTime(run.updatedAt || run.createdAt)}</small>
  </button>`;
}

function latestIdeaRunStage(timeline = null, stage = '') {
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  return archives.some((archive) => archive.evidence?.external?.stage === stage);
}

function latestIdeaRunArchive(timeline = null, stage = '') {
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  for (const archive of archives.slice().reverse()) {
    if (!stage || archive.evidence?.external?.stage === stage) return archive;
  }
  return null;
}

function ideaRunArchiveSummary(archive = null, artifacts = []) {
  if (!archive) return null;
  const external = archive.evidence?.external || {};
  const fileCount = Array.isArray(external.fileChanges)
    ? external.fileChanges.length
    : Array.isArray(archive.evidence?.files) ? archive.evidence.files.length : 0;
  const blockers = archive.governance?.summary?.blockerCount ?? archive.governance?.blockers?.length ?? 0;
  return {
    id: archive.id || '',
    status: archive.status || 'archived',
    summary: archive.summary || archive.id || 'Execution archive recorded.',
    toolResultCount: Number(archive.verification?.toolResultCount || 0),
    fileCount: Number(fileCount || 0),
    artifactCount: Array.isArray(artifacts) ? artifacts.length : 0,
    blockerCount: Number(blockers || 0),
  };
}

function ideaRunWorkflowState(run = {}, timeline = null) {
  const messages = Array.isArray(timeline?.messages) ? timeline.messages : [];
  const toolResults = Array.isArray(timeline?.toolResults) ? timeline.toolResults : [];
  const archives = Array.isArray(timeline?.archives) ? timeline.archives : [];
  const artifacts = Array.isArray(timeline?.artifacts) ? timeline.artifacts : [];
  const manifestDraft = latestIdeaRunManifestDraft(timeline);
  const hasManifestDraft = Boolean(manifestDraft);
  const hasPatchDraft = Boolean(manifestDraft?.patchQuality || messages.some((message) => message.payload?.manifestDraft?.patchQuality));
  const hasApproval = Boolean(run.approvalId || run.details?.approvalId);
  const deferReason = run.deferReason || run.details?.deferReason || '';
  const isDeferredApproval = run.status === 'deferred' && (/approval/i.test(deferReason) || hasApproval);
  const hasGate = Boolean(run.details?.approvalResumeGateAudit);
  const finalArchive = latestIdeaRunArchive(timeline, 'idea_final_archive') || (['succeeded', 'failed', 'cancelled'].includes(run.status) ? latestIdeaRunArchive(timeline) : null);
  const hasFinalArchive = Boolean(finalArchive) || latestIdeaRunStage(timeline, 'idea_final_archive') || ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const hasVerification = toolResults.length > 0 || archives.some((archive) => Number(archive.verification?.toolResultCount) > 0);
  const hasArtifacts = artifacts.length > 0;
  const dispatchMeta = run.agentProfileId || (run.skills || []).join(', ') || 'profile';
  const finished = ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const nextLabel = isDeferredApproval
    ? 'Preflight Review 等待审批续跑'
    : !hasManifestDraft && !hasFinalArchive
      ? 'Generate Manifest 或 Generate Patch'
      : hasManifestDraft && !hasFinalArchive
        ? 'Auto Work + Verify'
        : hasGate
          ? 'Gate Audit Report / Archive Report'
          : 'Archive evidence ready';
  return {
    hasManifestDraft,
    hasPatchDraft,
    hasApproval,
    isDeferredApproval,
    hasGate,
    hasFinalArchive,
    hasVerification,
    hasArtifacts,
    dispatchMeta,
    nextLabel,
    finished,
    runId: run.id,
    approvalId: run.approvalId || run.details?.approvalId || '',
    archiveSummary: ideaRunArchiveSummary(finalArchive, artifacts),
    steps: [
      { label: 'Idea', status: 'done', meta: run.taskId || run.sourceId || 'captured' },
      { label: 'Dispatch', status: 'done', meta: dispatchMeta },
      { label: 'Manifest/Patch', status: hasManifestDraft || hasFinalArchive ? 'done' : 'current', meta: hasPatchDraft ? 'patch quality' : (hasManifestDraft ? 'manifest draft' : 'draft needed') },
      { label: 'Work + Verify', status: hasFinalArchive ? 'done' : (hasManifestDraft && !isDeferredApproval ? 'current' : 'pending'), meta: hasVerification ? 'verification evidence' : 'local verify' },
      { label: 'Preflight', status: hasGate ? 'done' : (isDeferredApproval ? 'current' : 'pending'), meta: hasGate ? 'gate accepted' : (isDeferredApproval ? 'approval required' : 'if needed') },
      { label: 'Archive', status: hasFinalArchive ? 'done' : 'pending', meta: hasArtifacts ? 'artifacts linked' : 'final evidence' },
    ],
  };
}

function ideaRunWorkflowActions(state = {}) {
  const runId = state.runId || '';
  const actions = { primary: null, secondary: [] };
  if (!runId) return actions;
  const action = (label, attrs = {}, variant = 'secondary') => ({ label, attrs, variant });
  if (state.isDeferredApproval) {
    actions.primary = action('Open Preflight Review', { 'data-agent-run-governance-review': runId }, 'primary');
    if (state.approvalId) actions.secondary.push(action('打开审批', { 'data-agent-run-approval': state.approvalId }, 'tertiary'));
    actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
    return actions;
  }
  if (!state.hasManifestDraft && !state.finished) {
    actions.primary = action('Generate Manifest', { 'data-agent-run-idea-generate-manifest': runId }, 'primary');
    actions.secondary.push(action('Generate Patch', { 'data-agent-run-idea-generate-patch': runId }, 'secondary'));
    actions.secondary.push(action('Run Custom Manifest', { 'data-agent-run-idea-manifest': runId }, 'secondary'));
    actions.secondary.push(action('Auto Work + Verify', { 'data-agent-run-idea-auto': runId }, 'secondary'));
    actions.secondary.push(action('Record Completion', { 'data-agent-run-idea-complete': runId }, 'tertiary'));
    return actions;
  }
  if (state.hasManifestDraft && !state.finished) {
    actions.primary = action('Auto Work + Verify', { 'data-agent-run-idea-auto': runId }, 'primary');
    actions.secondary.push(action('Edit Manifest', { 'data-agent-run-idea-manifest': runId }, 'secondary'));
    actions.secondary.push(action('Record Completion', { 'data-agent-run-idea-complete': runId }, 'tertiary'));
    return actions;
  }
  if (state.hasGate) {
    actions.primary = action('Gate Audit Report', { 'data-agent-run-gate-audit': runId }, 'primary');
    actions.secondary.push(action('Archive Report', { 'data-agent-run-gate-audit-archive': runId }, 'secondary'));
    actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
    return actions;
  }
  actions.primary = action('Review Archive', { 'data-agent-run-review-archive': runId }, 'primary');
  if (state.hasArtifacts) actions.secondary.push(action('Open Artifacts', { 'data-agent-run-open-artifacts': runId }, 'secondary'));
  actions.secondary.push(action('Add Archive Note', { 'data-agent-run-archive': runId }, 'secondary'));
  actions.secondary.push(action('Activity', { 'data-agent-run-activity': runId }, 'tertiary'));
  return actions;
}

function renderAgentWorkflowButton(action = null, options = {}) {
  if (!action) return '';
  const attrs = Object.entries(action.attrs || {})
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
    .join(' ');
  const marker = options.primary ? 'data-agent-main-next="true"' : 'data-agent-main-secondary="true"';
  const variant = action.variant === 'primary' ? 'cxbtn-primary'
    : action.variant === 'tertiary' ? 'cxbtn-tertiary'
      : 'cxbtn-secondary';
  return `<button class="cxbtn ${variant} cxbtn-sm ${options.primary ? 'agent-main-next-btn' : ''}" ${marker} ${attrs}>${escapeHtml(action.label || 'Open')}</button>`;
}

function renderIdeaRunWorkflow(run = {}, timeline = null) {
  if (run.sourceType !== 'idea_to_archive') return '';
  const state = ideaRunWorkflowState(run, timeline);
  const actions = ideaRunWorkflowActions(state);
  const archiveSummary = state.archiveSummary;
  return `<div class="agent-run-block agent-main-path" data-agent-main-path="run">
    <div class="agent-main-path-head">
      <strong>Idea-to-Archive Path</strong>
      <span>Next: ${escapeHtml(state.nextLabel)}</span>
    </div>
    <div class="agent-workflow-steps">
      ${state.steps.map((step) => window.PanelAgentGraphDispatch?.renderWorkflowStep?.(step.label, step.status, step.meta) || '').join('')}
    </div>
    ${archiveSummary ? `<div class="agent-main-archive-summary" data-agent-main-archive-summary>
      <div>
        <strong>Final archive</strong>
        <span>${escapeHtml(archiveSummary.summary)}</span>
      </div>
      <div class="agent-main-archive-stats">
        <span>${escapeHtml(archiveSummary.status)}</span>
        <span>${escapeHtml(archiveSummary.toolResultCount)} tools</span>
        <span>${escapeHtml(archiveSummary.fileCount)} files</span>
        <span>${escapeHtml(archiveSummary.artifactCount)} artifacts</span>
        <span>${escapeHtml(archiveSummary.blockerCount)} blockers</span>
      </div>
    </div>` : ''}
    <div class="agent-main-path-actions">
      <span class="agent-main-path-action-label">Recommended next</span>
      ${renderAgentWorkflowButton(actions.primary, { primary: true })}
      ${actions.secondary.length ? `<span class="agent-main-path-action-label">Other actions</span>${actions.secondary.map(item => renderAgentWorkflowButton(item)).join('')}` : ''}
    </div>
  </div>`;
}

function renderAgentRunDetail(run, timeline = null) {
  const messages = timeline?.messages || [];
  const toolResults = timeline?.toolResults || [];
  const activityEvents = timeline?.activityEvents || [];
  const governanceLineage = timeline?.governanceLineage || null;
  const archives = timeline?.archives || messages.filter(message => message.kind === 'archive' && message.payload?.archive).map(message => ({ ...message.payload.archive, messageId: message.id }));
  const artifacts = timeline?.artifacts || [];
  const diagnostics = run.details?.diagnostics || [];
  const budgetIncidentId = run.budgetIncidentId || run.details?.budgetIncidentId || governanceLineage?.budgetIncidents?.[0]?.id || '';
  const isIdeaRun = run.sourceType === 'idea_to_archive';
  return `<div class="agent-run-detail-inner">
    <div class="agent-run-detail-head">
      <div>
        <span class="agent-run-status status-${escapeHtml(run.status || 'unknown')}">${escapeHtml(run.status || '-')}</span>
        <strong>${escapeHtml(run.id)}</strong>
      </div>
      <span>${escapeHtml(agentRunMetricText(run))}</span>
    </div>
    <div class="agent-run-meta-grid">
      <div><b>Room</b><code>${escapeHtml(run.roomId || '-')}</code></div>
      <div><b>Session</b><code>${escapeHtml(run.sessionId || '-')}</code></div>
      <div><b>Profile</b><code>${escapeHtml(run.agentProfileId || '-')}</code></div>
      <div><b>Adapter</b><code>${escapeHtml(run.adapterId || '-')}</code></div>
      <div><b>Model</b><code>${escapeHtml(run.modelId || '-')}</code></div>
      <div><b>Source</b><code>${escapeHtml(run.sourceType || '-')} / ${escapeHtml(run.sourceId || '-')}</code></div>
      <div><b>Defer</b><code>${escapeHtml(run.deferReason || run.details?.deferReason || '-')}</code></div>
      <div><b>Approval</b><code>${escapeHtml(run.approvalId || run.details?.approvalId || '-')}</code></div>
      <div><b>Delegation</b><code>${escapeHtml(run.delegationId || run.details?.delegationId || '-')}</code></div>
      <div><b>Budget</b><code>${escapeHtml(budgetIncidentId || '-')}</code></div>
      <div><b>Next</b><code>${escapeHtml(governanceLineage?.nextAction?.type || run.lineageSummary?.nextActionType || '-')}</code></div>
    </div>
    <div class="agent-run-actions">
      ${run.approvalId || run.details?.approvalId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-approval="${escapeHtml(run.approvalId || run.details?.approvalId)}">打开审批</button>` : ''}
      ${run.delegationId || run.details?.delegationId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-delegation="${escapeHtml(run.delegationId || run.details?.delegationId)}">打开委派</button>` : ''}
      ${budgetIncidentId ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-budget="${escapeHtml(budgetIncidentId)}">预算 Activity</button>` : ''}
      <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-replay="${escapeHtml(run.id)}">Replay Plan</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-replay-result="${escapeHtml(run.id)}">Replay Result</button>
      ${!isIdeaRun ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-archive="${escapeHtml(run.id)}">Archive Run</button>` : ''}
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-activity="${escapeHtml(run.id)}">Activity</button>
    </div>
    ${governanceLineage ? renderAgentRunLineage(governanceLineage) : ''}
    ${renderIdeaRunWorkflow(run, timeline)}
    ${window.PanelAgentGraphEvidence?.renderAgentRunApprovalResumeGate?.(run.details?.approvalResumeGateAudit, run.id) || ''}
    ${renderAgentRunSessionSummary(timeline?.sessionTimeline)}
    ${window.PanelAgentGraphDispatch?.renderAgentCodebaseQuestionAnswer?.(run.details?.codebaseQuestionAnswer) || ''}
    ${archives.length ? (window.PanelAgentGraphEvidence?.renderAgentRunArchives?.(archives) || '') : ''}
    ${artifacts.length ? (window.PanelAgentGraphEvidence?.renderAgentRunArtifacts?.(artifacts, run.id) || '') : ''}
    ${diagnostics.length ? `<div class="agent-run-block"><h4>Diagnostics</h4>${diagnostics.slice(0, 6).map(item => `<div class="agent-run-line"><strong>${escapeHtml(item.code || 'diagnostic')}</strong><span>${escapeHtml(item.message || '')}</span></div>`).join('')}</div>` : ''}
    <div class="agent-run-block"><h4>Messages</h4>${messages.length ? messages.slice(-12).map(renderAgentRunMessage).join('') : '<div class="agent-empty">No messages.</div>'}</div>
    <div class="agent-run-block"><h4>Tool Results</h4>${toolResults.length ? toolResults.slice(-8).map(renderAgentRunToolResult).join('') : '<div class="agent-empty">No tool results.</div>'}</div>
    <div class="agent-run-block"><h4>Activity</h4>${activityEvents.length ? activityEvents.slice(-10).map(renderAgentRunActivity).join('') : '<div class="agent-empty">No related activity loaded.</div>'}</div>
  </div>`;
}

function renderAgentRunSessionSummary(sessionTimeline = null) {
  if (!sessionTimeline?.counts?.runs) return '';
  const counts = sessionTimeline.counts || {};
  const governance = sessionTimeline.governance || {};
  const evidenceChain = sessionTimeline.evidenceChain || {};
  const chainSummary = evidenceChain.summary || {};
  const statusText = Object.entries(sessionTimeline.statusCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  const sourceText = Object.entries(sessionTimeline.sourceTypeCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  const blockers = (governance.blockers || [])
    .slice(0, 4)
    .map(item => `${item.runId || '-'} ${item.kind}:${item.id || '-'}`)
    .join('; ') || '-';
  const nextActions = (governance.nextActions || [])
    .slice(0, 4)
    .map(item => `${item.runId || '-'} ${item.type || '-'}`)
    .join('; ') || '-';
  const recentRuns = (sessionTimeline.runs || []).slice(-6).reverse();
  const evidenceItems = (evidenceChain.items || []).slice(-8).reverse();
  const evidenceKindText = Object.entries(chainSummary.kindCounts || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ') || '-';
  return `<div class="agent-run-block agent-run-session">
    <div class="agent-run-block-head">
      <h4>Session Timeline</h4>
      <span>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-session-export="${escapeHtml(sessionTimeline.sessionId || '')}" type="button">Export Session</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-session-archive="${escapeHtml(sessionTimeline.sessionId || '')}" type="button">Archive Session</button>
      </span>
    </div>
    <div class="agent-run-line"><strong>session</strong><span>${escapeHtml(sessionTimeline.sessionId || '-')}</span></div>
    <div class="agent-run-line"><strong>counts</strong><span>${counts.runs || 0} runs · ${counts.messages || 0} messages · ${counts.toolResults || 0} tools · ${counts.archives || 0} archives · ${counts.activityEvents || 0} activity</span></div>
    <div class="agent-run-line"><strong>status</strong><span>${escapeHtml(statusText)}</span></div>
    <div class="agent-run-line"><strong>source</strong><span>${escapeHtml(sourceText)}</span></div>
    <div class="agent-run-line"><strong>blockers</strong><span>${escapeHtml(blockers)}</span></div>
    <div class="agent-run-line"><strong>next</strong><span>${escapeHtml(nextActions)}</span></div>
    <div class="agent-run-line"><strong>evidence</strong><span>${chainSummary.itemCount || 0} items · ${chainSummary.codebaseQuestionCount || 0} code answers · ${chainSummary.approvalResumeGateCount || 0} gates</span></div>
    <div class="agent-run-line"><strong>evidence kinds</strong><span>${escapeHtml(evidenceKindText)}</span></div>
    <div class="agent-run-session-list">
      ${recentRuns.map(run => `<button class="agent-run-session-chip ${agState().activeRunId === run.id ? 'is-active' : ''}" data-agent-run-id="${escapeHtml(run.id)}" type="button">
        <span>${escapeHtml(run.status || '-')}</span>
        <strong>${escapeHtml(run.taskId || run.sourceType || run.id)}</strong>
      </button>`).join('')}
    </div>
    ${evidenceItems.length ? `<div class="agent-run-evidence-chain">
      <h5>Session Evidence Chain</h5>
      ${evidenceItems.map(item => `<div class="agent-run-evidence-item">
        <code>#${item.sequence || '-'}</code>
        <strong>${escapeHtml(item.kind || '-')}</strong>
        <span>${escapeHtml(item.title || item.id || '-')}</span>
        <em>${escapeHtml(item.status || item.subkind || '-')}</em>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentRunLineage(lineage = {}) {
  const renderItems = (label, items) => {
    const text = (items || []).map(item => `${item.id}${item.status ? `:${item.status}` : ''}`).join(', ') || '-';
    return `<div class="agent-run-line"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>`;
  };
  const blockers = (lineage.blockers || []).map(item => `${item.kind}:${item.id || '-'} · ${item.reason || ''}`).join('; ') || '-';
  return `<div class="agent-run-block agent-run-lineage">
    <h4>Governance Chain</h4>
    ${renderItems('approvals', lineage.approvals)}
    ${renderItems('delegations', lineage.delegations)}
    ${renderItems('budget', lineage.budgetIncidents)}
    ${renderItems('autopilot', lineage.autopilotJobs)}
    <div class="agent-run-line"><strong>blockers</strong><span>${escapeHtml(blockers)}</span></div>
    <div class="agent-run-line"><strong>next</strong><span>${escapeHtml(lineage.nextAction?.label || lineage.nextAction?.type || '-')}</span></div>
  </div>`;
}

function renderAgentRunMessage(message) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(message.kind || message.role || 'message')}</strong>
    <span>${escapeHtml(message.summary || message.content || JSON.stringify(message.payload || {}).slice(0, 180))}</span>
  </div>`;
}

function renderAgentRunToolResult(result) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(result.toolName || 'tool')}</strong>
    <span>${escapeHtml(result.status || '-')}${result.outputSummary ? ` · ${escapeHtml(result.outputSummary)}` : ''}${Number(result.costUsd) ? ` · ${window.BudgetUtils.fmtUSD(Number(result.costUsd))}` : ''}</span>
  </div>`;
}

function renderAgentRunActivity(event) {
  return `<div class="agent-run-line">
    <strong>${escapeHtml(event.action || event.tag || 'activity')}</strong>
    <span>${escapeHtml(event.status || '')} ${activityTime(event.ts || event.createdAt)}</span>
  </div>`;
}

function latestIdeaRunManifestDraft(timeline = null) {
  const messages = Array.isArray(timeline?.messages) ? timeline.messages : [];
  for (const message of messages.slice().reverse()) {
    const draft = message.payload?.manifestDraft;
    if (message.kind === 'manifest_draft' && draft?.manifest && typeof draft.manifest === 'object') return draft;
  }
  return null;
}

async function refreshAgentRuns() {
  agState().runsLoading = true;
  agState().runError = '';
  window.PanelAgentGraph?.renderAgentRegistryModal?.();
  try {
    const params = new URLSearchParams();
    params.set('limit', '80');
    const f = agState().runFilters;
    if (f.status) params.set('status', f.status);
    if (f.roomId) params.set('roomId', f.roomId);
    if (f.sessionId) params.set('sessionId', f.sessionId);
    if (f.agentProfileId) params.set('agentProfileId', f.agentProfileId);
    if (f.sourceType) params.set('sourceType', f.sourceType);
    if (f.approvalId) params.set('approvalId', f.approvalId);
    if (f.delegationId) params.set('delegationId', f.delegationId);
    if (f.budgetIncidentId) params.set('budgetIncidentId', f.budgetIncidentId);
    if (f.deferReason) params.set('deferReason', f.deferReason);
    if (f.approvalResumeGateId) params.set('approvalResumeGateId', f.approvalResumeGateId);
    if (f.approvalResumeGateSha256) params.set('approvalResumeGateSha256', f.approvalResumeGateSha256);
    if (f.hasGovernance) params.set('hasGovernance', 'true');
    const result = await api('/api/agent-runs?' + params.toString());
    agState().runs = result.runs || [];
    if (!agState().activeRunId || !agState().runs.some(run => run.id === agState().activeRunId)) {
      agState().activeRunId = agState().runs[0]?.id || '';
      agState().runTimeline = null;
    }
  } catch (e) {
    agState().runError = e.message || '加载 Agent Runs 失败';
    agState().runs = [];
  } finally {
    agState().runsLoading = false;
    window.PanelAgentGraph?.renderAgentRegistryModal?.();
  }
}

async function loadAgentRunDetail(id) {
  if (!id) return;
  agState().activeRunId = id;
  agState().runTimeline = null;
  window.PanelAgentGraph?.renderAgentRegistryModal?.();
  try {
    agState().runTimeline = await api(`/api/agent-runs/${encodeURIComponent(id)}?includeSession=true&sessionLimit=80`);
    const run = agState().runTimeline?.run;
    if (run && !agState().runs.some(item => item.id === run.id)) {
      agState().runs = [run, ...agState().runs].slice(0, 80);
    }
  } catch (e) {
    agState().runError = e.message || '加载 Agent Run 失败';
  }
  window.PanelAgentGraph?.renderAgentRegistryModal?.();
}

    window.PanelAgentGraphRuns = {
      renderAgentRunsTab,
      refreshAgentRuns, loadAgentRunDetail,
      latestIdeaRunManifestDraft,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
