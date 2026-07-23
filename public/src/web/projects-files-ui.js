// @ts-check
// projects-files-ui.js — 方案 B 项目监控 + 接力链 history modal + 文件浏览器 + 全局 ⌘N/⌘1-9
// （loadProjects/openProjectModal/closeProjectModal/openHistoryModal/loadHistoryArchive/closeHistoryModal/
// loadFiles/formatSize/openFileInChat + #btnProjectsRefresh/#chainBadge/[data-close-project]/[data-close-history] 绑定
// + document keydown ×2：Esc 关 project/history modal、⌘N 新建/Esc 关新建弹窗/⌘1-9 切会话）
// （从 app.js 外迁；app.js 模块化第19批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（纯工具可解构；state 实时取 core.state 禁解构快照）。
// 跨文件依赖全走 window 懒解析：openModal/closeModal（PanelSessionsTools）/selectSession（PanelSessionsStream）。
// formatSize wrapper 随迁：主实现在 src/web/utils.js（window.PanelUtils），inline fallback 是 main.js 加载失败兜底。
// loadFiles 被 inspector tab 分发 hub（app.js 留守）与 sessions-stream（经桥 core.loadFiles）调用。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, $$, api, toast, escapeHtml, shortenPath, renderMarkdown } = core;
    const safeClassToken = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';

    // ───── 方案 B 项目监控 ─────
    async function loadProjects() {
      const list = $('#projectList');
      list.innerHTML = '<div class="muted small" style="padding:8px;">加载中…</div>';
      try {
        const r = await api('/api/projects');
        if (!r.ok || !r.items?.length) {
          list.innerHTML = `<div class="muted small" style="padding:12px;">${escapeHtml(r.reason || '未发现含 PROGRESS.md 的项目')}</div>`;
          return;
        }
        list.innerHTML = '';
        for (const p of r.items) {
          const card = document.createElement('div');
          card.className = 'project-card';
          const color = { green: '🟢', yellow: '🟡', red: '🔴' }[p.statusColor] || '⚪️';
          const ascBadge = p.ascState ? `<span class="proj-asc">${escapeHtml(p.ascState)}</span>` : '';
          const runBadge = p.running
            ? `<span class="proj-run ${p.lockStale ? 'stale' : ''}">${p.lockStale ? '⚠️ 锁陈旧' : '🟢 跑'}</span>`
            : '';
          const launchdBadge = p.launchdPlist ? `<span class="proj-launchd" title="${escapeHtml(p.launchdPlist)}">⏰ launchd</span>` : '';
          const blockedBadge = (p.activeBlocked && p.activeBlocked > 0)
            ? `<span class="proj-blocked">🚧 ${p.activeBlocked}</span>` : '';
          const lastCommit = p.lastCommitAt ? new Date(p.lastCommitAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
          card.innerHTML = `
            <div class="proj-row1">
              <span class="proj-color">${color}</span>
              <span class="proj-name">${escapeHtml(p.name)}</span>
              <span class="proj-cycle">cycle ${p.cycles ?? 0}</span>
            </div>
            <div class="proj-row2">${ascBadge}${runBadge}${launchdBadge}${blockedBadge}<span class="proj-commit">⏱ ${lastCommit}</span></div>
            ${p.headline ? `<div class="proj-headline">${escapeHtml(p.headline)}</div>` : ''}
          `;
          card.addEventListener('click', () => openProjectModal(p.name));
          list.appendChild(card);
        }
      } catch (e) {
        list.innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
      }
    }

    async function openProjectModal(name) {
      $('#projectModal').style.display = 'flex';
      $('#projectModalTitle').textContent = name;
      const body = $('#projectModalBody');
      body.innerHTML = '<div class="muted small">加载中…</div>';
      try {
        const p = await api(`/api/projects/${encodeURIComponent(name)}`);
        const sec = (title, content) => content
          ? `<h3 class="proj-sec-h">${escapeHtml(title)}</h3><div class="proj-sec-body">${renderMarkdown(content)}</div>`
          : '';
        const cycleCount = Number(p.cycles) || 0;
        const lockAgeSec = Math.max(0, Number(p.lockAgeSec) || 0);
        const runningText = p.running ? (p.lockStale ? ` · ⚠️ 锁陈旧 ${lockAgeSec}s` : ' · 🟢 在跑') : '';
        body.innerHTML = `
          <div class="proj-modal-meta muted small">
            path <code>${escapeHtml(p.path)}</code> · cycle ${cycleCount}
            ${p.ascState ? ' · ASC ' + escapeHtml(p.ascState) : ''}
            ${escapeHtml(runningText)}
            ${p.launchdPlist ? ' · ⏰ ' + escapeHtml(p.launchdPlist) : ''}
          </div>
          ${sec('STATUS.md', p.sections?.status)}
          ${sec('BLOCKED.md', p.sections?.blocked)}
          ${sec('PROGRESS.md（最近 60 行）', p.sections?.progressTail)}
          ${sec('ERROR_LOG.md', p.sections?.errorLog)}
        `;
      } catch (e) {
        body.innerHTML = `<div class="muted small" style="color:#c00;padding:8px;">${escapeHtml(e.message)}</div>`;
      }
    }

    function closeProjectModal() { $('#projectModal').style.display = 'none'; }
    $$('[data-close-project]').forEach(el => el.addEventListener('click', closeProjectModal));
    $('#btnProjectsRefresh')?.addEventListener('click', loadProjects);

    // ───── 接力链 history modal ─────
    async function openHistoryModal() {
      if (!core.state.activeId) return;
      $('#historyModal').style.display = 'flex';
      const body = $('#historyModalBody');
      body.innerHTML = '<div class="muted small">加载中…</div>';
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/handoff-history`);
        if (!r.ok || !r.items?.length) {
          body.innerHTML = '<div class="muted small" style="padding:8px;">尚无 history 归档（接力一次后会生成）</div>';
          return;
        }
        body.innerHTML = `
          <div class="muted small" style="margin-bottom:8px;">cwd: <code>${escapeHtml(r.cwd)}</code> · ${r.count} 个归档</div>
          <div class="history-list" id="historyList"></div>
          <div class="history-detail" id="historyDetail" style="display:none;">
            <div class="snapshot-head">
              <span class="muted small" id="historyDetailMeta"></span>
              <button class="btn-icon" id="btnHistBack">← 返回列表</button>
            </div>
            <div class="snapshot-body" id="historyDetailBody"></div>
          </div>
        `;
        const list = $('#historyList');
        for (const it of r.items) {
          const mtime = new Date(it.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const item = document.createElement('div');
          item.className = 'history-item';
          const triggerLabel = { panel: '🔁 panel', manual: '✋ manual', auto: '⏰ auto' }[it.trigger] || it.trigger;
          const triggerClass = safeClassToken(it.trigger);
          item.innerHTML = `
            <div class="hist-row1">
              <span class="hist-trigger trigger-${triggerClass}">${escapeHtml(triggerLabel)}</span>
              <span class="hist-time">${mtime}</span>
              <span class="hist-size">${(it.bytes/1024).toFixed(1)}KB</span>
            </div>
            <div class="hist-filename muted small">${escapeHtml(it.name)}</div>
          `;
          item.addEventListener('click', () => loadHistoryArchive(it.name));
          list.appendChild(item);
        }
        $('#btnHistBack').addEventListener('click', () => {
          $('#historyDetail').style.display = 'none';
          $('#historyList').style.display = '';
        });
      } catch (e) {
        body.innerHTML = `<div class="muted small" style="color:#c00;padding:8px;">${escapeHtml(e.message)}</div>`;
      }
    }

    async function loadHistoryArchive(filename) {
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/handoff-history?file=${encodeURIComponent(filename)}`);
        if (!r.ok) { toast('加载失败', 'error'); return; }
        $('#historyList').style.display = 'none';
        $('#historyDetail').style.display = '';
        $('#historyDetailMeta').textContent = `${filename} · ${(r.bytes/1024).toFixed(1)}KB · ${new Date(r.mtime).toLocaleString('zh-CN')}`;
        $('#historyDetailBody').innerHTML = renderMarkdown(r.content);
      } catch (e) {
        toast('读取失败: ' + e.message, 'error');
      }
    }

    function closeHistoryModal() { $('#historyModal').style.display = 'none'; }
    $$('[data-close-history]').forEach(el => el.addEventListener('click', closeHistoryModal));
    $('#chainBadge')?.addEventListener('click', openHistoryModal);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if ($('#projectModal').style.display === 'flex') closeProjectModal();
        if ($('#historyModal').style.display === 'flex') closeHistoryModal();
      }
    });

    // ───── 文件浏览器 ─────
    async function loadFiles(path) {
      core.state.filePath = path;
      $('#filePath').textContent = shortenPath(path);
      const list = $('#fileList');
      list.innerHTML = '<div class="muted small" style="padding:8px;">加载…</div>';
      try {
        const { items } = await api('/api/files?path=' + encodeURIComponent(path));
        list.innerHTML = '';
        // 加 .. 上一级
        const up = document.createElement('div');
        up.className = 'file-item up';
        up.innerHTML = '<span class="file-icon">↑</span><span class="file-name">.. 上一级</span>';
        up.addEventListener('click', () => {
          const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
          loadFiles(parent);
        });
        list.appendChild(up);
        items.forEach(it => {
          const div = document.createElement('div');
          div.className = 'file-item' + (it.isDir ? ' dir' : '');
          const icon = it.isDir ? '📁' : '📄';
          const sizeStr = it.isDir ? '' : formatSize(it.size);
          div.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(it.name)}</span><span class="file-size">${sizeStr}</span>`;
          div.addEventListener('click', () => {
            if (it.isDir) loadFiles(it.path);
            else openFileInChat(it.path);
          });
          list.appendChild(div);
        });
      } catch (e) {
        list.innerHTML = `<div class="muted small" style="padding:8px;color:var(--color-danger);">${escapeHtml(e.message)}</div>`;
      }
    }

    // S24 minimum: formatSize 主实现在 src/web/utils.js（inline fallback 是 main.js 加载失败兜底）
    function formatSize(b) {
      if (window.PanelUtils && window.PanelUtils.formatSize) return window.PanelUtils.formatSize(b);
      if (!b) return '';
      if (b < 1024) return b + 'B';
      if (b < 1024*1024) return (b/1024).toFixed(1) + 'K';
      return (b/1024/1024).toFixed(1) + 'M';
    }

    async function openFileInChat(path) {
      if (!core.state.activeId) {
        toast('先选一个 session', 'warn');
        return;
      }
      try {
        const resp = await api('/api/file?path=' + encodeURIComponent(path));
        const { content, truncated, size } = resp;
        const input = $('#chatInput');
        const ext = path.split('.').pop();
        const previewBody = (content || '').substring(0, 2000);
        const header = truncated
          ? `参考文件 ${path}（已截断：原文件 ${(size/1024/1024).toFixed(1)}MB，仅取前 1MB 的前 2000 字符）:`
          : `参考文件 ${path}:`;
        const ref = `\n\n${header}\n\`\`\`${ext}\n${previewBody}\n\`\`\`\n\n`;
        input.value = input.value + ref;
        input.focus();
        if (truncated) toast('文件 > 1MB，已截断', 'warn');
      } catch (e) {
        toast('读文件失败: ' + e.message, 'error');
      }
    }

    // 全局快捷键（⌘N 新建会话 / Esc 关新建弹窗 / ⌘1-9 切会话；openModal/closeModal 已迁 sessions-tools → window 懒解析）
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        window.PanelSessionsTools?.openModal?.();
      }
      if (e.key === 'Escape' && $('#newModal').style.display === 'flex') {
        window.PanelSessionsTools?.closeModal?.();
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (core.state.sessions[idx]) {
          e.preventDefault();
          window.PanelSessionsStream?.selectSession?.(core.state.sessions[idx].id);
        }
      }
    });

    window.PanelProjectsFiles = {
      loadProjects,
      openProjectModal,
      closeProjectModal,
      openHistoryModal,
      loadHistoryArchive,
      closeHistoryModal,
      loadFiles,
      openFileInChat,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
