// @ts-check
// agent-graph-dispatch-ui.js — 智能体图谱 Dispatch Preview 流子模块
// （从 agent-graph-ui.js 分文件；第三波批27 2026-06-11；纯机械搬移零逻辑改动）
// 持有：runAgentPreview/createAgentRunFromIdea/agentPreviewCwd/loadAgentChangedFiles/loadAgentCodebaseMap
//   + sanitizeCodebaseQuestionAnswer/parseAgentPreviewFiles（壳经 (...a)=> 转发进 PanelAgentGraph API 面，
//     batch15 钉 codebase-center 懒调用字面量）+ renderAgentChangedFilesInfo/renderAgentCodebaseQuestionAnswer
//   + workflow 步骤条（renderWorkflowStep/renderAgentDispatchWorkflow/refreshAgentDispatchWorkflow，
//     Dispatch tab 主消费，runs-view 的 renderIdeaRunWorkflow 懒取 renderWorkflowStep）。
// 共享状态 agentRegistryState 经 agState() 调用期实时取（单一属主在壳，禁解构/浅拷贝快照）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, api } = window.PanelCore;
    const agState = () => window.PanelAgentGraph.state;

function renderWorkflowStep(label, status, meta = '') {
  return `<div class="agent-workflow-step is-${escapeHtml(status || 'pending')}">
    <strong>${escapeHtml(label)}</strong>
    <span>${escapeHtml(meta || status || '-')}</span>
  </div>`;
}

function renderAgentDispatchWorkflow() {
  const hasIdea = Boolean((agState().text || '').trim());
  const hasContext = Boolean((agState().affectedFiles || '').trim() || agState().codebaseMap || agState().codebaseQuestionAnswer);
  const hasPreview = Boolean(agState().classification);
  const profile = agState().classification?.profile?.id || '-';
  const next = !hasIdea ? '输入一句任务目标'
    : !hasPreview ? '预演分派'
      : '创建 Run Draft';
  return `<div class="agent-main-path" data-agent-main-path="dispatch">
    <div class="agent-main-path-head">
      <strong>Idea-to-Archive Path</strong>
      <span>Next: ${escapeHtml(next)}</span>
    </div>
    <div class="agent-workflow-steps">
      ${renderWorkflowStep('Idea', hasIdea ? 'done' : 'current', hasIdea ? 'ready' : 'input')}
      ${renderWorkflowStep('Code Context', hasContext ? 'done' : 'pending', hasContext ? 'local evidence' : 'optional')}
      ${renderWorkflowStep('Dispatch Preview', hasPreview ? 'done' : (hasIdea ? 'current' : 'pending'), hasPreview ? profile : 'agent/skill')}
      ${renderWorkflowStep('Run Draft', hasPreview ? 'current' : 'pending', 'governed run')}
    </div>
  </div>`;
}

function refreshAgentDispatchWorkflow() {
  const node = document.querySelector('[data-agent-main-path="dispatch"]');
  if (node) node.outerHTML = renderAgentDispatchWorkflow();
}

