// @ts-check
// plugin-ui.js — Plugin 中心（pluginState/showPluginArea/hidePluginArea/loadPluginList/renderPluginList/renderPluginDetail/runPluginCommand/installPluginFromFile + #btnPlugin* 绑定）（从 app.js 外迁；app.js 模块化第13批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 注：showPluginArea/hidePluginArea 直接写 #roomArea/#termArea 等区外 DOM 的耦合保持原样（互相隐藏约定）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml, confirmModal, promptModal, createPanelMirroredState, requestWithApproval, handleApprovalFlow } = core;

    // ============ v0.52 Plugin 中心（Sprint 10 误删，v0.56 修复重写） ============
    // v0.84 真做 SSOT mirror：pluginState
    const _pluginStateRaw = { list: [], activeId: null };
    const pluginState = createPanelMirroredState('plugin', _pluginStateRaw);

    function showPluginArea() {
      $('#mainHeader') && ($('#mainHeader').style.display = 'none');
      $('#chatArea') && ($('#chatArea').style.display = 'none');
      $('#termArea') && ($('#termArea').style.display = 'none');
      $('#roomArea') && ($('#roomArea').style.display = 'none');
      $('#overviewArea') && ($('#overviewArea').style.display = 'none');
      $('#pluginArea').style.display = 'flex';
      loadPluginList();
    }
    function hidePluginArea() {
      $('#pluginArea').style.display = 'none';
      if (core.state.activeId) $('#chatArea').style.display = 'flex';
      else $('#mainHeader').style.display = 'flex';
    }

    async function loadPluginList() {
      try {
        const r = await fetch('/api/plugins').then(x => x.json());
        pluginState.list = r.plugins || [];
        renderPluginList();
        if (pluginState.activeId) {
          const e = pluginState.list.find(p => p.id === pluginState.activeId);
          if (e) renderPluginDetail(pluginState.activeId);
          else pluginState.activeId = null;
        }
      } catch (e) { toast('加载 plugin 列表失败：' + e.message, 'error'); }
    }

    function renderPluginList() {
      const root = $('#pluginList');
      if (!root) return;
      if (pluginState.list.length === 0) {
        root.innerHTML = '<div class="muted small" style="padding:12px;">没加载任何 plugin（builtin + user 都空？）</div>';
        return;
      }
      root.innerHTML = pluginState.list.map(p => {
        const active = pluginState.activeId === p.id ? ' active' : '';
        const sourceBadge = p.source === 'builtin' ? '<span class="badge">内置</span>' : '<span class="badge">用户</span>';
        const statusBadge = p.valid
          ? '<span class="badge" style="color:#2da44e;">✓ 可用</span>'
          : `<span class="badge" style="color:var(--color-danger-alt);" title="${escapeHtml(p.error || 'bin 探测失败')}">⚠️ 不可用</span>`;
        return `<div class="plugin-list-item${active}" data-id="${escapeHtml(p.id)}">
          <div class="plugin-list-item-head">
            <span style="font-size:16px;">${escapeHtml(p.icon || '🧩')}</span>
            <span class="plugin-list-item-name">${escapeHtml(p.displayName || p.id)}</span>
          </div>
          <div class="plugin-list-item-meta">
            ${sourceBadge} ${statusBadge}
            <span class="muted">${escapeHtml(p.type || 'spawn')} · ${(p.commands || []).length} cmd</span>
          </div>
        </div>`;
      }).join('');
      root.querySelectorAll('.plugin-list-item').forEach(el => {
        el.addEventListener('click', () => {
          pluginState.activeId = el.dataset.id;
          renderPluginList();
          renderPluginDetail(pluginState.activeId);
        });
      });
    }

    async function renderPluginDetail(id) {
      const root = $('#pluginMain');
      if (!root) return;
      root.innerHTML = '<div class="muted small" style="padding:20px;">加载详情中…</div>';
      let manifest;
      try {
        const r = await fetch('/api/plugins/' + encodeURIComponent(id)).then(x => x.json());
        if (!r.ok) { root.innerHTML = '<div class="muted">加载失败：' + escapeHtml(r.error || 'unknown') + '</div>'; return; }
        manifest = r.manifest;
      } catch (e) { root.innerHTML = '<div class="muted">异常：' + escapeHtml(e.message) + '</div>'; return; }

      const entry = pluginState.list.find(p => p.id === id);
      const cmdList = (manifest.commands || []).map(c => `
        <div class="plugin-cmd-card">
          <div><b>${escapeHtml(c.id)}</b> · ${escapeHtml(c.name || '')}</div>
          <div class="muted small">${escapeHtml(c.description || '')}</div>
          <div class="muted small" style="font-family:ui-monospace,monospace;font-size:11px;">args: ${escapeHtml((c.args || []).join(' '))}</div>
          <button class="cxbtn cxbtn-primary cxbtn-sm" data-run-cmd="${escapeHtml(c.id)}">▶ 运行</button>
        </div>
      `).join('');
      const isBuiltin = entry?.source === 'builtin';
      root.innerHTML = `
        <div class="plugin-detail-head">
          <h2>${escapeHtml(manifest.icon || '🧩')} ${escapeHtml(manifest.displayName || manifest.id)}</h2>
          <span class="muted small">${escapeHtml(manifest.id)} · v${escapeHtml(manifest.version || '0.0.0')} · type=${escapeHtml(manifest.type || 'spawn')}</span>
          <div class="plugin-detail-actions">
            ${isBuiltin ? '<span class="muted small">内置 plugin 不可卸载</span>' : `<button class="cxbtn cxbtn-danger cxbtn-sm" id="btnPluginUninstall">🗑 卸载</button>`}
          </div>
        </div>
        <div class="plugin-detail-body">
          ${entry?.error ? `<div style="padding:10px;background:rgba(220,53,69,0.08);border-left:3px solid #dc3545;border-radius:4px;">⚠️ ${escapeHtml(entry.error)}</div>` : ''}
          <h3>命令清单（${(manifest.commands || []).length}）</h3>
          <div class="plugin-cmd-list">${cmdList || '<div class="muted">此 plugin 未声明命令</div>'}</div>
        </div>
      `;
      $('#btnPluginUninstall')?.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: '卸载 Plugin',
          message: `要卸载 plugin「${id}」吗？此操作不可撤销。`,
          confirmLabel: '卸载', cancelLabel: '取消', danger: true,
        });
        if (!ok) return;
        const path = '/api/plugins/' + encodeURIComponent(id);
        const opts = { method: 'DELETE' };
        const result = await requestWithApproval(path, opts);
        await handleApprovalFlow(result, path, opts, {
          actionLabel: '卸载 Plugin：' + id,
          onOk: async () => { toast('已卸载', 'success', 1500); pluginState.activeId = null; loadPluginList(); },
          onError: (r) => toast('卸载失败：' + (r.error || 'unknown'), 'error'),
        });
      });
      root.querySelectorAll('[data-run-cmd]').forEach(el => {
        el.addEventListener('click', () => runPluginCommand(id, el.dataset.runCmd));
      });
    }

    async function runPluginCommand(pluginId, commandId) {
      const prompt = await promptModal({ title: `运行 ${pluginId}.${commandId}`, message: '输入要发给 plugin 的 prompt（可空）', multiline: true, placeholder: '...' });
      if (prompt === null) return;
      const loading = toast(`运行中（${pluginId}.${commandId}）…`, 'info', 60000);
      const clearLoading = () => { try { loading?.remove?.(); } catch {} };
      const path = `/api/plugins/${encodeURIComponent(pluginId)}/exec`;
      const opts = { method: 'POST', body: JSON.stringify({ commandId, prompt: prompt || '' }) };
      const result = await requestWithApproval(path, opts);
      await handleApprovalFlow(result, path, opts, {
        actionLabel: `运行 ${pluginId}.${commandId}`,
        onOk: async (r) => {
          clearLoading();
          const reply = r.body?.reply;
          await confirmModal({
            title: `✓ ${pluginId}.${commandId} 完成`,
            message: reply ? reply.slice(0, 4000) + (reply.length > 4000 ? '\n…（已截断）' : '') : '(空回复)',
            confirmLabel: '关闭', cancelLabel: '',
          });
        },
        onError: (r) => { clearLoading(); toast('运行失败：' + (r.error || 'unknown'), 'error', 5000); },
      });
      clearLoading(); // 用户在审批弹窗取消时兜底清除 loading
    }

    async function installPluginFromFile(file) {
      if (!file) return;
      if (file.size > 32 * 1024) { toast('manifest 文件过大（>32KB）', 'error'); return; }
      let manifest;
      try {
        const text = await file.text();
        manifest = JSON.parse(text);
      } catch (e) { toast('解析 manifest 失败：' + e.message, 'error'); return; }
      const path = '/api/plugins/install';
      const opts = { method: 'POST', body: JSON.stringify(manifest) };
      const result = await requestWithApproval(path, opts);
      await handleApprovalFlow(result, path, opts, {
        actionLabel: '安装 Plugin' + (manifest.id ? '：' + manifest.id : ''),
        onOk: async () => { toast('已安装 ' + (manifest.id || manifest.displayName || ''), 'success', 2000); loadPluginList(); },
        onError: (r) => toast('安装失败：' + (r.error || 'unknown'), 'error', 5000),
      });
    }

    $('#btnPlugins')?.addEventListener('click', showPluginArea);
    $('#btnPluginBack')?.addEventListener('click', hidePluginArea);
    $('#btnPluginInstall')?.addEventListener('click', () => $('#pluginInstallFile')?.click());
    $('#pluginInstallFile')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) installPluginFromFile(f);
      e.target.value = '';
    });
    $('#btnPluginReload')?.addEventListener('click', async () => {
      const path = '/api/plugins/reload';
      const opts = { method: 'POST' };
      const result = await requestWithApproval(path, opts);
      await handleApprovalFlow(result, path, opts, {
        actionLabel: '重扫 Plugin 目录',
        onOk: async () => { toast('已重扫', 'success', 1500); loadPluginList(); },
        onError: (r) => toast('刷新失败：' + (r.error || 'unknown'), 'error'),
      });
    });

    window.PanelPlugin = {
      get pluginState() { return pluginState; },
      showPluginArea,
      hidePluginArea,
      loadPluginList,
      renderPluginList,
      renderPluginDetail,
      runPluginCommand,
      installPluginFromFile,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
