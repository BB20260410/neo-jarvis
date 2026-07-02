// delegation-ui.js — 委派中心（从 app.js 外迁；app.js 模块化第6批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, escapeHtml, toast, promptModal, safeClassToken, activityTime, shortLineageValue, showRoomArea, loadRooms, selectRoom } = core;

    // ========== 委派中心 ==========
    const delegationState = {
      list: [],
      activeId: null,
      status: '',
      sourceRoomId: '',
    };

    function delegationTime(ts) {
      return activityTime(ts);
    }

    async function openDelegationModal(seed = {}) {
      $('#delegationModal').style.display = 'flex';
      if (seed.sourceRoomId) delegationState.sourceRoomId = seed.sourceRoomId;
      await refreshDelegations();
    }
    function closeDelegationModal() { $('#delegationModal').style.display = 'none'; }

    function delegationParams() {
      const params = new URLSearchParams();
      if (delegationState.status) params.set('status', delegationState.status);
      if (delegationState.sourceRoomId) params.set('sourceRoomId', delegationState.sourceRoomId);
      params.set('limit', '200');
      return params.toString();
    }

    async function refreshDelegations() {
      const root = $('#delegationModalBody');
      if (!root) return;
      root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
      try {
        const qs = delegationParams();
        const r = await api('/api/delegations' + (qs ? '?' + qs : ''));
        delegationState.list = r.delegations || [];
        if (!delegationState.activeId || !delegationState.list.some(d => d.id === delegationState.activeId)) {
          delegationState.activeId = delegationState.list[0]?.id || null;
        }
        renderDelegationModal();
      } catch (e) {
        root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
      }
    }

    function renderDelegationModal() {
      const root = $('#delegationModalBody');
      if (!root) return;
      const list = delegationState.list || [];
      const active = list.find(d => d.id === delegationState.activeId) || null;
      const queuedCount = list.filter(d => d.status === 'queued').length;
      const createdCount = list.filter(d => d.status === 'created').length;
      const failedCount = list.filter(d => d.status === 'failed').length;
      const currentRoomBtn = core.roomState.activeId
        ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" id="delegationUseCurrentRoom">当前房间</button>`
        : '';
      root.innerHTML = `
        <div class="delegation-toolbar">
          <select id="delegationStatusFilter">
            <option value="" ${delegationState.status === '' ? 'selected' : ''}>全部状态</option>
            <option value="queued" ${delegationState.status === 'queued' ? 'selected' : ''}>queued</option>
            <option value="created" ${delegationState.status === 'created' ? 'selected' : ''}>created</option>
            <option value="failed" ${delegationState.status === 'failed' ? 'selected' : ''}>failed</option>
            <option value="cancelled" ${delegationState.status === 'cancelled' ? 'selected' : ''}>cancelled</option>
          </select>
          <input id="delegationSourceRoom" type="text" placeholder="sourceRoomId" value="${escapeHtml(delegationState.sourceRoomId)}" />
          ${currentRoomBtn}
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="delegationClearFilters">清空</button>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="delegationRefresh">刷新</button>
        </div>
        <div class="delegation-stats">
          <span><strong>${list.length}</strong> delegations</span>
          <span><strong>${queuedCount}</strong> queued</span>
          <span><strong>${createdCount}</strong> created</span>
          <span class="${failedCount ? 'is-warn' : ''}"><strong>${failedCount}</strong> failed</span>
        </div>
        <div class="delegation-layout">
          <section class="delegation-list">
            ${list.length ? list.map(renderDelegationItem).join('') : '<div class="delegation-empty">当前筛选条件下没有委派记录。</div>'}
          </section>
          <section class="delegation-detail">
            ${active ? renderDelegationDetail(active) : '<div class="delegation-empty">选择左侧委派查看详情。</div>'}
          </section>
        </div>
      `;
      $('#delegationStatusFilter')?.addEventListener('change', (e) => {
        delegationState.status = e.target.value;
        delegationState.activeId = null;
        refreshDelegations();
      });
      $('#delegationSourceRoom')?.addEventListener('change', (e) => {
        delegationState.sourceRoomId = e.target.value.trim();
        delegationState.activeId = null;
        refreshDelegations();
      });
      $('#delegationUseCurrentRoom')?.addEventListener('click', () => {
        delegationState.sourceRoomId = core.roomState.activeId || '';
        delegationState.activeId = null;
        refreshDelegations();
      });
      $('#delegationClearFilters')?.addEventListener('click', () => {
        delegationState.status = '';
        delegationState.sourceRoomId = '';
        delegationState.activeId = null;
        refreshDelegations();
      });
      $('#delegationRefresh')?.addEventListener('click', refreshDelegations);
      root.querySelectorAll('[data-delegation-id]').forEach(el => {
        el.addEventListener('click', () => {
          delegationState.activeId = el.dataset.delegationId;
          renderDelegationModal();
        });
      });
      root.querySelectorAll('[data-delegation-execute]').forEach(btn => {
        btn.addEventListener('click', () => executeDelegation(btn.dataset.delegationExecute));
      });
      root.querySelectorAll('[data-delegation-cancel]').forEach(btn => {
        btn.addEventListener('click', () => cancelDelegation(btn.dataset.delegationCancel));
      });
      root.querySelectorAll('[data-delegation-autostart]').forEach(btn => {
        btn.addEventListener('click', () => queueDelegationAutostart(btn.dataset.delegationAutostart));
      });
      root.querySelectorAll('[data-delegation-open-room]').forEach(btn => {
        btn.addEventListener('click', () => openDelegationRoom(btn.dataset.delegationOpenRoom));
      });
    }

    function renderDelegationItem(d) {
      return `<button class="delegation-item ${d.id === delegationState.activeId ? 'is-active' : ''} status-${safeClassToken(d.status)}" data-delegation-id="${escapeHtml(d.id)}">
        <span class="delegation-item-head">
          <strong>${escapeHtml(d.title)}</strong>
          <span>${delegationTime(d.updatedAt || d.createdAt)}</span>
        </span>
        <span class="delegation-item-meta">source:${escapeHtml(shortLineageValue(d.sourceRoomId))}${d.sourceTaskId ? ' · task:' + escapeHtml(d.sourceTaskId) : ''}</span>
        <span class="delegation-item-foot">
          <span class="delegation-status ${safeClassToken(d.status)}">${escapeHtml(d.status)}</span>
          <span>${escapeHtml(d.targetMode)}</span>
        </span>
      </button>`;
    }

    function renderDelegationDetail(d) {
      return `
        <div class="delegation-detail-grid">
          <div class="k">ID</div><div class="v">${escapeHtml(d.id)}</div>
          <div class="k">状态</div><div class="v"><span class="delegation-status ${safeClassToken(d.status)}">${escapeHtml(d.status)}</span></div>
          <div class="k">标题</div><div class="v">${escapeHtml(d.title)}</div>
          <div class="k">模式</div><div class="v">${escapeHtml(d.targetMode)}</div>
          <div class="k">源房间</div><div class="v"><code>${escapeHtml(d.sourceRoomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-delegation-open-room="${escapeHtml(d.sourceRoomId)}">打开源房</button></div>
          <div class="k">源任务</div><div class="v">${d.sourceTaskId ? `<code>${escapeHtml(d.sourceTaskId)}</code>` : '-'}</div>
          <div class="k">目标房间</div><div class="v">${d.targetRoomId ? `<code>${escapeHtml(d.targetRoomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-delegation-open-room="${escapeHtml(d.targetRoomId)}">打开目标房</button>` : '-'}</div>
          <div class="k">创建时间</div><div class="v">${delegationTime(d.createdAt)}</div>
          <div class="k">执行时间</div><div class="v">${d.executedAt ? delegationTime(d.executedAt) : '-'}</div>
          ${d.error ? `<div class="k">错误</div><div class="v">${escapeHtml(d.error)}</div>` : ''}
        </div>
        <div class="delegation-instructions">${escapeHtml(d.instructions)}</div>
        <div class="delegation-actions">
          ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-primary" data-delegation-autostart="${escapeHtml(d.id)}">审批后自启动</button>` : ''}
          ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-primary" data-delegation-execute="${escapeHtml(d.id)}">执行委派</button>` : ''}
          ${d.status === 'queued' || d.status === 'failed' ? `<button class="cxbtn cxbtn-secondary" data-delegation-cancel="${escapeHtml(d.id)}">取消委派</button>` : ''}
        </div>
      `;
    }

    async function queueDelegationAutostart(id) {
      if (!id) return;
      try {
        const r = await api(`/api/delegations/${encodeURIComponent(id)}/autostart`, {
          method: 'POST',
          body: JSON.stringify({
            requireApproval: true,
            autoStart: true,
            budgetEstimate: { estimateCalls: 1 },
          }),
        });
        const approvalHint = r.approval?.id ? `，审批 ${r.approval.id}` : '';
        toast(`已加入 Autopilot 自启动队列${approvalHint}`, 'success', 2500);
        await refreshDelegations();
        if (r.approval?.status === 'pending') {
          closeDelegationModal();
          window.PanelApprovals?.openApprovalModal?.({ status: 'pending' });
        }
      } catch (e) {
        toast('加入自启动队列失败：' + e.message, 'error', 6000);
        refreshDelegations();
      }
    }

    async function executeDelegation(id) {
      if (!id) return;
      try {
        const r = await api(`/api/delegations/${encodeURIComponent(id)}/execute`, { method: 'POST' });
        delegationState.activeId = r.delegation?.id || id;
        toast('委派已执行', 'success', 1500);
        await refreshDelegations();
        await loadRooms();
      } catch (e) {
        toast('执行委派失败：' + e.message, 'error', 6000);
        refreshDelegations();
      }
    }

    async function cancelDelegation(id) {
      if (!id) return;
      const reason = await promptModal({
        title: '取消委派',
        message: '填写取消原因，留空也可以。',
        value: '',
        placeholder: '取消原因',
      });
      if (reason === null) return;
      try {
        const r = await api(`/api/delegations/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        delegationState.activeId = r.delegation?.id || id;
        toast('委派已取消', 'success', 1500);
        refreshDelegations();
      } catch (e) {
        toast('取消委派失败：' + e.message, 'error');
      }
    }

    async function openDelegationRoom(id) {
      if (!id) return;
      closeDelegationModal();
      showRoomArea();
      await loadRooms();
      selectRoom(id);
    }

    $('#btnDelegations')?.addEventListener('click', () => openDelegationModal());
    document.querySelectorAll('[data-close-delegation]').forEach(el => el.addEventListener('click', closeDelegationModal));

    window.PanelDelegation = {
      get state() { return delegationState; },
      openDelegationModal,
      closeDelegationModal,
      refreshDelegations,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