async function runAgentPreview() {
  const root = $('#agentPreviewResult');
  const text = ($('#agentPreviewText')?.value || '').trim();
  let affectedFilesText = ($('#agentPreviewFiles')?.value ?? agState().affectedFiles ?? '').trim();
  let affectedFiles = parseAgentPreviewFiles(affectedFilesText);
  if (affectedFiles.length === 0) {
    const stateFilesText = String(agState().affectedFiles || '').trim();
    const stateFiles = parseAgentPreviewFiles(stateFilesText);
    if (stateFiles.length > 0) {
      affectedFilesText = stateFilesText;
      affectedFiles = stateFiles;
    }
  }
  if (affectedFiles.length === 0 && !agState().previewFilesClearedByUser) {
    const fallbackFilesText = String(agState().lastNonEmptyAffectedFiles || '').trim();
    const fallbackFiles = parseAgentPreviewFiles(fallbackFilesText);
    if (fallbackFiles.length > 0) {
      affectedFilesText = fallbackFilesText;
      affectedFiles = fallbackFiles;
    }
  }
  const role = $('#agentPreviewRole')?.value || 'dev';
  agState().text = text;
  agState().affectedFiles = affectedFilesText;
  if (affectedFiles.length > 0) {
    agState().lastNonEmptyAffectedFiles = affectedFilesText;
    agState().previewFilesClearedByUser = false;
    const filesInput = $('#agentPreviewFiles');
    if (filesInput && filesInput.value.trim() !== affectedFilesText) filesInput.value = affectedFilesText;
  }
  agState().memberRole = role;
  if (!text) {
    root.innerHTML = '<div class="agent-empty">先输入任务文本。</div>';
    return null;
  }
  root.innerHTML = '<div class="muted small">预演中…</div>';
  try {
    const result = await api('/api/agent-registry/classify', {
      method: 'POST',
      body: JSON.stringify({
        text,
        codeContext: {
          affectedFiles,
          evidence: agState().codeContextEvidence || [],
          symbolGraph: agState().codeContextGraph || {},
          codebaseQuestionAnswer: sanitizeCodebaseQuestionAnswer(agState().codebaseQuestionAnswer),
        },
        member: { adapterId: 'preview', role, displayName: `Preview ${role}` },
        room: { name: 'Agent Preview', topic: text, skills: [] },
      }),
    });
    if (affectedFiles.length > 0) {
      result.codeContextSignals = {
        ...(result.codeContextSignals || {}),
        tags: Array.isArray(result.codeContextSignals?.tags) ? result.codeContextSignals.tags : [],
        fileCount: Number(result.codeContextSignals?.fileCount) || affectedFiles.length,
        signalFileCount: Number(result.codeContextSignals?.signalFileCount) || 0,
      };
    }
    agState().classification = result;
    if (result.codebaseQuestionAnswer) agState().codebaseQuestionAnswer = result.codebaseQuestionAnswer;
    root.innerHTML = window.PanelAgentGraphEvidence?.renderAgentClassification?.(result) || '';
    refreshAgentDispatchWorkflow();
    return result;
  } catch (e) {
    root.innerHTML = `<div class="agent-empty error">预演失败：${escapeHtml(e.message)}</div>`;
    return null;
  }
}

async function createAgentRunFromIdea(button = null) {
  const text = ($('#agentPreviewText')?.value || '').trim();
  const affectedFilesText = ($('#agentPreviewFiles')?.value || '').trim();
  const role = $('#agentPreviewRole')?.value || 'dev';
  if (!text) {
    toast('先输入任务文本', 'warning', 1800);
    return null;
  }
  const oldText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Creating…';
  }
  try {
    const classification = agState().classification || await runAgentPreview();
    if (!classification) throw new Error('分派预演失败，无法创建 Run Draft');
    const affectedFiles = parseAgentPreviewFiles(affectedFilesText);
    const result = await api('/api/agent-runs/idea', {
      method: 'POST',
      body: JSON.stringify({
        idea: text,
        role,
        affectedFiles,
        classification,
        roomId: window.PanelCore.roomState?.activeId || '',
        sessionId: window.PanelCore.state.activeId || '',
        agentProfileId: classification.profile?.id || '',
        agentProfileTitle: classification.profile?.title || '',
        codebaseQuestionAnswer: sanitizeCodebaseQuestionAnswer(agState().codebaseQuestionAnswer || classification.codebaseQuestionAnswer),
      }),
    });
    toast('Idea-to-Archive Run Draft 已创建', 'success', 1800);
    agState().activeTab = 'runs';
    agState().activeRunId = result.run?.id || '';
    agState().runTimeline = null;
    agState().runs = result.run ? [result.run, ...agState().runs.filter(run => run.id !== result.run.id)].slice(0, 80) : agState().runs;
    window.PanelAgentGraph?.renderAgentRegistryModal?.();
    if (result.run?.id) await window.PanelAgentGraphRuns?.loadAgentRunDetail?.(result.run.id);
    return result;
  } catch (e) {
    toast('创建 Run Draft 失败：' + (e.message || e), 'error', 3000);
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText || '创建 Run Draft';
    }
  }
}

