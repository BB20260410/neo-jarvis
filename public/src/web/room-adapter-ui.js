// room-adapter-ui.js — Room Adapter 外部 provider 配置 modal（从 app.js 外迁；app.js 模块化第3批）
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避「import 早于 main.js 体内桥赋值」时序bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, roomState, requestWithApproval, handleApprovalFlow, refreshRoomProviders, renderRoomMembers } = window.PanelCore;

  // ============ v0.52 Room Adapter 配置 modal ============
  async function openRoomAdaptersModal() {
    try {
      const r = await fetch('/api/room-adapters').then(x => x.json());
      if (!r?.ok) { toast('加载配置失败：' + (r?.error || ''), 'error'); return; }
      const modal = $('#roomAdaptersModal');
      modal.style.display = 'flex';

      // 4 个固定 section
      for (const sectionId of ['minimax', 'gemini', 'gemini_openai', 'gemini_cli']) {
        const sec = modal.querySelector(`.adapter-section[data-id="${sectionId}"]`);
        if (!sec) continue;
        const cfg = r.config[sectionId] || {};
        sec.querySelector('[data-field="enabled"]').checked = !!cfg.enabled;
        for (const field of ['apiKey', 'baseUrl', 'model']) {
          const input = sec.querySelector(`[data-field="${field}"]`);
          if (input) input.value = cfg[field] || '';
        }
        // v0.52 timeoutMs / maxTokens
        const tInput = sec.querySelector('[data-field="timeoutMs"]');
        if (tInput) tInput.value = cfg.timeoutMs || 0;
        const mInput = sec.querySelector('[data-field="maxTokens"]');
        if (mInput) mInput.value = cfg.maxTokens || 0;
      }
      // v0.52 spawn_overrides 内置 CLI adapter timeout
      const ovSec = modal.querySelector('.adapter-section[data-id="spawn_overrides"]');
      if (ovSec) {
        const ov = r.config.spawn_overrides || {};
        for (const k of ['claudeTimeoutMs', 'codexTimeoutMs', 'ccrTimeoutMs']) {
          const input = ovSec.querySelector(`[data-field="${k}"]`);
          if (input) input.value = ov[k] || 0;
        }
      }
      // gemini_cli 状态徽章
      const status = $('#geminiCliStatus');
      if (status) {
        status.textContent = r.geminiCliAvailable ? '✅ 已检测到 `gemini` 命令' : '⚠️ PATH 中未检测到 `gemini`，启用不生效';
        status.style.color = r.geminiCliAvailable ? '#16a34a' : '#dc2626';
      }
      // customs 列表
      renderCustomsList(r.config.customs || []);
      // 重置保存状态
      setAdapterSaveStatus('', '');
    } catch (e) {
      toast('加载配置异常：' + e.message, 'error');
    }
  }

  function closeRoomAdaptersModal() {
    $('#roomAdaptersModal').style.display = 'none';
  }

  function renderCustomsList(customs) {
    const list = $('#customsList');
    if (!list) return;
    list.innerHTML = '';
    for (const c of customs) {
      list.appendChild(renderCustomRow(c));
    }
  }

  function renderCustomRow(c) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    row.dataset.id = c.id || '';
    row.innerHTML = `
      <div class="custom-row-head">
        <label><input type="checkbox" data-field="enabled" ${c.enabled !== false ? 'checked' : ''} /> 启用</label>
        <input type="text" data-field="displayName" class="grow" placeholder="显示名（如 Groq Llama 70B）" maxlength="80" />
        <button class="btn-icon" data-action="remove" title="删除该自定义条目">🗑</button>
      </div>
      <div class="adapter-fields">
        <label>id <input type="text" data-field="id" placeholder="标识符（字母数字-_）" pattern="[A-Za-z0-9_-]{1,40}" maxlength="40" /></label>
        <label>Model <input type="text" data-field="model" placeholder="如 llama-3.1-70b-versatile" /></label>
        <label>Base URL <input type="text" data-field="baseUrl" placeholder="如 https://api.groq.com/openai/v1" /></label>
        <label>API Key <input type="password" data-field="apiKey" placeholder="autocomplete: off" autocomplete="off" /></label>
        <label>超时（毫秒，0=默认 1 小时）<input type="number" data-field="timeoutMs" min="0" max="7200000" step="60000" placeholder="0" /></label>
        <label>最大输出 tokens（0=不传）<input type="number" data-field="maxTokens" min="0" max="200000" step="1024" placeholder="0" /></label>
      </div>
    `;
    row.querySelector('[data-field="displayName"]').value = c.displayName || '';
    row.querySelector('[data-field="id"]').value = c.id || '';
    row.querySelector('[data-field="model"]').value = c.model || '';
    row.querySelector('[data-field="baseUrl"]').value = c.baseUrl || '';
    row.querySelector('[data-field="apiKey"]').value = c.apiKey || '';
    row.querySelector('[data-field="timeoutMs"]').value = c.timeoutMs || 0;
    row.querySelector('[data-field="maxTokens"]').value = c.maxTokens || 0;
    row.querySelector('[data-action="remove"]').addEventListener('click', () => row.remove());
    return row;
  }

  function collectRoomAdaptersFromDOM() {
    const modal = $('#roomAdaptersModal');
    const out = {};
    for (const sectionId of ['minimax', 'gemini', 'gemini_openai', 'gemini_cli']) {
      const sec = modal.querySelector(`.adapter-section[data-id="${sectionId}"]`);
      if (!sec) continue;
      const obj = { enabled: sec.querySelector('[data-field="enabled"]').checked };
      for (const field of ['apiKey', 'baseUrl', 'model']) {
        const input = sec.querySelector(`[data-field="${field}"]`);
        if (input) obj[field] = input.value;
      }
      const tInput = sec.querySelector('[data-field="timeoutMs"]');
      if (tInput) obj.timeoutMs = parseInt(tInput.value, 10) || 0;
      const mInput = sec.querySelector('[data-field="maxTokens"]');
      if (mInput) obj.maxTokens = parseInt(mInput.value, 10) || 0;
      out[sectionId] = obj;
    }
    // v0.52 spawn_overrides
    const ovSec = modal.querySelector('.adapter-section[data-id="spawn_overrides"]');
    if (ovSec) {
      const ov = {};
      for (const k of ['claudeTimeoutMs', 'codexTimeoutMs', 'ccrTimeoutMs']) {
        const input = ovSec.querySelector(`[data-field="${k}"]`);
        ov[k] = input ? (parseInt(input.value, 10) || 0) : 0;
      }
      out.spawn_overrides = ov;
    }
    const customs = [];
    for (const row of $('#customsList').querySelectorAll('.custom-row')) {
      const tInput = row.querySelector('[data-field="timeoutMs"]');
      const mInput = row.querySelector('[data-field="maxTokens"]');
      customs.push({
        id: row.querySelector('[data-field="id"]').value.trim(),
        displayName: row.querySelector('[data-field="displayName"]').value.trim(),
        baseUrl: row.querySelector('[data-field="baseUrl"]').value.trim(),
        apiKey: row.querySelector('[data-field="apiKey"]').value,
        model: row.querySelector('[data-field="model"]').value.trim(),
        enabled: row.querySelector('[data-field="enabled"]').checked,
        timeoutMs: tInput ? (parseInt(tInput.value, 10) || 0) : 0,
        maxTokens: mInput ? (parseInt(mInput.value, 10) || 0) : 0,
      });
    }
    out.customs = customs;
    return out;
  }

  function setAdapterSaveStatus(text, kind) {
    const el = $('#adapterSaveStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'adapter-save-status' + (kind ? ' ' + kind : '');
  }

  async function saveRoomAdaptersFromModal() {
    const body = collectRoomAdaptersFromDOM();
    setAdapterSaveStatus('保存中…', '');
    const path = '/api/room-adapters';
    const opts = { method: 'PUT', body: JSON.stringify(body) };
    const onSaved = async (r) => {
      setAdapterSaveStatus(`已保存。当前可用 adapter：${(r?.activeProviders || []).join(' / ')}`, 'success');
      await refreshRoomProviders();
      // 若已开房间，刷新成员区让新 adapter 可选
      if (roomState.activeId) {
        const rr = await fetch(`/api/rooms/${roomState.activeId}`).then(x => x.json());
        if (rr?.ok) renderRoomMembers(rr.room);
      }
    };
    try {
      const result = await requestWithApproval(path, opts);
      if (result.status === 'approval_required') setAdapterSaveStatus('写入 provider 配置需人工批准', '');
      await handleApprovalFlow(result, path, opts, {
        actionLabel: '写入 Provider 配置',
        onOk: async (r) => { await onSaved(r.body); },
        onDenied: (r) => setAdapterSaveStatus('写入被拒绝：' + (r.permissionDecision?.reason || 'permission denied'), 'error'),
        onError: (r) => setAdapterSaveStatus('保存失败：' + (r.error || 'unknown'), 'error'),
      });
    } catch (e) {
      setAdapterSaveStatus('保存异常：' + e.message, 'error');
    }
  }

  $('#btnRoomAdapters')?.addEventListener('click', openRoomAdaptersModal);
  $('#btnSaveRoomAdapters')?.addEventListener('click', saveRoomAdaptersFromModal);
  $('#btnAddCustom')?.addEventListener('click', () => {
    $('#customsList').appendChild(renderCustomRow({ enabled: true }));
  });
  document.querySelectorAll('[data-close-room-adapters]').forEach(el => {
    el.addEventListener('click', closeRoomAdaptersModal);
  });

    window.PanelRoomAdapter = {
      open: openRoomAdaptersModal,
      close: closeRoomAdaptersModal,
      renderCustomsList,
      renderCustomRow,
      collectRoomAdaptersFromDOM,
      setAdapterSaveStatus,
      saveRoomAdaptersFromModal,
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);
})();
