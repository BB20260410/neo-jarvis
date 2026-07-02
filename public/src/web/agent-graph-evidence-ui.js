// @ts-check
// agent-graph-evidence-ui.js — 智能体图谱 分类/代码证据渲染 + 证据归档动作子模块
// （从 agent-graph-ui.js 分文件；第三波批27 2026-06-11；纯机械搬移零逻辑改动）
// 持有：renderAgentClassification 及全部代码证据渲染（match/code-context/codebase-map/symbol-graph/
//   code-evidence/skill pills/diagnostics）+ run 证据块渲染（archives/artifacts/approval-resume-gate，
//   runs-view 的 renderAgentRunDetail 懒取）+ 证据动作（session export/archive、gate audit report
//   open/archive、openAgentRunArtifact——壳经 (...a)=> 转发进 PanelAgentGraph API 面）。
// 共享状态 agentRegistryState 经 agState() 调用期实时取（单一属主在壳，禁解构/浅拷贝快照）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      escapeHtml, toast, api, getOwnerToken,
      stagedDiffReviewText, governanceCenterBytes,
    } = window.PanelCore;
    const promptModal = (...args) => window.PanelDialog.promptModal(...args);
    const agState = () => window.PanelAgentGraph.state;

function renderAgentRunArchives(archives = []) {
  return `<div class="agent-run-block agent-run-archive">
    <h4>Execution Archive</h4>
    ${archives.slice(-3).map((archive) => {
      const blockers = (archive.governance?.blockers || []).map(item => `${item.kind}:${item.id || '-'}`).join(', ') || '-';
      const tools = archive.verification?.toolResultCount || 0;
      const external = archive.evidence?.external || {};
      const fileChanges = Array.isArray(external.fileChanges) ? external.fileChanges.length : 0;
      const artifacts = Array.isArray(external.evidenceArtifacts) ? external.evidenceArtifacts.length : 0;
      return `<div class="agent-run-line">
        <strong>${escapeHtml(archive.status || 'archived')}</strong>
        <span>${escapeHtml(archive.summary || archive.id || '-')} · tools ${tools} · file changes ${fileChanges} · artifacts ${artifacts} · blockers ${escapeHtml(blockers)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderAgentRunArtifacts(artifacts = [], runId = '') {
  return `<div class="agent-run-block agent-run-artifacts">
    <div class="agent-run-block-head">
      <h4>Execution Artifacts</h4>
      <span>${artifacts.length} recorded</span>
    </div>
    <div class="agent-run-artifact-list">
      ${artifacts.slice(-8).reverse().map((artifact) => {
        const size = artifact.size ? governanceCenterBytes(artifact.size) : '-';
        const hash = artifact.sha256 ? String(artifact.sha256).slice(0, 12) : '-';
        const ownerRunId = artifact.runId || runId;
        return `<div class="agent-run-artifact-row">
          <div>
            <strong>${escapeHtml(artifact.kind || 'artifact')}</strong>
            <code>${escapeHtml(artifact.path || '-')}</code>
            <span>${escapeHtml(size)} · sha ${escapeHtml(hash)}${artifact.sessionId ? ` · session ${escapeHtml(artifact.sessionId)}` : ''}${artifact.gateId ? ` · gate ${escapeHtml(artifact.gateId)}` : ''}</span>
          </div>
          <div class="agent-run-artifact-actions">
            <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-artifact-copy="${escapeHtml(artifact.path || '')}" type="button">Copy Path</button>
            ${artifact.downloadable ? `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-artifact-download="${escapeHtml(artifact.id || '')}" data-agent-run-artifact-run="${escapeHtml(ownerRunId || '')}" type="button">Open Artifact</button>` : '<span class="agent-run-artifact-muted">not downloadable</span>'}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderAgentRunApprovalResumeGate(audit = null, runId = '') {
  if (!audit || typeof audit !== 'object') return '';
  const counts = audit.counts || {};
  const files = Array.isArray(audit.files) ? audit.files : [];
  const commands = Array.isArray(audit.commands) ? audit.commands : [];
  const workCommands = Array.isArray(audit.workEvidenceCommands) ? audit.workEvidenceCommands : [];
  const stagedDiffText = stagedDiffReviewText(audit.stagedDiffReview || audit.diffReview || {});
  return `<div class="agent-run-block agent-run-approval-gate" data-agent-run-approval-gate>
    <h4>Approval Resume Gate</h4>
    <div class="agent-run-line"><strong>${escapeHtml(audit.status || 'reviewed')}</strong><span>${escapeHtml(audit.id || '-')} · ${escapeHtml((audit.sha256 || '').slice(0, 12) || '-')} · approval ${escapeHtml(audit.approvalId || '-')}</span></div>
    <div class="agent-run-line"><strong>counts</strong><span>${escapeHtml(counts.fileChanges || 0)} files · ${escapeHtml(counts.commands || 0)} verify · ${escapeHtml(counts.workEvidenceCommands || 0)} evidence · ${escapeHtml(counts.risks || 0)} risks</span></div>
    ${stagedDiffText ? `<div class="agent-run-line"><strong>staged diff</strong><span>${escapeHtml(stagedDiffText)}</span></div>` : ''}
    ${files.length ? `<div class="agent-run-line"><strong>files</strong><span>${escapeHtml(files.map(file => `${file.operation || '-'} ${file.path || '-'}`).join('; '))}</span></div>` : ''}
    ${commands.length || workCommands.length ? `<div class="agent-run-line"><strong>commands</strong><span>${escapeHtml([...commands, ...workCommands].map(item => item.command).filter(Boolean).join('; '))}</span></div>` : ''}
    ${runId ? `<div class="agent-run-line"><strong>audit</strong><span><button class="cxbtn cxbtn-tertiary cxbtn-sm" data-agent-run-gate-audit="${escapeHtml(runId)}">Gate Audit Report</button> <button class="cxbtn cxbtn-secondary cxbtn-sm" data-agent-run-gate-audit-archive="${escapeHtml(runId)}">Archive Report</button></span></div>` : ''}
  </div>`;
}

async function openAgentRunSessionExport(sessionId, btn = null) {
  if (!sessionId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/session/${encodeURIComponent(sessionId)}?format=markdown`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const markdown = await response.text();
    await promptModal({
      title: 'Session Evidence Export',
      message: `Agent Run session ${sessionId}`,
      multiline: true,
      value: markdown,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Session evidence export 失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Export Session';
    }
  }
}

async function archiveAgentRunSessionEvidence(sessionId, btn = null) {
  if (!sessionId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/session/${encodeURIComponent(sessionId)}/archive`, {
      method: 'POST',
      body: JSON.stringify({
        requestedBy: 'owner',
        runId: agState().activeRunId || undefined,
      }),
    });
    toast(`Session evidence archived: ${result.artifact?.path || 'done'}`, 'success', 2200);
    await window.PanelAgentGraphRuns?.loadAgentRunDetail?.(result.run?.id || agState().activeRunId);
  } catch (e) {
    toast('Session evidence 归档失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Session';
    }
  }
}

async function openAgentRunGateAuditReport(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(id)}/approval-resume-gate-audit?format=markdown`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const report = await response.text();
    await promptModal({
      title: 'Gate Audit Report',
      message: 'Approval resume gate 对账报告',
      multiline: true,
      value: report,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Gate audit report 加载失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Gate Audit Report';
    }
  }
}

async function archiveAgentRunGateAuditReport(id, btn = null) {
  if (!id) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Archiving…';
  }
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(id)}/approval-resume-gate-audit/archive`, {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'owner' }),
    });
    toast(`Gate audit report archived: ${result.artifact?.path || 'done'}`, 'success', 2200);
    await window.PanelAgentGraphRuns?.loadAgentRunDetail?.(id);
  } catch (e) {
    toast('Gate audit report 归档失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Archive Report';
    }
  }
}