function agentPreviewCwd() {
  const codebaseCenterCwd = $('#codebaseCenterCwd')?.value?.trim();
  return codebaseCenterCwd || window.PanelCore.state.activeCwd || window.PanelCore.roomState?.activeRoom?.cwd || '';
}

function renderAgentChangedFilesInfo(info = null) {
  if (!info) return '';
  if (info.error) return `<span class="error">${escapeHtml(info.error)}</span>`;
  const tags = Array.isArray(info.tags) && info.tags.length
    ? ` · ${info.tags.slice(0, 5).map(tag => `${escapeHtml(tag.tag)}:${escapeHtml(tag.score)}`).join(' ')}`
    : '';
  const evidence = info.evidenceSummary && info.evidenceSummary.fileCount
    ? ` · ${escapeHtml(info.evidenceSummary.symbolCount || 0)} symbols · ${escapeHtml(info.evidenceSummary.anchorCount || 0)} anchors`
    : '';
  if (info.mode === 'codebase-map') {
    return `<span>${escapeHtml(info.count || 0)} focus files from ${escapeHtml(info.scannedFileCount || 0)} scanned${tags}${evidence}</span>`;
  }
  return `<span>${escapeHtml(info.count || 0)} changed files${tags}${evidence}</span>`;
}

function sanitizeCodebaseQuestionAnswer(answer = null) {
  if (!answer || typeof answer !== 'object') return null;
  const citations = Array.isArray(answer.citations) ? answer.citations.slice(0, 6).map((item, index) => {
    const id = String(item.id || `C${index + 1}`).slice(0, 20).trim() || `C${index + 1}`;
    const path = String(item.path || '').slice(0, 300).trim();
    const line = Math.max(1, Number(item.line) || 1);
    const label = String(item.label || (path ? `${path}:${line}` : id)).slice(0, 340).trim();
    return {
      id,
      path,
      line,
      label,
      kind: String(item.kind || 'file').slice(0, 100).trim() || 'file',
      anchor: String(item.anchor || '').slice(0, 180).trim(),
      parser: String(item.parser || 'unknown').slice(0, 80).trim() || 'unknown',
      score: Number(item.score || 0),
      semanticScore: Number.isFinite(Number(item.semanticScore)) ? Number(item.semanticScore) : null,
      reasons: Array.isArray(item.reasons) ? item.reasons.map(reason => String(reason || '').slice(0, 120).trim()).filter(Boolean).slice(0, 4) : [],
      snippet: String(item.snippet || '').slice(0, 260).trim(),
      evidenceCount: Math.max(0, Number(item.evidenceCount) || 0),
      graphReferenceCount: Math.max(0, Number(item.graphReferenceCount) || 0),
      typeImplementationCount: Math.max(0, Number(item.typeImplementationCount) || 0),
      routeUsageCount: Math.max(0, Number(item.routeUsageCount) || 0),
      routeToTestChainCount: Math.max(0, Number(item.routeToTestChainCount) || 0),
      unresolvedReferenceCount: Math.max(0, Number(item.unresolvedReferenceCount) || 0),
      citationPathCount: Math.max(0, Number(item.citationPathCount) || 0),
    };
  }).filter(item => item.path || item.label) : [];
  const question = String(answer.question || '').slice(0, 500).trim();
  const text = String(answer.answer || '').slice(0, 1200).trim();
  if (!question && !text && !citations.length) return null;
  const coverage = answer.coverage && typeof answer.coverage === 'object' ? answer.coverage : {};
  return {
    ok: answer.ok !== false,
    mode: String(answer.mode || 'local-codebase-question').slice(0, 80),
    generatedBy: String(answer.generatedBy || 'CodebaseIndexStore').slice(0, 120),
    question,
    confidence: String(answer.confidence || 'unknown').slice(0, 40),
    answer: text,
    answerLines: Array.isArray(answer.answerLines) ? answer.answerLines.map(line => String(line || '').slice(0, 360).trim()).filter(Boolean).slice(0, 6) : [],
    citations,
    coverage: {
      resultCount: Math.max(0, Number(coverage.resultCount) || 0),
      citedResultCount: Math.max(0, Number(coverage.citedResultCount) || citations.length),
      uniqueFileCount: Math.max(0, Number(coverage.uniqueFileCount) || new Set(citations.map(item => item.path).filter(Boolean)).size),
      evidenceItemCount: Math.max(0, Number(coverage.evidenceItemCount) || 0),
      graphReferenceCount: Math.max(0, Number(coverage.graphReferenceCount) || 0),
      typeImplementationCount: Math.max(0, Number(coverage.typeImplementationCount) || 0),
      routeUsageCount: Math.max(0, Number(coverage.routeUsageCount) || 0),
      routeToTestChainCount: Math.max(0, Number(coverage.routeToTestChainCount) || 0),
      unresolvedReferenceCount: Math.max(0, Number(coverage.unresolvedReferenceCount) || 0),
      citationPathCount: Math.max(0, Number(coverage.citationPathCount) || 0),
    },
    nextActions: Array.isArray(answer.nextActions) ? answer.nextActions.map(item => String(item || '').slice(0, 180).trim()).filter(Boolean).slice(0, 6) : [],
    limitations: Array.isArray(answer.limitations) ? answer.limitations.map(item => String(item || '').slice(0, 180).trim()).filter(Boolean).slice(0, 6) : [],
  };
}

