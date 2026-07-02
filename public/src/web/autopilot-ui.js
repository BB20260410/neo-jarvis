// autopilot-ui.js — Autopilot 跨房自动化 UI（从 app.js 8771-9019 外迁；app.js 模块化破冰，workflow 蓝图指导）
// 依赖经 window.PanelCore（app.js 顶层桥）/ window.PanelDialog（已有）获取；main.js import，DOM ready 后自初始化。
(function () {
  'use strict';
  // 延迟到 DOMContentLoaded 再取依赖 + 定义：autopilot-ui 在 main.js import 时执行，早于 main.js 体内 window.PanelDialog 赋值
  function boot() {
    const { $, $$: _$$, toast, escapeHtml, createPanelMirroredState } = window.PanelCore;
    const { confirmModal, promptModal } = window.PanelDialog;
    const roomState = window.PanelCore.roomState;

  // ========== v0.56 Sprint 15-R4 — 🤖 Autopilot ==========
  // v0.84 真做 SSOT mirror：autopilotState
  const _autopilotStateRaw = { config: null, logs: [] };
  // B-018 v0.9: 渲染 autopilot 执行日志表格
  function renderAutopilotLogTable(logs) {
    if (!logs || logs.length === 0) {
      return '<div class="muted small" style="padding:12px;text-align:center;">📭 暂无日志（开启后房事件 done/error/auto_paused 会自动写）</div>';
    }
    // 按天分组
    const byDay = new Map();
    for (const l of logs.slice().reverse()) {
      const day = (l.at || '').slice(0, 10) || '未知日期';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(l);
    }
    const typeIcons = {
      fired: '✅', triggered: '✅',
      error: '❌', failed: '❌',
      skipped: '⏭', skip: '⏭',
      paused: '⏸', resumed: '▶',
    };
    const typeColors = {
      fired: 'var(--color-success)', triggered: 'var(--color-success)',
      error: 'var(--color-danger)', failed: 'var(--color-danger)',
      skipped: 'var(--gray-mid)', skip: 'var(--gray-mid)',
    };
    let html = `
      <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11.5px;">
        <thead style="position:sticky;top:0;background:var(--bg-top);z-index:1;">
          <tr style="border-bottom:1px solid var(--color-border-light);">
            <th style="text-align:left;padding:6px 8px;font-weight:600;">时间</th>
            <th style="text-align:left;padding:6px 8px;font-weight:600;">事件</th>
            <th style="text-align:left;padding:6px 8px;font-weight:600;">规则</th>
            <th style="text-align:left;padding:6px 8px;font-weight:600;">详情</th>
          </tr>
        </thead>
        <tbody>
    `;
    for (const [day, items] of byDay) {
      html += `<tr><td colspan="4" style="padding:8px;background:var(--bg-surface);font-weight:600;color:var(--color-text-foreground-secondary);">📅 ${escapeHtml(day)}（${items.length} 条）</td></tr>`;
      for (const l of items) {
        const time = (l.at || '').slice(11, 19);
        const typ = l.type || 'event';
        const icon = typeIcons[typ] || '•';
        const color = typeColors[typ] || 'var(--color-text-foreground)';
        const rule = l.ruleName || l.ruleId || '-';
        const detailParts = [];
        if (l.roomId) detailParts.push(`房=${l.roomId.slice(0, 8)}`);
        if (l.newRoomId) detailParts.push(`→ 新房=${l.newRoomId.slice(0, 8)}`);
        if (l.targetMode) detailParts.push(`mode=${l.targetMode}`);
        if (l.error) detailParts.push(`<span style="color:var(--color-danger);">err: ${escapeHtml(l.error.slice(0, 60))}</span>`);
        if (l.reason) detailParts.push(`原因: ${escapeHtml(l.reason.slice(0, 60))}`);
        const detail = detailParts.join(' · ') || '—';
        html += `
          <tr style="border-bottom:1px solid var(--color-border-light);">
            <td style="padding:4px 8px;color:var(--gray-mid);">${escapeHtml(time)}</td>
            <td style="padding:4px 8px;color:${color};">${icon} ${escapeHtml(typ)}</td>
            <td style="padding:4px 8px;min-width:0;word-break:break-word;">${escapeHtml(rule)}</td>
            <td style="padding:4px 8px;min-width:0;word-break:break-word;color:var(--color-text-foreground-secondary);">${detail}</td>
          </tr>
        `;
      }
    }
    html += '</tbody></table>';
    return html;
  }

  // v0.84 真做 SSOT mirror：autopilotState（_autopilotStateRaw 已在 line 5942 定义）
  const autopilotState = createPanelMirroredState('autopilot', _autopilotStateRaw);

  async function openAutopilotModal() {
    $('#autopilotModal').style.display = 'flex';
    await refreshAutopilot();
  }
  function closeAutopilotModal() { $('#autopilotModal').style.display = 'none'; }

  async function refreshAutopilot() {
    try {
      const [cfg, logs] = await Promise.all([
        fetch('/api/autopilot/config').then(x => x.json()),
        fetch('/api/autopilot/log?limit=50').then(x => x.json()),
      ]);
      autopilotState.config = cfg.config || null;
      autopilotState.logs = logs.logs || [];
      renderAutopilotModal();
    } catch (e) {
      $('#autopilotModalBody').innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAutopilotModal() {
    const root = $('#autopilotModalBody');
    const cfg = autopilotState.config;
    if (!cfg) { root.innerHTML = '<div class="muted">无配置</div>'; return; }
    const logs = autopilotState.logs || [];
    const rules = cfg.rules || [];
    const maxHops = Math.max(0, Number(cfg.maxHopsDefault) || 0);
    root.innerHTML = `
      <div class="autopilot-toggle-row">
        <span class="big-switch ${cfg.enabled ? 'is-on' : 'is-off'}">${cfg.enabled ? '🟢 已启用' : '⚪ 已关闭'}</span>
        <div class="ap-desc">
          ${cfg.enabled
            ? '房 done/error 时按下方规则自动 forward / notify；用户主动 claim 的房不动；每链最多 ' + maxHops + ' hop'
            : '默认关。开启后房自动触发跨房链路。所有动作都记日志，随时可关。'}
        </div>
        <button class="cxbtn ${cfg.enabled ? 'cxbtn-danger' : 'cxbtn-primary'}" id="btnAutopilotToggle">${cfg.enabled ? '⏸ 关闭' : '▶ 启用'}</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnAutopilotDryRun" title="模拟一次房间事件，看哪些规则会匹配（不真触发）">🧪 试跑</button>
      </div>

      <div>
        <div style="display:flex;align-items:center;margin-bottom:8px;">
          <h3 style="margin:0;flex:1;font-size:14px;">规则（${rules.length} 条）</h3>
          <label style="font-size:12px;color:var(--text-sec);">链路上限：
            <input type="number" id="apMaxHops" min="1" max="20" value="${cfg.maxHopsDefault}" style="width:60px;margin-left:4px;" />
          </label>
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApSaveHops" style="margin-left:6px;">💾</button>
        </div>
        <div class="autopilot-rules">
          ${rules.map(r => `
            <div class="autopilot-rule ${r.enabled ? '' : 'is-disabled'}" data-rule-id="${escapeHtml(r.id)}">
              <input type="checkbox" class="ap-rule-toggle" ${r.enabled ? 'checked' : ''} data-rule-id="${escapeHtml(r.id)}" />
              <div class="info">
                <div class="name">${escapeHtml(r.name)}${r.id.startsWith('builtin-') ? ' <span class="badge-builtin">内置</span>' : ''}</div>
                <div class="meta">事件 <b>${escapeHtml(r.when)}</b>${r.sourceMode ? ' · 仅 ' + escapeHtml(r.sourceMode) + ' 房' : ''} · 动作 <b>${escapeHtml(r.action)}</b>${r.targetMode ? ' → ' + escapeHtml(r.targetMode) : ''}${r.autoStart ? ' (autoStart)' : ''}</div>
              </div>
              ${r.id.startsWith('builtin-') ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm" data-rule-del="' + escapeHtml(r.id) + '">🗑</button>'}
            </div>
          `).join('')}
        </div>
      </div>

      <div>
        <div style="display:flex;align-items:center;margin:0 0 8px 0;gap:8px;flex-wrap:wrap;">
          <h3 style="margin:0;font-size:14px;flex:1;">📊 执行日志（${logs.length}）</h3>
          <select id="apLogFilter" class="ap-log-filter" style="font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--color-border-light);background:var(--bg-top);">
            <option value="">所有事件</option>
            <option value="fired">✅ 已触发</option>
            <option value="error">❌ 失败</option>
            <option value="skipped">⏭ 跳过</option>
          </select>
          <input id="apLogSearch" type="text" placeholder="搜规则名/房 ID" style="font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--color-border-light);background:var(--bg-top);max-width:160px;" />
        </div>
        <div class="autopilot-log-table" id="apLogTable" style="font-size:12px;border:1px solid var(--color-border-light);border-radius:6px;max-height:300px;overflow:auto;">
          ${renderAutopilotLogTable(logs)}
        </div>
      </div>

      <div class="archive-actions-row">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnApRefresh">↻ 刷新</button>
        <button class="cxbtn cxbtn-primary" data-close-autopilot>关闭</button>
      </div>
    `;
    // B-018: 日志过滤 + 搜索
    function applyLogFilters() {
      const typ = $('#apLogFilter')?.value || '';
      const q = ($('#apLogSearch')?.value || '').trim().toLowerCase();
      let filtered = autopilotState.logs || [];
      if (typ) filtered = filtered.filter(l => (l.type || '').includes(typ));
      if (q) filtered = filtered.filter(l => JSON.stringify(l).toLowerCase().includes(q));
      const tbl = $('#apLogTable');
      if (tbl) tbl.innerHTML = renderAutopilotLogTable(filtered);
    }
    $('#apLogFilter')?.addEventListener('change', applyLogFilters);
    $('#apLogSearch')?.addEventListener('input', applyLogFilters);

    $('#btnAutopilotToggle')?.addEventListener('click', toggleAutopilot);
    // v0.70.2-t4: dry-run 按钮（学自 W9 Flowise/Langflow/n8n dry-run）
    $('#btnAutopilotDryRun')?.addEventListener('click', async () => {
      const eventType = await promptModal({
        title: '🧪 Autopilot 规则试跑',
        message: '输入模拟的事件 type（room_done / room_error / room_auto_paused）',
        value: 'room_done',
      });
      if (!eventType) return;
      try {
        const r = await fetch('/api/autopilot/dry-run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: { type: eventType.trim(), sourceRoomId: roomState?.activeId || 'fake' } }),
        }).then(x => x.json());
        if (!r.ok) { toast('试跑失败：' + (r.error || ''), 'error'); return; }
        const matched = r.matched || [], actions = r.actions || [], skipped = r.skipped || [];
        const msg = `匹配规则 ${matched.length} 条：\n${matched.map(m => '  ✓ ' + m.name).join('\n') || '  (无)'}\n\n` +
                    `会触发 ${actions.length} 个 action：\n${actions.map(a => `  → ${a.ruleName}: ${a.action}${a.targetMode ? ' → ' + a.targetMode : ''}`).join('\n') || '  (无)'}\n\n` +
                    `跳过 ${skipped.length} 条：\n${skipped.map(s => `  − ${s.name}（${s.reason}）`).join('\n') || '  (无)'}`;
        await confirmModal({ title: '🧪 试跑结果（未真触发）', message: msg, confirmLabel: '关闭', cancelLabel: '' });
      } catch (e) { toast('试跑异常：' + e.message, 'error'); }
    });
    $('#btnApSaveHops')?.addEventListener('click', saveAutopilotHops);
    $('#btnApRefresh')?.addEventListener('click', refreshAutopilot);
    root.querySelectorAll('.ap-rule-toggle').forEach(el => {
      el.addEventListener('change', () => toggleAutopilotRule(el.dataset.ruleId, el.checked));
    });
    root.querySelectorAll('[data-rule-del]').forEach(el => {
      el.addEventListener('click', () => deleteAutopilotRule(el.dataset.ruleDel));
    });
    root.querySelectorAll('[data-close-autopilot]').forEach(el => el.addEventListener('click', closeAutopilotModal));
  }

  async function toggleAutopilot() {
    try {
      const r = await fetch('/api/autopilot/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autopilotState.config.enabled }),
      }).then(x => x.json());
      if (r.ok) { toast(r.enabled ? '✓ Autopilot 已启用' : '⏸ Autopilot 已关闭', 'success', 2000); refreshAutopilot(); }
      else toast('切换失败：' + (r.error || 'unknown'), 'error');
    } catch (e) { toast('切换失败：' + e.message, 'error'); }
  }
  async function saveAutopilotHops() {
    const v = Number($('#apMaxHops').value) || 5;
    try {
      const r = await fetch('/api/autopilot/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxHopsDefault: v }),
      }).then(x => x.json());
      if (r.ok) { toast('已保存', 'success', 1500); refreshAutopilot(); }
      else toast('保存失败：' + (r.error || 'unknown'), 'error');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  }
  async function toggleAutopilotRule(ruleId, enabled) {
    const rule = autopilotState.config.rules.find(r => r.id === ruleId);
    if (!rule) return;
    try {
      const r = await fetch('/api/autopilot/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rule, enabled }),
      }).then(x => x.json());
      if (r.ok) refreshAutopilot();
      else toast('保存失败：' + (r.error || 'unknown'), 'error');
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  }
  async function deleteAutopilotRule(id) {
    // S19 B2：原 confirm() blocking + 视觉不一致，改 confirmModal danger 风格
    const ok = await confirmModal({
      title: '删除 Autopilot 规则',
      message: '确定删除此规则？此操作不可撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/autopilot/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(x => x.json());
      if (r.ok) { toast('已删除', 'success', 1500); refreshAutopilot(); }
      else toast('删除失败：' + (r.error || 'unknown'), 'error');
    } catch (e) { toast('删除失败：' + e.message, 'error'); }
  }

  $('#btnAutopilot')?.addEventListener('click', openAutopilotModal);
  document.querySelectorAll('[data-close-autopilot]').forEach(el => el.addEventListener('click', closeAutopilotModal));

    window.PanelAutopilot = { open: openAutopilotModal };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0); // 非 loading 时延迟一拍，确保 main.js 体内 window.PanelDialog 赋值已执行完
})();
