// @ts-check
// search-ui.js — 跨 session 全局搜索（⌘⇧F）+ 跨房搜索（⌘⇧R）+ ⌘? cheatsheet + 统一快捷键（从 app.js 外迁；app.js 模块化第14批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// selectSession 仍留 app.js（批18 会话域），经 core.selectSession 调用时实时取；
// prompts 模板库（同批 prompts-notify-ui.js）经 window.PanelPromptsNotify 懒解析。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast } = core;

    // ─── F1 跨 session 全局搜索（⌘⇧F）─────
    const searchState = { items: [], activeIdx: 0, debounceTimer: null };
    function openSearch() {
      $('#searchModal').style.display = 'flex';
      $('#searchInput').value = '';
      searchState.items = [];
      searchState.activeIdx = 0;
      renderSearchResults();
      setTimeout(() => $('#searchInput').focus(), 0);
    }
    function closeSearch() { $('#searchModal').style.display = 'none'; }
    function escRegexp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function appendHighlightedText(target, text, query) {
      const value = String(text || '');
      const q = String(query || '').trim();
      if (!q) {
        target.textContent = value;
        return;
      }
      const re = new RegExp(escRegexp(q), 'gi');
      let cursor = 0;
      for (const match of value.matchAll(re)) {
        const index = match.index || 0;
        if (index > cursor) target.append(document.createTextNode(value.slice(cursor, index)));
        const mark = document.createElement('mark');
        mark.textContent = match[0];
        target.append(mark);
        cursor = index + match[0].length;
      }
      if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
    }
    async function runSearch(q) {
      if (!q || !q.trim()) { searchState.items = []; renderSearchResults(); return; }
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q.trim()) + '&limit=50').then(x => x.json());
        if (r.ok) {
          searchState.items = r.hits || [];
          searchState.activeIdx = 0;
        } else {
          searchState.items = [];
        }
      } catch {
        searchState.items = [];
      }
      renderSearchResults();
    }
    function renderSearchResults() {
      const list = $('#searchResults');
      if (!list) return;
      if (searchState.items.length === 0) {
        list.innerHTML = '<div class="cmdk-empty">没匹配到（输入关键词开始搜索）</div>';
        return;
      }
      const q = $('#searchInput').value.trim();
      list.innerHTML = '';
      searchState.items.forEach((h, i) => {
        const hit = document.createElement('div');
        hit.className = 'search-hit ' + (i === searchState.activeIdx ? 'active' : '');
        hit.dataset.idx = String(i);
        const head = document.createElement('div');
        head.className = 'search-hit-head';
        const name = document.createElement('span');
        name.className = 'search-hit-name';
        name.textContent = h.sessionName || '?';
        const role = document.createElement('span');
        role.className = 'search-hit-role';
        role.textContent = `${h.role || '-'} · msg #${h.msgIndex ?? '-'}${h.ts ? ' · ' + new Date(h.ts).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''}`;
        const snippet = document.createElement('div');
        snippet.className = 'search-hit-snippet';
        appendHighlightedText(snippet, h.snippet, q);
        head.append(name, role);
        hit.append(head, snippet);
        list.append(hit);
      });
      list.querySelectorAll('.search-hit').forEach(el => {
        el.addEventListener('click', () => jumpToSearchHit(parseInt(el.dataset.idx, 10)));
      });
    }
    function jumpToSearchHit(idx) {
      const h = searchState.items[idx];
      if (!h) return;
      closeSearch();
      core.selectSession(h.sessionId);
      // v0.51 ZZZZZ-02 fix: 300ms 不够时 retry，避免大 session 渲染慢导致静默失败
      let attempts = 0;
      const tryFind = () => {
        const el = document.querySelector(`#chatOutput .msg[data-msg-idx="${h.msgIndex}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('msg-highlight');
          setTimeout(() => el.classList.remove('msg-highlight'), 2400);
          return;
        }
        if (++attempts < 10) setTimeout(tryFind, 100);
        else toast('原消息可能已被截断或会话切换，请重新搜索', 'warn');
      };
      setTimeout(tryFind, 150);
    }
    $('#searchInput')?.addEventListener('input', (e) => {
      if (searchState.debounceTimer) clearTimeout(searchState.debounceTimer);
      searchState.debounceTimer = setTimeout(() => runSearch(e.target.value), 200);
    });
    $('#searchInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (searchState.items.length > 0) {
          searchState.activeIdx = Math.min(searchState.items.length - 1, searchState.activeIdx + 1);
          renderSearchResults();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (searchState.items.length > 0) {
          searchState.activeIdx = Math.max(0, searchState.activeIdx - 1);
          renderSearchResults();
        }
      } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (searchState.items[searchState.activeIdx]) jumpToSearchHit(searchState.activeIdx);
      }
    });
    $('#searchModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'searchModal') closeSearch();
    });

    // ─── v0.53 Sprint 3.5 跨房搜索（⌘⇧R）─────
    const roomSearchState = { items: [], activeIdx: 0, debounceTimer: null };
    function openRoomSearch() {
      $('#roomSearchModal').style.display = 'flex';
      $('#roomSearchInput').value = '';
      roomSearchState.items = [];
      roomSearchState.activeIdx = 0;
      renderRoomSearchResults();
      setTimeout(() => $('#roomSearchInput').focus(), 0);
    }
    function closeRoomSearch() { $('#roomSearchModal').style.display = 'none'; }
    async function runRoomSearch(q) {
      if (!q || !q.trim()) { roomSearchState.items = []; renderRoomSearchResults(); return; }
      const incl = $('#roomSearchInclArchived')?.checked ? '1' : '0';
      try {
        const r = await fetch('/api/rooms/search?q=' + encodeURIComponent(q.trim()) + '&limit=50&includeArchived=' + incl).then(x => x.json());
        if (r.ok) {
          roomSearchState.items = r.hits || [];
          roomSearchState.activeIdx = 0;
        } else {
          roomSearchState.items = [];
        }
      } catch {
        roomSearchState.items = [];
      }
      renderRoomSearchResults();
    }
    function renderRoomSearchResults() {
      const list = $('#roomSearchResults');
      if (!list) return;
      if (roomSearchState.items.length === 0) {
        list.innerHTML = '<div class="cmdk-empty">没匹配到（输入关键词开始搜索 · 跨所有房）</div>';
        return;
      }
      const q = $('#roomSearchInput').value.trim();
      const modeLabel = { debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' };
      list.innerHTML = '';
      roomSearchState.items.forEach((h, i) => {
        const hit = document.createElement('div');
        hit.className = 'search-hit ' + (i === roomSearchState.activeIdx ? 'active' : '');
        hit.dataset.idx = String(i);
        const head = document.createElement('div');
        head.className = 'search-hit-head';
        const name = document.createElement('span');
        name.className = 'search-hit-name';
        name.textContent = h.roomName || '?';
        const role = document.createElement('span');
        role.className = 'search-hit-role';
        role.textContent = `${modeLabel[h.mode] || h.mode || '-'} · ${h.where || ''}${h.speaker ? ' · ' + h.speaker : ''}`;
        const snippet = document.createElement('div');
        snippet.className = 'search-hit-snippet';
        appendHighlightedText(snippet, h.snippet, q);
        head.append(name, role);
        hit.append(head, snippet);
        list.append(hit);
      });
      list.querySelectorAll('.search-hit').forEach(el => {
        el.addEventListener('click', () => jumpToRoomSearchHit(parseInt(el.dataset.idx, 10)));
      });
    }
    function jumpToRoomSearchHit(idx) {
      const h = roomSearchState.items[idx];
      if (!h) return;
      closeRoomSearch();
      // 切换到房间区域并选中房
      window.PanelRoomsCore?.showRoomArea?.();
      window.PanelRoomsCore?.loadRooms?.().then(() => window.PanelRoomsCore?.selectRoom?.(h.roomId));
    }
    $('#roomSearchInput')?.addEventListener('input', (e) => {
      if (roomSearchState.debounceTimer) clearTimeout(roomSearchState.debounceTimer);
      roomSearchState.debounceTimer = setTimeout(() => runRoomSearch(e.target.value), 200);
    });
    $('#roomSearchInclArchived')?.addEventListener('change', () => {
      runRoomSearch($('#roomSearchInput').value);
    });
    $('#roomSearchInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRoomSearch(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (roomSearchState.items.length > 0) {
          roomSearchState.activeIdx = Math.min(roomSearchState.items.length - 1, roomSearchState.activeIdx + 1);
          renderRoomSearchResults();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (roomSearchState.items.length > 0) {
          roomSearchState.activeIdx = Math.max(0, roomSearchState.activeIdx - 1);
          renderRoomSearchResults();
        }
      } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (roomSearchState.items[roomSearchState.activeIdx]) jumpToRoomSearchHit(roomSearchState.activeIdx);
      }
    });
    $('#roomSearchModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'roomSearchModal') closeRoomSearch();
    });

    // ─── F4 ⌘? cheatsheet ─────
    function openCheatsheet() { $('#cheatsheetModal').style.display = 'flex'; }
    function closeCheatsheet() { $('#cheatsheetModal').style.display = 'none'; }
    $('#cheatsheetModal')?.addEventListener('click', (e) => { if (e.target.id === 'cheatsheetModal') closeCheatsheet(); });
    $('#statusKbBtn')?.addEventListener('click', openCheatsheet);

    // ─── 快捷键统一处理（boot 只绑一次）─────
    // 注意：注册时机晚于 app.js 内 closeTopOverlay 的 Esc 监听（同 document 节点，互不阻断），
    // Esc 分支只关本模块四个 modal，已关的层 closeTopOverlay 不会重复处理，行为与外迁前一致（e2e 把关）。
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault(); openSearch();
      } else if (mod && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault(); openRoomSearch();  // v0.53 Sprint 3.5 跨房搜索
      } else if (mod && (e.key === 'p' || e.key === 'P') && !e.shiftKey && !e.altKey) {
        e.preventDefault(); window.PanelPromptsNotify?.openPrompts?.();
      } else if (mod && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault(); openCheatsheet();
      } else if (e.key === 'Escape') {
        if ($('#searchModal').style.display === 'flex') closeSearch();
        else if ($('#roomSearchModal')?.style.display === 'flex') closeRoomSearch();
        else if ($('#cheatsheetModal').style.display === 'flex') closeCheatsheet();
        else if ($('#promptsModal').style.display === 'flex') window.PanelPromptsNotify?.closePrompts?.();
      }
    });

    window.PanelSearch = {
      get searchState() { return searchState; },
      get roomSearchState() { return roomSearchState; },
      openSearch, closeSearch, runSearch, renderSearchResults, jumpToSearchHit,
      openRoomSearch, closeRoomSearch, runRoomSearch, renderRoomSearchResults, jumpToRoomSearchHit,
      openCheatsheet, closeCheatsheet,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