function renderAgentCodebaseQuestionAnswer(answer = null) {
  const item = sanitizeCodebaseQuestionAnswer(answer);
  if (!item) return '';
  const coverage = item.coverage || {};
  const citations = item.citations || [];
  const extra = [
    coverage.routeToTestChainCount ? `${coverage.routeToTestChainCount} route-test chains` : '',
    coverage.unresolvedReferenceCount ? `${coverage.unresolvedReferenceCount} unresolved refs` : '',
  ].filter(Boolean).join(' · ');
  return `<section class="agent-code-question-answer" data-agent-code-question-answer>
    <div class="agent-code-context-head">
      <strong>Code Question Answer</strong>
      <span>${escapeHtml(item.confidence)} confidence · ${escapeHtml(coverage.uniqueFileCount || 0)} files · ${escapeHtml(citations.length)} citations${extra ? ` · ${escapeHtml(extra)}` : ''}</span>
    </div>
    ${item.question ? `<div class="agent-code-question-text"><strong>Question</strong><span>${escapeHtml(item.question)}</span></div>` : ''}
    ${item.answer ? `<div class="agent-code-question-text"><strong>Answer</strong><span>${escapeHtml(item.answer)}</span></div>` : ''}
    ${item.limitations?.length ? `<div class="agent-code-question-text"><strong>Limits</strong><span>${escapeHtml(item.limitations.slice(0, 3).join(' · '))}</span></div>` : ''}
    ${citations.length ? `<div class="agent-code-question-citations">
      ${citations.slice(0, 6).map(citation => `<span title="${escapeHtml((citation.reasons || []).join(', '))}">${escapeHtml(citation.id)} ${escapeHtml(citation.label)}</span>`).join('')}
    </div>` : ''}
  </section>`;
}