async function openAgentRunArtifact(runId, artifactId, btn = null) {
  if (!runId || !artifactId) return;
  const oldText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
  }
  try {
    const headers = { Accept: 'text/markdown' };
    const token = getOwnerToken();
    if (token) headers['X-Panel-Owner-Token'] = token;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const artifactPath = response.headers.get('X-Xike-Artifact-Path') || '';
    const markdown = await response.text();
    await promptModal({
      title: 'Agent Run Artifact',
      message: artifactPath || `Agent Run ${runId}`,
      multiline: true,
      value: markdown,
      confirmLabel: '关闭',
    });
  } catch (e) {
    toast('Artifact 打开失败：' + (e.message || e), 'error', 3000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'Open Artifact';
    }
  }
}

function renderAgentClassification(result) {
  const matches = result.matches || [];
  return `
    <div class="agent-preview-profile">
      <strong>${escapeHtml(result.profile?.title || 'No profile')}</strong>
      <code>${escapeHtml(result.profile?.id || '-')}</code>
    </div>
    ${window.PanelAgentGraphModels?.renderAgentGovernance?.(result.governance || result.profile?.governance, { overridden: result.profile?.governanceOverridden }) || ''}
    <div class="agent-match-list">
      ${matches.length ? matches.map(match => `
        <div class="agent-match-row">
          <strong>${escapeHtml(match.tag)}</strong>
          <span>${escapeHtml(match.agentId)} · score ${escapeHtml(match.score)}${match.codeScore ? ` · code ${escapeHtml(match.codeScore)}` : ''}</span>
          <em>${renderAgentMatchEvidence(match)}</em>
        </div>
      `).join('') : '<div class="agent-empty">没有命中 tag，会走角色 fallback。</div>'}
    </div>
    ${renderAgentCodeContext(result.codeContextSignals)}
    ${window.PanelAgentGraphDispatch?.renderAgentCodebaseQuestionAnswer?.(result.codebaseQuestionAnswer || agState().codebaseQuestionAnswer) || ''}
    ${renderAgentCodebaseMap(agState().codebaseMap)}
    ${renderAgentSymbolGraph(result.codeContextGraph || agState().codeContextGraph, result.codeContextGraphSummary || agState().codebaseMap?.symbolGraphSummary)}
    ${renderAgentCodeEvidence(result.codeContextEvidence, result.codeContextEvidenceSummary)}
    <div class="agent-preview-skills">
      <div><b>Installed</b> ${renderAgentSkillBindingPills(result.installedSkillBindings, result.installedSkillNames, 'ok')}</div>
      <div><b>Missing</b> ${(result.missingSkillNames || []).map(s => `<span class="missing">${escapeHtml(s)}</span>`).join('') || '<span class="ok">none</span>'}</div>
    </div>
    ${renderAgentSkillDiagnostics(result.skillDiagnostics)}
    <pre class="agent-prompt-preview"><code>${escapeHtml(result.promptPreview || '')}</code></pre>
  `;
}

