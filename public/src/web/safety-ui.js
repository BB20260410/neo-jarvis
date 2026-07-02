// @ts-check
// safety-ui.js — v0.27 安全历史 tab（refreshSafety/renderWatcherSection/renderHookEventsSection/
// attachWatcherSectionHandlers/maybeRefreshSafetyIfOpen + #btnSafetyRefresh 绑定）
// （从 app.js 外迁；app.js 模块化第19批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（纯工具+审批基建可解构：requestWithApproval/handleApprovalFlow/apiCall
// 留守 app.js 至批21，函数声明已 hoist 桥直引稳定；state 实时取 core.state 禁解构快照）。
// maybeRefreshSafetyIfOpen 被 sessions-stream 经桥 core.maybeRefreshSafetyIfOpen?.() 调 4 处（danger×2/approval/loop_guard）；
// refreshSafety 被 inspector tab 分发 hub（app.js 留守）window 懒调。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, apiCall, toast, escapeHtml, renderMarkdown, requestWithApproval, handleApprovalFlow } = core;

    async function refreshSafety() {
      const body = $('#safetyBody');
      const meta = $('#safetyMeta');
      if (!core.state.activeId) {
        body.innerHTML = '<div class="muted small" style="padding:8px;">— 未选中 session —</div>';
        meta.textContent = '—';
        return;
      }
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/safety-history`);
        const dangers = r.danger || [];
        const breaks = r.loopGuard || [];
        meta.textContent = `🛑 ${dangers.length} 危险 · 🔁 ${breaks.length} 熔断`;
        if (dangers.length === 0 && breaks.length === 0) {
          body.innerHTML = '<div class="muted small" style="padding:12px;">本 session 暂无安全事件记录 ✅</div>';
          return;
        }
        let html = '';
        if (dangers.length > 0) {
          html += '<h3 class="safety-sec-h">🛑 DangerDetector 拦截/警告</h3>';
          html += '<div class="safety-list">';
          for (const d of dangers.slice().reverse()) {
            const t = new Date(d.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const sev = d.severity || 'unknown';
            const tag = d.blocked ? '已拦截' : '仅警告';
            html += `<div class="safety-item safety-${sev}">
              <div class="safety-row1">
                <span class="safety-sev sev-${sev}">${escapeHtml(sev)}</span>
                <span class="safety-tag">${tag}</span>
                <span class="safety-time">${t}</span>
              </div>
              <div class="safety-cmd"><code>${escapeHtml((d.command || '').slice(0, 200))}</code></div>
              <div class="safety-hits">
                ${(d.hits || []).slice(0, 3).map(h => `<div>• <b>[${escapeHtml(h.severity)}] ${escapeHtml(h.category)}</b> — ${escapeHtml(h.advice || '')}</div>`).join('')}
              </div>
            </div>`;
          }
          html += '</div>';
        }
        // v0.29 状态时序（最近 20 次转移）
        const stateHist = (r.stateHistory || []).slice(-20);
        if (stateHist.length > 0) {
          html += `<h3 class="safety-sec-h">📈 状态时序（最近 ${stateHist.length} 次，当前: ${escapeHtml(r.currentState || 'idle')}）</h3>`;
          html += '<div class="state-timeline">';
          for (let i = stateHist.length - 1; i >= 0; i--) {
            const t = stateHist[i];
            const time = new Date(t.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            html += `<div class="state-tx">
              <span class="state-time">${time}</span>
              <span class="state-from state-pill state-${escapeHtml(t.from)}">${escapeHtml(t.from)}</span>
              <span class="state-arrow">→</span>
              <span class="state-to state-pill state-${escapeHtml(t.to)}">${escapeHtml(t.to)}</span>
              <span class="state-reason">${escapeHtml(t.reason || '')}</span>
            </div>`;
          }
          html += '</div>';
        }

        if (breaks.length > 0) {
          html += '<h3 class="safety-sec-h">🔁 LoopGuard 熔断</h3>';
          html += '<div class="safety-list">';
          for (const b of breaks.slice().reverse()) {
            const t = new Date(b.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            let label = b.type;
            if (b.type === 'steps_exceeded') label = `单任务步数 ${b.current}/${b.max}`;
            else if (b.type === 'repeated_instruction') label = `重复指令 ×${b.count}: "${(b.text || '').slice(0, 60)}"`;
            else if (b.type === 'cost_surge') label = `5min 成本激增 $${b.usdInWindow} > $${b.threshold}`;
            else if (b.type === 'file_churn') label = `${b.file} 颤动 ${b.churnCount} 次`;
            html += `<div class="safety-item safety-loop">
              <div class="safety-row1">
                <span class="safety-sev sev-high">${escapeHtml(b.type)}</span>
                <span class="safety-time">${t}</span>
              </div>
              <div class="safety-cmd">${escapeHtml(label)}</div>
            </div>`;
          }
          html += '</div>';
        }
        // v0.37 watcher 历史 + 配置段
        html += await renderWatcherSection();
        // v0.47 hook 事件流段
        html += await renderHookEventsSection();

        body.innerHTML = html;
        attachWatcherSectionHandlers();
      } catch (e) {
        body.innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
      }
    }
    $('#btnSafetyRefresh')?.addEventListener('click', refreshSafety);

    // v0.37 watcher 配置 + 历史
    async function renderWatcherSection() {
      let cfg = null;
      let history = [];
      try {
        const r = await api('/api/watcher/config');
        cfg = r.config;
        if (core.state.activeId) {
          const sess = await api(`/api/sessions/${core.state.activeId}`);
          history = sess.watcherHistory || [];
        }
      } catch (e) {
        return `<h3 class="safety-sec-h">👁️ 监视者</h3><div class="muted small">加载失败: ${escapeHtml(e.message)}</div>`;
      }
      let html = '<h3 class="safety-sec-h">👁️ 监视者（其他 LLM 监督 Claude）</h3>';

      // 配置段
      html += `<div class="watcher-config-box">
        <div class="watcher-cfg-row">
          <label>启用</label>
          <input type="checkbox" id="cfgWatcherEnabled" ${cfg.enabled ? 'checked' : ''} />
          <label style="margin-left:12px;">自动模式</label>
          <input type="checkbox" id="cfgWatcherAuto" ${cfg.autoMode ? 'checked' : ''} title="开启后 verdict 通过安全检查就自动发回 claude（默认半自动需点接受）" />
        </div>
        <div class="watcher-cfg-row">
          <label>Provider</label>
          <select id="cfgWatcherProvider">
            <option value="ollama" ${cfg.provider==='ollama'?'selected':''}>Ollama（本地，零成本）</option>
            <option value="minimax" ${cfg.provider==='minimax'?'selected':''}>MiniMax（需 chat plan）</option>
          </select>
        </div>
        <div class="watcher-cfg-row">
          <label>Model</label>
          <input type="text" id="cfgWatcherModel" value="${escapeHtml(cfg.model || '')}" placeholder="gemma3:4b / qwen2.5:7b / abab6.5s-chat" />
        </div>
        <div class="watcher-cfg-row">
          <label>API Key</label>
          <input type="password" id="cfgWatcherKey" value="${escapeHtml(cfg.apiKey || '')}" placeholder="Ollama 留 'ollama' 即可" />
        </div>
        <div class="watcher-cfg-row">
          <label>Base URL</label>
          <input type="text" id="cfgWatcherBaseUrl" value="${escapeHtml(cfg.baseUrl || '')}" placeholder="留空走 provider 默认" />
        </div>
        <div class="watcher-cfg-actions">
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnWatcherTest">测试连通</button>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="btnWatcherSave">保存</button>
        </div>
      </div>`;

      // 历史段
      if (history.length === 0) {
        html += '<div class="muted small" style="padding:8px;">本 session 暂无监视者历史</div>';
      } else {
        html += `<div class="watcher-history-list">`;
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i];
          const v = h.verdict || {};
          const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          html += `<div class="watcher-hist-item watcher-status-${v.status}">
            <div class="watcher-hist-row1">
              <span class="watcher-hist-status">${escapeHtml(v.status)}</span>
              <span class="watcher-hist-conf">${(v.confidence*100).toFixed(0)}%</span>
              <span class="watcher-hist-provider">${escapeHtml(h.provider)}</span>
              <span class="watcher-hist-time">${time}</span>
            </div>
            <div class="watcher-hist-reason">${escapeHtml((v.reasoning || '').slice(0, 200))}</div>
            ${v.next_action?.prompt ? `<div class="watcher-hist-prompt">→ ${escapeHtml(v.next_action.prompt.slice(0, 120))}</div>` : ''}
          </div>`;
        }
        html += '</div>';
      }
      return html;
    }

    // v0.47 hook 事件流（来自 Claude Code 外部 hook POST 进 panel 的 12 种事件）
    async function renderHookEventsSection() {
      let events = [];
      try {
        if (core.state.activeId) {
          const r = await fetch(`/api/hooks?sessionId=${core.state.activeId}&limit=50`).then(x => x.json());
          events = r.events || [];
        }
      } catch {}
      let html = `<div class="safety-section-head" style="margin-top:14px;">🪝 Hook 事件流（最近 50 条）</div>`;
      if (events.length === 0) {
        html += `<div class="muted small" style="padding:8px;">本 session 暂无 hook 事件。<br>
          <button class="link-btn" id="lnkHooksDoc">如何配置 ~/.claude/settings.json 接入 →</button></div>`;
      } else {
        html += `<div class="hook-events-list">`;
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          html += `<div class="hook-event-item hook-event-${e.event}">
            <span class="hook-event-name">${escapeHtml(e.event)}</span>
            ${e.tool ? `<span class="hook-event-tool">${escapeHtml(e.tool)}</span>` : ''}
            <span class="hook-event-time">${t}</span>
          </div>`;
        }
        html += '</div>';
      }
      return html;
    }

    function attachWatcherSectionHandlers() {
      // v0.47 hook 文档 modal
      $('#lnkHooksDoc')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const md = await fetch('/api/docs/HOOKS_USAGE.md').then(r => r.text());
          // 直接弹一个 modal 显示 markdown 渲染
          let modal = document.getElementById('docModal');
          if (!modal) {
            modal = document.createElement('div');
            modal.id = 'docModal';
            modal.className = 'doc-modal';
            document.body.appendChild(modal);
          }
          modal.innerHTML = `<div class="doc-modal-content">
            <button class="doc-modal-close" aria-label="关闭">✕</button>
            <div class="doc-modal-body">${renderMarkdown(md)}</div>
          </div>`;
          modal.style.display = 'flex';
          modal.querySelector('.doc-modal-close').addEventListener('click', () => modal.style.display = 'none');
          modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.style.display = 'none'; });
        } catch (err) {
          toast('打不开文档：' + err.message, 'error');
        }
      });
      $('#btnWatcherSave')?.addEventListener('click', async () => {
        const body = {
          enabled: $('#cfgWatcherEnabled').checked,
          autoMode: $('#cfgWatcherAuto').checked,
          provider: $('#cfgWatcherProvider').value,
          model: $('#cfgWatcherModel').value.trim(),
          baseUrl: $('#cfgWatcherBaseUrl').value.trim(),
        };
        const keyVal = $('#cfgWatcherKey').value;
        // 含 "..." 的脱敏值不覆盖原 key
        if (keyVal && !keyVal.includes('...')) body.apiKey = keyVal;
        // watcher config 是双重审批入口（provider.model_config.write + auto_accept.scope），走链式批准
        const path = '/api/watcher/config';
        const opts = { method: 'PUT', body: JSON.stringify(body) };
        const result = await requestWithApproval(path, opts);
        await handleApprovalFlow(result, path, opts, {
          actionLabel: '写入监视者 Provider 配置',
          onOk: (r) => toast('监视者配置已保存' + (r.body?.adapterActive ? '（adapter active）' : ''), 'success', 3000),
          onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
        });
      });
      $('#btnWatcherTest')?.addEventListener('click', async () => {
        try {
          const r = await apiCall('/api/watcher/test', { method: 'POST' }, { loadingMsg: '测试中…', errorPrefix: '测试失败' });
          if (r.ok) {
            const v = r.verdict;
            toast(`✅ 测试通过：${v.status} (${(v.confidence*100).toFixed(0)}%) — ${v.reasoning.slice(0,80)}`, 'success', 5000);
          } else {
            toast('测试失败: ' + (r.error || '').slice(0, 200), 'error', 5000);
          }
        } catch { /* apiCall 已 toast 网络/HTTP 错误 */ }
      });
    }

    // 实时增量：WS 收到危险/熔断时如果当前 safety tab 打开就刷新
    function maybeRefreshSafetyIfOpen() {
      const safetyTab = document.querySelector('.ins-tab[data-tab="safety"]');
      if (safetyTab?.classList.contains('active')) refreshSafety();
    }

    window.PanelSafety = {
      refreshSafety,
      maybeRefreshSafetyIfOpen,
      renderWatcherSection,
      renderHookEventsSection,
      attachWatcherSectionHandlers,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
