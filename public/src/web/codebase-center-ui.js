// @ts-check
// codebase-center-ui.js — Codebase Center：本地代码索引 状态/重建/查询/问答 + Dispatch Preview 证据注入
// （从 app.js 外迁；app.js 模块化第15批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（$/escapeHtml/toast/api/activityTime 纯工具可解构；
// state 实时取禁快照）。Agent 图谱经 window.PanelAgentGraph / window.PanelCore.agentRegistryState 懒解析，调用时再取。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, toast, api, activityTime } = core;

    // ========== Codebase Center ==========
    const codebaseCenterState = {
      status: null,
      results: [],
      query: 'Agent 图谱入口 DOM handler',
      error: '',
      loading: false,
      cwd: '',
      lastResult: null,
      questionAnswer: null,
    };

    function codebaseCenterCwd() {
      return codebaseCenterState.cwd || window.PanelAgentGraph?.agentPreviewCwd() || core.state.activeCwd || '';
    }

    async function openCodebaseCenterModal() {
      codebaseCenterState.cwd = codebaseCenterCwd();
      if (!codebaseCenterState.query && window.PanelCore.agentRegistryState?.text) codebaseCenterState.query = window.PanelCore.agentRegistryState?.text;
      $('#codebaseCenterModal').style.display = 'flex';
      renderCodebaseCenter();
      await refreshCodebaseStatus();
    }

    function closeCodebaseCenterModal() {
      $('#codebaseCenterModal').style.display = 'none';
    }

    function codebaseStatusText(status = null) {
      if (!status || !status.indexedAt) return 'not indexed';
      const parts = [
        `${status.scannedFileCount || 0} scanned`,
        `${status.focusFileCount || 0} focus`,
      ];
      if (status.evidenceSummary?.symbolCount) parts.push(`${status.evidenceSummary.symbolCount} symbols`);
      if (status.evidenceSummary?.parserCounts) {
        const parsers = Object.entries(status.evidenceSummary.parserCounts)
          .filter(([, count]) => Number(count) > 0)
          .slice(0, 2)
          .map(([parser, count]) => `${parser}:${count}`)
          .join('/');
        if (parsers) parts.push(`parsers ${parsers}`);
      }
      if (status.symbolGraphSummary?.typeImplementationCount) parts.push(`${status.symbolGraphSummary.typeImplementationCount} type impl`);
      if (status.symbolGraphSummary?.routeUsageCount) parts.push(`${status.symbolGraphSummary.routeUsageCount} route uses`);
      if (status.symbolGraphSummary?.routeToTestChainCount) parts.push(`${status.symbolGraphSummary.routeToTestChainCount} route-test chains`);
      if (status.symbolGraphSummary?.unresolvedReferenceCount) parts.push(`${status.symbolGraphSummary.unresolvedReferenceCount} unresolved refs`);
      if (status.vectorSummary?.rowCount) parts.push(`${status.vectorSummary.rowCount} vectors`);
      return parts.join(' · ');
    }

    function renderCodebaseCenter() {
      const root = $('#codebaseCenterBody');
      if (!root) return;
      const status = codebaseCenterState.status;
      const results = codebaseCenterState.results || [];
      const answer = codebaseCenterState.questionAnswer;
      root.innerHTML = `
        <div class="codebase-center-head">
          <label>
            <span>Project</span>
            <input id="codebaseCenterCwd" type="text" value="${escapeHtml(codebaseCenterCwd())}" placeholder="留空 = 当前 panel cwd" />
          </label>
          <div class="codebase-index-status">
            <strong>${escapeHtml(status?.ok === false ? 'error' : 'ready')}</strong>
            <span>${escapeHtml(codebaseStatusText(status))}</span>
            <em>${status?.indexedAt ? escapeHtml(activityTime(status.indexedAt)) : '-'}</em>
          </div>
        </div>
        <div class="codebase-query-bar">
          <input id="codebaseQueryInput" type="search" value="${escapeHtml(codebaseCenterState.query)}" placeholder="查询代码问题，例如：RoomAdapter 在哪里处理预算？" />
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="codebaseRebuildBtn">${codebaseCenterState.loading === 'rebuild' ? '重建中…' : 'Rebuild'}</button>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="codebaseQuestionBtn">${codebaseCenterState.loading === 'question' ? '回答中…' : 'Answer'}</button>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="codebaseQueryBtn">${codebaseCenterState.loading === 'query' ? '查询中…' : 'Query'}</button>
        </div>
        ${codebaseCenterState.error ? `<div class="agent-empty error">${escapeHtml(codebaseCenterState.error)}</div>` : ''}
        ${answer ? renderCodebaseQuestionAnswer(answer) : ''}
        <div class="codebase-result-actions">
          <span>${escapeHtml(results.length)} results</span>
          <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="codebaseAddAll" ${results.length ? '' : 'disabled'}>添加结果到 Dispatch Preview</button>
          <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="codebaseOpenDispatch">打开 Dispatch Preview</button>
        </div>
        <div class="codebase-results">
          ${results.length ? results.map(renderCodebaseResult).join('') : `<div class="agent-empty">${codebaseCenterState.loading ? '等待索引结果…' : '输入问题后查询本地代码索引。'}</div>`}
        </div>
      `;
      bindCodebaseCenterEvents(root);
    }

    function renderCodebaseResult(item, idx) {
      const symbols = Array.isArray(item.symbols) ? item.symbols : [];
      const routes = Array.isArray(item.routes) ? item.routes : [];
      return `<article class="codebase-result-card">
        <div class="codebase-result-title">
          <strong>${escapeHtml(item.path || '-')}<span>:${escapeHtml(item.line || 1)}</span></strong>
          <em>score ${escapeHtml(item.score || 0)}${item.semanticScore !== undefined ? ` · vector ${escapeHtml(Number(item.semanticScore).toFixed(3))}` : ''} · ${escapeHtml(item.parser || 'unknown')}</em>
        </div>
        <div class="codebase-result-meta">
          <span>${escapeHtml(item.kind || 'file')}</span>
          ${item.anchor ? `<span>${escapeHtml(item.anchor)}</span>` : ''}
        </div>
        ${item.text ? `<pre class="codebase-result-snippet"><code>${escapeHtml(item.text)}</code></pre>` : ''}
        <div class="codebase-result-reasons">
          ${(item.reason || []).slice(0, 9).map(reason => `<span>${escapeHtml(reason)}</span>`).join('')}
        </div>
        ${symbols.length || routes.length ? `<div class="codebase-result-evidence">
          ${symbols.slice(0, 5).map(symbol => `<span>${escapeHtml(symbol.name)}:${escapeHtml(symbol.line || 1)}</span>`).join('')}
          ${routes.slice(0, 5).map(route => `<span>${escapeHtml(route.name || route.route || route.kind)}</span>`).join('')}
        </div>` : ''}
        <div class="codebase-result-footer">
          <button class="cxbtn cxbtn-secondary cxbtn-sm" data-codebase-add="${idx}">添加到 Dispatch Preview</button>
        </div>
      </article>`;
    }

    function renderCodebaseQuestionAnswer(answer = {}) {
      const citations = Array.isArray(answer.citations) ? answer.citations : [];
      const lines = Array.isArray(answer.answerLines) ? answer.answerLines : [];
      const coverage = answer.coverage || {};
      const limitations = Array.isArray(answer.limitations) ? answer.limitations : [];
      const chainText = coverage.routeToTestChainCount ? ` · ${Number(coverage.routeToTestChainCount || 0)} route-test chains` : '';
      const unresolvedText = coverage.unresolvedReferenceCount ? ` · ${Number(coverage.unresolvedReferenceCount || 0)} unresolved refs` : '';
      const pathText = coverage.citationPathCount ? ` · ${Number(coverage.citationPathCount || 0)} citation paths` : '';
      // P0-A 证据 summary：把 reference kind 计数渲染成标注 chips（callback-registration / object-property-flow 等）
      const refKindEntries = Object.entries(coverage.referenceKindCounts || {})
        .filter(([, n]) => Number(n) > 0)
        .sort((a, b) => b[1] - a[1]);
      return `<section class="codebase-question-answer" data-codebase-question-answer>
        <div class="codebase-question-head">
          <strong>Local Code Answer</strong>
          <span>${escapeHtml(answer.confidence || 'unknown')} confidence</span>
          ${answer.weakEvidence ? '<span class="codebase-weak-evidence" title="无结构级证据或低置信——把引用当线索而非完整实现图">⚠ weak evidence</span>' : ''}
          <span>${Number(coverage.uniqueFileCount || 0)} files · ${Number(coverage.evidenceItemCount || 0)} evidence${coverage.typeImplementationCount ? ` · ${Number(coverage.typeImplementationCount || 0)} type impl` : ''}${chainText}${unresolvedText}${pathText}</span>
        </div>
        <p>${escapeHtml(answer.answer || '')}</p>
        ${refKindEntries.length ? `<div class="codebase-question-refkinds" data-codebase-refkinds>
          ${refKindEntries.slice(0, 8).map(([kind, n]) => `<span title="结构级引用证据">${escapeHtml(kind)} ${Number(n)}</span>`).join('')}
        </div>` : ''}
        ${limitations.length ? `<div class="codebase-question-limitations">${limitations.slice(0, 4).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
        ${lines.length ? `<ol class="codebase-question-lines">
          ${lines.slice(0, 6).map(line => `<li>${escapeHtml(line)}</li>`).join('')}
        </ol>` : ''}
        ${citations.length ? `<div class="codebase-question-citations">
          ${citations.slice(0, 6).map(item => `<span title="${escapeHtml((item.reasons || []).join(', '))}">${escapeHtml(item.id)} ${escapeHtml(item.label)}</span>`).join('')}
        </div>` : ''}
      </section>`;
    }

    function bindCodebaseCenterEvents(root) {
      $('#codebaseCenterCwd')?.addEventListener('change', (e) => {
        codebaseCenterState.cwd = e.target.value.trim();
        refreshCodebaseStatus();
      });
      $('#codebaseQueryInput')?.addEventListener('input', (e) => {
        codebaseCenterState.query = e.target.value;
      });
      $('#codebaseQueryInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runCodebaseQuery();
      });
      $('#codebaseRebuildBtn')?.addEventListener('click', rebuildCodebaseIndex);
      $('#codebaseQuestionBtn')?.addEventListener('click', runCodebaseQuestion);
      $('#codebaseQueryBtn')?.addEventListener('click', runCodebaseQuery);
      $('#codebaseAddAll')?.addEventListener('click', () => addCodebaseResultsToDispatch(codebaseCenterState.results));
      $('#codebaseOpenDispatch')?.addEventListener('click', openDispatchPreviewFromCodebase);
      root.querySelectorAll('[data-codebase-add]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.codebaseAdd);
          const item = codebaseCenterState.results[idx];
          addCodebaseResultsToDispatch(item ? [item] : []);
        });
      });
    }

    async function refreshCodebaseStatus() {
      try {
        const params = new URLSearchParams();
        const cwd = codebaseCenterCwd();
        if (cwd) params.set('cwd', cwd);
        const result = await api('/api/codebase-index/status' + (params.toString() ? '?' + params.toString() : ''));
        codebaseCenterState.status = result.status || null;
        codebaseCenterState.error = '';
      } catch (e) {
        codebaseCenterState.error = e.message || '读取 Codebase Index 状态失败';
      }
      renderCodebaseCenter();
    }

    async function rebuildCodebaseIndex() {
      codebaseCenterState.loading = 'rebuild';
      codebaseCenterState.error = '';
      renderCodebaseCenter();
      try {
        const result = await api('/api/codebase-index/rebuild', {
          method: 'POST',
          body: JSON.stringify({
            cwd: codebaseCenterCwd(),
            query: codebaseCenterState.query,
            focusLimit: 24,
          }),
        });
        codebaseCenterState.status = result.status || null;
        codebaseCenterState.lastResult = result.map || null;
        codebaseCenterState.questionAnswer = null;
        toast('Codebase Index 已重建', 'success', 1600);
      } catch (e) {
        codebaseCenterState.error = e.message || '重建 Codebase Index 失败';
      } finally {
        codebaseCenterState.loading = false;
        renderCodebaseCenter();
      }
    }

    async function runCodebaseQuery() {
      const query = (codebaseCenterState.query || '').trim();
      if (!query) {
        codebaseCenterState.error = '请输入查询问题。';
        renderCodebaseCenter();
        return;
      }
      codebaseCenterState.loading = 'query';
      codebaseCenterState.error = '';
      codebaseCenterState.questionAnswer = null;
      renderCodebaseCenter();
      try {
        const result = await api('/api/codebase-index/query', {
          method: 'POST',
          body: JSON.stringify({
            cwd: codebaseCenterCwd(),
            query,
            maxResults: 20,
            focusLimit: 24,
          }),
        });
        codebaseCenterState.results = result.results || [];
        codebaseCenterState.status = result.status || codebaseCenterState.status;
        codebaseCenterState.lastResult = result;
      } catch (e) {
        codebaseCenterState.error = e.message || '查询 Codebase Index 失败';
        codebaseCenterState.results = [];
      } finally {
        codebaseCenterState.loading = false;
        renderCodebaseCenter();
      }
    }

    async function runCodebaseQuestion() {
      const question = (codebaseCenterState.query || '').trim();
      if (!question) {
        codebaseCenterState.error = '请输入代码问题。';
        renderCodebaseCenter();
        return;
      }
      codebaseCenterState.loading = 'question';
      codebaseCenterState.error = '';
      renderCodebaseCenter();
      try {
        const result = await api('/api/codebase-index/question', {
          method: 'POST',
          body: JSON.stringify({
            cwd: codebaseCenterCwd(),
            question,
            maxResults: 8,
            focusLimit: 24,
          }),
        });
        codebaseCenterState.results = result.results || [];
        codebaseCenterState.questionAnswer = result.answer || null;
        codebaseCenterState.status = result.status || codebaseCenterState.status;
        codebaseCenterState.lastResult = result;
      } catch (e) {
        codebaseCenterState.error = e.message || '回答代码问题失败';
        codebaseCenterState.questionAnswer = null;
        codebaseCenterState.results = [];
      } finally {
        codebaseCenterState.loading = false;
        renderCodebaseCenter();
      }
    }

    function codebaseResultToEvidence(item) {
      if (!item?.path) return null;
      return {
        path: item.path,
        language: item.path.endsWith('.css') ? 'css' : item.path.endsWith('.html') ? 'html' : item.path.endsWith('.md') ? 'markdown' : 'javascript',
        parser: item.parser || 'unknown',
        symbols: Array.isArray(item.symbols) ? item.symbols : [],
        imports: [],
        anchors: Array.isArray(item.routes) ? item.routes : [],
        snippets: item.text ? [{ line: item.line || 1, reason: (item.reason || []).slice(0, 3).join(', ') || 'codebase-query', text: item.text }] : [],
        references: [],
      };
    }

    function addCodebaseResultsToDispatch(items = [], options = {}) {
      const list = (items || []).filter(item => item?.path);
      if (!list.length) return;
      const ag = window.PanelCore.agentRegistryState;
      if (!ag) { toast('Agent 图谱模块未就绪', 'error'); return; }
      const questionAnswer = window.PanelAgentGraph?.sanitizeCodebaseQuestionAnswer(options.questionAnswer || codebaseCenterState.questionAnswer);
      const existing = window.PanelAgentGraph?.parseAgentPreviewFiles(ag.affectedFiles) || [];
      const paths = [...new Set([...existing, ...list.map(item => item.path)])].slice(0, 40);
      const evidenceByPath = new Map((ag.codeContextEvidence || []).map(item => [item.path, item]));
      for (const item of list) {
        const evidence = codebaseResultToEvidence(item);
        if (evidence) evidenceByPath.set(evidence.path, evidence);
      }
      ag.affectedFiles = paths.join('\n');
      ag.codeContextEvidence = [...evidenceByPath.values()].slice(0, 24);
      ag.codeContextGraph = null;
      ag.codebaseMap = null;
      ag.codebaseQuestionAnswer = questionAnswer;
      ag.classification = null;
      ag.changedFilesInfo = {
        mode: 'codebase-query',
        count: paths.length,
        evidenceSummary: {
          fileCount: ag.codeContextEvidence.length,
          symbolCount: ag.codeContextEvidence.reduce((sum, file) => sum + (file.symbols || []).length, 0),
          anchorCount: ag.codeContextEvidence.reduce((sum, file) => sum + (file.anchors || []).length, 0),
        },
      };
      if (codebaseCenterState.query) ag.text = codebaseCenterState.query;
      if ($('#agentRegistryModal')?.style.display === 'flex') window.PanelAgentGraph?.renderAgentRegistryModal();
      toast(`已添加 ${list.length} 条代码证据到 Dispatch Preview`, 'success', 1800);
    }

    async function openDispatchPreviewFromCodebase() {
      codebaseCenterState.query = ($('#codebaseQueryInput')?.value || codebaseCenterState.query || '').trim();
      const ag = window.PanelCore.agentRegistryState;
      if (!ag) { toast('Agent 图谱模块未就绪', 'error'); return; }
      const questionAnswer = window.PanelAgentGraph?.sanitizeCodebaseQuestionAnswer(codebaseCenterState.questionAnswer);
      if (questionAnswer) {
        ag.codebaseQuestionAnswer = questionAnswer;
        ag.classification = null;
      }
      if (codebaseCenterState.query) ag.text = codebaseCenterState.query;
      closeCodebaseCenterModal();
      ag.activeTab = 'dispatch';
      await window.PanelAgentGraph?.open();
    }

    $('#btnCodebaseCenter')?.addEventListener('click', openCodebaseCenterModal);
    document.querySelectorAll('[data-close-codebase-center]').forEach(el => el.addEventListener('click', closeCodebaseCenterModal));

    window.PanelCodebase = {
      get state() { return codebaseCenterState; },
      codebaseCenterCwd,
      openCodebaseCenterModal,
      closeCodebaseCenterModal,
      codebaseStatusText,
      renderCodebaseCenter,
      renderCodebaseResult,
      renderCodebaseQuestionAnswer,
      bindCodebaseCenterEvents,
      refreshCodebaseStatus,
      rebuildCodebaseIndex,
      runCodebaseQuery,
      runCodebaseQuestion,
      codebaseResultToEvidence,
      addCodebaseResultsToDispatch,
      openDispatchPreviewFromCodebase,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
