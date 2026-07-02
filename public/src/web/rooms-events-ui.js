// @ts-check
// rooms-events-ui.js — 房间 WS 事件总分发 handleRoomEvent（debate/squad/arena/cross_verify/chat/cluster 全 mode）（从 app.js 外迁；app.js 模块化第12批 2026-06-10）
// 原 handleRoomEvent 单函数 523 行超 <500 函数约束 → 按 mode 机械切分为 6 个子函数 + 顶层 dispatch：
//   各 mode 事件类型互斥，子函数顺序调用与原单函数 if-chain 顺序评估观测等价，纯机械搬移零逻辑改动；
//   公共前置（connected/debate_state_meta/room_auto_paused/room_requirement_added/room_start_ignored）留在 dispatch。
// 2026-06-11 第12批b 分文件达标 <500：handleSquadEvent/handleCrossVerifyEvent/handleClusterEvent 三个零共享状态子函数
//   原样搬入 rooms-events-collab-ui.js（window.PanelRoomsEventsCollab），dispatch 与导出面改 window 懒解析/懒转发。
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, renderMarkdown, toast } = core;

    function handleRoomEvent(msg) {
      if (msg.type === 'connected') {
        if (msg.room) window.PanelRoomsDebate?.renderRoomDebate?.(msg.room);
        return;
      }
      // v0.70.2 W5+W6：debate state machine 元数据 → inspector tab 渲染
      if (msg.type === 'debate_state_meta') {
        try {
          const log = $('#debateStateLog');
          if (log) {
            // 清空首次的占位
            if (log.querySelector('.muted')) log.innerHTML = '';
            const consensusBadge = msg.consensus
              ? `<span style="color:#2da44e;font-weight:600;">✓ 共识 (score=${(msg.consensusScore || 0).toFixed(2)})</span>`
              : `<span style="color:var(--gray-mid);">分歧/继续 (score=${(msg.consensusScore || 0).toFixed(2)})</span>`;
            const evid = (msg.consensusEvidence || []).map(e => `<div style="margin-left:12px;color:var(--gray-mid);">└ ${escapeHtml(e)}</div>`).join('');
            log.insertAdjacentHTML('beforeend', `
              <div style="border-bottom:1px dashed var(--color-border-light);padding:6px 0;">
                <div><b>${escapeHtml(msg.kind)}</b> · 大轮 ${msg.macroRound} · state=${escapeHtml(msg.state)}</div>
                <div class="muted" style="font-size:11px;">${escapeHtml(msg.stateDesc || '')}</div>
                <div>${consensusBadge}</div>
                ${evid}
              </div>
            `);
            log.scrollTop = log.scrollHeight;
          }
        } catch {}
        return;
      }
      // v0.53 Sprint 3.5 自动暂停
      if (msg.type === 'room_auto_paused') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('auto_paused');
        toast(`房间已自动暂停：${msg.reason || '连续失败'}。检查 adapter 配置后可点 ▶ 续跑`, 'error', 6000);
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'room_requirement_added') {
        toast(`已追加需求，影响 ${msg.appliedTaskIds?.length || 0} 个未完成阶段`, 'success', 3500);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'room_start_ignored') {
        const reason = msg.reason === 'already_running'
          ? '房间已经在运行，重复启动请求已忽略。'
          : `启动请求已忽略：${msg.reason || 'unknown'}`;
        toast(reason, 'info', 3500);
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      // 按 mode 分发：事件类型互斥，顺序调用与原 if-chain 等价（命中后续调用均为空匹配无副作用）
      // squad/cross_verify/cluster 三子函数本体在 rooms-events-collab-ui.js，经 window 懒解析（免疫加载顺序）
      handleDebateEvent(msg);
      handleArenaEvent(msg);
      window.PanelRoomsEventsCollab?.handleSquadEvent?.(msg);
      window.PanelRoomsEventsCollab?.handleCrossVerifyEvent?.(msg);
      window.PanelRoomsEventsCollab?.handleClusterEvent?.(msg);
      handleChatEvent(msg);
    }

    // round/turn/judge 事件为 debate/arena 共用（按 msg.kind 渲染），按原 if-chain 位置归入本函数
    function handleDebateEvent(msg) {
      if (msg.type === 'debate_start') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('running');
        $('#roomRounds').innerHTML = '';
        $('#roomConsensus').style.display = 'none';
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      // v0.52 续跑
      if (msg.type === 'debate_resume') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('running');
        toast('辩论从未完成阶段续跑…', 'info', 2500);
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'round_skip') {
        // resume 跳过已完成阶段，前端不用渲染（rounds 数据已在 store 里，pullRoomAndRender 已显示）
        return;
      }
      if (msg.type === 'judge_skip') {
        return;
      }
      if (msg.type === 'round_start') {
        window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        return;
      }
      if (msg.type === 'turn_start') {
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        if (!cards) return;
        const placeholder = document.createElement('div');
        placeholder.className = 'room-turn-card speaking';
        placeholder.dataset.speaker = msg.speaker;
        placeholder.dataset.pending = '1';
        placeholder.dataset.startedAt = String(Date.now());
        placeholder.dataset.lastProgressAt = String(Date.now());
        placeholder.dataset.bytesSeen = '0';
        placeholder.innerHTML = `
          <div class="room-turn-head">
            <span class="room-turn-speaker">${escapeHtml(msg.displayName)}</span>
            <span class="room-turn-spinner" data-elapsed="1">⏳ 思考中… 00:00</span>
          </div>
          <div class="room-turn-progress" style="font-size:11px;color:#6b7280;padding:4px 12px 0;">已收 0 KB</div>
          <div class="room-turn-content"></div>`;
        cards.appendChild(placeholder);
        window.PanelRoomsMembers?.startElapsedTicker?.();
        return;
      }
      if (msg.type === 'turn_progress') {
        // v0.52 spawn 收到 stdout 时更新"已收 X KB / Y 秒前"
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        if (!cards) return;
        const safeSpeaker = (window.CSS && CSS.escape) ? CSS.escape(msg.speaker) : msg.speaker;
        const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${safeSpeaker}"][data-pending]`);
        if (placeholder) {
          placeholder.dataset.lastProgressAt = String(Date.now());
          placeholder.dataset.bytesSeen = String(msg.bytes || 0);
          const kb = ((msg.bytes || 0) / 1024).toFixed(1);
          const progEl = placeholder.querySelector('.room-turn-progress');
          if (progEl) {
            progEl.textContent = `已收 ${kb} KB`;
            progEl.style.color = '#6b7280';
          }
          placeholder.classList.remove('stalled');
        }
        return;
      }
      if (msg.type === 'turn_done') {
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        if (!cards) return;
        const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${msg.speaker}"][data-pending]`);
        const real = window.PanelRoomsDebate?.renderTurnCard?.(msg, msg.kind);
        if (placeholder) placeholder.replaceWith(real); else cards.appendChild(real);
        // v0.52 Sprint1-D: 重试成功也走 turn_done，但要把"以前的 error 卡"也替换掉
        if (msg.retry) {
          const oldErr = cards.querySelector(`.room-turn-card.error[data-speaker="${msg.speaker}"]`);
          if (oldErr && oldErr !== placeholder) oldErr.replaceWith(real.cloneNode(true));
        }
        window.PanelRoomsMembers?.maybeStopElapsedTicker?.();
        return;
      }
      if (msg.type === 'turn_error') {
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        if (!cards) return;
        const placeholder = cards.querySelector(`.room-turn-card[data-speaker="${msg.speaker}"][data-pending]`);
        const elapsed = placeholder ? Math.floor((Date.now() - parseInt(placeholder.dataset.startedAt || '0', 10)) / 1000) : 0;
        const real = window.PanelRoomsDebate?.renderTurnCard?.({
          speaker: msg.speaker,
          displayName: msg.displayName || msg.speaker,
          content: `❌ ${msg.error || '失败'}${elapsed ? `（耗时 ${window.PanelRoomsMembers?.formatElapsed?.(elapsed)}）` : ''}`,
          error: true,
        }, msg.kind);
        if (placeholder) placeholder.replaceWith(real); else cards.appendChild(real);
        window.PanelRoomsMembers?.maybeStopElapsedTicker?.();
        return;
      }
      // v0.52 Sprint1-D 局部重试启动
      if (msg.type === 'turn_retry_start') {
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.(msg.kind);
        if (!cards) return;
        const safeSpeaker = (window.CSS && CSS.escape) ? CSS.escape(msg.speaker) : msg.speaker;
        const oldErr = cards.querySelector(`.room-turn-card.error[data-speaker="${safeSpeaker}"]`);
        const placeholder = document.createElement('div');
        placeholder.className = 'room-turn-card speaking';
        placeholder.dataset.speaker = msg.speaker;
        placeholder.dataset.pending = '1';
        placeholder.dataset.startedAt = String(Date.now());
        placeholder.dataset.lastProgressAt = String(Date.now());
        placeholder.innerHTML = `
          <div class="room-turn-head">
            <span class="room-turn-speaker">${escapeHtml(msg.displayName || msg.speaker)}</span>
            <span class="room-turn-spinner" data-elapsed="1" data-label="重试中">⏳ 重试中… 00:00</span>
          </div>
          <div class="room-turn-progress" style="font-size:11px;color:#6b7280;padding:4px 12px 0;">已收 0 KB</div>
          <div class="room-turn-content"></div>`;
        if (oldErr) oldErr.replaceWith(placeholder); else cards.appendChild(placeholder);
        window.PanelRoomsMembers?.startElapsedTicker?.();
        return;
      }
      if (msg.type === 'round_done') {
        return;
      }
      if (msg.type === 'judge_start') {
        window.PanelRoomsDebate?.ensureRoundCard?.('r4_judge');
        return;
      }
      if (msg.type === 'judge_done') {
        $('#roomConsensus').style.display = 'flex';
        $('#roomConsensusBody').innerHTML = renderMarkdown(msg.content || '');
        // 也补 round card
        const cards = window.PanelRoomsDebate?.ensureRoundCard?.('r4_judge');
        if (cards) cards.appendChild(window.PanelRoomsDebate?.renderTurnCard?.({ speaker: 'claude', displayName: '🟣 Claude（主持）', content: msg.content }));
        return;
      }
      if (msg.type === 'judge_error') {
        toast('主持总结失败：' + msg.error, 'error');
        return;
      }
      if (msg.type === 'debate_done') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('done');
        toast('辩论完成 🎯', 'success', 3000);
        window.PanelRoomsCore?.loadRooms?.();   // 刷新房间列表 + 运行中指示器
        return;
      }
      if (msg.type === 'debate_paused') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('paused');
        toast('辩论已暂停', 'info');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'debate_error') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('error');
        toast('辩论出错：' + msg.error, 'error');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
    }

    function handleArenaEvent(msg) {
      // v0.52 Sprint1-A Arena 事件
      if (msg.type === 'arena_start') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('running');
        $('#roomRounds').innerHTML = '';
        $('#roomConsensus').style.display = 'none';
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'arena_done') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('done');
        toast('对决完成 🏟', 'success', 3000);
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'arena_paused') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('paused');
        toast('对决已暂停', 'info');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'arena_error') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('error');
        toast('对决出错：' + msg.error, 'error');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
    }

    function handleChatEvent(msg) {
      // v0.48 chat 事件
      if (msg.type === 'chat_user_msg') {
        const wrap = $('#chatRoomMessages');
        if (!wrap) return;
        const empty = wrap.querySelector('.chat-room-empty');
        if (empty) empty.remove();
        wrap.appendChild(window.PanelRoomsChat?.buildChatMessageEl?.(msg.message));
        wrap.scrollTop = wrap.scrollHeight;
        return;
      }
      if (msg.type === 'chat_thinking') {
        const wrap = $('#chatRoomMessages');
        if (!wrap) return;
        wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
        const placeholder = window.PanelRoomsChat?.buildChatMessageEl?.({
          from: msg.member, displayName: msg.displayName, content: '', thinking: true, at: new Date().toISOString(),
        });
        wrap.appendChild(placeholder);
        wrap.scrollTop = wrap.scrollHeight;
        return;
      }
      if (msg.type === 'chat_ai_msg') {
        const wrap = $('#chatRoomMessages');
        if (!wrap) return;
        wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
        wrap.appendChild(window.PanelRoomsChat?.buildChatMessageEl?.(msg.message));
        wrap.scrollTop = wrap.scrollHeight;
        $('#btnChatAbort').style.display = 'none';
        return;
      }
      if (msg.type === 'chat_error') {
        const wrap = $('#chatRoomMessages');
        if (wrap) {
          wrap.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
          if (msg.message) wrap.appendChild(window.PanelRoomsChat?.buildChatMessageEl?.(msg.message));
        }
        $('#btnChatAbort').style.display = 'none';
        toast('chat 失败：' + msg.error, 'error', 4000);
        return;
      }
      if (msg.type === 'chat_aborted') {
        $('#chatRoomMessages')?.querySelectorAll('[data-thinking="1"]').forEach(el => el.remove());
        $('#btnChatAbort').style.display = 'none';
        toast('已中断 AI 思考', 'info', 2000);
        return;
      }
      // 卡⑤ session rotate：对话超 token 阈值 → 亮"轮换交接"按钮并提示一次
      if (msg.type === 'chat_rotate_suggested') {
        const rotateBtn = $('#btnChatRotate');
        if (rotateBtn) rotateBtn.style.display = 'inline-flex';
        toast(`对话已较长（约 ${Math.round((msg.tokens || 0) / 1000)}k token），建议点「🔁 轮换交接」开新房继续`, 'info', 6000);
        return;
      }
    }

    window.PanelRoomsEvents = {
      handleRoomEvent,
      handleDebateEvent,
      handleArenaEvent,
      // 三子函数本体已搬 rooms-events-collab-ui.js，导出面保留懒转发兼容旧引用
      handleSquadEvent: (...a) => window.PanelRoomsEventsCollab?.handleSquadEvent?.(...a),
      handleCrossVerifyEvent: (...a) => window.PanelRoomsEventsCollab?.handleCrossVerifyEvent?.(...a),
      handleClusterEvent: (...a) => window.PanelRoomsEventsCollab?.handleClusterEvent?.(...a),
      handleChatEvent,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
