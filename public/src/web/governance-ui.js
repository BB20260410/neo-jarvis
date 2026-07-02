// governance-ui.js — 治理中心（Governance Center）UI 模块（从 app.js 外迁；app.js 模块化第4批）
// 第三波批26（2026-06-11）：Preflight/Resume Review 子域（stagedDiffFileMeta/governanceCommandKey/
// governanceCommandChips/governanceRiskReasons/governanceCoverageExplanations/orderedGovernanceReviewFiles/
// renderGovernanceCoverageFilter/renderGovernanceResumeReview/renderGovernanceCenterApprovals+
// command-jump/coverage-filter 两段 review 区绑定）外迁 governance-review-ui.js，
// 经 window.PanelGovernanceReview 懒解析（调用期实时取，免疫加载顺序）。
// 本文件保留状态/常量+modal 开关/刷新+看板渲染+主渲染绑定+三个 async 动作
// （approveAndResumeGovernanceRun 安全关键路径整体不动）+window.PanelGovernance（open/close/refresh 不变）。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      $, toast, escapeHtml, api,
      safeClassToken,
      openApprovalModal, openDelegationModal,

    } = window.PanelCore;

    // governanceKindLabel — 治理区内部用（overview-ui.js 有自己的私有同名版）
    function governanceKindLabel(kind) {
      return ({
        approval: '审批',
        budget: '预算',
        delegation: '委派',
        autopilot_job: '调度',
      })[kind] || kind || '事件';
    }

    // ========== P0 Governance Center — 统一治理入口 ==========
    const governanceCenterState = {
      summary: null,
      queue: null,
      loading: false,
      error: '',
    };

    // P5：工作队列状态机——五态及推进顺序（done 为终态）
    const GOV_QUEUE_STATE_LABELS = {
      pending_review: '待审批',
      pending_verify: '待验证',
      pending_archive: '待归档',
      pending_fix: '待修复',
      done: '已处理',
    };
    const GOV_QUEUE_NEXT_STATE = {
      pending_review: 'pending_verify',
      pending_verify: 'pending_archive',
      pending_archive: 'done',
      pending_fix: 'done',
    };

    function governanceCenterTime(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '-';
      try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
      catch { return '-'; }
    }

    function governanceCenterSeverityClass(severity) {
      return safeClassToken(severity || 'info');
    }

    function governanceCenterMetric(n) {
      return String(Number(n) || 0);
    }

    async function openGovernanceCenterModal() {
      $('#governanceCenterModal').style.display = 'flex';
      await refreshGovernanceCenter();
    }

    function closeGovernanceCenterModal() {
      $('#governanceCenterModal').style.display = 'none';
    }

    async function refreshGovernanceCenter() {
      const root = $('#governanceCenterBody');
      if (!root) return;
      governanceCenterState.loading = true;
      governanceCenterState.error = '';
      root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
      try {
        governanceCenterState.summary = await api('/api/governance/summary');
        // 工作队列与 summary 并行口径：派生失败不阻断主看板
        try { governanceCenterState.queue = await api('/api/governance/queue'); }
        catch { governanceCenterState.queue = null; }
      } catch (e) {
        governanceCenterState.error = e.message || '加载治理中心失败';
      } finally {
        governanceCenterState.loading = false;
        renderGovernanceCenter();
      }
    }

    // 推进队列项到下一状态
    async function advanceGovernanceQueueItem(id, nextState, btn = null) {
      if (!id || !nextState) return;
      if (btn) btn.disabled = true;
      try {
        await api(`/api/governance/queue/${encodeURIComponent(id)}/state`, {
          method: 'POST',
          body: JSON.stringify({ state: nextState }),
        });
        toast(`已推进到「${GOV_QUEUE_STATE_LABELS[nextState] || nextState}」`, 'success', 1500);
        await refreshGovernanceCenter();
      } catch (e) {
        toast('推进失败：' + (e.message || e), 'error');
        if (btn) btn.disabled = false;
      }
    }

    function renderGovernanceCenterQueue(queue) {
      const grouped = queue && queue.queue && !Array.isArray(queue.queue) ? queue.queue : null;
      const order = ['pending_review', 'pending_verify', 'pending_fix', 'pending_archive', 'done'];
      const cols = order.map((state) => {
        const items = (grouped && grouped[state]) || [];
        const cards = items.length
          ? items.map((it) => {
            const next = GOV_QUEUE_NEXT_STATE[it.queueState];
            const btn = next
              ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-gov-queue-advance="${escapeHtml(it.id)}" data-gov-queue-next="${escapeHtml(next)}">→ ${escapeHtml(GOV_QUEUE_STATE_LABELS[next] || next)}</button>`
              : '';
            return `<div class="gov-queue-item" data-gov-queue-id="${escapeHtml(it.id)}">
          <div class="gov-queue-item-title">${escapeHtml(it.title || it.sourceId || it.sourceKind || '-')}</div>
          <div class="gov-queue-item-meta"><span>${escapeHtml(it.sourceKind || '-')}</span>${btn}</div>
        </div>`;
          }).join('')
          : '<div class="muted small">—</div>';
        return `<div class="gov-queue-col" data-gov-queue-col="${state}">
      <div class="gov-queue-col-head">${escapeHtml(GOV_QUEUE_STATE_LABELS[state] || state)} <span>${items.length}</span></div>
      ${cards}
    </div>`;
      }).join('');
      return `<section class="governance-center-section" data-gov-center-queue>
    <h4>工作队列</h4>
    <div class="gov-queue-board">${cols}</div>
  </section>`;
    }

    function governanceActionLabel(action = {}) {
      return action.label || ({
        review_pending_approvals: 'Review pending approvals',
        resolve_budget_hard_stop: 'Resolve budget hard stop',
        inspect_failed_delegation: 'Inspect failed delegation',
        inspect_running_autopilot: 'Inspect running Autopilot',
        inspect_deferred_agent_run: 'Inspect deferred Agent Run',
      })[action.type] || action.type || 'Inspect governance item';
    }

    function renderGovernanceCenterCards(counts = {}) {
      const items = [
        { label: '待审批', value: counts.pendingApprovals, severity: counts.pendingApprovals ? 'warn' : 'info', target: 'approval' },
        { label: '预算事件', value: counts.openBudgetIncidents, severity: counts.openBudgetIncidents ? 'warn' : 'info', target: 'budget' },
        { label: '委派队列', value: (counts.queuedDelegations || 0) + (counts.failedDelegations || 0), severity: counts.failedDelegations ? 'error' : 'info', target: 'delegation' },
        { label: '自驾任务', value: (counts.queuedAutopilotJobs || 0) + (counts.runningAutopilotJobs || 0), severity: counts.runningAutopilotJobs ? 'warn' : 'info', target: 'autopilot_job' },
        { label: '治理 Run', value: counts.governedAgentRuns, severity: counts.governedAgentRuns ? 'info' : 'info', target: 'agent_run' },
        { label: '硬阻塞', value: counts.hardBlockers, severity: counts.hardBlockers ? 'error' : 'info', target: 'blockers' },
      ];
      return `<section class="governance-center-kpis">
    ${items.map(item => `<button class="governance-center-kpi sev-${governanceCenterSeverityClass(item.severity)}" data-gov-center-target="${escapeHtml(item.target)}">
      <span class="k">${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(governanceCenterMetric(item.value))}</strong>
    </button>`).join('')}
  </section>`;
    }

    function renderGovernanceCenterNextActions(actions = []) {
      if (!actions.length) {
        return `<section class="governance-center-section">
      <h3>Next Actions</h3>
      <div class="governance-center-empty">当前没有阻塞性治理动作。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Next Actions</h3>
    <div class="governance-center-action-list">
      ${actions.map(action => `<button class="governance-center-action sev-${governanceCenterSeverityClass(action.severity)}" data-gov-center-open="${escapeHtml(action.targetKind || '')}" data-gov-center-id="${escapeHtml(action.targetId || '')}">
        <span>${escapeHtml(governanceActionLabel(action))}</span>
        <code>${escapeHtml(action.targetId || action.targetKind || '-')}</code>
      </button>`).join('')}
    </div>
  </section>`;
    }

    function renderGovernanceCenterBlockers(blockers = []) {
      if (!blockers.length) {
        return `<section class="governance-center-section">
      <h3>Open Items</h3>
      <div class="governance-center-empty">没有待处理审批、预算、委派或调度事项。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Open Items</h3>
    <div class="governance-center-item-list">
      ${blockers.map(item => `<button class="governance-center-item sev-${governanceCenterSeverityClass(item.severity)}" data-gov-center-open="${escapeHtml(item.kind || '')}" data-gov-center-id="${escapeHtml(item.id || '')}">
        <span class="kind">${escapeHtml(governanceKindLabel(item.kind))}</span>
        <span class="title" title="${escapeHtml(item.title || item.id || '')}">${escapeHtml(item.title || item.id || '-')}</span>
        <span class="status">${escapeHtml(item.status || '-')}</span>
      </button>`).join('')}
    </div>
  </section>`;
    }

    function renderGovernanceCenterBudgetIncidents(incidents = []) {
      if (!incidents.length) {
        return `<section class="governance-center-section">
      <h3>Budget Actions</h3>
      <div class="governance-center-empty">当前没有 open budget incident。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Budget Actions</h3>
    <div class="governance-center-budget-list">
      ${incidents.map(incident => {
        const usage = `${window.BudgetUtils.fmtBudgetMetric(incident.metric, incident.observedAmount)} / ${window.BudgetUtils.fmtBudgetMetric(incident.metric, incident.limitAmount)}`;
        const scope = window.BudgetUtils.budgetScopeLabel(incident.scopeType, incident.scopeId);
        const hard = incident.thresholdType === 'hard_stop';
        return `<div class="governance-center-budget ${hard ? 'sev-error' : 'sev-warn'}">
          <button class="governance-center-budget-main" data-gov-center-open="budget" data-gov-center-id="${escapeHtml(incident.id)}">
            <span class="title">${escapeHtml(scope)}</span>
            <span class="meta">${escapeHtml(incident.thresholdType || '-')} · ${escapeHtml(usage)}</span>
          </button>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" data-gov-center-resolve-budget="${escapeHtml(incident.id)}">标记已处理</button>
        </div>`;
      }).join('')}
    </div>
  </section>`;
    }

    function renderGovernanceCenterRuns(runs = []) {
      if (!runs.length) {
        return `<section class="governance-center-section">
      <h3>Agent Runs</h3>
      <div class="governance-center-empty">最近没有带治理链路的 Agent Run。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Agent Runs</h3>
    <div class="governance-center-run-list">
      ${runs.map(run => `<button class="governance-center-run" data-gov-center-open="agent_run" data-gov-center-id="${escapeHtml(run.id)}">
        <span class="title">${escapeHtml(run.taskId || run.id)}</span>
        <span class="meta">${escapeHtml(run.status || '-')} · ${escapeHtml(run.sourceType || '-')} · ${escapeHtml(run.deferReason || 'no defer')}</span>
        <span class="ids">${[run.approvalId, run.budgetIncidentId, run.delegationId].filter(Boolean).map(escapeHtml).join(' · ') || '-'}</span>
      </button>`).join('')}
    </div>
  </section>`;
    }

    function renderGovernanceCenterActivity(events = []) {
      if (!events.length) {
        return `<section class="governance-center-section">
      <h3>Recent Activity</h3>
      <div class="governance-center-empty">最近没有治理审计事件。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Recent Activity</h3>
    <div class="governance-center-activity-list">
      ${events.map(event => `<button class="governance-center-activity" data-gov-center-open="${event.agentRunId ? 'agent_run' : 'activity'}" data-gov-center-id="${escapeHtml(event.agentRunId || event.entityId || event.id || '')}">
        <span class="action">${escapeHtml(event.action || '-')}</span>
        <span class="meta">${escapeHtml(event.entityType || '-')} · ${escapeHtml(event.entityId || '-')} · ${governanceCenterTime(event.ts)}</span>
      </button>`).join('')}
    </div>
  </section>`;
    }

    function renderGovernanceCenter() {
      const root = $('#governanceCenterBody');
      if (!root) return;
      if (governanceCenterState.error) {
        root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(governanceCenterState.error)}</div>`;
        return;
      }
      const summary = governanceCenterState.summary || {};
      const counts = summary.counts || {};
      const sections = summary.sections || {};
      root.innerHTML = `
    <div class="governance-center-toolbar">
      <div>
        <strong>本地治理总控</strong>
        <span>${summary.generatedAt ? `更新于 ${governanceCenterTime(summary.generatedAt)}` : '等待数据'}</span>
      </div>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnGovernanceCenterRefresh">刷新</button>
    </div>
    ${renderGovernanceCenterCards(counts)}
    ${renderGovernanceCenterQueue(governanceCenterState.queue)}
    <div class="governance-center-grid">
      ${renderGovernanceCenterNextActions(summary.nextActions || [])}
      ${window.PanelGovernanceReview?.renderGovernanceCenterApprovals?.(sections.approvals || []) || ''}
      ${renderGovernanceCenterBudgetIncidents(sections.budgetIncidents || [])}
      ${renderGovernanceCenterBlockers(summary.blockers || [])}
      ${renderGovernanceCenterRuns(sections.agentRuns || [])}
      ${renderGovernanceCenterActivity(sections.activityEvents || [])}
    </div>
  `;
      $('#btnGovernanceCenterRefresh')?.addEventListener('click', refreshGovernanceCenter);
      root.querySelectorAll('[data-gov-queue-advance]').forEach(btn => {
        btn.addEventListener('click', () => advanceGovernanceQueueItem(btn.dataset.govQueueAdvance, btn.dataset.govQueueNext, btn));
      });
      root.querySelectorAll('[data-gov-center-open]').forEach(btn => {
        btn.addEventListener('click', () => openGovernanceCenterTarget(btn.dataset.govCenterOpen, btn.dataset.govCenterId));
      });
      root.querySelectorAll('[data-gov-center-target]').forEach(btn => {
        btn.addEventListener('click', () => openGovernanceCenterTarget(btn.dataset.govCenterTarget, ''));
      });
      root.querySelectorAll('[data-gov-center-resolve-budget]').forEach(btn => {
        btn.addEventListener('click', () => resolveGovernanceCenterBudgetIncident(btn.dataset.govCenterResolveBudget, btn));
      });
      root.querySelectorAll('[data-gov-center-approve-resume]').forEach(btn => {
        btn.addEventListener('click', () => approveAndResumeGovernanceRun(btn.dataset.govCenterApproveResume, btn.dataset.govCenterRun, btn, {
          reviewGateId: btn.dataset.govCenterReviewGate,
          reviewSha256: btn.dataset.govCenterReviewSha,
        }));
      });
      // review 区两段绑定（command-jump 滚动高亮 + coverage filter）随渲染同属主迁 governance-review-ui.js
      window.PanelGovernanceReview?.bindReviewEvents?.(root);
    }

    async function approveAndResumeGovernanceRun(approvalId, runId, btn = null, options = {}) {
      if (!approvalId || !runId) return;
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '续跑中…';
      }
      try {
        const preview = await api(`/api/agent-runs/${encodeURIComponent(runId)}/approval-resume-preview?approvalId=${encodeURIComponent(approvalId)}`);
        const currentGate = preview.resumeReviewGate || preview.resumeReview?.gate || {};
        if (!currentGate.id || !currentGate.sha256) {
          throw new Error('Preflight review gate missing');
        }
        if (preview.resumeReview?.safeToResume === false || currentGate.safeToResume === false) {
          throw new Error('Preflight review is not safe to resume');
        }
        if ((options.reviewGateId && options.reviewGateId !== currentGate.id)
          || (options.reviewSha256 && options.reviewSha256 !== currentGate.sha256)) {
          throw new Error('Preflight review gate changed; refresh and review again');
        }
        await api(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Governance Center approve and resume' }),
        });
        const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}/approval-resume`, {
          method: 'POST',
          body: JSON.stringify({
            approvalId,
            requestedBy: 'owner',
            reviewGateId: currentGate.id,
            reviewSha256: currentGate.sha256,
          }),
        });
        toast(result.archive?.summary || '审批已通过，Agent Run 已续跑', 'success', 2200);
        closeGovernanceCenterModal();
        await window.PanelCore.openAgentRunFromActivity?.(runId);
      } catch (e) {
        toast('批准续跑失败：' + (e.message || e), 'error', 3500);
        await refreshGovernanceCenter();
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '批准并续跑';
        }
      }
    }

    async function resolveGovernanceCenterBudgetIncident(id, btn = null) {
      if (!id) return;
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '处理中…';
      }
      try {
        await api(`/api/budgets/incidents/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ source: 'governance_center' }),
        });
        toast('预算事件已处理', 'success', 1500);
        await refreshGovernanceCenter();
        if (window.PanelOverview?.state.shown) window.PanelOverview.refreshOverview();
      } catch (e) {
        toast('处理失败：' + e.message, 'error');
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '标记已处理';
        }
      }
    }

    async function openGovernanceCenterTarget(kind, id = '') {
      closeGovernanceCenterModal();
      if (kind === 'approval') return openApprovalModal(id || null);
      if (kind === 'budget' || kind === 'blockers') return window.PanelOverview?.showOverviewArea();
      if (kind === 'delegation') {
        if (id && window.PanelCore.delegationState) window.PanelCore.delegationState.activeId = id;
        return openDelegationModal();
      }
      if (kind === 'autopilot_job') return window.PanelAutopilot?.open();
      if (kind === 'agent_run' && id) return window.PanelCore.openAgentRunFromActivity?.(id);
      if (kind === 'activity') return window.PanelActivity.open(id ? { entityId: id } : {});
      return window.PanelActivity.open({ q: id || kind || '' });
    }

    // 按钮绑定
    $('#btnGovernance')?.addEventListener('click', () => openGovernanceCenterModal());
    document.querySelectorAll('[data-close-governance-center]').forEach(el => el.addEventListener('click', closeGovernanceCenterModal));

    window.PanelGovernance = { open: openGovernanceCenterModal, close: closeGovernanceCenterModal, refresh: refreshGovernanceCenter };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
