// @ts-check
// approval-flow-ui.js — P2 权限治理 UI 闭环：审批后重试基础设施
// （apiCall/requestWithApproval/approveAndRetryRequest/maskUrlForDisplay/openApprovalRetryModal/handleApprovalFlow）
// （从 app.js 外迁；app.js 模块化第21批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（纯工具可解构：api/toast/escapeHtml/getOwnerToken）；
// boot 延迟初始化避时序 bug。无 DOM 绑定、无加载即执行副作用，boot 仅挂 window.PanelApprovalFlow。
// 消费方（webhook-ui/mcp-ui/plugin-ui/safety-ui/room-adapter-ui/rooms-actions-ui）经 PanelCore 桥
// 懒转发取用，调用时实时解析，与本模块 boot 顺序无关。
// 跨文件依赖走 window 懒解析：PanelApprovals.openApprovalModal（审批中心）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { api, toast, escapeHtml, getOwnerToken } = core;

    // D6：统一「请求 + 失败 toast」样板（封装 api()）。成功返回 json；失败弹 error toast 并 rethrow，
    // 调用方可选再 catch。loadingMsg 给出时显示 info toast 直到完成；errorPrefix 定制错误文案前缀。
    async function apiCall(path, opts = {}, { loadingMsg, errorPrefix = '操作失败' } = {}) {
      const loading = loadingMsg ? toast(loadingMsg, 'info', 60000) : null;
      try {
        const r = await api(path, opts);
        loading?.remove?.();
        return r;
      } catch (e) {
        loading?.remove?.();
        toast(`${errorPrefix}：${e.message}`, 'error');
        throw e;
      }
    }

    // ─── P2 权限治理 UI 闭环：高风险写操作「审批后安全重试」─────
    // 后端约定：ask → HTTP 202 + { ok:false, error:'approval_required', approval, approvalId }
    //          deny → HTTP 403 + { ok:false, error:'permission_denied', permissionDecision }
    // 本机制只引导用户「批准后带 approvalId 重试同一请求」，绑定原 action/target，
    // 不自动重放危险终端命令（shell.exec 类不接入此机制）。
    async function requestWithApproval(path, opts = {}) {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      const token = getOwnerToken();
      if (token) headers['X-Panel-Owner-Token'] = token;
      let r;
      try {
        r = await fetch(path, { ...opts, headers });
      } catch (e) {
        return { status: 'error', httpStatus: 0, error: e.message };
      }
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      if (r.status === 202 && body && body.error === 'approval_required') {
        return {
          status: 'approval_required',
          httpStatus: 202,
          body,
          approvalId: body.approvalId || body.approval?.id || null,
          approval: body.approval || null,
          permissionDecision: body.permissionDecision || null,
        };
      }
      if (r.status === 403 && body && body.error === 'permission_denied') {
        return { status: 'denied', httpStatus: 403, body, permissionDecision: body.permissionDecision || null };
      }
      if (!r.ok || (body && body.ok === false)) {
        return { status: 'error', httpStatus: r.status, body, error: (body && body.error) || `HTTP ${r.status}` };
      }
      return { status: 'ok', httpStatus: r.status, body };
    }

    // 批准最新一个 approval 后带「全部已批准的 approvalId」重发原请求。
    // approvalId 走 X-Panel-Approval-Id header（逗号分隔，不改原 body，避免污染配置类入口 payload）；
    // 后端按 action/target 各自匹配对应 id，支持 watcher 这类同一请求内多重审批的链式批准。
    async function approveAndRetryRequest(approvalIds, path, opts = {}) {
      const ids = (Array.isArray(approvalIds) ? approvalIds : [approvalIds]).filter(Boolean);
      if (!ids.length) throw new Error('缺少 approvalId');
      await api(`/api/approvals/${encodeURIComponent(ids[ids.length - 1])}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason: '审批后重试原操作' }),
      });
      const retryOpts = { ...opts, headers: { ...(opts.headers || {}), 'X-Panel-Approval-Id': ids.join(',') } };
      return requestWithApproval(path, retryOpts);
    }

    function maskUrlForDisplay(url) {
      const s = String(url || '');
      try { const u = new URL(s); return u.host + (u.pathname && u.pathname !== '/' ? '/…' : ''); }
      catch { return s.length > 40 ? s.slice(0, 40) + '…' : s; }
    }

    // 通用「需要审批」弹窗：展示 approval payload 摘要，返回 Promise<'approve'|'cancel'>（纯展示+等待决定）
    function openApprovalRetryModal(opts = {}) {
      const { approvalId, approval, permissionDecision, actionLabel } = opts;
      const payload = approval?.payload || permissionDecision?.approvalPayload || {};
      const target = payload.target || {};
      const action = payload.action || permissionDecision?.action || '-';
      const risk = payload.risk || permissionDecision?.risk || 'high';
      const reason = payload.reason || permissionDecision?.reason || '需要人工批准';
      const urlDisp = target.url ? maskUrlForDisplay(target.url) : '';
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal approval-retry-modal';
        overlay.setAttribute('data-approval-retry-modal', approvalId || '');
        overlay.innerHTML = `
          <div class="confirm-modal-bg"></div>
          <div class="confirm-modal-body">
            <h3 class="confirm-modal-title">需要人工批准${actionLabel ? '：' + escapeHtml(actionLabel) : ''}</h3>
            <div class="approval-retry-summary">
              <div class="approval-retry-row"><span>操作</span><code>${escapeHtml(String(action))}</code></div>
              ${target.operation ? `<div class="approval-retry-row"><span>动作</span><code>${escapeHtml(String(target.operation))}</code></div>` : ''}
              ${urlDisp ? `<div class="approval-retry-row"><span>目标</span><code>${escapeHtml(urlDisp)}</code></div>` : ''}
              <div class="approval-retry-row"><span>风险</span><code>${escapeHtml(String(risk))}</code></div>
              <div class="approval-retry-row"><span>原因</span><span>${escapeHtml(String(reason))}</span></div>
              <div class="approval-retry-row"><span>审批 ID</span><code>${escapeHtml(approvalId || '-')}</code></div>
            </div>
            <div class="approval-retry-note">批准后将带 approvalId 重试同一操作（绑定原 action/target）；不会自动重放危险终端命令。</div>
            <div class="confirm-modal-actions">
              <button class="cxbtn cxbtn-tertiary" data-approval-retry-open-center>打开审批中心</button>
              <button class="cxbtn cxbtn-secondary" data-approval-retry-cancel>取消</button>
              <button class="cxbtn cxbtn-primary" data-approval-retry-confirm>批准并重试</button>
            </div>
          </div>
        `;
        let settled = false;
        const finish = (decision) => { if (settled) return; settled = true; overlay.remove(); resolve(decision); };
        overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish('cancel'));
        overlay.querySelector('[data-approval-retry-cancel]').addEventListener('click', () => finish('cancel'));
        overlay.querySelector('[data-approval-retry-open-center]').addEventListener('click', () => {
          finish('cancel');
          try { window.PanelApprovals?.openApprovalModal?.(); } catch { /* 审批中心可能未加载 */ }
        });
        overlay.querySelector('[data-approval-retry-confirm]').addEventListener('click', () => finish('approve'));
        document.body.appendChild(overlay);
      });
    }

    // 处理（可能多步的）审批后重试链：弹窗 → 批准 → 重试 → 若仍需审批则对下一个 approval 再弹，
    // 直到 ok / denied / error / 用户取消。支持 watcher 这类双重审批入口。单 approval 入口只循环一次。
    async function handleApprovalFlow(initialResult, path, opts, handlers = {}) {
      const { actionLabel = '', onOk, onDenied, onError, maxSteps = 5 } = handlers;
      let res = initialResult;
      let step = 0;
      const approvedIds = []; // 累积所有已批准的 approvalId，重试时全部带上（双重审批入口每步匹配各自的）
      while (res && res.status === 'approval_required') {
        step += 1;
        if (step > maxSteps) {
          toast('审批步骤过多，请到审批中心逐项处理', 'error', 5000);
          return;
        }
        const decision = await openApprovalRetryModal({
          approvalId: res.approvalId,
          approval: res.approval,
          permissionDecision: res.permissionDecision,
          actionLabel: step > 1 ? `${actionLabel}（第 ${step} 步审批）` : actionLabel,
        });
        if (decision !== 'approve') return; // 用户取消，静默
        if (res.approvalId && !approvedIds.includes(res.approvalId)) approvedIds.push(res.approvalId);
        try {
          res = await approveAndRetryRequest(approvedIds, path, opts);
        } catch (e) {
          res = { status: 'error', error: e.message || String(e) };
        }
      }
      if (!res) return;
      if (res.status === 'ok') { if (onOk) await onOk(res); }
      else if (res.status === 'denied') {
        if (onDenied) onDenied(res);
        else toast('操作被拒绝：' + (res.permissionDecision?.reason || 'permission denied'), 'error', 5000);
      } else {
        if (onError) onError(res);
        else toast('操作失败：' + (res.error || res.status || 'unknown'), 'error');
      }
    }

    window.PanelApprovalFlow = {
      apiCall,
      requestWithApproval,
      approveAndRetryRequest,
      maskUrlForDisplay,
      openApprovalRetryModal,
      handleApprovalFlow,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
