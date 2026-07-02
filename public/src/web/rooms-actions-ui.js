// @ts-check
// rooms-actions-ui.js — 房间操作群（startDebate/abortDebate/deleteRoom/pullRoomAndRender/delegateActiveRoom/addRoomRequirement）
// + 房间域全部顶层 DOM 绑定块（#btnRooms/#btnRoom*/#btnChat*/结论转发/拖放粘贴/#qaStrictSelect/#btnRoomRestart/#btnRoomResume/#roomDebateRoundsInput）
// （从 app.js 外迁；app.js 模块化第12批 2026-06-10）。绑定随 boot 只执行一次（防重复绑定）；chat 发送经 window.PanelRoomsChat 懒解析。
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, confirmModal, promptModal, api, apiCall } = core;

    async function startDebate() {
      const topic = $('#roomTopicInput').value.trim();
      if (!topic) { toast('先填任务再启动', 'warn'); return; }
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const activeRoom = window.PanelRoomsCore.roomState.activeRoom || window.PanelRoomsCore.roomState.rooms?.find(r => r.id === window.PanelRoomsCore.roomState.activeId);
      if (window.PanelRoomsCore?.isRoomRunningLike?.(activeRoom?.status)) {
        toast('当前房间已在运行中，不需要重复点击启动；如需停止请点“立即结束”。', 'info', 3000);
        return;
      }
      // v0.52 并发警告
      const running = (window.PanelRoomsCore.roomState.rooms || []).filter(r => window.PanelRoomsCore?.isRoomRunningLike?.(r.status) && r.id !== window.PanelRoomsCore.roomState.activeId).length;
      if (running >= 3) {
        const ok = await confirmModal({
          title: '⚠️ 高并发提示',
          message: `已有 ${running} 个房间在运行。同账户 LLM 高并发可能 rate limit（Claude 同账户 ~10 并发上限）。建议错开 model 池或暂停部分房。要继续启动吗？`,
          confirmLabel: '继续启动',
          cancelLabel: '取消',
        });
        if (!ok) return;
      }
      // v0.52 debate 模式才带 debateRounds；squad/chat 模式同 endpoint 仅传 topic
      const body = { topic };
      const roundsInput = $('#roomDebateRoundsInput');
      if (roundsInput && roundsInput.offsetParent !== null) {
        let n = parseInt(roundsInput.value, 10);
        if (Number.isFinite(n)) {
          n = Math.max(1, Math.min(10, n));
          body.debateRounds = n;
        }
      }
      const goalModeInput = $('#roomGoalModeInput');
      if (activeRoom?.mode === 'cross_verify') {
        body.goalMode = goalModeInput ? goalModeInput.checked : true;
      }
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/debate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(x => x.json());
        if (r.ok) {
          if (r.liveCheckDegraded) {
            const names = (r.degradedMembers || []).map(m => m.displayName || m.adapterId).filter(Boolean).join('、');
            toast(`集群已降级启动；已跳过掉线成员：${names || 'unknown'}`, 'warn', 5000);
          } else {
            toast(body.debateRounds ? `辩论已启动（${body.debateRounds} 大轮）…` : '辩论已启动…', 'info');
          }
        } else {
          await window.PanelRoomsClusterTools?.showClusterStartFailure?.(r);
          toast('启动失败：' + (window.PanelRoomsClusterTools?.clusterStartErrorSummary?.(r) ?? 'unknown'), 'error', 8000);
        }
      } catch (e) { toast('启动失败：' + e.message, 'error'); }
    }

    async function abortDebate() {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/abort`, { method: 'POST' }).then(x => x.json());
        if (r?.ok && r.aborted) toast('已发送结束信号，AI 调用收尾中…', 'info', 2500);
        else if (r?.ok) toast('当前房未在运行', 'warn', 2000);
        else toast('结束失败：' + (r?.error || ''), 'error');
      } catch (e) { toast('结束失败：' + e.message, 'error'); }
    }

    async function deleteRoom() {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const ok = await confirmModal({
        title: '🗑 删除房间',
        message: '将永久删除：房间记录 + 所有 turn / conversation / taskList / finalConsensus。\n\n此操作不可恢复，是否继续？',
        confirmLabel: '永久删除',
        cancelLabel: '取消',
        danger: true,
      });
      if (!ok) return;
      await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}`, { method: 'DELETE' });
      window.PanelRoomsCore.roomState.activeId = null;
      window.PanelRoomsCore.roomState.activeRoom = null;
      $('#roomDebate').style.display = 'none';
      $('.room-empty').style.display = '';
      window.PanelRoomsCore?.renderRoomLineage?.(null);
      await window.PanelRoomsCore?.loadRooms?.();
    }

    // v0.44 P2 #16: throttle，避免 WS 事件 burst 触发请求风暴
    // v0.45 P1-3: trailing 调用 capture activeId，房间切换后不再拉错房间
    let _pullRoomThrottle = { pending: false, timer: null, lastAt: 0 };
    async function pullRoomAndRender() {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const THROTTLE_MS = 250;
      const now = Date.now();
      const targetId = window.PanelRoomsCore.roomState.activeId; // capture，trailing 时校验
      if (now - _pullRoomThrottle.lastAt < THROTTLE_MS) {
        if (!_pullRoomThrottle.pending) {
          _pullRoomThrottle.pending = true;
          _pullRoomThrottle.timer = setTimeout(() => {
            _pullRoomThrottle.pending = false;
            _pullRoomThrottle.timer = null;
            if (window.PanelRoomsCore.roomState.activeId === targetId) pullRoomAndRender();
          }, THROTTLE_MS - (now - _pullRoomThrottle.lastAt));
        }
        return;
      }
      _pullRoomThrottle.lastAt = now;
      try {
        const r = await fetch(`/api/rooms/${targetId}`).then(x => x.json());
        if (window.PanelRoomsCore.roomState.activeId !== targetId) return; // 期间切走了
        if (r.ok && r.room) {
          window.PanelRoomsCore.roomState.activeRoom = r.room;
          window.PanelRoomsCore?.renderRoomLineage?.(r.room);
          if (r.room.mode === 'cross_verify') window.PanelRoomsDebate?.renderRoomDebate?.(r.room);
        }
        if (r.ok && r.room?.mode === 'squad') {
          window.PanelRoomsSquad?.renderSquadKanban?.(r.room.taskList || []);
        }
      } catch {}
    }

    $('#btnRooms')?.addEventListener('click', () => {
      window.PanelRoomsCore?.showRoomArea?.();
      window.PanelRoomsCore?.loadRooms?.({ autoSelectRunning: true });
    });
    $('#btnRoomBack')?.addEventListener('click', () => window.PanelRoomsCore?.hideRoomArea?.());
    $('#btnRoomNewDebate')?.addEventListener('click', () => window.PanelRoomsCore?.createRoom?.('debate'));
    $('#btnRoomNewSquad')?.addEventListener('click', () => window.PanelRoomsCore?.createRoom?.('squad'));
    $('#btnRoomNewArena')?.addEventListener('click', () => window.PanelRoomsCore?.createRoom?.('arena'));
    $('#btnRoomNewCv')?.addEventListener('click', () => window.PanelRoomsCore?.createRoom?.('cross_verify'));

    // v0.52 Sprint1-F：转发当前 finalConsensus 给新房
    // v0.56 U10：让 squad/debate/arena 也能选「全部对话历史」作为 topic（之前只能用 finalConsensus）
    document.querySelectorAll('#roomConsensusActions [data-forward]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!window.PanelRoomsCore.roomState.activeId) return;
        const targetMode = btn.dataset.forward;
        const targetLabel = { squad: 'AI 团队拆活', debate: '多模型辩论', arena: '多模型联网核对', chat: '单模型聊天' }[targetMode] || targetMode;

        // 选 seed 范围：chat 模式已经默认 seed 全部 → 不问；其他 3 个先问 scope 再问 autoStart
        let seedScope = 'all';
        if (targetMode !== 'chat') {
          const useAll = await confirmModal({
            title: `转给${targetLabel} · 用什么做 topic？`,
            message: '「全部对话历史」会把源房的完整 R1/R2/R3 讨论 + 最终结论一起 seed 进新房（信息量大，新房 AI 能看到推理过程）。「只用最终结论」更短更聚焦，但新房只看得到结论文字。',
            confirmLabel: '📚 全部对话历史（推荐）',
            cancelLabel: '📌 只用最终结论',
          });
          seedScope = useAll ? 'all' : 'final';
        }
        const autoStart = targetMode !== 'chat' && await confirmModal({
          title: `转给${targetLabel}`,
          message: `已选「${seedScope === 'all' ? '全部对话历史' : '只用最终结论'}」作为 topic。要不要立即启动？`,
          confirmLabel: '新建并立即启动',
          cancelLabel: '只新建不启动',
        });
        try {
          const r = await fetch('/api/rooms/forward', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceRoomId: window.PanelRoomsCore.roomState.activeId, targetMode, autoStart: !!autoStart, seedScope }),
          }).then(x => x.json());
          if (r?.ok && r.newRoomId) {
            toast(`已创建新${targetLabel}${r.started ? '并启动' : ''}`, 'success', 2500);
            await window.PanelRoomsCore?.loadRooms?.();
            window.PanelRoomsCore?.selectRoom?.(r.newRoomId);
          } else {
            toast('转发失败：' + (r?.error || ''), 'error');
          }
        } catch (e) { toast('转发失败：' + e.message, 'error'); }
      });
    });

    async function delegateActiveRoom() {
      if (!window.PanelRoomsCore.roomState.activeId) { toast('先选一个房间', 'warn'); return; }
      let room = window.PanelRoomsCore.roomState.activeRoom;
      if (!room || room.id !== window.PanelRoomsCore.roomState.activeId) {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}`).then(x => x.json());
        if (!r.ok) { toast('读取房间失败：' + (r.error || 'unknown'), 'error'); return; }
        room = r.room;
        window.PanelRoomsCore.roomState.activeRoom = room;
      }
      const defaultTitle = room.objective?.title || room.topic?.slice(0, 80) || room.name || '委派任务';
      const title = await promptModal({
        title: '创建跨房间委派',
        message: '给目标房间一个明确任务标题。',
        value: defaultTitle,
        placeholder: '例：把方案拆成可执行开发任务',
      });
      if (!title) return;
      const instructions = await promptModal({
        title: '委派说明',
        message: '写清楚目标房间要做什么；会自动带上来源房间、目标和 lineage。',
        value: room.finalConsensus || room.topic || room.objective?.description || '',
        placeholder: '例：基于当前共识，拆出 P0/P1 任务并给出验收标准。',
        multiline: true,
      });
      if (!instructions) return;
      const targetMode = await promptModal({
        title: '目标房间模式',
        message: '输入 chat / debate / squad / arena。Free 版如果没有 squad/arena 权限，会由后端拒绝并保留委派记录。',
        value: 'debate',
        placeholder: 'debate',
      });
      if (!targetMode) return;
      try {
        const created = await api('/api/delegations', {
          method: 'POST',
          body: JSON.stringify({
            sourceRoomId: room.id,
            sourceTaskId: room.lineage?.taskId || null,
            targetMode,
            title,
            instructions,
            payload: {
              acceptanceCriteria: room.objective?.acceptanceCriteria || [],
            },
          }),
        });
        const executed = await api(`/api/delegations/${encodeURIComponent(created.delegation.id)}/execute`, { method: 'POST' });
        toast('已创建委派房间', 'success', 2000);
        await window.PanelRoomsCore?.loadRooms?.();
        if (executed.room?.id) window.PanelRoomsCore?.selectRoom?.(executed.room.id);
      } catch (e) {
        toast('委派失败：' + e.message, 'error', 6000);
      }
    }

    $('#btnRoomNewChat')?.addEventListener('click', async () => {
      // 让用户选搭子
      const partner = await promptModal('和谁聊？（claude / codex / ollama / minimax）', 'codex');
      if (!partner) return;
      window.PanelRoomsCore?.createRoom?.('chat', partner);
    });
    $('#btnChatSend')?.addEventListener('click', () => window.PanelRoomsChat?.sendChatMessage?.());
    $('#btnChatAbort')?.addEventListener('click', () => window.PanelRoomsChat?.abortChat?.());
    // 卡⑤ session rotate：点「轮换交接」→ 后端 finalizeTurn 凝交接 → 建新房注入第一条消息 → 跳过去无缝继续
    $('#btnChatRotate')?.addEventListener('click', async () => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const ok = await confirmModal({
        title: '轮换交接',
        message: '把当前对话凝成交接总结，开一间新房无缝继续？旧房保留，可随时回看。',
        confirmLabel: '轮换',
        cancelLabel: '再聊会儿',
      });
      if (!ok) return;
      try {
        const r = await apiCall(`/api/rooms/${encodeURIComponent(window.PanelRoomsCore.roomState.activeId)}/rotate`, { method: 'POST' }, { loadingMsg: '正在生成交接…', errorPrefix: '轮换失败' });
        if (r?.ok && r.newRoomId) {
          toast('已开新房并注入交接', 'success', 2500);
          await window.PanelRoomsCore?.loadRooms?.();
          window.PanelRoomsCore?.selectRoom?.(r.newRoomId);
        }
      } catch { /* apiCall 已 toast 过错误 */ }
    });
    $('#btnChatAttach')?.addEventListener('click', () => $('#chatMediaInput')?.click());
    $('#chatMediaInput')?.addEventListener('change', (e) => {
      window.PanelRoomsChatMedia?.ingestChatMediaFiles?.([...(e.target.files || [])]);
      e.target.value = '';
    });
    $('#chatRoomInput')?.addEventListener('keydown', (e) => {
      // v0.54 Sprint 7：Enter 发送 / Shift+Enter 换行 / ⌘+Enter 也发送（兼容旧习惯）
      // IME 选字时不触发
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter') return;
      if (e.shiftKey) return;             // Shift+Enter 让 textarea 自然换行
      e.preventDefault();
      window.PanelRoomsChat?.sendChatMessage?.();
    });
    {
      const dropzone = $('#chatMediaDropzone');
      const chatInput = $('#chatRoomInput');
      const hasMediaFiles = files => [...files].some(file => window.PanelRoomsChatMedia?.isAcceptedMediaFile?.(file));
      const hasPotentialFiles = e => [...(e.dataTransfer?.types || [])].includes('Files') || hasMediaFiles(e.dataTransfer?.files || []);
      ['dragenter', 'dragover'].forEach(type => dropzone?.addEventListener(type, (e) => {
        if (!hasPotentialFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      }, true));
      ['dragleave', 'dragend'].forEach(type => dropzone?.addEventListener(type, () => {
        dropzone.classList.remove('dragover');
      }, true));
      dropzone?.addEventListener('drop', (e) => {
        const files = [...(e.dataTransfer?.files || [])];
        if (!hasMediaFiles(files)) return;
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
        window.PanelRoomsChatMedia?.ingestChatMediaFiles?.(files);
      }, true);
      chatInput?.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!hasMediaFiles(files)) return;
        e.preventDefault();
        window.PanelRoomsChatMedia?.ingestChatMediaFiles?.(files);
      }, true);
      const topicInput = $('#roomTopicInput');
      ['dragenter', 'dragover'].forEach(type => topicInput?.addEventListener(type, (e) => {
        if (!hasPotentialFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        topicInput.classList.add('dragover');
      }, true));
      ['dragleave', 'dragend'].forEach(type => topicInput?.addEventListener(type, () => {
        topicInput.classList.remove('dragover');
      }, true));
      topicInput?.addEventListener('drop', (e) => {
        const files = [...(e.dataTransfer?.files || [])];
        if (!hasMediaFiles(files)) return;
        e.preventDefault();
        e.stopPropagation();
        topicInput.classList.remove('dragover');
        window.PanelRoomsChatMedia?.ingestTaskMediaFiles?.(files, topicInput);
      }, true);
      topicInput?.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!hasMediaFiles(files)) return;
        e.preventDefault();
        window.PanelRoomsChatMedia?.ingestTaskMediaFiles?.(files, topicInput);
      }, true);
    }
    $('#qaStrictSelect')?.addEventListener('change', async (e) => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      try {
        await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qaStrictness: e.target.value }),
        });
        toast(`QA 严格度已切换到 ${e.target.value}`, 'success', 2000);
      } catch (err) { toast('切换失败：' + err.message, 'error'); }
    });
    $('#btnRoomStart')?.addEventListener('click', startDebate);
    $('#btnRoomAbort')?.addEventListener('click', abortDebate);
    $('#btnRoomDelete')?.addEventListener('click', deleteRoom);
    $('#btnDelegateRoom')?.addEventListener('click', delegateActiveRoom);
    $('#btnRoomAddRequirement')?.addEventListener('click', addRoomRequirement);
    $('#btnRoomClusterPreflight')?.addEventListener('click', () => window.PanelRoomsClusterTools?.runClusterPreflight?.());
    $('#btnRoomClusterConcurrency')?.addEventListener('click', () => window.PanelRoomsClusterTools?.showClusterConcurrencyBudget?.());
    $('#btnRoomClusterDiagnostics')?.addEventListener('click', () => window.PanelRoomsClusterTools?.showClusterDiagnostics?.());
    $('#btnRoomClusterRepair')?.addEventListener('click', () => window.PanelRoomsClusterTools?.repairClusterRuntime?.());
    $('#btnRoomDeliveryPackage')?.addEventListener('click', () => window.PanelRoomsClusterTools?.openClusterDeliveryPackage?.());
    $('#btnRoomArchiveDeliveryPackage')?.addEventListener('click', () => window.PanelRoomsClusterTools?.archiveClusterDeliveryPackage?.());

    async function addRoomRequirement() {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const content = await promptModal({
        title: '追加需求',
        message: '运行中的子进程不会被强制打断；新增需求会写入未完成阶段，后续阶段/下一轮会看到。',
        multiline: true,
        placeholder: '例如：新增存档导出功能；或：UI 必须支持横屏和平板适配。',
        confirmLabel: '追加',
        cancelLabel: '取消',
      });
      const text = String(content || '').trim();
      if (!text) return;
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/requirements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        }).then(x => x.json());
        if (!r.ok) {
          toast('追加需求失败：' + (r.error || ''), 'error', 5000);
          return;
        }
        toast(`已追加需求，影响 ${r.appliedTaskIds?.length || 0} 个未完成阶段`, 'success', 3500);
        await pullRoomAndRender();
      } catch (e) {
        toast('追加需求失败：' + (e.message || e), 'error', 5000);
      }
    }

    // v0.52 重启（清空进度重头跑）
    $('#btnRoomRestart')?.addEventListener('click', async () => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const ok = await confirmModal({
        title: '🔄 重启房间？',
        message: '会**清空当前已经跑出来的 R1/R2/R3 内容**，按当前 topic 从头重跑。继续吗？',
        confirmLabel: '重启',
        cancelLabel: '取消',
        danger: true,
      });
      if (!ok) return;
      await startDebate();   // 沿用现有 start，dispatcher.start 自然会清空 rounds
    });

    // v0.52 续跑（从未完成阶段接着跑）
    $('#btnRoomResume')?.addEventListener('click', async () => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      try {
        const activeRoom = window.PanelRoomsCore.roomState.activeRoom || window.PanelRoomsCore.roomState.rooms?.find(r => r.id === window.PanelRoomsCore.roomState.activeId);
        const body = activeRoom?.mode === 'cross_verify'
          ? { goalMode: $('#roomGoalModeInput') ? $('#roomGoalModeInput').checked : true }
          : {};
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(x => x.json());
        if (r?.ok) toast('已发送续跑信号…', 'info', 2500);
        else toast('续跑失败：' + (r?.error || ''), 'error');
      } catch (e) { toast('续跑失败：' + e.message, 'error'); }
    });

    // v0.52 debate 大轮数 change → PATCH 持久化（防误改后启动取错值）
    $('#roomDebateRoundsInput')?.addEventListener('change', async (e) => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      let n = parseInt(e.target.value, 10);
      if (!Number.isFinite(n)) n = 2;
      n = Math.max(1, Math.min(10, n));
      e.target.value = String(n);
      const startBtn = $('#btnRoomStart');
      if (startBtn && startBtn.textContent.includes('debate')) {
        startBtn.textContent = `🚀 启动辩论（${n} 大轮）`;
      }
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debateRounds: n }),
        }).then(x => x.json());
        if (r?.ok) toast(`大轮数已设为 ${n}`, 'success', 1500);
        else toast('保存失败：' + (r?.error || ''), 'error');
      } catch (err) { toast('保存失败：' + err.message, 'error'); }
    });

    // 第13批：房详情区"📂 立即归档"按钮绑定迁回房间操作属主（原 app.js 散落绑定；归档对象=当前活跃房间）
    $('#btnArchiveNow')?.addEventListener('click', async () => {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      try {
        const r = await fetch(`/api/archive/rooms/${encodeURIComponent(window.PanelRoomsCore.roomState.activeId)}`, { method: 'POST' }).then(x => x.json());
        if (r.ok) {
          toast(`已归档到 ${r.dir}（${r.files.length} 个文件）`, 'success', 5000);
        } else {
          toast('归档失败：' + (r.error || 'unknown'), 'error', 5000);
        }
      } catch (e) { toast('归档失败：' + e.message, 'error'); }
    });

    window.PanelRoomsActions = {
      startDebate,
      abortDebate,
      deleteRoom,
      pullRoomAndRender,
      delegateActiveRoom,
      addRoomRequirement,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
