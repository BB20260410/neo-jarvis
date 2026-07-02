// @ts-check
// sessions-list-ui.js — 会话列表渲染 + 归档区 + 聊天区切换 + appendMessage
// （renderList/buildSessionItem/renderArchived/showEmpty/showChat/appendMessage + #archivedToggle 绑定）
// （从 app.js 外迁；app.js 模块化第17批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 原 app.js 启动块的 showEmpty() 初始调用随属主迁入 boot()，只执行一次。
// 跨文件依赖全走 window 懒解析：CRUD/右键菜单/重命名（PanelSessionsCore）、selectSession/STATE_LABELS（PanelSessionsStream）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, toast, escapeHtml, escapeHtmlEarly, shortenPath, renderMarkdown, confirmModal, promptModal, persistCollapsedGroups } = core;
    const safeClassToken = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';

    function renderList() {
      const list = $('#sessionList');
      list.innerHTML = '';
      if (core.state.sessions.length === 0) {
        list.innerHTML = '<div class="muted small" style="padding:12px;text-align:center;">还没有活跃会话</div>';
        return;
      }
      // v0.19 Codex 风格分组：按 cwd 分组
      const groups = new Map(); // cwd → [sessions]
      for (const s of core.state.sessions) {
        if (!groups.has(s.cwd)) groups.set(s.cwd, []);
        groups.get(s.cwd).push(s);
      }
      // 单 cwd 组（≤1 个 session）不显 header，直接平铺
      const showGroups = groups.size > 1 || [...groups.values()].some(arr => arr.length > 1);
      if (!showGroups) {
        core.state.sessions.forEach(s => list.appendChild(buildSessionItem(s)));
        return;
      }
      // 按"组内最新 createdAt"倒序
      const sortedGroups = [...groups.entries()].sort((a, b) => {
        const aT = Math.max(...a[1].map(s => new Date(s.createdAt).getTime() || 0));
        const bT = Math.max(...b[1].map(s => new Date(s.createdAt).getTime() || 0));
        return bT - aT;
      });
      for (const [cwd, sessions] of sortedGroups) {
        const groupName = (cwd.split('/').filter(Boolean).pop()) || cwd;
        const collapsed = core.state.collapsedGroups.has(cwd);
        const groupBusy = sessions.some(s => s.busy);
        const totalUSD = sessions.reduce((s, x) => s + (x.totalUSD || 0), 0);
        const head = document.createElement('button');
        head.className = 'session-group-head' + (collapsed ? ' collapsed' : '');
        head.setAttribute('type', 'button');
        head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        head.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${groupName} 组 (${sessions.length} 个会话)`);
        head.innerHTML = `
          <span class="group-arrow" aria-hidden="true">${collapsed ? '▶' : '▼'}</span>
          <span class="group-name" title="${escapeHtml(cwd)}">${escapeHtml(groupName)}</span>
          <span class="group-count">${sessions.length}${groupBusy ? ' · ⚡' : ''}${totalUSD > 0 ? ` · $${totalUSD.toFixed(2)}` : ''}</span>
        `;
        head.addEventListener('click', () => {
          if (core.state.collapsedGroups.has(cwd)) core.state.collapsedGroups.delete(cwd);
          else core.state.collapsedGroups.add(cwd);
          persistCollapsedGroups();
          renderList();
        });
        list.appendChild(head);
        if (!collapsed) {
          sessions.forEach(s => list.appendChild(buildSessionItem(s)));
        }
      }
    }

    function buildSessionItem(s) {
        const div = document.createElement('div');
        div.className = 'session-item' + (s.id === core.state.activeId ? ' active' : '') + (s.busy ? ' busy' : '');
        const rs = s.runState || 'idle';
        const runStateClass = safeClassToken(rs);
        const runStateLabel = window.PanelSessionsStream?.STATE_LABELS?.[rs] || rs;
        const goalChip = s.mainGoal ? `<div class="session-goal" title="${escapeHtml(s.mainGoal)}">🎯 ${escapeHtml(s.mainGoal.slice(0, 22))}${s.mainGoal.length > 22 ? '…' : ''}</div>` : '';
        div.innerHTML = `
          <div class="session-name">${escapeHtml(s.name)}</div>
          <div class="session-cwd">${escapeHtml(shortenPath(s.cwd))}</div>
          <div class="session-meta">${s.msgCount} 消息${s.busy ? ' · ⚡' : ''}${s.totalUSD > 0 ? ` · $${s.totalUSD.toFixed(2)}` : ''}</div>
          ${goalChip}
          <div class="session-status state-${runStateClass}" title="${escapeHtml(runStateLabel)}"></div>
          <div class="session-hover-actions">
            <button class="session-action-btn session-rename-btn" title="重命名（也可双击名称）" aria-label="重命名会话 ${escapeHtml(s.name)}">✏️</button>
            <button class="session-action-btn session-archive-btn" title="归档（不删除，移到底部折叠区）" aria-label="归档会话 ${escapeHtml(s.name)}">📦</button>
          </div>
        `;
        div.addEventListener('click', () => window.PanelSessionsStream?.selectSession?.(s.id));
        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          window.PanelSessionsCore?.openContextMenu?.([
            { label: '✏️ 重命名', onSelect: () => {
              const nameEl = div.querySelector('.session-name');
              if (nameEl) window.PanelSessionsCore?.startRenameSession?.(s.id, nameEl);
            }},
            { label: '🎯 编辑主目标', onSelect: async () => {
              const cur = s.mainGoal || '';
              const next = await promptModal({
                title: '编辑主目标',
                message: '每 5 个 user message 自动提醒 claude 防漂移。留空则禁用。',
                value: cur,
                placeholder: '例如：实现并发布 v0.8 风格统一',
                confirmLabel: '保存',
              });
              if (next !== null) {
                await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ mainGoal: next }) });
                await window.PanelSessionsCore?.listSessions?.();
                toast(next ? `主目标已更新` : `主目标已清除`, 'success');
              }
            }},
            { label: '📦 归档', onSelect: () => window.PanelSessionsCore?.setSessionArchived?.(s.id, true) },
            { label: '⤓ 导出为 markdown', onSelect: () => {
              // v0.50 F2: 触发下载
              const a = document.createElement('a');
              a.href = `/api/sessions/${s.id}/export`;
              a.download = (s.name || 'session') + '.md';
              document.body.appendChild(a); a.click(); a.remove();
              toast('已开始下载', 'success');
            }},
            { divider: true },
            { label: '🗑 彻底删除…', danger: true, onSelect: () => {
              confirmModal({
                title: '彻底删除会话？',
                message: `「${s.name}」会话数据不可恢复。\n如果只是想暂时收起，请用「📦 归档」。`,
                confirmLabel: '彻底删除',
                danger: true,
              }).then(ok => { if (ok) window.PanelSessionsCore?.deleteSession?.(s.id); });
            }},
          ], e.clientX, e.clientY);
        });
        const nameEl = div.querySelector('.session-name');
        if (nameEl) {
          nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            window.PanelSessionsCore?.startRenameSession?.(s.id, nameEl);
          });
        }
        div.querySelector('.session-archive-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          window.PanelSessionsCore?.setSessionArchived?.(s.id, true);
        });
        // v0.18 ✏️ 重命名按钮（发现性提升）
        div.querySelector('.session-rename-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          const nameElInner = div.querySelector('.session-name');
          if (nameElInner) window.PanelSessionsCore?.startRenameSession?.(s.id, nameElInner);
        });
        return div;
    }

    function renderArchived() {
      const section = $('#archivedSection');
      const list = $('#archivedList');
      const count = core.state.archivedSessions.length;
      $('#archivedCount').textContent = count;
      if (count === 0) {
        section.style.display = 'none';
        return;
      }
      section.style.display = '';
      list.style.display = core.state.archivedExpanded ? '' : 'none';
      $('#archArrow').textContent = core.state.archivedExpanded ? '▼' : '▶';
      list.innerHTML = '';
      core.state.archivedSessions.forEach(s => {
        const div = document.createElement('div');
        div.className = 'archived-item';
        const archDate = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
        div.setAttribute('role', 'listitem');
        div.setAttribute('aria-label', `已归档会话: ${s.name}`);
        div.innerHTML = `
          <div class="arch-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
          <div class="arch-meta muted small">${s.msgCount} 条 · 归档于 ${archDate}</div>
          <div class="arch-actions">
            <button class="btn-tiny" data-act="restore" title="恢复到活跃列表" aria-label="恢复会话 ${escapeHtml(s.name)}">↩</button>
            <button class="btn-tiny btn-tiny-danger" data-act="delete" title="彻底删除" aria-label="彻底删除会话 ${escapeHtml(s.name)}">🗑</button>
          </div>
        `;
        div.querySelector('[data-act="restore"]').addEventListener('click', (e) => {
          e.stopPropagation();
          window.PanelSessionsCore?.setSessionArchived?.(s.id, false);
        });
        div.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
          e.stopPropagation();
          confirmModal({
            title: '彻底删除会话？',
            message: `「${s.name}」会话数据不可恢复。`,
            confirmLabel: '彻底删除',
            danger: true,
          }).then(ok => { if (ok) window.PanelSessionsCore?.deleteSession?.(s.id); });
        });
        list.appendChild(div);
      });
    }

    $('#archivedToggle')?.addEventListener('click', () => {
      core.state.archivedExpanded = !core.state.archivedExpanded;
      $('#archivedToggle').setAttribute('aria-expanded', core.state.archivedExpanded ? 'true' : 'false');
      renderArchived();
    });

    function showEmpty() {
      $('#mainHeader').style.display = 'flex';
      $('#chatArea').style.display = 'none';
      $('#sessionInfo').innerHTML = '<span class="muted">— 未选中 —</span>';
    }

    function showChat() {
      $('#mainHeader').style.display = 'none';
      $('#chatArea').style.display = 'flex';
    }

    function appendMessage(m, providedIndex) {
      const out = $('#chatOutput');
      // v0.15 去重：若 assistant text 已经流式渲染过（finalized div 内容相同），跳过
      if (m.role === 'assistant' && m.content) {
        const finalized = out.querySelectorAll('.msg-finalized[data-full-text]');
        for (let i = finalized.length - 1; i >= 0 && i >= finalized.length - 5; i--) {
          if (finalized[i].dataset.fullText === m.content) return;
        }
      }
      const div = document.createElement('div');
      div.className = `msg msg-${m.role}`;
      // v0.50 F1/F5/F7: 给每条消息打上索引 + ⭐ 按钮支持
      const msgIdx = Number.isInteger(providedIndex) ? providedIndex : out.querySelectorAll('.msg').length;
      div.dataset.msgIdx = msgIdx;
      const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let icon = '·';
      if (m.role === 'user') icon = '👤';
      else if (m.role === 'assistant') icon = '🤖';
      else if (m.role === 'tool_use') icon = '🔧';
      else if (m.role === 'system') icon = '🔁';
      // 是否已收藏（v0.51 R-14: 用 core.state.activeStarred，比 core.state.sessions 缓存更可靠）
      const starred = Array.isArray(core.state.activeStarred) && core.state.activeStarred.includes(msgIdx);
      div.innerHTML = `
        <div class="msg-head">
          <span class="msg-icon">${icon}</span>
          <span class="msg-role">${m.role}</span>
          <span class="msg-time">${time}</span>
          <button class="msg-star-btn ${starred ? 'starred' : ''}" title="收藏（也可右键菜单）" aria-label="收藏消息">★</button>
        </div>
        <div class="msg-body" data-raw-text="${escapeHtmlEarly(m.content || '')}">${renderMarkdown(m.content)}</div>
      `;
      out.appendChild(div);
      out.scrollTop = out.scrollHeight;
    }

    // 原 app.js 启动块的初始空态（随属主迁入，boot 只执行一次）
    showEmpty();

    window.PanelSessionsList = {
      renderList,
      buildSessionItem,
      renderArchived,
      showEmpty,
      showChat,
      appendMessage,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
