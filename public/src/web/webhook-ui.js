// webhook-ui.js — Webhook 出站推送 UI（从 app.js 外迁；app.js 模块化第2批）
// 依赖经 window.PanelCore/PanelDialog/Modal/UI 桥；setTimeout 延迟初始化避「import 早于 main.js 体内 PanelDialog 赋值」时序bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, requestWithApproval, handleApprovalFlow } = window.PanelCore;
    const { confirmModal } = window.PanelDialog;
    const _Modal = window.Modal, _UI = window.UI;

  const webhookState = { items: [], activeId: null, isNew: false };

  // S18-3：改走 Modal 组件，open/close 变薄壳，原 state 复位挪进 onClose hook
  window.Modal?.register('webhookModal', {
    onOpen: () => refreshWebhookList(),
    onClose: () => { webhookState.activeId = null; webhookState.isNew = false; },
  });
  function openWebhookModal() { window.Modal.open('webhookModal'); }

  async function refreshWebhookList() {
    try {
      const r = await fetch('/api/webhooks').then(x => x.json());
      webhookState.items = r.webhooks || [];
    } catch (e) {
      webhookState.items = [];
      toast('加载 webhook 列表失败：' + e.message, 'error');
    }
    renderWebhookList();
    if (webhookState.activeId) {
      const e = webhookState.items.find(w => w.id === webhookState.activeId);
      if (e) renderWebhookDetail(e);
      else { webhookState.activeId = null; renderWebhookEmpty(); }
    } else if (!webhookState.isNew) {
      renderWebhookEmpty();
    }
  }

  function renderWebhookList() {
    const root = $('#webhookList');
    const count = $('#webhookCount');
    if (count) count.textContent = String(webhookState.items.length);
    if (!root) return;
    if (webhookState.items.length === 0) {
      root.innerHTML = window.UI.EmptyState({ kind: 'empty', text: '还没配置 webhook · 点 ＋ 新建', padding: '12px 4px' });
      return;
    }
    root.innerHTML = webhookState.items.map(w => {
      const active = webhookState.activeId === w.id ? ' active' : '';
      const fmtBadge = ({ discord: '🟣 Discord', slack: '🟢 Slack', json: '📦 JSON' })[w.format] || w.format;
      const disabled = w.enabled === false ? window.UI.Badge({ text: '已禁用', kind: 'disabled' }) : '';
      const stats = w.stats || { successCount: 0, errorCount: 0 };
      return `<div class="webhook-item${active}" data-wid="${escapeHtml(w.id)}">
        <div class="wname">${escapeHtml(w.name)} ${window.UI.Badge({ text: fmtBadge })}${disabled}</div>
        <div class="wurl">${escapeHtml(w.url)}</div>
        <div class="wstats">触发 <span class="ok">✓${stats.successCount}</span> <span class="err">✕${stats.errorCount}</span>${stats.lastError ? ' · ' + escapeHtml(stats.lastError.slice(0, 50)) : ''}</div>
      </div>`;
    }).join('');
    root.querySelectorAll('.webhook-item').forEach(el => {
      el.addEventListener('click', () => {
        webhookState.activeId = el.dataset.wid;
        webhookState.isNew = false;
        const w = webhookState.items.find(x => x.id === webhookState.activeId);
        if (w) { renderWebhookList(); renderWebhookDetail(w); }
      });
    });
  }

  function renderWebhookEmpty() {
    $('#webhookDetail').innerHTML = window.UI.EmptyState({ kind: 'neutral', text: '从左侧选一项编辑，或点 ＋ 新建一个', padding: '20px' });
  }

  function renderWebhookDetail(w) {
    const isNew = webhookState.isNew;
    const events = w.events || ['room_done', 'room_error', 'room_auto_paused'];
    const headers = w.headers || {};
    const headersJson = Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '';
    $('#webhookDetail').innerHTML = `
      <div class="webhook-form-row">
        <label>名字</label>
        <input id="whName" maxlength="80" placeholder="例：我的 Discord 服务器" value="${escapeHtml(w.name || '')}" />
      </div>
      <div class="webhook-form-row">
        <label>URL（必须 https://，仅 localhost 允许 http）</label>
        <input id="whUrl" maxlength="2048" placeholder="https://discord.com/api/webhooks/.../..." value="${escapeHtml(w.url || '')}" />
        ${isNew ? '' : '<div class="webhook-help-text">已存在的 webhook，URL 显示为掩码版（保留原 URL）。重新填则覆盖。</div>'}
      </div>
      <div class="webhook-form-row">
        <label>格式</label>
        <select id="whFormat">
          <option value="discord" ${w.format === 'discord' ? 'selected' : ''}>Discord（嵌入 embed 卡片）</option>
          <option value="slack" ${w.format === 'slack' ? 'selected' : ''}>Slack（attachments）</option>
          <option value="json" ${w.format === 'json' ? 'selected' : ''}>JSON（原始 event payload）</option>
        </select>
      </div>
      <div class="webhook-form-row">
        <label>订阅事件</label>
        <div class="webhook-events-row">
          <label><input type="checkbox" id="whEv_done"        ${events.includes('room_done') ? 'checked' : ''} /> 房间完成 (debate/squad/arena_done)</label>
          <label><input type="checkbox" id="whEv_error"       ${events.includes('room_error') ? 'checked' : ''} /> 房间出错 (*_error)</label>
          <label><input type="checkbox" id="whEv_auto_paused" ${events.includes('room_auto_paused') ? 'checked' : ''} /> 自动暂停</label>
        </div>
      </div>
      <div class="webhook-form-row">
        <label>自定义 headers（JSON 格式，可空）</label>
        <textarea id="whHeaders" placeholder='{"X-Token": "your-token"}'>${escapeHtml(headersJson)}</textarea>
        <div class="webhook-help-text">仅 json 格式有用。Authorization 头允许配但请谨慎。host/content-length 等被过滤。</div>
      </div>
      <div class="webhook-form-row">
        <label><input type="checkbox" id="whEnabled" ${w.enabled !== false ? 'checked' : ''} /> 启用</label>
      </div>
      <div class="webhook-form-actions">
        ${isNew ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm left-grow" id="btnWebhookDelete">🗑 删除</button>'}
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnWebhookTest" ${isNew ? 'disabled title="先保存才能测试"' : ''}>🧪 发送测试推送</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-webhook>取消</button>
        <button class="cxbtn cxbtn-primary" id="btnWebhookSave">${isNew ? '✓ 创建' : '💾 保存'}</button>
      </div>
    `;
    $('#btnWebhookSave')?.addEventListener('click', () => saveWebhook(isNew ? null : w.id));
    $('#btnWebhookTest')?.addEventListener('click', () => testWebhookById(w.id));
    $('#btnWebhookDelete')?.addEventListener('click', () => deleteWebhook(w.id));
    // S18-3：data-close-webhook 由 Modal event delegation 接管，不再每次重绑
  }

  function collectWebhookFromForm() {
    const eventsArr = [];
    if ($('#whEv_done')?.checked) eventsArr.push('room_done');
    if ($('#whEv_error')?.checked) eventsArr.push('room_error');
    if ($('#whEv_auto_paused')?.checked) eventsArr.push('room_auto_paused');
    let headers = {};
    const hRaw = ($('#whHeaders')?.value || '').trim();
    if (hRaw) {
      try { const obj = JSON.parse(hRaw); if (obj && typeof obj === 'object' && !Array.isArray(obj)) headers = obj; }
      catch { throw new Error('headers JSON 解析失败'); }
    }
    return {
      name: $('#whName')?.value || '',
      url: $('#whUrl')?.value || '',
      format: $('#whFormat')?.value || 'json',
      events: eventsArr,
      headers,
      enabled: $('#whEnabled')?.checked,
    };
  }

  async function saveWebhook(idOrNull) {
    let body;
    try { body = collectWebhookFromForm(); }
    catch (e) { toast(e.message, 'error'); return; }
    const isNew = !idOrNull;
    // 编辑时如果 URL 是掩码（含 "..."），不覆盖（让后端保留旧 URL）—— 这里前端做：URL 含 "..." 时去掉 url 字段
    if (!isNew && body.url && body.url.includes('...')) delete body.url;
    const path = isNew ? '/api/webhooks' : '/api/webhooks/' + encodeURIComponent(idOrNull);
    const opts = { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) };
    const onSaved = async (label, r) => {
      toast(label, 'success', 1800);
      webhookState.isNew = false;
      webhookState.activeId = r?.webhook?.id || webhookState.activeId;
      await refreshWebhookList();
    };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: isNew ? '创建 Webhook' : '更新 Webhook',
      onOk: async (r) => { await onSaved(isNew ? '已创建' : '已保存', r.body); },
      onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
    });
  }

  async function testWebhookById(id) {
    const path = `/api/webhooks/${encodeURIComponent(id)}/test`;
    const opts = { method: 'POST' };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: '发送测试推送',
      onOk: async () => { toast('测试推送成功 ✓ 查看目标平台确认收到', 'success', 3000); await refreshWebhookList(); },
      onError: (r) => toast('测试推送失败：' + (r.error || 'unknown'), 'error', 5000),
    });
  }

  async function deleteWebhook(id) {
    const w = webhookState.items.find(x => x.id === id);
    if (!w) return;
    const ok = await confirmModal({
      title: '删除 webhook',
      message: `要删除「${w.name}」吗？此操作不可撤销。`,
      confirmLabel: '删除', cancelLabel: '取消',
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/webhooks/' + encodeURIComponent(id), { method: 'DELETE' }).then(x => x.json());
      if (r.ok) {
        toast('已删除', 'success', 1500);
        webhookState.activeId = null;
        await refreshWebhookList();
      } else { toast('删除失败：' + (r.error || 'unknown'), 'error'); }
    } catch (e) { toast('删除失败：' + e.message, 'error'); }
  }

  $('#btnWebhooks')?.addEventListener('click', openWebhookModal);
  // 第13批：#btnWebhookNew 新建按钮绑定迁回属主模块（原 app.js 散落绑定，改直引模块内符号）
  $('#btnWebhookNew')?.addEventListener('click', () => {
    webhookState.isNew = true; webhookState.activeId = null;
    renderWebhookList();
    renderWebhookDetail({
      name: '', url: '', format: 'discord',
      events: ['room_done', 'room_error', 'room_auto_paused'],
      headers: {}, enabled: true,
    });
  });

    window.PanelWebhook = { open: openWebhookModal, get state() { return webhookState; }, renderList: renderWebhookList, renderDetail: renderWebhookDetail };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);
})();