async function loadAgentChangedFiles(button = null) {
  const requestSeq = ++agState().previewFilesRequestSeq;
  const startedRevision = agState().previewFilesRevision;
  try {
    if (button) button.disabled = true;
    const cwd = agentPreviewCwd();
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const result = await api('/api/agent-registry/changed-files' + qs);
    if (requestSeq !== agState().previewFilesRequestSeq || startedRevision !== agState().previewFilesRevision) return;
    const paths = (result.files || []).map(file => file.path).filter(Boolean);
    agState().affectedFiles = paths.join('\n');
    if (paths.length > 0) {
      agState().lastNonEmptyAffectedFiles = agState().affectedFiles;
      agState().previewFilesClearedByUser = false;
    }
    agState().codeContextEvidence = result.codeContextEvidence || [];
    agState().codeContextGraph = result.codeContextGraph || null;
    agState().codebaseMap = null;
    agState().codebaseQuestionAnswer = null;
    agState().classification = null;
    agState().changedFilesInfo = {
      count: paths.length,
      tags: result.codeContextSignals?.tags || [],
      evidenceSummary: result.codeContextEvidenceSummary || null,
    };
    const input = $('#agentPreviewFiles');
    if (input) input.value = agState().affectedFiles;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agState().changedFilesInfo);
  } catch (e) {
    agState().codeContextEvidence = [];
    agState().codeContextGraph = null;
    agState().changedFilesInfo = { error: e.message || '读取当前变更失败' };
    agState().codebaseQuestionAnswer = null;
    agState().classification = null;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agState().changedFilesInfo);
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadAgentCodebaseMap(button = null) {
  const requestSeq = ++agState().previewFilesRequestSeq;
  const startedRevision = agState().previewFilesRevision;
  try {
    if (button) button.disabled = true;
    const cwd = agentPreviewCwd();
    const query = ($('#agentPreviewText')?.value || '').trim();
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    if (query) params.set('q', query);
    params.set('limit', '24');
    const result = await api('/api/agent-registry/codebase-map?' + params.toString());
    if (requestSeq !== agState().previewFilesRequestSeq || startedRevision !== agState().previewFilesRevision) return;
    const map = result || {};
    const paths = (map.focusFiles || []).map(file => file.path).filter(Boolean);
    agState().affectedFiles = paths.join('\n');
    if (paths.length > 0) {
      agState().lastNonEmptyAffectedFiles = agState().affectedFiles;
      agState().previewFilesClearedByUser = false;
    }
    agState().codeContextEvidence = map.evidence || [];
    agState().codeContextGraph = map.symbolGraph || null;
    agState().codebaseMap = map;
    agState().codebaseQuestionAnswer = null;
    agState().classification = null;
    agState().changedFilesInfo = {
      mode: 'codebase-map',
      count: paths.length,
      scannedFileCount: map.scannedFileCount || 0,
      tags: map.codeContextSignals?.tags || [],
      evidenceSummary: map.evidenceSummary || null,
    };
    const input = $('#agentPreviewFiles');
    if (input) input.value = agState().affectedFiles;
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agState().changedFilesInfo);
  } catch (e) {
    agState().codeContextEvidence = [];
    agState().codeContextGraph = null;
    agState().codebaseMap = null;
    agState().codebaseQuestionAnswer = null;
    agState().classification = null;
    agState().changedFilesInfo = { error: e.message || '构建工程地图失败' };
    const info = $('#agentPreviewFilesInfo');
    if (info) info.innerHTML = renderAgentChangedFilesInfo(agState().changedFilesInfo);
  } finally {
    if (button) button.disabled = false;
  }
}

function parseAgentPreviewFiles(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map(line => line.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 40);
}

    window.PanelAgentGraphDispatch = {
      renderWorkflowStep, renderAgentDispatchWorkflow, refreshAgentDispatchWorkflow,
      runAgentPreview, createAgentRunFromIdea,
      agentPreviewCwd, sanitizeCodebaseQuestionAnswer, parseAgentPreviewFiles,
      renderAgentChangedFilesInfo, renderAgentCodebaseQuestionAnswer,
      loadAgentChangedFiles, loadAgentCodebaseMap,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