function renderAgentMatchEvidence(match) {
  const text = [];
  if ((match.matched || []).length) text.push(`text: ${(match.matched || []).join(', ')}`);
  if ((match.contextReasons || []).length) text.push(`code: ${(match.contextReasons || []).join(', ')}`);
  if ((match.contextPaths || []).length) text.push(`files: ${(match.contextPaths || []).slice(0, 3).join(', ')}`);
  return escapeHtml(text.join(' · ') || 'no keyword detail');
}

function renderAgentCodeContext(codeContextSignals = null) {
  const tags = Array.isArray(codeContextSignals?.tags) ? codeContextSignals.tags : [];
  const fileCount = codeContextSignals?.fileCount || 0;
  if (tags.length === 0 && fileCount === 0) return '';
  return `<div class="agent-code-context">
    <div class="agent-code-context-head">
      <strong>Code Context</strong>
      <span>${escapeHtml(codeContextSignals.signalFileCount || 0)}/${escapeHtml(fileCount)} files signaled</span>
    </div>
    <div class="agent-code-context-list">
      ${tags.length ? tags.slice(0, 6).map(tag => `
        <div class="agent-code-context-row">
          <strong>${escapeHtml(tag.tag)}</strong>
          <span>score ${escapeHtml(tag.score)} · ${(tag.reasons || []).slice(0, 3).map(escapeHtml).join(', ') || 'path signal'}</span>
          <em>${(tag.paths || []).slice(0, 4).map(escapeHtml).join(', ')}</em>
        </div>
      `).join('') : '<div class="agent-empty">已接收 affected files，但暂未推断出专属代码信号。</div>'}
    </div>
  </div>`;
}

