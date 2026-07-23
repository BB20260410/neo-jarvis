// @ts-check
// watcher-ui.js — v0.35 Watcher 监视者 UI（showWatcherVerdict/updateWatcherToggleUI/loadWatcherProviders/watcherState
// + #btnWatcherDismiss/#btnWatcherReject/#btnWatcherAccept/#btnWatcherToggle/#watcherProviderSelect 绑定）
// （从 app.js 外迁；app.js 模块化第18批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 原 app.js 模块加载即执行的 loadWatcherProviders() 收进 boot()，保持页面加载即拉 providers，只执行一次。
// 跨文件依赖全走 window 懒解析：listSessions（PanelSessionsCore）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, toast, hasOwnerToken, renderOwnerTokenMissingBanner } = core;

    let _lastVerdictPrompt = null;

    function showWatcherVerdict(msg) {
      const banner = $('#watcherVerdictBanner');
      const verdict = msg.verdict || {};
      const statusMap = {
        completed: { icon: '✅', label: '已完成', color: 'verdict-completed' },
        partial: { icon: '🟡', label: '部分完成', color: 'verdict-partial' },
        stuck: { icon: '⚠️', label: '卡住了', color: 'verdict-stuck' },
        need_user: { icon: '🙋', label: '需要你介入', color: 'verdict-need-user' },
        failed: { icon: '❌', label: '失败', color: 'verdict-failed' },
        drifted: { icon: '🌀', label: '偏离主目标', color: 'verdict-drifted' },
      };
      const meta = statusMap[verdict.status] || statusMap.partial;
      $('#watcherVerdictIcon').textContent = meta.icon;
      $('#watcherVerdictStatus').textContent = meta.label;
      $('#watcherVerdictConf').textContent = `置信 ${(verdict.confidence * 100).toFixed(0)}%`;
      $('#watcherVerdictProvider').textContent = msg.provider || '';
      $('#watcherVerdictReasoning').textContent = verdict.reasoning || '';
      banner.className = 'watcher-verdict-banner ' + meta.color;
      if (verdict.drift_detected) banner.classList.add('verdict-drift');

      const promptWrap = $('#watcherVerdictPromptWrap');
      const next = verdict.next_action || {};
      if (next.prompt && (next.type === 'continue' || next.type === 'retry_with_hint')) {
        $('#watcherVerdictPrompt').textContent = next.prompt;
        if (next.danger_level === 'needs_review') {
          $('#watcherVerdictPrompt').classList.add('verdict-prompt-danger');
        } else {
          $('#watcherVerdictPrompt').classList.remove('verdict-prompt-danger');
        }
        _lastVerdictPrompt = next.prompt;
        promptWrap.style.display = '';
      } else {
        promptWrap.style.display = 'none';
        _lastVerdictPrompt = null;
      }
      banner.style.display = '';
    }

    $('#btnWatcherDismiss')?.addEventListener('click', () => {
      $('#watcherVerdictBanner').style.display = 'none';
      _lastVerdictPrompt = null;
    });
    $('#btnWatcherReject')?.addEventListener('click', () => {
      $('#watcherVerdictBanner').style.display = 'none';
      _lastVerdictPrompt = null;
      toast('已拒绝监视者建议', 'info', 1500);
    });
    $('#btnWatcherAccept')?.addEventListener('click', async () => {
      if (!_lastVerdictPrompt || !core.state.activeId) return;
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text: _lastVerdictPrompt }),
        });
        if (r && r.ok === false) {
          toast('发送失败：' + (r.message || r.error), 'error');
        } else {
          $('#watcherVerdictBanner').style.display = 'none';
          _lastVerdictPrompt = null;
          toast('已接受并发送', 'success', 2000);
        }
      } catch (e) {
        toast('发送失败：' + e.message, 'error');
      }
    });

    // 👁️ 监视者 toggle 按钮
    $('#btnWatcherToggle')?.addEventListener('click', async () => {
      if (!core.state.activeId) return;
      const cur = core.state.sessions.find(s => s.id === core.state.activeId);
      const next = !(cur?.watcherEnabled);
      try {
        await api(`/api/sessions/${core.state.activeId}`, {
          method: 'PATCH',
          body: JSON.stringify({ watcherEnabled: next }),
        });
        toast(next ? '👁️ 监视者已启用（claude turn 完成时分析）' : '监视者已关闭', next ? 'success' : 'info', 2500);
        await window.PanelSessionsCore?.listSessions?.();
        updateWatcherToggleUI();
      } catch (e) {
        toast('切换失败: ' + e.message, 'error');
      }
    });

    function updateWatcherToggleUI() {
      const btn = $('#btnWatcherToggle');
      if (!btn) return;
      const cur = core.state.sessions.find(s => s.id === core.state.activeId);
      const on = !!cur?.watcherEnabled;
      btn.textContent = on ? '👁️ 监视中' : '👁️ 监视';
      btn.classList.toggle('cxbtn-primary', on);
      btn.classList.toggle('cxbtn-secondary', !on);
      // v0.40 provider 下拉：仅启用时显示
      const sel = $('#watcherProviderSelect');
      if (sel) {
        sel.style.display = on ? 'inline-block' : 'none';
        if (on) {
          const pid = cur?.watcherProviderId || watcherState.defaultProviderId || 'ollama';
          sel.value = pid;
        }
      }
    }

    // v0.40 拉 providers 列表 + 渲染下拉
    const watcherState = { providers: [], defaultProviderId: null, loaded: false };
    async function loadWatcherProviders() {
      if (watcherState.loaded) return;
      if (!hasOwnerToken()) {
        renderOwnerTokenMissingBanner();
        return;
      }
      try {
        const r = await fetch('/api/watcher/providers').then(x => x.json());
        watcherState.providers = r.providers || [];
        watcherState.defaultProviderId = r.defaultId || 'ollama';
        watcherState.loaded = true;
        const sel = $('#watcherProviderSelect');
        if (sel) {
          sel.innerHTML = '';
          for (const p of watcherState.providers) {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.displayName;
            sel.appendChild(o);
          }
        }
      } catch (e) {
        // S26 B2：Watcher providers 加载失败用户应感知（watcher tab 用不了）
        console.warn('loadWatcherProviders failed:', e.message);
        try { toast('Watcher providers 加载失败：' + e.message, 'error', 8000); } catch {}
      }
    }
    $('#watcherProviderSelect')?.addEventListener('change', async (e) => {
      if (!core.state.activeId) return;
      const pid = e.target.value;
      try {
        await api(`/api/sessions/${core.state.activeId}`, {
          method: 'PATCH',
          body: JSON.stringify({ watcherProviderId: pid }),
        });
        toast(`监视者已切换到 ${watcherState.providers.find(p => p.id === pid)?.displayName || pid}`, 'success', 2000);
        await window.PanelSessionsCore?.listSessions?.();
      } catch (e) { toast('切换失败：' + e.message, 'error'); }
    });
    // 原 app.js 模块加载即执行（保持页面加载即拉 providers，boot 只执行一次）
    loadWatcherProviders();

    window.PanelWatcher = {
      showWatcherVerdict,
      updateWatcherToggleUI,
      loadWatcherProviders,
      get watcherState() { return watcherState; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
