// @ts-check
// agent-graph-run-actions-ui.js — 智能体图谱 Runs 事件绑定 + run 生命周期动作子模块
// （从 agent-graph-ui.js 分文件；第三波批27 2026-06-11；纯机械搬移零逻辑改动）
// 持有：bindAgentRunsEvents（12 过滤器+全部 data-attr 委托）+ replay/archive/complete/auto-verify/
//   generate manifest/patch + idea manifest 编辑（default/parse/edit）+ focusAgentRunBlock +
//   openGovernanceCenterForAgentRun。绑定与动作同文件直引；跨模块全走 window 懒解析：
//   刷新/详情 → PanelAgentGraphRuns；session/gate 归档与 artifact 动作 → PanelAgentGraphEvidence（<500 预算归彼）。
// 共享状态 agentRegistryState 经 agState() 调用期实时取（单一属主在壳，禁解构/浅拷贝快照）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      $, toast, api, fallbackCopy,
      openApprovalModal, openDelegationModal,
    } = window.PanelCore;
    const promptModal = (...args) => window.PanelDialog.promptModal(...args);
    const agState = () => window.PanelAgentGraph.state;
    const refreshAgentRuns = () => window.PanelAgentGraphRuns?.refreshAgentRuns?.();
    const loadAgentRunDetail = (id) => window.PanelAgentGraphRuns?.loadAgentRunDetail?.(id);

