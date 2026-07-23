// @ts-check
// rooms-debate-ui.js — 辩论渲染 + 轮次卡（renderRoomDebate/ROUND_TITLES/getRoundTitle/renderRounds/getCurrentRoomStatus/renderTurnCard/retryTurn/ensureRoundCard + 全局 Esc 结束辩论）（从 app.js 外迁；app.js 模块化第11批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, renderMarkdown, toast } = core;

    function renderRoomDebate(room) {
      window.PanelRoomsCore.roomState.activeRoom = room || null;
      $('#roomDebate').style.display = 'flex';
      $('.room-empty').style.display = 'none';
      window.PanelRoomsCore?.renderRoomLineage?.(room);
      $('#roomNameDisplay').textContent = (room.name || '未命名') + (
        room.mode === 'squad' ? '  · 团队拆活' :
        room.mode === 'chat'  ? '  · 单聊'  :
        room.mode === 'arena' ? '  · 联网核对'  :
        room.mode === 'cross_verify' ? '  · 集群协同' :
        '  · 辩论'
      );
      {
        const _topicTa = $('#roomTopicInput');
        _topicTa.value = room.topic || '';
        _topicTa.dispatchEvent(new Event('input', { bubbles: false }));
      }
      window.PanelRoomsMembers?.updateRoomStatusChip?.(room.status);
      window.PanelRoomsMembers?.renderRoomMembers?.(room);
      window.PanelRoomsMembers?.renderRoomSkillBindings?.(room);
      // v0.41/v0.48 按 mode 切换视图
      const isSquad = room.mode === 'squad';
      const isChat = room.mode === 'chat';
      const isCrossVerify = room.mode === 'cross_verify';
      $('#squadBoard').style.display = isSquad ? 'flex' : 'none';
      $('#roomRounds').style.display = (isSquad || isChat || isCrossVerify) ? 'none' : 'flex';
      $('#chatRoom').style.display = isChat ? 'flex' : 'none';
      // chat 模式隐藏任务输入区（chat 直接在底部输入框）
      const topicWrap = document.querySelector('.room-topic-wrap');
      if (topicWrap) topicWrap.style.display = isChat ? 'none' : 'flex';
      // v0.52 大轮数控件仅 debate 模式显示，并回填 room.debateRounds
      const roundsWrap = $('#roomDebateRoundsWrap');
      const roundsInput = $('#roomDebateRoundsInput');
      if (roundsWrap) roundsWrap.style.display = (!isSquad && !isChat && !isCrossVerify) ? 'flex' : 'none';
      if (roundsInput) {
        let n = parseInt(room.debateRounds, 10);
        if (!Number.isFinite(n)) n = 2;
        n = Math.max(1, Math.min(10, n));
        roundsInput.value = String(n);
      }
      const goalModeWrap = $('#roomGoalModeWrap');
      const goalModeInput = $('#roomGoalModeInput');
      if (goalModeWrap) goalModeWrap.style.display = isCrossVerify ? 'inline-flex' : 'none';
      if (goalModeInput) goalModeInput.checked = room.goalMode?.enabled !== false;
      // 启动按钮文案：debate / arena / squad
      const isArena = room.mode === 'arena';
      const startBtn = $('#btnRoomStart');
      if (startBtn) {
        const isRunningRoom = window.PanelRoomsCore?.isRoomRunningLike?.(room.status);
        startBtn.disabled = isRunningRoom;
        if (isRunningRoom) startBtn.textContent = '⏳ 集群协同运行中';
        else if (isSquad) startBtn.textContent = '🚀 启动小组';
        else if (isArena) startBtn.textContent = '🏟 启动对决';
        else if (isCrossVerify) startBtn.textContent = '🤝 启动集群协同';
        else if (!isChat) startBtn.textContent = `🚀 启动辩论（${roundsInput?.value || 2} 大轮）`;
      }
      // arena 房不需要"大轮数"控件
      if (roundsWrap && isArena) roundsWrap.style.display = 'none';
      // v0.42 QA 严格度下拉，仅 squad 房显示
      const qaLabel = $('#qaStrictLabel');
      if (qaLabel) {
        qaLabel.style.display = isSquad ? 'inline-flex' : 'none';
        const sel = $('#qaStrictSelect');
        if (sel) sel.value = room.qaStrictness || 'standard';
      }
      if (isChat) {
        core.renderChatRoom(room);
        $('#roomConsensusHead').textContent = '';
        $('#roomConsensus').style.display = 'none';
      } else if (isSquad) {
        window.PanelRoomsSquad?.renderSquadKanban?.(room.taskList || []);
        $('#roomConsensusHead').textContent = '🎯 最终交付（PM 总结）';
      } else if (isArena) {
        renderRounds(room.rounds || []);
        $('#roomConsensusHead').textContent = '🌐 统一最优意见（已联网核对）';
      } else if (isCrossVerify) {
        $('#roomConsensusHead').textContent = '🤝 集群协同共识';
      } else {
        renderRounds(room.rounds || []);
        $('#roomConsensusHead').textContent = '🎯 最终共识方案（Claude 主持）';
      }
      const consensusContent = room.finalConsensus || (isCrossVerify ? (window.PanelRoomsClusterLive?.renderCrossVerifyConsensusMarkdown?.(room) ?? '') : '');
      if (consensusContent || isCrossVerify) {
        $('#roomConsensus').style.display = 'flex';
        // v0.45 P2: 读 finalDegraded 字段加 banner
        const degradedBadge = room.finalDegraded ? '<div class="final-degraded-badge">⚠️ Judge 失败，下面是 R3 三方终稿降级合并</div>' : '';
        $('#roomConsensusBody').innerHTML = degradedBadge + renderMarkdown(consensusContent || '');
        if (isCrossVerify) window.PanelRoomsClusterLive?.renderClusterRuntimeLivePanel?.(room);
      } else {
        $('#roomConsensus').style.display = 'none';
      }
      const deliveryBtn = $('#btnRoomDeliveryPackage');
      const preflightBtn = $('#btnRoomClusterPreflight');
      const concurrencyBtn = $('#btnRoomClusterConcurrency');
      const diagnosticsBtn = $('#btnRoomClusterDiagnostics');
      const repairBtn = $('#btnRoomClusterRepair');
      const addRequirementBtn = $('#btnRoomAddRequirement');
      if (preflightBtn) {
        preflightBtn.style.display = isCrossVerify ? 'inline-flex' : 'none';
        preflightBtn.disabled = !isCrossVerify;
      }
      if (concurrencyBtn) {
        concurrencyBtn.style.display = isCrossVerify ? 'inline-flex' : 'none';
        concurrencyBtn.disabled = !isCrossVerify;
      }
      if (diagnosticsBtn) {
        diagnosticsBtn.style.display = isCrossVerify ? 'inline-flex' : 'none';
        diagnosticsBtn.disabled = !isCrossVerify;
      }
      if (repairBtn) {
        repairBtn.style.display = isCrossVerify ? 'inline-flex' : 'none';
        repairBtn.disabled = !isCrossVerify;
      }
      if (addRequirementBtn) {
        addRequirementBtn.style.display = (isCrossVerify || isSquad) ? 'inline-flex' : 'none';
        addRequirementBtn.disabled = !(isCrossVerify || isSquad);
      }
      const showClusterDeliveryPackage = Boolean(room.clusterDeliveryPackage) && !window.PanelRoomsCore?.isRoomRunningLike?.(room.status);
      if (deliveryBtn) {
        deliveryBtn.style.display = showClusterDeliveryPackage ? 'inline-flex' : 'none';
        deliveryBtn.disabled = !showClusterDeliveryPackage;
        deliveryBtn.title = showClusterDeliveryPackage
          ? `打开集群协同交付包：${room.clusterDeliveryPackage.status || 'unknown'}`
          : window.PanelRoomsCore?.isRoomRunningLike?.(room.status)
            ? '集群协同运行中，旧交付包已隐藏，等待本轮完成后重新生成'
            : '当前房间暂无集群协同交付包';
      }
      const archiveDeliveryBtn = $('#btnRoomArchiveDeliveryPackage');
      if (archiveDeliveryBtn) {
        archiveDeliveryBtn.style.display = showClusterDeliveryPackage ? 'inline-flex' : 'none';
        archiveDeliveryBtn.disabled = !showClusterDeliveryPackage;
        archiveDeliveryBtn.title = room.clusterDeliveryArchive
          ? `最近归档：${room.clusterDeliveryArchive.archiveDir || room.clusterDeliveryArchive.id || ''}`
          : '把集群协同最终交付包写入项目归档目录';
      }
    }

    // v0.52 全局 Esc：聊天室区域可见时按 Esc 触发结束
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 仅当房间区域可见 + 当前房 status=running 时生效
      const roomArea = $('#roomArea');
      if (!roomArea || roomArea.style.display === 'none') return;
      const abortBtn = $('#btnRoomAbort');
      if (!abortBtn || abortBtn.style.display === 'none') return;
      // 输入框焦点时不抢（Esc 让用户取消输入）
      const t = document.activeElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      e.preventDefault();
      core.abortDebate();
    });

    // v0.52 兼容 kind 带 `@<n>` 后缀（多大轮 debate）；老房间 kind 无后缀按大轮 1 渲染
    const ROUND_TITLES = {
      r1_propose: '第 1 阶段 · 独立提案',
      r2_critique: '第 2 阶段 · 互评修订',
      r3_final: '第 3 阶段 · 终稿表态',
      r4_judge: '主持总结',
      proposals: '🏟 各方独立提案（匿名）',     // v0.52 Sprint1-A Arena
      arena_judge: '🌐 联网核对 + 综合最优',
    };
    function getRoundTitle(kind) {
      const m = /^(r[123])_(propose|critique|final)@(\d+)$/.exec(kind);
      if (m) {
        const base = `${m[1]}_${m[2]}`;
        return `第 ${m[3]} 大轮 · ${ROUND_TITLES[base] || base}`;
      }
      // 老 kind：r1_propose / r2_critique / r3_final / r4_judge
      return ROUND_TITLES[kind] || kind;
    }

    function renderRounds(rounds) {
      const wrap = $('#roomRounds');
      wrap.innerHTML = '';
      for (const round of rounds) {
        const card = document.createElement('div');
        card.className = 'room-round';
        card.dataset.kind = round.kind;
        card.innerHTML = `
          <div class="room-round-head">${escapeHtml(getRoundTitle(round.kind))}</div>
          <div class="room-round-cards"></div>`;
        const cardsWrap = card.querySelector('.room-round-cards');
        for (const t of (round.turns || [])) cardsWrap.appendChild(renderTurnCard(t, round.kind));
        wrap.appendChild(card);
      }
    }

    // v0.54 Sprint 4.1：拿当前 active room status（从 chip className 读，跟 WS 实时同步）
    function getCurrentRoomStatus() {
      const chip = $('#roomStatusChip');
      if (!chip) return null;
      // className 形如 "room-status-chip running"
      const m = chip.className.match(/\b(idle|running|paused|done|error|auto_paused)\b/);
      return m ? m[1] : null;
    }

    function renderTurnCard(turn, kind) {
      const div = document.createElement('div');
      div.className = 'room-turn-card' + (turn.error ? ' error' : '');
      div.dataset.speaker = turn.speaker;
      // v0.52 Sprint1-D error 卡片右上加重试按钮
      // v0.54 Sprint 4.1：房间 running 时按钮 disabled + 解释（dispatcher 不允许 running 状态局部重试，防数据竞争）
      const isRunning = getCurrentRoomStatus() === 'running';
      const retryBtn = turn.error
        ? (isRunning
            ? `<button class="room-turn-retry" disabled title="房间正在跑后续 round，等跑完或手动暂停后再重试">⏸ 等房暂停</button>`
            : `<button class="room-turn-retry" data-kind="${escapeHtml(kind || '')}" data-speaker="${escapeHtml(turn.speaker)}" title="只重跑这一个 AI，不影响其他成员">🔄 重试这个</button>`)
        : '';
      div.innerHTML = `
        <div class="room-turn-head">
          <span class="room-turn-speaker">${escapeHtml(turn.displayName)}</span>
          ${turn.tokensOut ? `<span class="room-turn-tokens">${turn.tokensOut} tok</span>` : ''}
          ${retryBtn}
          <button class="room-turn-expand" title="全屏展开看完整内容">⤢</button>
        </div>
        <div class="room-turn-content"></div>`;
      div.querySelector('.room-turn-content').innerHTML = renderMarkdown(turn.content || '');
      const btn = div.querySelector('.room-turn-retry');
      if (btn) btn.addEventListener('click', (e) => {
        e.stopPropagation();
        retryTurn(btn.dataset.kind, btn.dataset.speaker);
      });
      return div;
    }

    async function retryTurn(kind, speaker) {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/retry-turn`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, speaker }),
        }).then(x => x.json());
        if (r?.ok) toast('已重试，等待新输出…', 'info', 2000);
        else toast('重试失败：' + (r?.error || ''), 'error');
      } catch (e) { toast('重试失败：' + e.message, 'error'); }
    }

    function ensureRoundCard(kind) {
      // v0.52 kind 可能含 `@`（如 r1_propose@2），用 CSS.escape 安全选属性
      const safeKind = (window.CSS && CSS.escape) ? CSS.escape(kind) : kind;
      let card = $(`#roomRounds .room-round[data-kind="${safeKind}"]`);
      if (!card) {
        const wrap = $('#roomRounds');
        card = document.createElement('div');
        card.className = 'room-round';
        card.dataset.kind = kind;
        card.innerHTML = `
          <div class="room-round-head">${escapeHtml(getRoundTitle(kind))}</div>
          <div class="room-round-cards"></div>`;
        wrap.appendChild(card);
      }
      return card.querySelector('.room-round-cards');
    }

    window.PanelRoomsDebate = {
      ROUND_TITLES,
      renderRoomDebate,
      getRoundTitle,
      renderRounds,
      getCurrentRoomStatus,
      renderTurnCard,
      retryTurn,
      ensureRoundCard,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
