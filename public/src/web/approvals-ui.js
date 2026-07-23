// approvals-ui.js — 本地审批中心（从 app.js 外迁；app.js 模块化第6批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, escapeHtml, toast, promptModal } = core;

    // ========== 本地审批中心 ==========
    const approvalState = {
      status: 'pending',
      approvals: [],
      activeId: null,
    };

    function approvalTypeLabel(type) {
      return ({
        dangerous_command: '危险命令',
        budget_override: '预算覆盖',
        manual: '人工确认',
      })[type] || type || '审批';
    }
    function approvalTitle(a) {
      const p = a?.payload || {};
      if (a?.type === 'dangerous_command') return (p.command || '危险命令').slice(0, 90);
      return p.title || p.summary || approvalTypeLabel(a?.type);
    }
    function approvalTime(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '-';
      try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
      catch { return '-'; }
    }

    async function openApprovalModal(focusId = null) {
      $('#approvalModal').style.display = 'flex';
      if (focusId) approvalState.activeId = focusId;
      await refreshApprovals();
    }
    function closeApprovalModal() { $('#approvalModal').style.display = 'none'; }

    async function refreshApprovals() {
      try {
        const statusParam = approvalState.status ? `?status=${encodeURIComponent(approvalState.status)}&limit=100` : '?limit=100';
        const r = await api('/api/approvals' + statusParam);
        approvalState.approvals = r.approvals || [];
        if (!approvalState.activeId || !approvalState.approvals.some(a => a.id === approvalState.activeId)) {
          approvalState.activeId = approvalState.approvals[0]?.id || null;
        }
        renderApprovalModal();
      } catch (e) {
        $('#approvalModalBody').innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
      }
    }

    function renderApprovalModal() {
      const root = $('#approvalModalBody');
      if (!root) return;
      const approvals = approvalState.approvals || [];
      const active = approvals.find(a => a.id === approvalState.activeId) || null;
      root.innerHTML = `
        <section>
          <div class="approval-toolbar">
            <select id="approvalStatusFilter" aria-label="审批状态">
              <option value="pending" ${approvalState.status === 'pending' ? 'selected' : ''}>待处理</option>
              <option value="" ${approvalState.status === '' ? 'selected' : ''}>全部</option>
              <option value="approved" ${approvalState.status === 'approved' ? 'selected' : ''}>已批准</option>
              <option value="rejected" ${approvalState.status === 'rejected' ? 'selected' : ''}>已拒绝</option>
              <option value="cancelled" ${approvalState.status === 'cancelled' ? 'selected' : ''}>已取消</option>
            </select>
            <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApprovalRefresh">刷新</button>
          </div>
          <div class="approval-list">
            ${approvals.length ? approvals.map(a => `
              <div class="approval-item ${a.id === approvalState.activeId ? 'is-active' : ''}" data-approval-id="${escapeHtml(a.id)}">
                <div>
                  <div class="title" title="${escapeHtml(approvalTitle(a))}">${escapeHtml(approvalTitle(a))}</div>
                  <div class="meta">${escapeHtml(approvalTypeLabel(a.type))} · ${escapeHtml(a.requesterType || '-')}:${escapeHtml(a.requesterId || '-')} · ${approvalTime(a.createdAt)}</div>
                </div>
                <span class="approval-status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
              </div>
            `).join('') : '<div class="approval-empty">当前筛选条件下没有审批。</div>'}
          </div>
        </section>
        <section class="approval-detail">
          ${active ? renderApprovalDetail(active) : '<div class="approval-empty">选择左侧审批查看详情。</div>'}
        </section>
      `;

      $('#approvalStatusFilter')?.addEventListener('change', (e) => {
        approvalState.status = e.target.value;
        approvalState.activeId = null;
        refreshApprovals();
      });
      $('#btnApprovalRefresh')?.addEventListener('click', refreshApprovals);
      root.querySelectorAll('[data-approval-id]').forEach(el => {
        el.addEventListener('click', () => {
          approvalState.activeId = el.dataset.approvalId;
          renderApprovalModal();
        });
      });
      root.querySelectorAll('[data-approval-action]').forEach(btn => {
        btn.addEventListener('click', () => decideApproval(btn.dataset.approvalId, btn.dataset.approvalAction));
      });
    }

    function renderApprovalDetail(a) {
      const p = a.payload || {};
      const hits = Array.isArray(p.hits) ? p.hits : [];
      const isPending = a.status === 'pending';
      const command = p.command || '';
      return `
        <div class="approval-detail-grid">
          <div class="k">ID</div><div class="v">${escapeHtml(a.id)}</div>
          <div class="k">类型</div><div class="v">${escapeHtml(approvalTypeLabel(a.type))}</div>
          <div class="k">状态</div><div class="v"><span class="approval-status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></div>
          <div class="k">来源</div><div class="v">${escapeHtml(p.source || '-')}</div>
          <div class="k">目录</div><div class="v">${escapeHtml(p.cwd || '-')}</div>
          <div class="k">请求者</div><div class="v">${escapeHtml(a.requesterType || '-')} / ${escapeHtml(a.requesterId || '-')}</div>
          <div class="k">创建时间</div><div class="v">${approvalTime(a.createdAt)}</div>
          ${a.decidedAt ? `<div class="k">处理时间</div><div class="v">${approvalTime(a.decidedAt)} · ${escapeHtml(a.decisionBy || '-')}</div>` : ''}
          ${a.decisionReason ? `<div class="k">处理说明</div><div class="v">${escapeHtml(a.decisionReason)}</div>` : ''}
        </div>
        ${command ? `<div class="approval-command">${escapeHtml(command)}</div>` : ''}
        <div>
          ${hits.length ? hits.map(h => `<div class="approval-hit">
            <strong>${escapeHtml(h.severity || h.rule?.severity || 'risk')}</strong>
            ${escapeHtml(h.category || h.rule?.category || '')}
            <div class="muted small">${escapeHtml(h.advice || h.rule?.advice || h.snippet || '')}</div>
          </div>`).join('') : '<div class="approval-empty">没有附加风险规则详情。</div>'}
        </div>
        ${isPending ? `<div class="approval-actions">
          <button class="cxbtn cxbtn-secondary" data-approval-action="reject" data-approval-id="${escapeHtml(a.id)}">拒绝</button>
          <button class="cxbtn cxbtn-tertiary" data-approval-action="cancel" data-approval-id="${escapeHtml(a.id)}">取消审批</button>
          <button class="cxbtn cxbtn-danger" data-approval-action="approve" data-approval-id="${escapeHtml(a.id)}">批准</button>
        </div>` : ''}
      `;
    }

    async function decideApproval(id, action) {
      if (!id || !action) return;
      const label = action === 'approve' ? '批准' : (action === 'reject' ? '拒绝' : '取消');
      const reason = await promptModal({
        title: `${label}审批`,
        message: action === 'approve'
          ? '批准会记录人工决策；HTTP/API 操作可带 approvalId 重试同一动作，危险终端命令不会自动重放。'
          : '填写处理说明，留空也可以。',
        value: '',
        placeholder: '处理说明',
        confirmLabel: label,
      });
      if (reason === null) return;
      try {
        const r = await api(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          body: JSON.stringify({ decisionBy: 'owner', reason }),
        });
        approvalState.activeId = r.approval?.id || id;
        toast(`审批已${label}`, 'success', 1500);
        refreshApprovals();
      } catch (e) {
        toast(`${label}失败：${e.message}`, 'error');
      }
    }

    function handleApprovalRequired(msg) {
      const approval = msg?.approval || null;
      const id = approval?.id || msg?.approvalId || null;
      toast(`危险操作已暂停等待审批${id ? '：' + id : ''}，批准后可重试原操作`, 'warn', 5000);
      if ($('#approvalModal')?.style.display === 'flex') {
        if (id) approvalState.activeId = id;
        refreshApprovals();
      }
    }

    $('#btnApprovals')?.addEventListener('click', () => openApprovalModal());
    document.querySelectorAll('[data-close-approval]').forEach(el => el.addEventListener('click', closeApprovalModal));

    window.PanelApprovals = {
      get state() { return approvalState; },
      openApprovalModal,
      closeApprovalModal,
      refreshApprovals,
      handleApprovalRequired,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