function bindAgentRunsEvents(root) {
  if (!root) return;
  $('#agentRunStatusFilter')?.addEventListener('change', (e) => {
    agState().runFilters.status = e.target.value;
    refreshAgentRuns();
  });
  $('#agentRunRoomFilter')?.addEventListener('change', (e) => {
    agState().runFilters.roomId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunSessionFilter')?.addEventListener('change', (e) => {
    agState().runFilters.sessionId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunProfileFilter')?.addEventListener('change', (e) => {
    agState().runFilters.agentProfileId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunSourceFilter')?.addEventListener('change', (e) => {
    agState().runFilters.sourceType = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunApprovalFilter')?.addEventListener('change', (e) => {
    agState().runFilters.approvalId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunDelegationFilter')?.addEventListener('change', (e) => {
    agState().runFilters.delegationId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunBudgetFilter')?.addEventListener('change', (e) => {
    agState().runFilters.budgetIncidentId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunDeferFilter')?.addEventListener('change', (e) => {
    agState().runFilters.deferReason = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGateFilter')?.addEventListener('change', (e) => {
    agState().runFilters.approvalResumeGateId = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGateShaFilter')?.addEventListener('change', (e) => {
    agState().runFilters.approvalResumeGateSha256 = e.target.value.trim();
    refreshAgentRuns();
  });
  $('#agentRunGovernanceFilter')?.addEventListener('change', (e) => {
    agState().runFilters.hasGovernance = e.target.checked;
    refreshAgentRuns();
  });
  $('#agentRunsClear')?.addEventListener('click', () => {
    agState().runFilters = {
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
    };
    refreshAgentRuns();
  });
  $('#agentRunsRefresh')?.addEventListener('click', () => refreshAgentRuns());
  root.querySelectorAll('[data-agent-run-id]').forEach((btn) => {
    btn.addEventListener('click', () => loadAgentRunDetail(btn.dataset.agentRunId));
  });
  root.querySelectorAll('[data-agent-run-approval]').forEach((btn) => {
    btn.addEventListener('click', () => openApprovalModal(btn.dataset.agentRunApproval));
  });
  root.querySelectorAll('[data-agent-run-delegation]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.PanelCore.delegationState != null) window.PanelCore.delegationState.activeId = btn.dataset.agentRunDelegation;
      openDelegationModal();
    });
  });
  root.querySelectorAll('[data-agent-run-budget]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelActivity.open({ q: btn.dataset.agentRunBudget }));
  });
  root.querySelectorAll('[data-agent-run-replay]').forEach((btn) => {
    btn.addEventListener('click', () => planAgentRunReplay(btn.dataset.agentRunReplay, btn));
  });
  root.querySelectorAll('[data-agent-run-replay-result]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRunReplayResult(btn.dataset.agentRunReplayResult, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-auto]').forEach((btn) => {
    btn.addEventListener('click', () => autoVerifyIdeaRun(btn.dataset.agentRunIdeaAuto, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-generate-manifest]').forEach((btn) => {
    btn.addEventListener('click', () => generateIdeaRunManifest(btn.dataset.agentRunIdeaGenerateManifest, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-generate-patch]').forEach((btn) => {
    btn.addEventListener('click', () => generateIdeaRunPatchManifest(btn.dataset.agentRunIdeaGeneratePatch, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-manifest]').forEach((btn) => {
    btn.addEventListener('click', () => editIdeaRunManifest(btn.dataset.agentRunIdeaManifest, btn));
  });
  root.querySelectorAll('[data-agent-run-idea-complete]').forEach((btn) => {
    btn.addEventListener('click', () => completeIdeaRunExecution(btn.dataset.agentRunIdeaComplete, btn));
  });
  root.querySelectorAll('[data-agent-run-governance-review]').forEach((btn) => {
    btn.addEventListener('click', () => openGovernanceCenterForAgentRun(btn.dataset.agentRunGovernanceReview, btn));
  });
  root.querySelectorAll('[data-agent-run-review-archive]').forEach((btn) => {
    btn.addEventListener('click', () => focusAgentRunBlock('.agent-run-archive', btn, 'Execution Archive'));
  });
  root.querySelectorAll('[data-agent-run-open-artifacts]').forEach((btn) => {
    btn.addEventListener('click', () => focusAgentRunBlock('.agent-run-artifacts', btn, 'Execution Artifacts'));
  });
  root.querySelectorAll('[data-agent-run-archive]').forEach((btn) => {
    btn.addEventListener('click', () => archiveAgentRun(btn.dataset.agentRunArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-gate-audit]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelAgentGraphEvidence?.openAgentRunGateAuditReport?.(btn.dataset.agentRunGateAudit, btn));
  });
  root.querySelectorAll('[data-agent-run-gate-audit-archive]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelAgentGraphEvidence?.archiveAgentRunGateAuditReport?.(btn.dataset.agentRunGateAuditArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-activity]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelActivity.open({ agentOnly: true, agentRunId: btn.dataset.agentRunActivity }));
  });
  root.querySelectorAll('[data-agent-run-session-export]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelAgentGraphEvidence?.openAgentRunSessionExport?.(btn.dataset.agentRunSessionExport, btn));
  });
  root.querySelectorAll('[data-agent-run-session-archive]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelAgentGraphEvidence?.archiveAgentRunSessionEvidence?.(btn.dataset.agentRunSessionArchive, btn));
  });
  root.querySelectorAll('[data-agent-run-artifact-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.dataset.agentRunArtifactCopy || '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(path).then(() => toast('Artifact path copied', 'success', 1400)).catch(() => fallbackCopy(path));
      } else {
        fallbackCopy(path);
      }
    });
  });
  root.querySelectorAll('[data-agent-run-artifact-download]').forEach((btn) => {
    btn.addEventListener('click', () => window.PanelAgentGraphEvidence?.openAgentRunArtifact?.(btn.dataset.agentRunArtifactRun, btn.dataset.agentRunArtifactDownload, btn));
  });
}

function focusAgentRunBlock(selector, btn = null, label = 'section') {
  const block = document.querySelector(selector);
  if (!block) {
    toast(`${label} 暂无可聚焦内容`, 'warning', 1800);
    return;
  }
  document.querySelectorAll('.agent-run-block.is-highlighted').forEach(node => node.classList.remove('is-highlighted'));
  block.classList.add('is-highlighted');
  block.scrollIntoView({ block: 'center', inline: 'nearest' });
  setTimeout(() => block.classList.remove('is-highlighted'), 2200);
  if (btn) btn.blur();
}

