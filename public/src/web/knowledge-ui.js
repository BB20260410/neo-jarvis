// knowledge-ui.js — 知识库（证据 FTS 检索）P4/A2（从 app.js 外迁；app.js 模块化第6批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, escapeHtml, toast, showRoomArea, loadRooms, selectRoom } = core;

    // ========== 知识库（证据 FTS 检索）P4/A2 ==========
    // 跨 Agent Run / 工具结果 / 审计的本地证据全文检索；命中可跳到审计时间线。
    // 复用 Codebase Center 的卡片/查询条样式类，避免新增 CSS。
    const KNOWLEDGE_KIND_LABELS = {
      agent_message: 'Agent 消息',
      tool_result: '工具结果',
      activity: '审计事件',
    };
    const knowledgeCenterState = {
      query: '',
      kind: '',
      hits: [],
      indexed: 0,
      error: '',
      loading: false,
      searched: false,
    };

    // 结果区空态文案：区分「检索中 / 已搜 0 命中 / 空库 / 未搜」四态，避免 0 命中误显初始提示
    function knowledgeEmptyText() {
      const s = knowledgeCenterState;
      if (s.loading === 'search') return '检索中…';
      if (s.searched) {
        const q = (s.query || '').trim();
        const head = `未找到匹配${q ? `「${escapeHtml(q)}」` : ''}的证据。`;
        return head + (s.indexed ? '换个关键词，或调整来源筛选。' : '知识库为空，先点「重建索引」。');
      }
      return s.indexed
        ? '输入关键词后检索本地证据（可按来源筛选）。'
        : '知识库为空，先点「重建索引」，从 Agent Run / 工具结果 / 审计派生本地证据。';
    }

    async function openKnowledgeCenterModal() {
      $('#knowledgeCenterModal').style.display = 'flex';
      renderKnowledgeCenter();
      await refreshKnowledgeStats();
    }

    function closeKnowledgeCenterModal() {
      $('#knowledgeCenterModal').style.display = 'none';
    }

    function renderKnowledgeCenter() {
      const root = $('#knowledgeCenterBody');
      if (!root) return;
      const hits = knowledgeCenterState.hits || [];
      const kind = knowledgeCenterState.kind;
      root.innerHTML = `
        <div class="codebase-index-status knowledge-center-status">
          <strong>本地证据知识库</strong>
          <span>已索引 ${escapeHtml(knowledgeCenterState.indexed)} 条（Agent 消息 / 工具结果 / 审计）</span>
        </div>
        <div class="codebase-query-bar">
          <input id="knowledgeQueryInput" type="search" value="${escapeHtml(knowledgeCenterState.query)}" placeholder="检索本地证据，例如：预算审批 / RoomAdapter 错误" />
          <select id="knowledgeKindSelect" class="cxbtn cxbtn-secondary cxbtn-sm">
            <option value="">全部来源</option>
            <option value="agent_message"${kind === 'agent_message' ? ' selected' : ''}>Agent 消息</option>
            <option value="tool_result"${kind === 'tool_result' ? ' selected' : ''}>工具结果</option>
            <option value="activity"${kind === 'activity' ? ' selected' : ''}>审计事件</option>
          </select>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="knowledgeReindexBtn">${knowledgeCenterState.loading === 'reindex' ? '索引中…' : '重建索引'}</button>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="knowledgeSearchBtn">${knowledgeCenterState.loading === 'search' ? '检索中…' : '检索'}</button>
        </div>
        ${knowledgeCenterState.error ? `<div class="agent-empty error">${escapeHtml(knowledgeCenterState.error)}</div>` : ''}
        <div class="codebase-result-actions"><span>${escapeHtml(hits.length)} 条命中</span></div>
        <div class="codebase-results">
          ${hits.length ? hits.map(renderKnowledgeHit).join('') : `<div class="agent-empty">${knowledgeEmptyText()}</div>`}
        </div>
      `;
      bindKnowledgeCenterEvents(root);
    }

    function renderKnowledgeHit(hit, idx) {
      const kindLabel = KNOWLEDGE_KIND_LABELS[hit.refKind] || hit.refKind || '证据';
      return `<article class="codebase-result-card">
        <div class="codebase-result-title">
          <strong>${escapeHtml(kindLabel)}</strong>
          <em title="按相关度排序">#${Number(idx) + 1}</em>
        </div>
        <div class="codebase-result-meta">
          <span>${escapeHtml(hit.refKind || '-')}:${escapeHtml(hit.refId || '-')}</span>
          ${hit.sessionId ? `<span>session ${escapeHtml(hit.sessionId)}</span>` : ''}
        </div>
        ${hit.snippet ? `<pre class="codebase-result-snippet"><code>${escapeHtml(hit.snippet)}</code></pre>` : ''}
        <div class="codebase-result-footer">
          <button class="cxbtn cxbtn-secondary cxbtn-sm" data-knowledge-open="${idx}">在审计中查看</button>
        </div>
      </article>`;
    }

    function bindKnowledgeCenterEvents(root) {
      $('#knowledgeQueryInput')?.addEventListener('input', (e) => {
        knowledgeCenterState.query = e.target.value;
        knowledgeCenterState.searched = false; // 改查询词回到中性提示，不再显示上次的「未找到」
      });
      $('#knowledgeQueryInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runKnowledgeSearch();
      });
      $('#knowledgeKindSelect')?.addEventListener('change', (e) => {
        knowledgeCenterState.kind = e.target.value;
        if ((knowledgeCenterState.query || '').trim()) runKnowledgeSearch(); // 已有查询词 → 按新来源即时重搜
      });
      $('#knowledgeReindexBtn')?.addEventListener('click', runKnowledgeReindex);
      $('#knowledgeSearchBtn')?.addEventListener('click', runKnowledgeSearch);
      root.querySelectorAll('[data-knowledge-open]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.knowledgeOpen);
          const hit = knowledgeCenterState.hits[idx];
          if (!hit) return;
          closeKnowledgeCenterModal();
          // 跳转优先级:
          //   选项 C：squad_*（协作产出）→ 直接跳到对应房间（roomId）
          //   F1：runId（agent_message/tool_result）→ 开对应 Agent Run
          //   E2 兜底：sessionId → 该会话审计上下文
          //   末位：按事件 id 检索 activity
          const isSquad = typeof hit.refKind === 'string' && hit.refKind.startsWith('squad_');
          if (isSquad && hit.roomId) {
            showRoomArea();
            loadRooms().then(() => selectRoom(hit.roomId)).catch(() => {});
          } else if (hit.runId) window.PanelCore.openAgentRunFromActivity?.(hit.runId);
          else if (hit.sessionId) window.PanelActivity.open({ sessionId: hit.sessionId });
          else window.PanelActivity.open({ q: hit.refId || hit.refKind || '' });
        });
      });
    }

    async function refreshKnowledgeStats() {
      try {
        const r = await api('/api/knowledge/evidence/stats');
        knowledgeCenterState.indexed = r.indexed || 0;
        knowledgeCenterState.error = '';
      } catch (e) {
        knowledgeCenterState.error = e.message || '读取证据知识库状态失败';
      }
      renderKnowledgeCenter();
    }

    async function runKnowledgeSearch() {
      const q = (knowledgeCenterState.query || '').trim();
      if (!q) {
        knowledgeCenterState.error = '请输入检索关键词。';
        renderKnowledgeCenter();
        return;
      }
      knowledgeCenterState.loading = 'search';
      knowledgeCenterState.error = '';
      renderKnowledgeCenter();
      try {
        const params = new URLSearchParams({ q });
        if (knowledgeCenterState.kind) params.set('kind', knowledgeCenterState.kind);
        params.set('limit', '30');
        const r = await api('/api/knowledge/evidence/search?' + params.toString());
        knowledgeCenterState.hits = r.hits || [];
        knowledgeCenterState.indexed = r.indexed ?? knowledgeCenterState.indexed;
      } catch (e) {
        knowledgeCenterState.error = e.message || '检索失败';
      } finally {
        knowledgeCenterState.loading = false;
        knowledgeCenterState.searched = true; // 标记已执行检索 → 0 命中显示「未找到」而非初始提示
        renderKnowledgeCenter();
      }
    }

    async function runKnowledgeReindex() {
      knowledgeCenterState.loading = 'reindex';
      knowledgeCenterState.error = '';
      renderKnowledgeCenter();
      try {
        const r = await api('/api/knowledge/evidence/reindex', {
          method: 'POST',
          body: JSON.stringify({ limit: 200 }),
        });
        knowledgeCenterState.indexed = r.total ?? knowledgeCenterState.indexed;
        toast(`证据知识库已索引（新增 ${r.indexed || 0}，跳过 ${r.skipped || 0}）`, 'success', 1800);
      } catch (e) {
        knowledgeCenterState.error = e.message || '重建索引失败';
      } finally {
        knowledgeCenterState.loading = false;
        renderKnowledgeCenter();
      }
    }

    $('#btnKnowledgeCenter')?.addEventListener('click', openKnowledgeCenterModal);
    document.querySelectorAll('[data-close-knowledge-center]').forEach(el => el.addEventListener('click', closeKnowledgeCenterModal));

    window.PanelKnowledge = {
      get state() { return knowledgeCenterState; },
      openKnowledgeCenterModal,
      closeKnowledgeCenterModal,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
