// @ts-check
// prompts-notify-ui.js — Prompts 模板库（⌘P）+ F3 浏览器通知（长任务完成）+ turn_end 通知轮询（从 app.js 外迁；app.js 模块化第14批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 原 app.js 模块加载即执行的 notifInit() 与顶层 4s setInterval 均收进 boot()，只执行/只起一次（防双轮询）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, toast, confirmModal } = core;

    // ─── F3 浏览器通知（长任务完成）─────
    const notifState = { enabled: false, granted: false };
    function notifInit() {
      if (!('Notification' in window)) return;
      notifState.enabled = localStorage.getItem('cp-notif-enabled') !== '0';
      notifState.granted = Notification.permission === 'granted';
      if (notifState.enabled && !notifState.granted && Notification.permission === 'default') {
        // 首次后台 turn_end 时再请求权限，避免无故弹
      }
    }
    async function maybeNotify(title, body) {
      if (!notifState.enabled) return;
      if (!('Notification' in window)) return;
      if (!document.hidden) return; // tab 在前台不通知
      try {
        if (Notification.permission === 'default') {
          const r = await Notification.requestPermission();
          notifState.granted = r === 'granted';
        }
        if (Notification.permission !== 'granted') return;
        const n = new Notification(title, { body, icon: '/favicon.ico', silent: false });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => { try { n.close(); } catch {} }, 8000);
      } catch {}
    }
    notifInit();

    // ─── F6 Prompts 模板库（⌘P）─────
    async function openPrompts() {
      $('#promptsModal').style.display = 'flex';
      await loadPromptsList();
      setTimeout(() => $('#promptName')?.focus(), 0);
    }
    function closePrompts() { $('#promptsModal').style.display = 'none'; }
    async function loadPromptsList() {
      try {
        const r = await fetch('/api/prompts').then(x => x.json());
        const list = r.prompts || [];
        const el = $('#promptsList');
        if (!el) return;
        if (list.length === 0) {
          el.innerHTML = '<div class="cmdk-empty" style="padding:18px;">还没模板。下面填名+内容点「添加」存一条。</div>';
          return;
        }
        el.innerHTML = list.map(p => `<div class="prompts-item" data-id="${escapeHtml(p.id)}">
          <div class="prompts-item-name">
            <span>${escapeHtml(p.name)}</span>
            <button class="prompts-item-del" data-del="${escapeHtml(p.id)}" title="删除">🗑</button>
          </div>
          <div class="prompts-item-preview">${escapeHtml(String(p.content).slice(0, 120))}${p.content.length > 120 ? '…' : ''}</div>
        </div>`).join('');
        el.querySelectorAll('.prompts-item').forEach(item => {
          item.addEventListener('click', (ev) => {
            if (ev.target.classList.contains('prompts-item-del')) return;
            const id = item.dataset.id;
            const p = list.find(x => x.id === id);
            if (!p) return;
            const input = $('#chatInput');
            if (!input) { toast('先选一个 session', 'warn'); return; }
            input.value = input.value ? input.value + '\n\n' + p.content : p.content;
            input.focus();
            closePrompts();
            toast(`已插入「${p.name}」`, 'success', 2000);
          });
        });
        el.querySelectorAll('.prompts-item-del').forEach(btn => {
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.del;
            if (!await confirmModal({ title: '删除模板？', message: '不可撤销', confirmLabel: '删除', danger: true })) return;
            await fetch('/api/prompts/' + id, { method: 'DELETE' });
            loadPromptsList();
          });
        });
      } catch (e) {
        $('#promptsList').innerHTML = '<div class="cmdk-empty">加载失败：' + escapeHtml(e.message) + '</div>';
      }
    }
    $('#btnPromptAdd')?.addEventListener('click', async () => {
      const name = $('#promptName').value.trim();
      const content = $('#promptContent').value.trim();
      if (!name || !content) { toast('名称和内容都不能空', 'warn'); return; }
      try {
        const r = await fetch('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) }).then(x => x.json());
        if (r.ok) {
          $('#promptName').value = '';
          $('#promptContent').value = '';
          loadPromptsList();
          toast('模板已添加', 'success');
        } else {
          toast('添加失败：' + r.error, 'error');
        }
      } catch (e) {
        toast('异常：' + e.message, 'error');
      }
    });
    $('#promptsModal')?.addEventListener('click', (e) => { if (e.target.id === 'promptsModal') closePrompts(); });

    // ─── F3 长任务 turn_end 通知（在 ws message handler 已经处理 busy=false，这里 hook 全局）─────
    // 监听 ws state 的 busy false 事件——简单做法：在 setInterval 4s 里检查上次 busy 状态变化
    // 状态实时取：sessions 列表经 core.state 读，禁解构快照
    const notifTrack = { lastBusyById: new Map() };
    setInterval(() => {
      const aliveIds = new Set();
      for (const s of (core.state.sessions || [])) {
        aliveIds.add(s.id);
        const prev = notifTrack.lastBusyById.get(s.id);
        if (prev === true && !s.busy) {
          // 这个 session 刚从 busy 变 idle → 触发通知
          maybeNotify(`✅ ${s.name} 完成`, '点击切回 panel 查看');
        }
        notifTrack.lastBusyById.set(s.id, s.busy);
      }
      // v0.51 R-15 fix: 清理已删除的 session entry，避免 Map 单调增长
      for (const id of notifTrack.lastBusyById.keys()) {
        if (!aliveIds.has(id)) notifTrack.lastBusyById.delete(id);
      }
    }, 4000);

    window.PanelPromptsNotify = {
      get notifState() { return notifState; },
      get notifTrack() { return notifTrack; },
      notifInit, maybeNotify,
      openPrompts, closePrompts, loadPromptsList,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
