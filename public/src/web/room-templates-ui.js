// @ts-check
// room-templates-ui.js — 房间模板 modal（roomTemplateState/modeChip/openRoomTemplateModal/closeRoomTemplateModal/renderRoomTemplateList/renderRoomTemplateItem/selectRoomTemplate/createRoomFromTemplate/deleteRoomTemplate + #btnRoomNewFromTemplate/[data-close-room-template] 绑定）（从 app.js 外迁；app.js 模块化第13批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；建房后经 window.PanelRoomsCore 懒解析（既有约定保持）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml, confirmModal } = core;

    // ========== v0.53 Sprint 3 — 🎯 房间模板 ==========
    const roomTemplateState = {
      list: [],
      activeId: null,
    };

    function modeChip(mode) {
      const map = { debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' };
      return map[mode] || mode;
    }

    async function openRoomTemplateModal() {
      $('#roomTemplateModal').style.display = 'flex';
      try {
        const r = await fetch('/api/room-templates').then(x => x.json());
        roomTemplateState.list = r.templates || [];
        renderRoomTemplateList();
        if (roomTemplateState.list.length > 0) {
          selectRoomTemplate(roomTemplateState.list[0].id);
        }
      } catch (e) {
        toast('加载模板失败：' + e.message, 'error');
      }
    }

    function closeRoomTemplateModal() {
      $('#roomTemplateModal').style.display = 'none';
      roomTemplateState.activeId = null;
    }

    function renderRoomTemplateList() {
      const root = $('#roomTemplateList');
      if (!root) return;
      const builtins = roomTemplateState.list.filter(t => t.builtin);
      const users = roomTemplateState.list.filter(t => !t.builtin);
      let html = '';
      if (builtins.length > 0) {
        html += '<div class="room-template-list-section">内置</div>';
        for (const t of builtins) html += renderRoomTemplateItem(t);
      }
      if (users.length > 0) {
        html += '<div class="room-template-list-section">我的</div>';
        for (const t of users) html += renderRoomTemplateItem(t);
      }
      if (!html) html = '<div class="muted small" style="padding: 20px;">没有可用模板</div>';
      root.innerHTML = html;
      root.querySelectorAll('.room-template-item').forEach(el => {
        el.addEventListener('click', () => selectRoomTemplate(el.dataset.tid));
      });
    }

    function renderRoomTemplateItem(t) {
      const active = roomTemplateState.activeId === t.id ? ' active' : '';
      return `<div class="room-template-item${active}" data-tid="${escapeHtml(t.id)}">
        <span class="tname">${escapeHtml(t.name)}</span>
        <span class="tmode"><span class="chip">${modeChip(t.mode)}</span>${(t.preset?.members || []).length} 成员</span>
      </div>`;
    }

    function selectRoomTemplate(id) {
      roomTemplateState.activeId = id;
      renderRoomTemplateList();
      const t = roomTemplateState.list.find(x => x.id === id);
      const root = $('#roomTemplateDetail');
      if (!root) return;
      if (!t) { root.innerHTML = '<div class="muted small">模板不存在</div>'; return; }
      const debateRoundsLine = t.mode === 'debate' && t.preset?.debateRounds
        ? `<span><strong>大轮数：</strong>${t.preset.debateRounds}</span>` : '';
      const qaStrictLine = t.mode === 'squad' && t.preset?.qaStrictness
        ? `<span><strong>QA 严格度：</strong>${escapeHtml(t.preset.qaStrictness)}</span>` : '';
      const membersHtml = (t.preset?.members || []).map(m => {
        const roleChip = m.role ? `<span class="role-chip">${escapeHtml(m.role)}</span>` : '';
        const modelChip = m.model ? `<span class="role-chip">${escapeHtml(m.model)}</span>` : '';
        const disabledHint = m.enabled === false ? ' <span class="muted">(默认禁用)</span>' : '';
        return `<li>${escapeHtml(m.displayName || m.adapterId)}${roleChip}${modelChip}${disabledHint}</li>`;
      }).join('');
      const placeholder = escapeHtml(t.preset?.topicPlaceholder || '');
      const defaultName = t.name;
      const deleteBtn = t.builtin
        ? ''
        : `<button class="cxbtn cxbtn-danger cxbtn-sm room-template-detail-delete" id="btnRoomTemplateDelete">🗑 删除此模板</button>`;
      root.innerHTML = `
        <h3>${modeChip(t.mode)} · ${escapeHtml(t.name)}</h3>
        <div class="desc">${escapeHtml(t.description || '')}</div>
        <div class="meta">
          <span><strong>类型：</strong>${modeChip(t.mode)}</span>
          <span><strong>成员：</strong>${(t.preset?.members || []).length} 个</span>
          ${debateRoundsLine}
          ${qaStrictLine}
        </div>
        <strong>成员列表</strong>
        <ul class="members-list">${membersHtml}</ul>
        <div class="room-template-detail-form">
          <label>房间名（必填）</label>
          <input id="rtNewName" maxlength="200" placeholder="给新房一个名字" value="${escapeHtml(defaultName)}" />
          <label>初始 topic（可空，建房后再填）</label>
          <input id="rtNewTopic" maxlength="500" placeholder="${placeholder}" />
          <div class="actions">
            ${deleteBtn}
            <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-room-template>取消</button>
            <button class="cxbtn cxbtn-primary" id="btnCreateRoomFromTemplate">▶ 用此模板建房</button>
          </div>
        </div>
      `;
      $('#btnCreateRoomFromTemplate')?.addEventListener('click', () => createRoomFromTemplate(t.id));
      $('#btnRoomTemplateDelete')?.addEventListener('click', () => deleteRoomTemplate(t.id));
      root.querySelectorAll('[data-close-room-template]').forEach(el => {
        el.addEventListener('click', closeRoomTemplateModal);
      });
    }

    async function createRoomFromTemplate(templateId) {
      const t = roomTemplateState.list.find(x => x.id === templateId);
      if (!t) return;
      const name = ($('#rtNewName')?.value || '').trim();
      if (!name) { toast('请填写房间名', 'error'); return; }
      const topic = ($('#rtNewTopic')?.value || '').trim();
      try {
        const r = await fetch('/api/rooms', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, mode: t.mode,
            members: t.preset?.members || [],
          }),
        }).then(x => x.json());
        if (!r.ok || !r.room) { toast('创建失败：' + (r.error || 'unknown'), 'error'); return; }
        // 套 debateRounds / qaStrictness
        const patch = {};
        if (t.mode === 'debate' && t.preset?.debateRounds) patch.debateRounds = t.preset.debateRounds;
        if (t.mode === 'squad' && t.preset?.qaStrictness) patch.qaStrictness = t.preset.qaStrictness;
        if (Object.keys(patch).length > 0) {
          try {
            await fetch(`/api/rooms/${r.room.id}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
          } catch {}
        }
        closeRoomTemplateModal();
        await window.PanelRoomsCore?.loadRooms?.();
        window.PanelRoomsCore?.selectRoom?.(r.room.id);
        // 若有 topic，prefill 到输入框（不自动启动）
        if (topic) {
          setTimeout(() => {
            const ti = $('#roomTopicInput');
            if (ti) ti.value = topic;
          }, 200);
        }
        toast(`已从模板「${t.name}」创建房间`, 'success', 2500);
      } catch (e) {
        toast('创建失败：' + e.message, 'error');
      }
    }

    async function deleteRoomTemplate(id) {
      const t = roomTemplateState.list.find(x => x.id === id);
      if (!t || t.builtin) return;
      const ok = await confirmModal({
        title: '删除模板',
        message: `要删除模板「${t.name}」吗？此操作不可撤销（内置模板无法删除，用户模板可删）。`,
        confirmLabel: '删除',
        cancelLabel: '取消',
      });
      if (!ok) return;
      try {
        const r = await fetch(`/api/room-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(x => x.json());
        if (r.ok) {
          toast('模板已删除', 'success', 1800);
          // 重新拉
          const rr = await fetch('/api/room-templates').then(x => x.json());
          roomTemplateState.list = rr.templates || [];
          renderRoomTemplateList();
          const next = roomTemplateState.list[0];
          if (next) selectRoomTemplate(next.id);
          else $('#roomTemplateDetail').innerHTML = '<div class="muted small">没有可用模板</div>';
        } else {
          toast('删除失败：' + (r.error || 'unknown'), 'error');
        }
      } catch (e) {
        toast('删除失败：' + e.message, 'error');
      }
    }

    $('#btnRoomNewFromTemplate')?.addEventListener('click', openRoomTemplateModal);
    document.querySelectorAll('[data-close-room-template]').forEach(el => {
      el.addEventListener('click', closeRoomTemplateModal);
    });

    window.PanelRoomTemplates = {
      get roomTemplateState() { return roomTemplateState; },
      modeChip,
      openRoomTemplateModal,
      closeRoomTemplateModal,
      renderRoomTemplateList,
      renderRoomTemplateItem,
      selectRoomTemplate,
      createRoomFromTemplate,
      deleteRoomTemplate,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
