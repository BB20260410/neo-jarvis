// @ts-check
// rooms-members-ui.js — 房间成员/技能绑定/providers 缓存/elapsed 计时器/状态 chip（从 app.js 外迁；app.js 模块化第10批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；状态经 core.roomState 实时取；boot 延迟初始化避时序 bug。
// ⚠️ main.js import 顺序契约：本模块在 rooms-core-ui.js 之后 boot（ROOM_STATUS_ZH 快照来自 window.PanelRoomsCore）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml, promptModal, api, hasOwnerToken, renderOwnerTokenMissingBanner, isRoomRunningLike } = core;
    // v0.52 状态翻译表本体随第10批迁入 rooms-core-ui.js（const 对象身份稳定，快照安全）
    const ROOM_STATUS_ZH = window.PanelRoomsCore?.ROOM_STATUS_ZH || {};

    // v0.52 房间 adapter providers 缓存（GET /api/room-adapters/providers）
    let roomProvidersCache = [];
    async function refreshRoomProviders() {
      if (!hasOwnerToken()) {
        renderOwnerTokenMissingBanner();
        return;
      }
      try {
        const r = await fetch('/api/room-adapters/providers').then(x => x.json());
        if (r?.ok && Array.isArray(r.providers)) roomProvidersCache = r.providers;
      } catch {}
    }

    let roomAgentProfilesCache = [];
    let roomAgentProfilesLoaded = false;
    async function refreshRoomAgentProfiles() {
      if (roomAgentProfilesLoaded) return;
      roomAgentProfilesLoaded = true;
      try {
        const r = await api('/api/agent-registry');
        if (r?.ok && Array.isArray(r.profiles)) {
          roomAgentProfilesCache = r.profiles.map((profile) => ({
            id: profile.id,
            title: profile.title || profile.id,
          }));
        }
      } catch {
        roomAgentProfilesLoaded = false;
      }
    }

    let roomSkillsCache = [];
    let roomSkillsLoaded = false;
    async function refreshRoomSkills() {
      if (roomSkillsLoaded) return;
      roomSkillsLoaded = true;
      try {
        const r = await fetch('/api/skills').then(x => x.json());
        if (r?.ok && Array.isArray(r.skills)) {
          roomSkillsCache = r.skills
            .filter(skill => skill.enabled !== false)
            .map(skill => ({
              name: skill.name,
              displayName: skill.displayName || skill.name,
              description: skill.description || '',
              bodyLen: Number(skill.bodyLen || 0),
              updatedAt: skill.updatedAt || '',
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
      } catch {
        roomSkillsLoaded = false;
      }
    }

    function renderRoomSkillBindings(room) {
      const root = $('#roomSkillBindings');
      if (!root) return;
      if (!roomSkillsLoaded) {
        root.innerHTML = '<span class="room-skill-label">Skills</span><span class="room-skill-empty">加载中…</span>';
        refreshRoomSkills().then(() => {
          if (core.roomState.activeRoom?.id === room?.id) renderRoomSkillBindings(core.roomState.activeRoom);
        });
        return;
      }
      const active = new Set(Array.isArray(room?.skills) ? room.skills : []);
      if (roomSkillsCache.length === 0) {
        root.innerHTML = '<span class="room-skill-label">Skills</span><span class="room-skill-empty">暂无可绑定 Skill</span>';
        return;
      }
      root.innerHTML = `
        <span class="room-skill-label">Skills</span>
        <div class="room-skill-chip-list">
          ${roomSkillsCache.map(skill => `
            <label class="room-skill-chip ${active.has(skill.name) ? 'is-active' : ''}" title="${escapeHtml(skill.description)}">
              <input type="checkbox" value="${escapeHtml(skill.name)}" ${active.has(skill.name) ? 'checked' : ''} />
              <span>${escapeHtml(skill.name)}</span>
            </label>
          `).join('')}
        </div>
      `;
      root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener('change', () => updateRoomSkillsFromControls(root));
      });
    }

    async function updateRoomSkillsFromControls(root = $('#roomSkillBindings')) {
      if (!core.roomState.activeId || !root) return;
      const skills = [...root.querySelectorAll('input[type="checkbox"]:checked')]
        .map(input => input.value)
        .filter(Boolean);
      const u = await fetch(`/api/rooms/${core.roomState.activeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills }),
      }).then(x => x.json());
      if (u.ok) {
        core.roomState.activeRoom = u.room;
        renderRoomSkillBindings(u.room);
      } else {
        toast('Skill 绑定失败：' + (u.error || ''), 'error');
        if (core.roomState.activeRoom) renderRoomSkillBindings(core.roomState.activeRoom);
      }
    }

    function renderRoomMembers(room) {
      const wrap = $('#roomMembers');
      if (!wrap) return;
      if (!roomAgentProfilesLoaded) {
        refreshRoomAgentProfiles().then(() => {
          if (core.roomState.activeRoom?.id === room?.id) renderRoomMembers(core.roomState.activeRoom);
        });
      }
      wrap.innerHTML = '';
      for (const [idx, m] of (room.members || []).entries()) {
        const chip = document.createElement('div');
        chip.className = 'room-member-chip' + (m.enabled === false ? ' disabled' : '');
        chip.dataset.idx = idx;

        // v0.52 adapter id 下拉（让用户切到 gemini / minimax / custom:xxx 等）
        const adapterSel = document.createElement('select');
        adapterSel.title = '切换 adapter（claude/codex/ollama/gemini/...）';
        adapterSel.className = 'room-member-adapter';
        const providers = roomProvidersCache.length > 0 ? roomProvidersCache : [{ id: m.adapterId, displayName: m.adapterId }];
        // 若当前 adapterId 不在 providers 缓存里（例如配置变化后），仍保留一项以免显示空
        const hasCurrent = providers.some(p => p.id === m.adapterId);
        const finalProviders = hasCurrent ? providers : [{ id: m.adapterId, displayName: m.adapterId + ' (未注册)' }, ...providers];
        for (const p of finalProviders) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.displayName || p.id;
          if (p.id === m.adapterId) o.selected = true;
          adapterSel.appendChild(o);
        }
        adapterSel.addEventListener('change', () => {
          const newId = adapterSel.value;
          const provider = roomProvidersCache.find(p => p.id === newId);
          // 切 adapter 时同步 displayName + 清掉 model（新 adapter 的 MODEL_OPTIONS 可能不同）
          updateMember(idx, { adapterId: newId, displayName: provider?.displayName || newId, model: '' });
        });

        // v0.52 model 改成 input + datalist：允许自由填新型号（MiniMax-M2.7 / gemini-3-pro 等）
        const opts = core.MODEL_OPTIONS?.[m.adapterId] || [];
        const listId = `models-${m.adapterId.replace(/[^a-z0-9-]/gi, '_')}-${idx}`;
        const dataList = document.createElement('datalist');
        dataList.id = listId;
        for (const opt of opts) {
          if (!opt) continue;
          const o = document.createElement('option');
          o.value = opt;
          dataList.appendChild(o);
        }
        const select = document.createElement('input');
        select.type = 'text';
        select.className = 'room-member-model';
        select.setAttribute('list', listId);
        select.value = m.model || '';
        select.placeholder = '默认';
        select.title = '模型名（自由输入，预置清单仅作提示）';
        select.addEventListener('change', () => updateMember(idx, { model: select.value.trim() }));
        let agentSel = null;
        if (roomAgentProfilesCache.length > 0) {
          agentSel = document.createElement('select');
          agentSel.title = '绑定 Xike Agent Profile（默认按角色自动匹配）';
          agentSel.className = 'room-member-agent';
          const auto = document.createElement('option');
          auto.value = '';
          auto.textContent = 'auto profile';
          agentSel.appendChild(auto);
          const currentAgentProfileId = m.agentProfileId || m.profileId || m.agentId || '';
          for (const profile of roomAgentProfilesCache) {
            const o = document.createElement('option');
            o.value = profile.id;
            o.textContent = profile.id;
            o.title = profile.title;
            if (profile.id === currentAgentProfileId) o.selected = true;
            agentSel.appendChild(o);
          }
          agentSel.addEventListener('change', () => updateMember(idx, { agentProfileId: agentSel.value }));
        }
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'room-member-toggle';
        toggleBtn.textContent = m.enabled === false ? '✓' : '✕';
        toggleBtn.title = m.enabled === false ? '启用' : '关闭';
        toggleBtn.addEventListener('click', () => updateMember(idx, { enabled: !(m.enabled !== false) }));
        const roleBadge = m.role ? `<span class="room-member-role ${m.role}">${m.role}</span>` : '';
        chip.innerHTML = `${roleBadge}<span>${escapeHtml(m.displayName)}</span>`;
        chip.appendChild(adapterSel);
        chip.appendChild(select);
        if (agentSel) chip.appendChild(agentSel);
        chip.appendChild(dataList);
        chip.appendChild(toggleBtn);
        // v0.52 移除按钮（让用户能精简成员）
        const removeBtn = document.createElement('button');
        removeBtn.className = 'room-member-toggle';
        removeBtn.textContent = '🗑';
        removeBtn.title = '移除该成员';
        removeBtn.addEventListener('click', () => removeMember(idx));
        chip.appendChild(removeBtn);
        wrap.appendChild(chip);
      }
      // v0.52 ＋ 加成员
      const addChip = document.createElement('button');
      addChip.className = 'room-member-chip room-member-add';
      addChip.textContent = '＋ 加成员';
      addChip.title = '从已注册 adapter 中挑一个加入（可在 ⚙️ adapter 配置里启用 Gemini/MiniMax/自定义）';
      addChip.addEventListener('click', () => addRoomMember());
      wrap.appendChild(addChip);
    }

    async function updateMember(idx, patch) {
      if (!core.roomState.activeId) return;
      const r = await fetch(`/api/rooms/${core.roomState.activeId}`).then(x => x.json());
      if (!r.ok) return;
      const members = [...(r.room.members || [])];
      if (!members[idx]) return;
      members[idx] = { ...members[idx], ...patch };
      const u = await fetch(`/api/rooms/${core.roomState.activeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members }),
      }).then(x => x.json());
      if (u.ok) {
        core.roomState.activeRoom = u.room;
        renderRoomMembers(u.room);
      }
    }

    async function removeMember(idx) {
      if (!core.roomState.activeId) return;
      const r = await fetch(`/api/rooms/${core.roomState.activeId}`).then(x => x.json());
      if (!r.ok) return;
      const members = [...(r.room.members || [])];
      if (members.length <= 1) { toast('至少保留 1 个成员', 'warn'); return; }
      members.splice(idx, 1);
      const u = await fetch(`/api/rooms/${core.roomState.activeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members }),
      }).then(x => x.json());
      if (u.ok) {
        core.roomState.activeRoom = u.room;
        renderRoomMembers(u.room);
      }
    }

    async function addRoomMember() {
      if (!core.roomState.activeId) return;
      if (roomProvidersCache.length === 0) await refreshRoomProviders();
      if (roomProvidersCache.length === 0) { toast('暂无可用 adapter（点 ⚙️ 配置 Gemini/MiniMax/自定义）', 'warn'); return; }
      // S19 B3：原 native prompt() blocking 改 promptModal；lines 用 ' / ' 单行显示，CSS word-break 自动 wrap
      const lines = roomProvidersCache.map((p, i) => `${i + 1}.${p.displayName || p.id}`).join(' / ');
      const sel = await promptModal({
        title: '加成员：选 adapter',
        message: `${lines}（输入序号 1-${roomProvidersCache.length}）`,
        value: '1',
      });
      if (sel == null) return;
      const idx = parseInt(sel, 10) - 1;
      const provider = roomProvidersCache[idx];
      if (!provider) { toast('无效序号', 'error'); return; }
      const r = await fetch(`/api/rooms/${core.roomState.activeId}`).then(x => x.json());
      if (!r.ok) return;
      const members = [...(r.room.members || [])];
      members.push({ adapterId: provider.id, displayName: provider.displayName || provider.id, model: '', enabled: true });
      const u = await fetch(`/api/rooms/${core.roomState.activeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members }),
      }).then(x => x.json());
      if (u.ok) {
        core.roomState.activeRoom = u.room;
        renderRoomMembers(u.room);
      }
      else toast('加成员失败：' + (u.error || ''), 'error');
    }

    // v0.52 elapsed 计时器（辩论 turn placeholder + 小组 task 卡片共用）
    let _elapsedTimer = null;
    // S24 minimum: formatElapsed 主实现挪到 src/web/utils.js
    function formatElapsed(sec) {
      if (window.PanelUtils && window.PanelUtils.formatElapsed) return window.PanelUtils.formatElapsed(sec);
      const m = Math.floor(sec / 60), s = sec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    function startElapsedTicker() {
      if (_elapsedTimer) return;
      _elapsedTimer = setInterval(() => {
        const targets = document.querySelectorAll('[data-elapsed="1"]');
        if (targets.length === 0) { clearInterval(_elapsedTimer); _elapsedTimer = null; return; }
        const now = Date.now();
        for (const el of targets) {
          const parent = el.closest('[data-started-at]') || el.parentElement?.closest('[data-started-at]');
          if (!parent) continue;
          const start = parseInt(parent.dataset.startedAt || '0', 10);
          if (!start) continue;
          const sec = Math.floor((now - start) / 1000);
          const label = el.dataset.label || '思考中';
          el.textContent = `⏳ ${label}… ${formatElapsed(sec)}`;
          // v0.52 卡死检测：60s 无 stdout 进度变红
          const lastProg = parseInt(parent.dataset.lastProgressAt || '0', 10);
          if (lastProg > 0) {
            const idleSec = Math.floor((now - lastProg) / 1000);
            if (idleSec >= 60 && !parent.classList.contains('stalled')) {
              parent.classList.add('stalled');
              const progEl = parent.querySelector('.room-turn-progress');
              if (progEl) {
                progEl.textContent = `⚠️ ${idleSec}s 无新输出（疑似卡住，可点 ⏹ 立即结束）`;
                progEl.style.color = '#dc2626';
              }
            } else if (parent.classList.contains('stalled')) {
              const progEl = parent.querySelector('.room-turn-progress');
              if (progEl) progEl.textContent = `⚠️ ${idleSec}s 无新输出（疑似卡住，可点 ⏹ 立即结束）`;
            }
          }
        }
      }, 1000);
    }
    function maybeStopElapsedTicker() {
      // 若 DOM 里没有 data-elapsed 元素，停止 ticker（省 CPU）
      if (document.querySelector('[data-elapsed="1"]')) return;
      if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
    }
    function updateRoomStatusChip(status) {
      const chip = $('#roomStatusChip');
      const s = status || 'idle';
      chip.className = 'room-status-chip ' + s;
      chip.textContent = ROOM_STATUS_ZH[s] || s;
      $('#btnRoomAbort').style.display = isRoomRunningLike(s) ? 'inline-flex' : 'none';

      // v0.52 paused/error 显示"重启"；只有 debate/squad 支持"续跑"
      // v0.53 Sprint 3.5：auto_paused 也算 paused 状态，可续跑/重启
      const isPausedOrError = (s === 'paused' || s === 'error' || s === 'auto_paused');
      const activeRoom = (core.roomState.rooms || []).find(rr => rr.id === core.roomState.activeId);
      const supportsResume = activeRoom && (activeRoom.mode === 'debate' || activeRoom.mode === 'squad' || activeRoom.mode === 'cross_verify');
      const r = $('#btnRoomResume'); if (r) r.style.display = (isPausedOrError && supportsResume) ? 'inline-flex' : 'none';
      const rr = $('#btnRoomRestart'); if (rr) rr.style.display = isPausedOrError ? 'inline-flex' : 'none';

      // v0.54 Sprint 4.1：状态变化时 toggle 所有 turn 卡 retry 按钮（避免 running 时点了被后端拒）
      const isRunning = isRoomRunningLike(s);
      const startBtn = $('#btnRoomStart');
      if (startBtn) {
        startBtn.disabled = isRunning;
        if (isRunning) startBtn.textContent = '⏳ 集群协同运行中';
      }
      document.querySelectorAll('#roomRounds .room-turn-retry').forEach((btn) => {
        if (isRunning) {
          btn.disabled = true;
          btn.textContent = '⏸ 等房暂停';
          btn.title = '房间正在跑后续 round，等跑完或手动暂停后再重试';
        } else if (btn.disabled) {
          btn.disabled = false;
          btn.textContent = '🔄 重试这个';
          btn.title = '只重跑这一个 AI，不影响其他成员';
        }
      });
    }

    // 顶层副作用迁入 boot：providers 缓存启动预热（原 app.js 顶层 refreshRoomProviders() 调用）
    refreshRoomProviders();

    window.PanelRoomsMembers = {
      refreshRoomProviders, refreshRoomAgentProfiles, refreshRoomSkills,
      renderRoomSkillBindings, updateRoomSkillsFromControls,
      renderRoomMembers, updateMember, removeMember, addRoomMember,
      formatElapsed, startElapsedTicker, maybeStopElapsedTicker, updateRoomStatusChip,
      // 缓存是模块内 let（会被整体重赋值），经 getter 实时取；roomSkillsLoaded 供 PanelCore set 桥写（agent-graph 触发重拉）
      get roomProvidersCache() { return roomProvidersCache; },
      get roomSkillsCache() { return roomSkillsCache; },
      get roomSkillsLoaded() { return roomSkillsLoaded; },
      setRoomSkillsLoaded(v) { roomSkillsLoaded = v; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