function renderAgentCodebaseMap(map = null) {
  if (!map || !Array.isArray(map.focusFiles) || map.focusFiles.length === 0) return '';
  const edges = Array.isArray(map.graph?.edges) ? map.graph.edges : [];
  const files = map.focusFiles.slice(0, 8);
  return `<div class="agent-codebase-map">
    <div class="agent-code-context-head">
      <strong>Codebase Map</strong>
      <span>${escapeHtml(map.scannedFileCount || 0)} scanned · ${escapeHtml(map.focusFileCount || files.length)} focus · ${escapeHtml(map.graph?.edgeCount || 0)} edges</span>
    </div>
    <div class="agent-codebase-focus">
      ${files.map(file => `<div class="agent-codebase-focus-row">
        <strong>${escapeHtml(file.path)}</strong>
        <span>score ${escapeHtml(file.score || 0)} · ${(file.reasons || []).slice(0, 4).map(escapeHtml).join(', ') || 'project priority'}</span>
      </div>`).join('')}
    </div>
    ${edges.length ? `<div class="agent-codebase-edges">
      ${edges.slice(0, 8).map(edge => `<span>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentSymbolGraph(graph = null, summary = null) {
  const data = graph || {};
  const definitions = Array.isArray(data.definitions) ? data.definitions : [];
  const refs = Array.isArray(data.references) ? data.references : [];
  const routes = Array.isArray(data.routes) ? data.routes : [];
  const usages = Array.isArray(data.routeUsages) ? data.routeUsages : [];
  const routeChains = Array.isArray(data.routeTestChains) ? data.routeTestChains : [];
  const unresolved = Array.isArray(data.unresolvedReferences) ? data.unresolvedReferences : [];
  if (definitions.length === 0 && routes.length === 0) return '';
  const meta = summary || data;
  const topDefinitions = definitions
    .slice()
    .sort((a, b) => ((b.referenceCount || 0) + (b.callCount || 0)) - ((a.referenceCount || 0) + (a.callCount || 0)) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 6);
  return `<div class="agent-symbol-graph">
    <div class="agent-code-context-head">
      <strong>Symbol Graph</strong>
      <span>${escapeHtml(meta.definitionCount || definitions.length)} defs · ${escapeHtml(meta.referenceCount || refs.length)} refs · ${escapeHtml(meta.callCount || refs.filter(item => item.kind === 'call').length)} calls · ${escapeHtml(meta.typeImplementationCount || refs.filter(item => item.kind === 'type-implementation').length)} type impl · ${escapeHtml(meta.routeUsageCount || usages.length)} route uses · ${escapeHtml(meta.routeToTestChainCount || routeChains.length)} route-test · ${escapeHtml(meta.unresolvedReferenceCount || unresolved.length)} unresolved</span>
    </div>
    <div class="agent-symbol-list">
      ${topDefinitions.map(item => `<div class="agent-symbol-row">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.type || 'symbol')} · ${escapeHtml(item.path)}:${escapeHtml(item.line)}</span>
        <em>${escapeHtml(item.referenceCount || 0)} refs · ${escapeHtml(item.callCount || 0)} calls</em>
      </div>`).join('')}
    </div>
    ${routes.length ? `<div class="agent-symbol-routes">
      ${routes.slice(0, 6).map(item => `<span>${escapeHtml(item.route)} · ${escapeHtml(item.usageCount || 0)} uses</span>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAgentCodeEvidence(evidence = [], summary = null) {
  const list = Array.isArray(evidence) ? evidence : [];
  const meta = summary || {};
  const visible = list.filter(file => (file.symbols || []).length || (file.anchors || []).length || (file.imports || []).length).slice(0, 6);
  if (visible.length === 0) return '';
  const parserCounts = meta.parserCounts && typeof meta.parserCounts === 'object' ? meta.parserCounts : {};
  const parserText = Object.entries(parserCounts)
    .filter(([, count]) => Number(count) > 0)
    .slice(0, 3)
    .map(([parser, count]) => `${parser}:${count}`)
    .join(' · ');
  return `<div class="agent-code-evidence">
    <div class="agent-code-context-head">
      <strong>Code Evidence</strong>
      <span>${escapeHtml(meta.symbolCount || 0)} symbols · ${escapeHtml(meta.anchorCount || 0)} anchors · ${escapeHtml(meta.importCount || 0)} imports · ${escapeHtml(meta.referenceCount || 0)} refs${parserText ? ` · ${escapeHtml(parserText)}` : ''}</span>
    </div>
    <div class="agent-code-evidence-list">
      ${visible.map(file => {
        const symbols = (file.symbols || []).slice(0, 5).map(item => `${item.name}:${item.line}`);
        const anchors = (file.anchors || []).slice(0, 4).map(item => `${item.kind}:${item.name}:${item.line}`);
        const imports = (file.imports || []).slice(0, 4).map(item => item.source);
        const parser = file.parser ? `/${file.parser}` : '';
        return `<div class="agent-code-evidence-row">
          <strong>${escapeHtml(file.path)}</strong>
          <span>${escapeHtml(`${file.language || 'text'}${parser}`)} · ${(symbols.length ? `symbols ${symbols.join(', ')}` : 'no symbols')}</span>
          <em>${escapeHtml([anchors.length ? `anchors ${anchors.join(', ')}` : '', imports.length ? `imports ${imports.join(', ')}` : ''].filter(Boolean).join(' · ') || 'no anchors')}</em>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderAgentSkillBindingPills(bindings = [], fallbackNames = [], cls = 'ok') {
  const list = Array.isArray(bindings) && bindings.length > 0
    ? bindings
    : (fallbackNames || []).map(name => ({ name, sources: [] }));
  if (list.length === 0) return '<span class="missing">none</span>';
  return list.map((binding) => {
    const sources = Array.isArray(binding.sources) ? binding.sources.filter(Boolean) : [];
    const sourceText = sources.join(' + ');
    return `<span class="${cls}" title="${escapeHtml(sourceText || 'source unknown')}">${escapeHtml(binding.name)}${sourceText ? `<em>${escapeHtml(sourceText)}</em>` : ''}</span>`;
  }).join('');
}

function renderAgentSkillDiagnostics(diagnostics = []) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length === 0) return '';
  return `<div class="agent-skill-diagnostics">
    ${list.map((item) => `
      <div class="agent-skill-diagnostic ${escapeHtml(item.severity || 'info')}">
        <strong>${escapeHtml(item.code || 'skill_diagnostic')}</strong>
        <span>${escapeHtml(item.message || '')}</span>
      </div>
    `).join('')}
  </div>`;
}

    window.PanelAgentGraphEvidence = {
      renderAgentClassification,
      renderAgentRunArchives, renderAgentRunArtifacts, renderAgentRunApprovalResumeGate,
      openAgentRunSessionExport, archiveAgentRunSessionEvidence,
      openAgentRunGateAuditReport, archiveAgentRunGateAuditReport,
      openAgentRunArtifact,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
