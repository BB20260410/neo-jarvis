// @ts-check
// rooms-core-ui.js — 房间核心状态/列表/选择/归档/WS（roomState/loadRooms/selectRoom/attachRoomWS/MODEL_OPTIONS/状态纯函数/lineage）（从 app.js 外迁；app.js 模块化第10批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// ⚠️ main.js import 顺序契约：本模块必须先于 autopilot/room-adapter/summary-report/agent-graph 等模块 boot——
// 它们 boot 时快照 core.roomState / core.MODEL_OPTIONS，若本模块后 boot 快照将是 undefined。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml, promptModal, confirmModal, hasOwnerToken, renderOwnerTokenMissingBanner, shortenPath, wsUrl } = core;

    // ========== v0.39 多 AI 聊天室 ==========
    const roomState = {
      rooms: [],
      activeId: null,
      activeRoom: null,
      ws: null,
    };

    function showRoomArea() {
      $('#mainHeader').style.display = 'none';
      $('#chatArea').style.display = 'none';
      $('#termArea').style.display = 'none';
      $('#pluginArea').style.display = 'none';
      const ov = $('#overviewArea'); if (ov) ov.style.display = 'none';
      $('#roomArea').style.display = 'flex';
    }
    function hideRoomArea() {
      $('#roomArea').style.display = 'none';
      if (roomState.ws) { try { roomState.ws.close(); } catch {} roomState.ws = null; }
      roomState.activeRoom = null;
      renderRoomLineage(null);
      if (core.state.activeId) $('#chatArea').style.display = 'flex';
      else $('#mainHeader').style.display = 'flex';
    }

    async function loadRooms(options = {}) {
      if (!hasOwnerToken()) {
        renderOwnerTokenMissingBanner();
        roomState.rooms = [];
        renderRoomList();
        updateRunningRoomsIndicator();
        return;
      }
      try {
        const r = await fetch('/api/rooms').then(x => x.json());
        roomState.rooms = r.rooms || [];
        renderRoomList();
        maybeAutoSelectRunningRoom(options);
        loadArchivedRooms();   // v0.52 同步刷归档
        updateRunningRoomsIndicator();   // v0.52 并发提示
      } catch (e) {
        toast('加载房间失败：' + e.message, 'error');
      }
    }

    function maybeAutoSelectRunningRoom(options = {}) {
      if (!options.autoSelectRunning || roomState.activeId) return;
      const runningRooms = (roomState.rooms || []).filter(r => isRoomRunningLike(r.status));
      if (runningRooms.length !== 1) return;
      const targetId = runningRooms[0].id;
      requestAnimationFrame(() => {
        if (!roomState.activeId) selectRoom(targetId);
      });
    }

    // 启动时先加载一次房间摘要，让欢迎页底部的「运行中 N 房」不再显示过期 0。
    // （顶层副作用迁入 boot：boot 只跑一次，保证只绑/只启一次）
    setTimeout(() => {
      renderOwnerTokenMissingBanner();
      if (hasOwnerToken()) loadRooms();
    }, 0);

    // v0.52 顶部"运行中 N 房"指示器 + 高并发警告
    function updateRunningRoomsIndicator() {
      const running = (roomState.rooms || []).filter(r => isRoomRunningLike(r.status)).length;
      const el = $('#statusRoomsRunning');
      if (!el) return;
      el.textContent = `🏟 运行中 ${running} 房`;
      if (running >= 5) {
        el.style.color = '#dc2626';
        el.title = `${running} 房同时运行——同账户 LLM 大概率 rate limit。建议错开 model 池或暂停部分房`;
      } else if (running >= 3) {
        el.style.color = '#b45309';
        el.title = `${running} 房同时运行——同账户高并发可能 rate limit。建议错开 Claude/Codex/Gemini 池`;
      } else {
        el.style.color = '';
        el.title = '正在运行的聊天室数（≥3 提示并发限速）';
      }
    }

    function renderRoomList() {
      const list = $('#roomList');
      if (!list) return;
      list.innerHTML = '';
      for (const r of roomState.rooms) {
        const div = document.createElement('div');
        div.className = 'room-list-item' + (r.id === roomState.activeId ? ' active' : '');
        div.dataset.id = r.id;
        const memberCount = (r.members || []).filter(m => m.enabled !== false).length;
        const statusText = isRoomRunningLike(r.status)
          ? '🟠 讨论中'
          : r.status === 'done'
            ? '🟢 完成'
            : r.status === 'error'
              ? '🔴 错误'
              : '⚪ ' + (ROOM_STATUS_ZH[r.status] || '闲置');
        const objectiveTitle = r.objective?.title || r.lineage?.taskId || '';
        const objectiveHtml = objectiveTitle
          ? `<div class="room-list-item-objective" title="${escapeHtml(objectiveTitle)}">目标 ${escapeHtml(objectiveTitle.slice(0, 42))}${objectiveTitle.length > 42 ? '…' : ''}</div>`
          : '';
        div.innerHTML = `
          <div class="room-list-item-name">${escapeHtml(r.name || '未命名')}</div>
          ${objectiveHtml}
          <div class="room-list-item-meta">
            <span>${memberCount} 成员</span>
            <span>${escapeHtml(statusText)}</span>
          </div>
          <button class="room-list-item-archive" data-act="archive" title="归档此房间">📦</button>`;
        div.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="archive"]')) return;
          selectRoom(r.id);
        });
        div.querySelector('[data-act="archive"]').addEventListener('click', (e) => {
          e.stopPropagation();
          setRoomArchived(r.id, true);
        });
        list.appendChild(div);
      }
    }

    // v0.52 房间归档
    const _roomArchState = { expanded: false, archived: [] };
    async function loadArchivedRooms() {
      if (!hasOwnerToken()) {
        _roomArchState.archived = [];
        renderArchivedRooms();
        return;
      }
      try {
        const r = await fetch('/api/rooms?archived=1').then(x => x.json());
        _roomArchState.archived = r.rooms || [];
        renderArchivedRooms();
      } catch {}
    }
    function renderArchivedRooms() {
      const section = $('#roomArchivedSection');
      const list = $('#roomArchivedList');
      const arr = _roomArchState.archived;
      $('#roomArchivedCount').textContent = arr.length;
      if (arr.length === 0) { section.style.display = 'none'; return; }
      section.style.display = '';
      list.style.display = _roomArchState.expanded ? '' : 'none';
      $('#roomArchArrow').textContent = _roomArchState.expanded ? '▼' : '▶';
      list.innerHTML = '';
      for (const r of arr) {
        const archDate = r.archivedAt ? new Date(r.archivedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
        const div = document.createElement('div');
        div.className = 'archived-item';
        div.innerHTML = `
          <div class="arch-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name || '未命名')}</div>
          <div class="arch-meta muted small">${(r.members || []).length} 成员 · 归档于 ${archDate}</div>
          <div class="arch-actions">
            <button class="btn-tiny" data-act="restore" title="恢复到活跃列表">↩</button>
            <button class="btn-tiny btn-tiny-danger" data-act="delete" title="彻底删除">🗑</button>
          </div>`;
        div.querySelector('[data-act="restore"]').addEventListener('click', (e) => {
          e.stopPropagation();
          setRoomArchived(r.id, false);
        });
        div.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await confirmModal('彻底删除房间「' + r.name + '」？', '彻底删除');
          if (!ok) return;
          await fetch(`/api/rooms/${r.id}`, { method: 'DELETE' });
          await loadArchivedRooms();
        });
        list.appendChild(div);
      }
    }

    async function setRoomArchived(id, archived) {
      try {
        await fetch(`/api/rooms/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        });
        if (archived && roomState.activeId === id) {
          roomState.activeId = null;
          roomState.activeRoom = null;
          $('#roomDebate').style.display = 'none';
          $('.room-empty').style.display = '';
          renderRoomLineage(null);
        }
        await loadRooms();
        await loadArchivedRooms();
        toast(archived ? '已归档' : '已恢复', 'success', 1500);
      } catch (e) { toast('操作失败：' + e.message, 'error'); }
    }

    $('#roomArchivedToggle')?.addEventListener('click', () => {
      _roomArchState.expanded = !_roomArchState.expanded;
      $('#roomArchivedToggle').setAttribute('aria-expanded', _roomArchState.expanded ? 'true' : 'false');
      renderArchivedRooms();
    });

    async function createRoom(mode = 'debate', defaultPartner) {
      const defaultName = mode === 'squad' ? 'AI 团队拆活' : mode === 'chat' ? '单模型聊天' : mode === 'arena' ? '多模型联网核对' : mode === 'cross_verify' ? '集群协同' : '多模型辩论';
      const name = await promptModal('给房间起个名字', defaultName);
      if (!name) return;
      let projectName = '';
      if (mode === 'cross_verify') {
        projectName = await promptModal(
          '独立项目文件夹名（每个集群协同房间都会新建专属目录，避免读到别的项目文件）',
          name,
        );
        if (!projectName) return;
      }
      try {
        const payload = { name, mode, defaultPartner };
        if (mode === 'cross_verify') {
          payload.projectScaffold = {
            enabled: true,
            projectName,
          };
        }
        const r = await fetch('/api/rooms', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(x => x.json());
        if (r.ok) {
          await loadRooms();
          await selectRoom(r.room.id);
          if (r.room?.projectScaffold?.projectDir) {
            toast(`已创建独立项目目录：${shortenPath(r.room.projectScaffold.projectDir)}`, 'success', 3000);
          }
        } else {
          toast(r.error || '创建失败', 'error');
        }
      } catch (e) {
        toast('创建失败：' + e.message, 'error');
      }
    }

    async function selectRoom(id) {
      const prevId = roomState.activeId;
      roomState.activeId = id;
      roomState.activeRoom = null;
      if (roomState.ws) { try { roomState.ws.close(); } catch {} roomState.ws = null; }
      renderRoomList();
      let r;
      try {
        r = await fetch(`/api/rooms/${id}`).then(x => x.json());
      } catch (e) {
        // 网络错误：回滚高亮，避免房间面板卡在「已选中但空白」状态
        roomState.activeId = prevId;
        renderRoomList();
        toast('加载房间失败：' + e.message, 'error');
        return;
      }
      if (!r.ok) {
        roomState.activeId = prevId;
        renderRoomList();
        toast('加载房间失败：' + (r.error || ''), 'error');
        return;
      }
      roomState.activeRoom = r.room;
      // 第11批：renderRoomDebate 已外迁 rooms-debate-ui → 改 window 懒解析
      window.PanelRoomsDebate?.renderRoomDebate?.(r.room);
      // v0.51 S-27 fix: room WS 自动重连（指数退避，最多 5 次）
      roomState.wsReconnectAttempts = 0;
      attachRoomWS(id);
    }
    function attachRoomWS(id) {
      const ws = new WebSocket(wsUrl(`/ws/room/${id}`));
      roomState.ws = ws;
      ws.onmessage = ev => {
        try { core.handleRoomEvent(JSON.parse(ev.data)); } catch {}
      };
      ws.onopen = () => { roomState.wsReconnectAttempts = 0; };
      ws.onclose = () => {
        if (roomState.ws === ws) roomState.ws = null;
        // 用户切走或会话被删则不重连
        if (roomState.activeId !== id) return;
        roomState.wsReconnectAttempts = (roomState.wsReconnectAttempts || 0) + 1;
        if (roomState.wsReconnectAttempts > 5) {
          toast('房间 WS 连接丢失（重试 5 次），请重新打开房间', 'error', 5000);
          return;
        }
        const delay = Math.min(8000, 800 * Math.pow(2, roomState.wsReconnectAttempts - 1));
        setTimeout(() => { if (roomState.activeId === id) attachRoomWS(id); }, delay);
      };
    }

    // v0.47 模型清单（每个 adapter 可选模型 + 默认/自定义）
    // 来源：claude --help 实测接受别名+全名；codex exec -m 实测 gpt-5.5 可用；Anthropic 2026-05-28 发布 Claude Opus 4.8
    const MODEL_OPTIONS = {
      claude: [
        '',                       // 默认（CLI 自己决定）
        'opus',                   // 别名 = Claude CLI 自己决定的最新 Opus；后端按 Opus 4.8 默认 xhigh + workflows
        'sonnet',                 // 别名 = claude-sonnet-4-6
        'haiku',                  // 别名 = claude-haiku-4-5
        'claude-opus-4-8',        // 全名精确锁版本；后端默认 --effort xhigh + workflow prompt
        'claude-opus-4-7',        // 全名精确锁版本
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ],
      codex: [
        '',                       // 默认（当前按 gpt-5.5 处理；后端默认 xhigh 推理）
        'gpt-5.5',                // 当前默认/最新；后端默认 xhigh 推理
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-mini',             // P0#3 快档:比 gpt-5 快 3-5x,squad 实测 dev 耗时降一半,代码质量略降
        'gpt-4o',                 // 上一代旗舰,稳定 fallback
        'gpt-4o-mini',            // 最快最便宜,简单任务足够
        'o3',
        'o3-mini',
      ],
      ollama: [
        '',
        'gemma3:4b',
        'qwen2.5:7b',
        'llama3.2:3b',
        'gpt-oss:20b',
      ],
      minimax: [
        '',
        'MiniMax-M2.7',           // 2026 最新
        'MiniMax-M2.6',
        'MiniMax-M2',
        'abab7-chat',
        'abab6.5s-chat',
      ],
      ccr: [
        '',                       // CCR 自己路由（推荐留默认）
        'opus',
        'sonnet',
        'haiku',
      ],
      // v0.56 U11 Gemini 三种入口（2026-05-20 实测）：
      // ✅ 实测可用：3.1-pro-preview / 3.1-flash-lite / 3-flash-preview
      // 🆕 新 stable：3.5-flash（文档已上 stable，gemini CLI 0.42 暂未识别，HTTP 直连可能可用）
      // 关停：3 Pro Preview（2026-03 已下线）
      gemini: [
        '',
        'gemini-3.5-flash',                       // 🆕 2026-05 最新 stable flash（CLI 0.42 暂未识别，HTTP 端点优先试）
        'gemini-3.1-pro-preview',                 // 最强 pro（preview）
        'gemini-3.1-pro-preview-customtools',     // 带 bash+tools 变体（agent 场景）
        'gemini-3.1-flash-lite',                  // ✅ 实测可用 stable
        'gemini-3.1-flash-lite-preview',
        'gemini-3.1-flash-image-preview',         // 🆕 图像生成
        'gemini-3.1-flash-live-preview',          // 🆕 实时对话
        'gemini-3-flash-preview',                 // ✅ 实测可用
        'gemini-2.5-pro',                         // 2.5 系列 stable
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
      ],
      'gemini-openai': [
        '',
        'google/gemini-3.5-flash',                // 🆕 OpenRouter 前缀
        'google/gemini-3.1-pro-preview',
        'google/gemini-3.1-flash-lite',
        'google/gemini-3-flash-preview',
        'gemini-3.5-flash',                       // 直连 Google OpenAI 兼容 endpoint 不带前缀
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
      ],
      'gemini-cli': [
        '',
        'gemini-3.5-flash',                       // 🆕（CLI 0.42 报 ModelNotFoundError，等 CLI 升级）
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
        'gemini-3-flash-preview',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ],
    };

    // v0.52 状态翻译表（原 app.js 顶层；本模块 statusLabel/renderRoomList 与 rooms-members-ui 的 updateRoomStatusChip 共用）
    const ROOM_STATUS_ZH = {
      idle: '闲置', running: '进行中', paused: '已暂停', done: '已完成', error: '出错',
      auto_paused: '🛑 自动暂停',
    };

    function statusLabel(status) {
      return ROOM_STATUS_ZH[status] || status || '未知';
    }

    function isRoomRunningLike(status) {
      return status === 'running' || status === 'debating' || status === 'active' || status === 'processing';
    }

    function shortLineageValue(value) {
      const s = String(value || '').trim();
      if (!s) return '';
      if (s.length <= 36) return s;
      return `${s.slice(0, 14)}…${s.slice(-14)}`;
    }

    function renderRoomLineage(room) {
      const panel = $('#roomLineagePanel');
      if (!panel) return;
      if (!room) {
        panel.innerHTML = `
          <div class="room-lineage-title">目标追溯</div>
          <div class="room-lineage-empty">选择房间后显示目标、任务链路和上下文注入状态。</div>`;
        return;
      }

      const objective = room.objective || null;
      const lineage = room.lineage || {};
      const contextSummary = room.projectContextSummary || room.projectContext || null;
      const tasks = Array.isArray(room.taskList) ? room.taskList : [];
      const counts = tasks.reduce((acc, t) => {
        const key = t?.status || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const acceptance = Array.isArray(objective?.acceptanceCriteria) ? objective.acceptanceCriteria : [];
      const lineageRows = [
        ['project', lineage.projectId || room.cwd || ''],
        ['objective', lineage.objectiveId || objective?.id || ''],
        ['task', lineage.taskId || ''],
        ['parent room', lineage.parentRoomId || ''],
        ['parent task', lineage.parentTaskId || ''],
        ['source', lineage.source || 'manual'],
      ].filter(([, value]) => value);
      const taskChips = tasks.slice(0, 10).map(t => {
        const st = t?.status || 'unknown';
        const title = t?.title || t?.id || 'task';
        return `<span class="room-lineage-task-chip ${escapeHtml(st)}" title="${escapeHtml(st)} · ${escapeHtml(title)}">${escapeHtml(t?.id || title)}</span>`;
      }).join('');
      const hiddenTasks = tasks.length > 10 ? `<span class="room-lineage-task-chip">+${tasks.length - 10}</span>` : '';
      const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' / ');
      const contextFiles = Array.isArray(contextSummary?.files)
        ? contextSummary.files.slice(0, 3).map(f => f.name || f.path).filter(Boolean)
        : [];

      panel.innerHTML = `
        <div class="room-lineage-title">目标追溯</div>
        <div class="room-lineage-node">
          <div class="label">当前目标</div>
          <div class="value">${escapeHtml(objective?.title || room.name || '未命名目标')}</div>
          <div class="room-lineage-path">
            <span>状态 ${escapeHtml(statusLabel(objective?.status || room.status))}${acceptance.length ? ` · 验收 ${acceptance.length} 条` : ''}</span>
            ${objective?.description ? `<span>${escapeHtml(objective.description.slice(0, 120))}${objective.description.length > 120 ? '…' : ''}</span>` : ''}
          </div>
        </div>
        <div class="room-lineage-node">
          <div class="label">链路</div>
          <div class="room-lineage-path">
            ${lineageRows.length ? lineageRows.map(([label, value]) => `<span>${escapeHtml(label)} <code title="${escapeHtml(value)}">${escapeHtml(shortLineageValue(value))}</code></span>`).join('') : '<span>未记录 lineage</span>'}
          </div>
        </div>
        <div class="room-lineage-node">
          <div class="label">任务</div>
          <div class="value">${tasks.length ? `${tasks.length} 个任务` : '暂无任务'}</div>
          ${countText ? `<div class="room-lineage-path"><span>${escapeHtml(countText)}</span></div>` : ''}
          ${taskChips || hiddenTasks ? `<div class="room-lineage-task-list">${taskChips}${hiddenTasks}</div>` : ''}
        </div>
        <div class="room-lineage-node">
          <div class="label">项目上下文</div>
          <div class="value">${contextSummary?.fileCount ? `${contextSummary.fileCount} 个文件 · ${contextSummary.totalChars || 0} 字符` : '未注入'}</div>
          <div class="room-lineage-path">
            ${contextSummary?.truncated ? '<span>已截断，避免上下文膨胀</span>' : ''}
            ${contextFiles.length ? `<span>${contextFiles.map(escapeHtml).join(' / ')}</span>` : ''}
          </div>
        </div>`;
    }

    window.PanelRoomsCore = {
      roomState,
      showRoomArea, hideRoomArea,
      loadRooms, maybeAutoSelectRunningRoom, updateRunningRoomsIndicator, renderRoomList,
      loadArchivedRooms, renderArchivedRooms, setRoomArchived,
      createRoom, selectRoom, attachRoomWS,
      MODEL_OPTIONS, ROOM_STATUS_ZH,
      statusLabel, isRoomRunningLike, shortLineageValue, renderRoomLineage,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
