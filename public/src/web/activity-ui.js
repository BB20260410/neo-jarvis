// activity-ui.js — 本地结构化审计时间线 modal（从 app.js 外迁；app.js 模块化第3批）
// 第三波批25（2026-06-11）：提取器层（activityTitle/activityAgentRunIds/isAgentActivityEvent 等 17 个纯函数）
// 与详情面板渲染（renderActivityDetail/ApprovalResumeGatePanel/AgentPanel/ArtifactPanel/ClusterDeliveryPanel/
// RunButtons）外迁 activity-detail-ui.js，经 window.PanelActivityDetail 懒解析（detail() 访问器，免疫加载顺序）。
// 本文件保留 activityState 单一属主 + modal 开关/刷新 + 主渲染与全部绑定 + window.PanelActivity（open/close/refresh 不变）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      $, toast, escapeHtml, api, roomState,
      activityTime, safeClassToken,

      fallbackCopy, showRoomArea, loadRooms, selectRoom,
    } = window.PanelCore;

    // 提取器/详情渲染懒解析桥（属主：activity-detail-ui.js；boot 顺序无关，调用期实时取）
    const detail = () => window.PanelActivityDetail || {};

    // ========== 本地结构化审计时间线 ==========
    const activityState = {
      events: [],
      activeId: null,
      filters: {
        q: '',
        action: '',
        roomId: '',
        sessionId: '',
        taskId: '',
        entityType: '',
        entityId: '',
        agentRunId: '',
        approvalResumeGateId: '',
        approvalResumeGateSha256: '',
        severity: '',
        status: '',
        agentOnly: false,
        agentProfileId: '',
        skillName: '',
        diagnosticCode: '',
        limit: 200,
      },
    };

    function filteredActivityEvents() {
      const q = (activityState.filters.q || '').trim().toLowerCase();
      if (!q) return activityState.events || [];
      return (activityState.events || []).filter(e => (detail().activitySearchText?.(e) || '').includes(q));
    }
    function activityApiParams() {
      const f = activityState.filters;
      const params = new URLSearchParams();
      for (const key of ['action', 'roomId', 'sessionId', 'taskId', 'entityType', 'entityId', 'agentRunId', 'approvalResumeGateId', 'approvalResumeGateSha256', 'severity', 'status']) {
        if (f[key]) params.set(key, f[key]);
      }
      if (f.agentOnly) params.set('agentOnly', '1');
      for (const key of ['agentProfileId', 'skillName', 'diagnosticCode']) {
        if (f[key]) params.set(key, f[key]);
      }
      params.set('limit', String(Math.max(1, Math.min(1000, Number(f.limit) || 200))));
      return params.toString();
    }

    async function openActivityModal(seed = {}) {
      $('#activityModal').style.display = 'flex';
      if (seed.roomId) activityState.filters.roomId = seed.roomId;
      if (seed.sessionId) activityState.filters.sessionId = seed.sessionId;
      if (seed.taskId) activityState.filters.taskId = seed.taskId;
      if (seed.entityType) activityState.filters.entityType = seed.entityType;
      if (seed.entityId) activityState.filters.entityId = seed.entityId;
      if (seed.agentRunId) {
        activityState.filters.q = '';
        activityState.filters.entityType = '';
        activityState.filters.entityId = '';
        activityState.filters.agentRunId = seed.agentRunId;
      }
      if (seed.approvalResumeGateId || seed.reviewGateId) {
        activityState.filters.q = '';
        activityState.filters.approvalResumeGateId = seed.approvalResumeGateId || seed.reviewGateId;
      }
      if (seed.approvalResumeGateSha256 || seed.reviewSha256) {
        activityState.filters.q = '';
        activityState.filters.approvalResumeGateSha256 = seed.approvalResumeGateSha256 || seed.reviewSha256;
      }
      if (seed.agentOnly) activityState.filters.agentOnly = true;
      if (seed.agentProfileId) activityState.filters.agentProfileId = seed.agentProfileId;
      if (seed.skillName) activityState.filters.skillName = seed.skillName;
      if (seed.diagnosticCode) activityState.filters.diagnosticCode = seed.diagnosticCode;
      if (seed.q) activityState.filters.q = seed.q;
      await refreshActivity();
    }
    function closeActivityModal() { $('#activityModal').style.display = 'none'; }

    async function refreshActivity() {
      const root = $('#activityModalBody');
      if (!root) return;
      root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
      try {
        const qs = activityApiParams();
        const r = await api('/api/activity' + (qs ? '?' + qs : ''));
        activityState.events = r.events || [];
        if (!activityState.activeId || !activityState.events.some(e => String(e.id) === String(activityState.activeId))) {
          activityState.activeId = activityState.events[0]?.id || null;
        }
        renderActivityModal();
      } catch (e) {
        root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
      }
    }

    function renderActivityModal() {
      const root = $('#activityModalBody');
      if (!root) return;
      const events = filteredActivityEvents();
      const active = events.find(e => String(e.id) === String(activityState.activeId)) || events[0] || null;
      if (active && String(active.id) !== String(activityState.activeId)) activityState.activeId = active.id;
      const errorCount = events.filter(e => ['error', 'warn', 'warning'].includes(String(e.severity || '').toLowerCase()) || String(e.status || '').toLowerCase().includes('error')).length;
      const roomCount = new Set(events.map(e => e.roomId).filter(Boolean)).size;
      const actionCount = new Set(events.map(e => e.action).filter(Boolean)).size;
      const agentCount = events.filter(e => detail().isAgentActivityEvent?.(e)).length;
      const diagnosticCount = events.reduce((sum, e) => sum + (detail().activityDiagnosticItems?.(e) || []).length, 0);
      const currentRoomBtn = roomState.activeId
        ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" id="activityUseCurrentRoom">当前房间</button>`
        : '';
      const allPresetActive = !activityState.filters.agentOnly
        && !activityState.filters.action
        && !activityState.filters.agentProfileId
        && !activityState.filters.skillName
        && !activityState.filters.diagnosticCode
        && !activityState.filters.approvalResumeGateId
        && !activityState.filters.approvalResumeGateSha256;

      root.innerHTML = `
        <div class="activity-filter-presets">
          <button class="cxbtn cxbtn-tertiary cxbtn-sm ${allPresetActive ? 'is-active' : ''}" data-activity-preset="all">全部</button>
          <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.agentOnly && !activityState.filters.action ? 'is-active' : ''}" data-activity-preset="agent">Agent/Skill</button>
          <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.action === 'agent.skill_diagnostics' || activityState.filters.diagnosticCode ? 'is-active' : ''}" data-activity-preset="diagnostics">诊断</button>
          <button class="cxbtn cxbtn-tertiary cxbtn-sm ${activityState.filters.action === 'metrics.recorded' ? 'is-active' : ''}" data-activity-preset="metrics">Metrics</button>
          ${currentRoomBtn}
        </div>
        <div class="activity-toolbar">
          <input class="activity-search-field" id="activitySearch" type="search" placeholder="搜索 action / room / task / details" value="${escapeHtml(activityState.filters.q)}" />
          <input id="activityAction" type="text" placeholder="action 精确过滤" value="${escapeHtml(activityState.filters.action)}" />
          <input id="activityRoomId" type="text" placeholder="roomId" value="${escapeHtml(activityState.filters.roomId)}" />
          <input id="activitySessionId" type="text" placeholder="sessionId" value="${escapeHtml(activityState.filters.sessionId)}" />
          <input id="activityTaskId" type="text" placeholder="taskId" value="${escapeHtml(activityState.filters.taskId)}" />
          <input id="activityEntityType" type="text" placeholder="entityType" value="${escapeHtml(activityState.filters.entityType)}" />
          <input id="activityEntityId" type="text" placeholder="entityId" value="${escapeHtml(activityState.filters.entityId)}" />
          <input id="activityAgentRunId" type="text" placeholder="agentRunId" value="${escapeHtml(activityState.filters.agentRunId)}" />
          <input id="activityGateId" type="text" placeholder="reviewGateId" value="${escapeHtml(activityState.filters.approvalResumeGateId)}" />
          <input id="activityGateSha" type="text" placeholder="reviewSha256" value="${escapeHtml(activityState.filters.approvalResumeGateSha256)}" />
          <input id="activityAgentProfileId" type="text" placeholder="agentProfileId" value="${escapeHtml(activityState.filters.agentProfileId)}" />
          <input id="activitySkillName" type="text" placeholder="skill" value="${escapeHtml(activityState.filters.skillName)}" />
          <input id="activityDiagnosticCode" type="text" placeholder="diagnostic code" value="${escapeHtml(activityState.filters.diagnosticCode)}" />
          <select id="activitySeverity">
            <option value="" ${activityState.filters.severity === '' ? 'selected' : ''}>severity 全部</option>
            <option value="info" ${activityState.filters.severity === 'info' ? 'selected' : ''}>info</option>
            <option value="warn" ${activityState.filters.severity === 'warn' ? 'selected' : ''}>warn</option>
            <option value="error" ${activityState.filters.severity === 'error' ? 'selected' : ''}>error</option>
          </select>
          <input id="activityStatus" type="text" placeholder="status" value="${escapeHtml(activityState.filters.status)}" />
          <select id="activityLimit">
            ${[100, 200, 500, 1000].map(n => `<option value="${n}" ${Number(activityState.filters.limit) === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
          <label class="activity-toggle"><input id="activityAgentOnly" type="checkbox" ${activityState.filters.agentOnly ? 'checked' : ''} /><span>Agent/Skill</span></label>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="activityClearFilters">清空</button>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="activityRefresh">刷新</button>
        </div>
        <div class="activity-stats">
          <span><strong>${events.length}</strong> events</span>
          <span><strong>${actionCount}</strong> actions</span>
          <span><strong>${roomCount}</strong> rooms</span>
          <span><strong>${agentCount}</strong> agent/skill</span>
          <span class="${diagnosticCount ? 'is-warn' : ''}"><strong>${diagnosticCount}</strong> diagnostics</span>
          <span class="${errorCount ? 'is-warn' : ''}"><strong>${errorCount}</strong> warn/error</span>
        </div>
        <div class="activity-layout">
          <section class="activity-list">
            ${events.length ? events.map(e => renderActivityItem(e)).join('') : '<div class="activity-empty">当前筛选条件下没有审计事件。</div>'}
          </section>
          <section class="activity-detail">
            ${active ? (detail().renderActivityDetail?.(active) || '') : '<div class="activity-empty">选择左侧事件查看结构化详情。</div>'}
          </section>
        </div>
      `;

      for (const [id, key] of [
        ['activitySearch', 'q'],
        ['activityAction', 'action'],
        ['activityRoomId', 'roomId'],
        ['activitySessionId', 'sessionId'],
        ['activityTaskId', 'taskId'],
        ['activityEntityType', 'entityType'],
        ['activityEntityId', 'entityId'],
        ['activityAgentRunId', 'agentRunId'],
        ['activityGateId', 'approvalResumeGateId'],
        ['activityGateSha', 'approvalResumeGateSha256'],
        ['activityAgentProfileId', 'agentProfileId'],
        ['activitySkillName', 'skillName'],
        ['activityDiagnosticCode', 'diagnosticCode'],
        ['activitySeverity', 'severity'],
        ['activityStatus', 'status'],
        ['activityLimit', 'limit'],
      ]) {
        const el = $('#' + id);
        if (!el) continue;
        const eventName = id === 'activitySearch' ? 'input' : 'change';
        el.addEventListener(eventName, () => {
          activityState.filters[key] = el.value.trim ? el.value.trim() : el.value;
          if (key === 'q') renderActivityModal();
          else refreshActivity();
        });
      }
      $('#activityAgentOnly')?.addEventListener('change', (e) => {
        activityState.filters.agentOnly = e.target.checked;
        activityState.activeId = null;
        refreshActivity();
      });
      $('#activityRefresh')?.addEventListener('click', refreshActivity);
      $('#activityClearFilters')?.addEventListener('click', () => {
        activityState.filters = { q: '', action: '', roomId: '', sessionId: '', taskId: '', entityType: '', entityId: '', agentRunId: '', approvalResumeGateId: '', approvalResumeGateSha256: '', severity: '', status: '', agentOnly: false, agentProfileId: '', skillName: '', diagnosticCode: '', limit: 200 };
        activityState.activeId = null;
        refreshActivity();
      });
      root.querySelectorAll('[data-activity-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const preset = btn.dataset.activityPreset;
          activityState.activeId = null;
          if (preset === 'all') {
            Object.assign(activityState.filters, { action: '', entityType: '', entityId: '', agentRunId: '', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: false, agentProfileId: '', skillName: '', diagnosticCode: '' });
          } else if (preset === 'agent') {
            Object.assign(activityState.filters, { action: '', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true, diagnosticCode: '' });
          } else if (preset === 'diagnostics') {
            Object.assign(activityState.filters, { action: 'agent.skill_diagnostics', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true });
          } else if (preset === 'metrics') {
            Object.assign(activityState.filters, { action: 'metrics.recorded', approvalResumeGateId: '', approvalResumeGateSha256: '', agentOnly: true, diagnosticCode: '' });
          }
          refreshActivity();
        });
      });
      $('#activityUseCurrentRoom')?.addEventListener('click', () => {
        activityState.filters.roomId = roomState.activeId || '';
        activityState.activeId = null;
        refreshActivity();
      });
      root.querySelectorAll('[data-activity-id]').forEach(el => {
        el.addEventListener('click', () => {
          activityState.activeId = Number(el.dataset.activityId) || el.dataset.activityId;
          renderActivityModal();
        });
      });
      root.querySelectorAll('[data-activity-open-room]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.activityOpenRoom;
          closeActivityModal();
          showRoomArea();
          await loadRooms();
          selectRoom(id);
        });
      });
      root.querySelectorAll('[data-activity-open-run]').forEach(btn => {
        btn.addEventListener('click', () => window.PanelCore.openAgentRunFromActivity?.(btn.dataset.activityOpenRun));
      });
      root.querySelectorAll('[data-activity-artifact-copy]').forEach(btn => {
        btn.addEventListener('click', () => {
          const path = btn.dataset.activityArtifactCopy || '';
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(path).then(() => toast('Artifact path copied', 'success', 1400)).catch(() => fallbackCopy(path));
          } else {
            fallbackCopy(path);
          }
        });
      });
      root.querySelectorAll('[data-activity-artifact-download]').forEach(btn => {
        btn.addEventListener('click', () => window.PanelCore.openAgentRunArtifact?.(btn.dataset.activityArtifactRun, btn.dataset.activityArtifactDownload, btn));
      });
    }

    function renderActivityItem(e) {
      const active = String(e.id) === String(activityState.activeId);
      const sev = safeClassToken(e.severity || 'info');
      const agentHint = renderActivityItemAgentHint(e);
      return `<button class="activity-item ${active ? 'is-active' : ''} sev-${sev}" data-activity-id="${escapeHtml(e.id)}">
        <span class="activity-item-head">
          <strong>${escapeHtml(detail().activityTitle?.(e) || '')}</strong>
          <span>${activityTime(e.ts)}</span>
        </span>
        <span class="activity-item-meta">${escapeHtml(detail().activityScopeLine?.(e) || '')}</span>
        ${agentHint}
        <span class="activity-item-foot">
          <span class="activity-severity ${sev}">${escapeHtml(e.severity || 'info')}</span>
          ${e.status ? `<span>${escapeHtml(e.status)}</span>` : ''}
          <span>${escapeHtml(e.actorType || 'system')}</span>
        </span>
      </button>`;
    }

    function renderActivityItemAgentHint(e) {
      const d = detail();
      if (!d.isAgentActivityEvent?.(e)) return '';
      const run = (d.activityAgentRunIds?.(e) || [])[0];
      const profile = (d.activityAgentProfileIds?.(e) || [])[0];
      const gate = (d.activityApprovalResumeGateIds?.(e) || [])[0];
      const skillCount = (d.activitySkillNames?.(e) || []).length;
      const diagnosticCount = (d.activityDiagnosticItems?.(e) || []).length;
      const parts = [];
      if (run) parts.push(run);
      if (gate) parts.push(gate);
      if (profile) parts.push(profile);
      if (skillCount) parts.push(`${skillCount} skills`);
      if (diagnosticCount) parts.push(`${diagnosticCount} diagnostics`);
      return `<span class="activity-agent-hint">${parts.map(part => `<span>${escapeHtml(part)}</span>`).join('')}</span>`;
    }

    // 按钮绑定
    $('#btnActivity')?.addEventListener('click', () => openActivityModal());
    document.querySelectorAll('[data-close-activity]').forEach(el => el.addEventListener('click', closeActivityModal));

    window.PanelActivity = { open: openActivityModal, close: closeActivityModal, refresh: refreshActivity };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
