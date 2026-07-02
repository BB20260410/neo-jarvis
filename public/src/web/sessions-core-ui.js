// @ts-check
// sessions-core-ui.js — 会话 CRUD + 全局右键菜单 + 双击重命名（listSessions/setSessionArchived/renameSession/
// closeContextMenu/openContextMenu/startRenameSession/createSession/deleteSession）（从 app.js 外迁；app.js 模块化第17批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 原 app.js 启动块的 listSessions() 初拉 + 4s 轮询 + visibilitychange，以及 document 全局 click/keydown（Esc 关菜单/中断）
// 均收进 boot()，只执行/只绑一次（防双轮询/双绑）。
// 跨文件依赖全走 window 懒解析：renderList/renderArchived/showEmpty（PanelSessionsList）、selectSession（PanelSessionsStream）；
// 批19/20 留守 app.js 的 updateBusyUI/updateStatusBar/interruptCurrentTurn 经 core 桥调用时实时取（迁走后桥改 window 懒转发）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, hasOwnerToken, renderOwnerTokenMissingBanner } = core;

    async function listSessions() {
      if (!hasOwnerToken()) {
        renderOwnerTokenMissingBanner();
        return;
      }
      // v0.51 T-31 fix: 抛错时 silent log，避免 4s 重试每次触发 unhandledrejection toast
      let active, archived;
      try {
        [active, archived] = await Promise.all([
          api('/api/sessions'),
          api('/api/sessions?archived=1'),
        ]);
      } catch (e) {
        console.warn('[listSessions]', e?.message || e);
        return;
      }
      core.state.sessions = active;
      core.state.archivedSessions = archived;
      // v0.20 同步当前 activeBusy 跟 server 状态（防 WS 丢消息导致卡 busy）
      if (core.state.activeId) {
        const cur = active.find(s => s.id === core.state.activeId);
        if (cur && typeof cur.busy === 'boolean' && cur.busy !== core.state.activeBusy) {
          core.state.activeBusy = cur.busy;
          core.updateBusyUI?.();
        }
      }
      window.PanelSessionsList?.renderList?.();
      window.PanelSessionsList?.renderArchived?.();
      core.updateStatusBar?.();
    }

    async function setSessionArchived(id, archived) {
      await api(`/api/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived }),
      });
      // 归档时如果是当前激活的 → 切回 empty
      if (archived && core.state.activeId === id) {
        // v0.51 ZZZZZ-01 fix: 同 T-38（deleteSession）清所有 active state 一致性
        core.state.activeId = null;
        core.state.activeCwd = null;
        core.state.activeBusy = false;
        core.state.activeStarred = [];
        if (core.state.ws) { try { core.state.ws.close(); } catch {} core.state.ws = null; }
        core.state.streamingDivs?.clear?.();
        window.PanelSessionsList?.showEmpty?.();
      }
      await listSessions();
    }

    async function renameSession(id, name) {
      if (!name || !name.trim()) return;
      await api(`/api/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      await listSessions();
      if (core.state.activeId === id) $('#chatHeaderName').textContent = name.trim();
    }

    // ─── v0.6 全局右键菜单（portal）─────
    let activeContextMenu = null;
    function closeContextMenu() {
      if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
      }
    }
    function openContextMenu(items, x, y) {
      closeContextMenu();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - items.length * 32) + 'px';
      for (const it of items) {
        if (it.divider) {
          const d = document.createElement('div');
          d.className = 'context-menu-divider';
          menu.appendChild(d);
          continue;
        }
        const btn = document.createElement('button');
        btn.className = 'context-menu-item' + (it.danger ? ' danger' : '');
        btn.textContent = it.label;
        btn.addEventListener('click', e => {
          e.stopPropagation();
          closeContextMenu();
          it.onSelect?.();
        });
        menu.appendChild(btn);
      }
      document.body.appendChild(menu);
      activeContextMenu = menu;
    }
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && activeContextMenu) {
        closeContextMenu();
        return;
      }
      // v0.16 Esc 中断当前 turn（在没 modal 打开时才触发）
      if (e.key === 'Escape' && core.state.activeBusy && !document.querySelector('.confirm-modal, #cmdkModal[style*="flex"], #projectModal[style*="flex"], #historyModal[style*="flex"]')) {
        const inInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
        if (!inInput) {
          e.preventDefault();
          core.interruptCurrentTurn?.();
        }
      }
    });

    // ─── v0.6 双击重命名 ─────
    function startRenameSession(sessionId, nameElement) {
      const oldName = nameElement.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-rename-input';
      input.value = oldName;
      nameElement.replaceWith(input);
      input.focus();
      input.select();
      let committed = false;
      const commit = (save) => {
        if (committed) return;
        committed = true;
        const newName = input.value.trim();
        const span = document.createElement('div');
        span.className = 'session-name';
        span.textContent = save && newName ? newName : oldName;
        input.replaceWith(span);
        if (save && newName && newName !== oldName) {
          renameSession(sessionId, newName);
        }
      };
      input.addEventListener('blur', () => commit(true));
      input.addEventListener('keydown', e => {
        e.stopPropagation();
        // v0.50 Q-01 IME fix: 中文选字 Enter 不应 commit
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
    }

    async function createSession(name, cwd, mainGoal) {
      const s = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, cwd, mainGoal }),
      });
      await listSessions();
      window.PanelSessionsStream?.selectSession?.(s.id);
    }

    async function deleteSession(id) {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      if (core.state.activeId === id) {
        // v0.51 T-38 fix: 清所有 active state，避免后续 toggleStar / append 用脏数据
        core.state.activeId = null;
        core.state.activeCwd = null;
        core.state.activeBusy = false;
        core.state.activeStarred = [];
        if (core.state.ws) { try { core.state.ws.close(); } catch {} core.state.ws = null; }
        core.state.streamingDivs?.clear?.();
        window.PanelSessionsList?.showEmpty?.();
      }
      await listSessions();
    }

    // ─── 启动初拉 + 轮询（原 app.js 启动块，随域迁入 boot 只起一次）─────
    listSessions();
    // S21 P2：visibility-aware polling — 页面隐藏时不 fetch（省电 + 省网络）
    // 用户切回 panel 时 visibilitychange 触发立即拉一次同步
    setInterval(() => { if (!document.hidden && hasOwnerToken()) listSessions(); }, 4000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) listSessions();
    });

    window.PanelSessionsCore = {
      listSessions,
      setSessionArchived,
      renameSession,
      closeContextMenu,
      openContextMenu,
      startRenameSession,
      createSession,
      deleteSession,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
