// @ts-check
// cmdk-ui.js — v0.6 ⌘K 命令面板（cmdkState/buildCmdkItems/openCmdk/closeCmdk/renderCmdk
// + #cmdkInput/#cmdkModal 绑定 + 全局 ⌘K/⌘D document keydown）
// （从 app.js 外迁；app.js 模块化第20批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// ⚠️ window.PanelCmdk 已被 main.js 占用（cmdk-commands.js 的 BUILTIN_COMMANDS/matchCommands/resolveAction 桥）——
// 本模块 boot 时 Object.assign 合并挂载运行时键（boot=setTimeout(0)，必在 main.js 模块体赋值之后跑；
// main.js 侧已同步改为合并赋值，双向保险，谁后跑都不覆盖对方）。
// 跨文件依赖全走 window 懒解析：openModal（PanelSessionsTools）/ toggleTheme（PanelTheme）/
// selectSession（PanelSessionsStream）/ setSessionArchived（PanelSessionsCore）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, shortenPath, confirmModal } = core;

    const cmdkState = { activeIdx: 0, items: [] };

    function buildCmdkItems(query) {
      const q = query.trim().toLowerCase();
      const items = [];

      // v0.80 真迁：COMMANDS 静态声明从 cmdk-commands.js module 拿（main.js 桥接）
      // 失败 fallback 用 inline 定义（main.js 桥未挂 BUILTIN_COMMANDS 时兼容）
      let COMMANDS;
      if (window.PanelCmdk?.BUILTIN_COMMANDS) {
        const dispatcher = {
          openModal: () => { closeCmdk(); window.PanelSessionsTools?.openModal?.(); },
          toggleTheme: () => { window.PanelTheme?.toggleTheme?.(); closeCmdk(); },
          btnHandoff: () => { closeCmdk(); $('#btnHandoff')?.click(); },
          btnExternal: () => { closeCmdk(); $('#btnExternal')?.click(); },
        };
        COMMANDS = window.PanelCmdk.BUILTIN_COMMANDS.map(c => ({
          type: 'cmd',
          icon: c.icon, title: c.title, subtitle: c.subtitle,
          action: dispatcher[c.actionRef] || (() => closeCmdk()),
        }));
      } else {
        // fallback inline
        COMMANDS = [
          { type: 'cmd', icon: '＋', title: '新建会话', subtitle: '⌘N', action: () => { closeCmdk(); window.PanelSessionsTools?.openModal?.(); } },
          { type: 'cmd', icon: '🌓', title: '切换主题（暗/亮）', subtitle: '⌘D', action: () => { window.PanelTheme?.toggleTheme?.(); closeCmdk(); } },
          { type: 'cmd', icon: '🔄', title: '为当前会话接力', subtitle: '需先选中一个会话', action: () => { closeCmdk(); $('#btnHandoff')?.click(); } },
          { type: 'cmd', icon: '⤴', title: '在 Terminal 打开当前会话', subtitle: '', action: () => { closeCmdk(); $('#btnExternal')?.click(); } },
        ];
      }
      for (const c of COMMANDS) {
        if (!q || c.title.toLowerCase().includes(q)) items.push(c);
      }

      // session 跳转组
      for (const s of core.state.sessions) {
        const blob = (s.name + ' ' + s.cwd + ' ' + (s.mainGoal || '')).toLowerCase();
        if (q && !blob.includes(q)) continue;
        items.push({
          type: 'session',
          icon: '✦',
          title: s.name,
          subtitle: shortenPath(s.cwd) + (s.mainGoal ? ` · 🎯 ${s.mainGoal}` : ''),
          action: () => { window.PanelSessionsStream?.selectSession?.(s.id); closeCmdk(); },
        });
      }
      // 归档跳转组
      for (const s of core.state.archivedSessions || []) {
        const blob = (s.name + ' ' + s.cwd).toLowerCase();
        if (q && !blob.includes(q)) continue;
        items.push({
          type: 'archived',
          icon: '📦',
          title: s.name + '（归档）',
          subtitle: shortenPath(s.cwd) + ' · 双击恢复',
          action: () => {
            confirmModal({
              title: '从归档恢复？',
              message: `「${s.name}」恢复到活跃会话列表。`,
              confirmLabel: '↩ 恢复',
            }).then(ok => { if (ok) window.PanelSessionsCore?.setSessionArchived?.(s.id, false)?.then(closeCmdk); });
          },
        });
      }
      return items;
    }

    function openCmdk() {
      $('#cmdkModal').style.display = 'flex';
      $('#cmdkInput').value = '';
      cmdkState.activeIdx = 0;
      renderCmdk('');
      setTimeout(() => $('#cmdkInput').focus(), 0);
    }
    function closeCmdk() {
      $('#cmdkModal').style.display = 'none';
    }
    function renderCmdk(query) {
      cmdkState.items = buildCmdkItems(query);
      if (cmdkState.activeIdx >= cmdkState.items.length) cmdkState.activeIdx = 0;
      const list = $('#cmdkList');
      list.innerHTML = '';
      if (cmdkState.items.length === 0) {
        list.innerHTML = '<div class="cmdk-empty">没匹配到</div>';
        return;
      }
      cmdkState.items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'cmdk-item' + (i === cmdkState.activeIdx ? ' active' : '');
        const icon = document.createElement('span');
        icon.className = 'cmdk-icon';
        icon.textContent = it.icon || '';
        const title = document.createElement('span');
        title.className = 'cmdk-title';
        title.textContent = it.title || '';
        const subtitle = document.createElement('span');
        subtitle.className = 'cmdk-subtitle';
        subtitle.textContent = it.subtitle || '';
        row.append(icon, title, subtitle);
        row.addEventListener('click', () => it.action?.());
        row.addEventListener('mouseenter', () => {
          cmdkState.activeIdx = i;
          [...list.children].forEach((c, j) => c.classList.toggle('active', j === i));
        });
        list.appendChild(row);
      });
    }
    $('#cmdkInput')?.addEventListener('input', e => renderCmdk(e.target.value));
    $('#cmdkInput')?.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cmdkState.activeIdx = Math.min(cmdkState.activeIdx + 1, cmdkState.items.length - 1);
        renderCmdk($('#cmdkInput').value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cmdkState.activeIdx = Math.max(0, cmdkState.activeIdx - 1);
        renderCmdk($('#cmdkInput').value);
      } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        const it = cmdkState.items[cmdkState.activeIdx];
        if (it) it.action?.();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCmdk();
      }
    });
    $('#cmdkModal')?.addEventListener('click', e => {
      if (e.target.id === 'cmdkModal') closeCmdk();
    });

    // 全局快捷键：⌘K 打开命令面板 / ⌘D 切主题（原 app.js document keydown 随迁，boot 只绑一次；
    // 与既有 Esc/⌘N/⌘⇧F/⌘P 等键位无冲突，注册序不影响行为）
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCmdk();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        window.PanelTheme?.toggleTheme?.();
      }
    });

    window.PanelCmdk = Object.assign(window.PanelCmdk || {}, {
      openCmdk,
      closeCmdk,
      renderCmdk,
      buildCmdkItems,
      cmdkState,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