async function openGovernanceCenterForAgentRun(runId, btn = null) {
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
  }
  try {
    await window.PanelGovernance.open();
    if (runId) {
      const target = document.querySelector(`#governanceCenterBody [data-gov-center-run="${CSS.escape(runId)}"]`)
        || document.querySelector(`#governanceCenterBody [data-gov-center-id="${CSS.escape(runId)}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.classList.add('is-highlighted');
        setTimeout(() => target.classList.remove('is-highlighted'), 2200);
      }
    }
  } catch (e) {
    toast('打开 Preflight Review 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Open Preflight Review';
    }
  }
}

async function planAgentRunReplay(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Planning…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/replay-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.replayPlan?.summary || 'Replay plan recorded', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Replay plan 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Replay Plan';
    }
  }
}

async function archiveAgentRunReplayResult(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Replay Result',
    message: '结果摘要',
    multiline: true,
    value: 'Replay result recorded.',
    confirmLabel: '归档',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/replay-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', status: 'recorded', summary }),
    });
    toast(result.replayResult?.summary || 'Replay result archived', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Replay result 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Replay Result';
    }
  }
}

async function archiveAgentRun(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Archive Run',
    message: '阶段归档摘要',
    multiline: true,
    value: 'Execution archive recorded.',
    confirmLabel: '归档',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', summary }),
    });
    toast(result.archive?.summary || 'Run archived', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Run archive 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Run';
    }
  }
}

async function completeIdeaRunExecution(id, btn = null) {
  if (!id) return;
  const summary = await promptModal({
    title: 'Complete Idea Run',
    message: '执行与验证摘要',
    multiline: true,
    value: 'Idea execution completed and verified.',
    confirmLabel: '完成',
  });
  if (summary == null) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Completing…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedBy: 'owner',
        status: 'succeeded',
        summary,
        verificationSummary: summary,
      }),
    });
    toast(result.archive?.summary || 'Idea Run completed', 'success', 1800);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Idea Run 完成失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Complete Idea Run';
    }
  }
}

async function autoVerifyIdeaRun(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-auto-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.archive?.summary || 'Idea Run verified and archived', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('自动验证失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Auto Work + Verify';
    }
  }
}

async function generateIdeaRunManifest(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-manifest-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(result.manifestDraft?.summary || 'Manifest draft generated', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Manifest 生成失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Generate Manifest';
    }
  }
}

async function generateIdeaRunPatchManifest(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-patch-manifest-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'owner', useModel: false }),
    });
    toast(result.manifestDraft?.summary || 'Patch manifest draft generated', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Patch Manifest 生成失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Generate Patch';
    }
  }
}

function defaultIdeaRunManifestText(run = null) {
  const timeline = agState().runTimeline?.run?.id === run?.id ? agState().runTimeline : null;
  const manifestDraft = window.PanelAgentGraphRuns?.latestIdeaRunManifestDraft?.(timeline);
  if (manifestDraft?.manifest) return JSON.stringify(manifestDraft.manifest, null, 2);
  const manifest = {
    fileChanges: [],
    workEvidenceCommands: [
      'git status --porcelain=v1',
      'git diff --stat',
    ],
    commands: [
      'git diff --check',
      'npm test',
    ],
    evidenceArtifacts: [],
  };
  const approvalId = run?.approvalId || run?.details?.approvalId;
  if (approvalId) manifest.approvalId = approvalId;
  return JSON.stringify(manifest, null, 2);
}

function parseIdeaRunManifestText(text) {
  const value = String(text || '').trim();
  if (!value) return {};
  const manifest = JSON.parse(value);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be a JSON object');
  }
  return manifest;
}

async function editIdeaRunManifest(id, btn = null) {
  if (!id) return;
  const manifestText = await promptModal({
    title: 'Idea Manifest',
    message: 'JSON manifest',
    multiline: true,
    value: defaultIdeaRunManifestText(agState().runTimeline?.run?.id === id ? agState().runTimeline.run : null),
    confirmLabel: 'Run Manifest',
  });
  if (manifestText == null) return;
  let manifest;
  try {
    manifest = parseIdeaRunManifestText(manifestText);
  } catch (e) {
    toast('Manifest JSON 无效：' + (e.message || e), 'error', 3500);
    return;
  }
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/idea-auto-execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...manifest, requestedBy: 'owner' }),
    });
    toast(result.archive?.summary || 'Idea manifest executed', 'success', 2200);
    await loadAgentRunDetail(id);
  } catch (e) {
    toast('Manifest 执行失败：' + (e.message || e), 'error', 3500);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Edit Manifest';
    }
  }
}

    window.PanelAgentGraphRunActions = {
      bindAgentRunsEvents,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
