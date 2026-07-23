// @ts-check
// rooms-events-collab-ui.js — 房间 WS 事件协作域子分发（squad/cross_verify/cluster 三 mode）（从 rooms-events-ui.js 分文件；app.js 模块化第12批b 2026-06-11）
// rooms-events-ui.js 585 行超 <500 文件约束 → 把零共享状态的 3 个独立子函数原样搬入本文件（纯机械搬移零逻辑改动）：
//   handleSquadEvent / handleCrossVerifyEvent / handleClusterEvent。dispatch 仍在 rooms-events-ui.js，
//   经 window.PanelRoomsEventsCollab 懒解析调用（与全仓桥模式一致，免疫加载顺序）。
// ⚠️ 原样保留（行为零变化铁律）：handleSquadEvent 第二个 squad_start 块本就是死分支；task_escalated 无 return 的
//   fall-through 与原文件一致（后续类型不匹配，无副作用）。
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, renderMarkdown, toast } = core;

    function handleSquadEvent(msg) {
      // v0.41 squad events
      if (msg.type === 'squad_start') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('running');
        $('#squadBoard').style.display = 'flex';
        $('#roomRounds').style.display = 'none';
        $('#roomConsensus').style.display = 'none';
        for (const c of (window.PanelRoomsSquad?.SQUAD_COLS || [])) {
          const col = $('#squadCol' + c.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
          if (col) col.innerHTML = '';
        }
        return;
      }
      if (msg.type === 'pm_planning') {
        toast(`PM(${msg.pm}) 正在拆任务...`, 'info', 2500);
        return;
      }
      if (msg.type === 'plan_done') {
        toast(`PM 拆出 ${msg.taskList.length} 个任务`, 'success', 2500);
        window.PanelRoomsSquad?.renderSquadKanban?.(msg.taskList);
        return;
      }
      if (msg.type === 'plan_cycle_fixed') {
        toast(`PM 输出有依赖环，已退化成线性`, 'warn', 3000);
        return;
      }
      if (msg.type === 'batch_start') {
        return;
      }
      if (msg.type === 'task_dev_start') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.set(msg.taskId, { phase: 'dev', start: Date.now(), who: msg.dev || 'Dev' });
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'task_dev_done') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.delete(msg.taskId);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'task_qa_start') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.set(msg.taskId, { phase: 'qa', start: Date.now(), who: msg.qa || 'QA' });
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'task_qa_done') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.delete(msg.taskId);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        if (msg.review?.verdict === 'reject') {
          toast(`${msg.taskId} 被 ${msg.by} 打回（第 ${msg.iteration} 次审查）`, 'warn', 3000);
        } else if (msg.review?.verdict === 'pass') {
          toast(`${msg.taskId} ✅ 通过审查`, 'success', 2500);
        }
        return;
      }
      if (msg.type === 'task_done') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.delete(msg.taskId);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'task_escalated') {
        window.PanelRoomsSquad?._squadTaskStartedAt?.delete(msg.taskId);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        toast(`${msg.taskId} ⚠️ 已搁置（${msg.reason}）— task 跑失败需要人工介入，可在卡片上点重试`, 'error', 5000);
      }
      // v0.54 Sprint 6：squad 单 task 重试事件
      if (msg.type === 'task_retry_start') {
        const cascaded = msg.cascadedCount ? `（含 ${msg.cascadedCount} 个被牵连下游）` : '';
        toast(`🔄 ${msg.taskId} 开始重试${cascaded}…`, 'info', 3500);
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'task_retry_error') {
        toast(`${msg.taskId} 重试失败：${msg.error || 'unknown'}`, 'error', 5000);
        return;
      }
      if (msg.type === 'final_summary_start') {
        toast('PM 正在总结最终交付...', 'info', 2500);
        return;
      }
      if (msg.type === 'final_summary_done') {
        $('#roomConsensus').style.display = 'flex';
        $('#roomConsensusBody').innerHTML = renderMarkdown(msg.content || '');
        return;
      }
      if (msg.type === 'squad_done') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('done');
        // P1#6 完成后告知产物路径:用户能看到/复制 cwd,Finder/IDE 直接定位产物
        const cwd = window.PanelRoomsCore.roomState?.activeRoom?.cwd || '';
        const msg1 = cwd ? `小组协作完成 🎯 产物在: ${cwd}` : '小组协作完成 🎯';
        toast(msg1, 'success', 8000); // 8s 让用户看清路径
        if (cwd && navigator.clipboard?.writeText) {
          // 路径复制到剪贴板,用户 cmd+v 直接粘到 Terminal/Finder
          navigator.clipboard.writeText(cwd).catch(() => {});
        }
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'squad_paused') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('paused');
        toast('小组已暂停', 'info');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'squad_error') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('error');
        toast('小组出错：' + msg.error, 'error');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'squad_start') {
        window.PanelRoomsCore?.loadRooms?.();
      }
    }

    function handleCrossVerifyEvent(msg) {
      // 集群协同(cross_verify)WS 事件
      if (msg.type === 'cross_verify_start') {
        toast('🤝 集群协同开启 — 成员并行写方案中...', 'info', 4000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_round_start') {
        toast(`Round ${msg.round}: ${msg.memberCount || 2} 个成员并行写方案 + 互审中...`, 'info', 3500);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_propose_done') {
        const lens = msg.planLens ? Object.entries(msg.planLens).map(([id, n]) => `${id}:${n}`).join(' / ') : `planA ${msg.planALen} / planB ${msg.planBLen}`;
        toast(`Round ${msg.round}: 集群方案已出 (${lens} chars),互审中`, 'info', 3000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_review_done') {
        const a = msg.agreeA ? '✅' : '❌';
        const b = msg.agreeB ? '✅' : '❌';
        const ok = msg.totalMembers ? msg.agreeCount === msg.totalMembers : (msg.agreeA && msg.agreeB);
        const label = msg.totalMembers ? `${msg.agreeCount}/${msg.totalMembers} 同意` : `A${a} B${b}`;
        toast(`Round ${msg.round} 集群互审: ${label}`, ok ? 'success' : 'warn', 3500);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_consensus') {
        toast(`🎯 Round ${msg.round} 集群全员互签一致 → task ${msg.taskId} 完成`, 'success', 4500);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_disagree') {
        const aReason = (msg.ackA?.reasoning || '').slice(0, 60);
        const bReason = (msg.ackB?.reasoning || '').slice(0, 60);
        const count = msg.totalMembers ? `${msg.agreeCount}/${msg.totalMembers} 同意。` : '';
        toast(`Round ${msg.round} 集群未达成一致,进下一轮。${count}A:${aReason} | B:${bReason}`, 'warn', 5000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_quality_gate_repair') {
        const reason = (msg.reason || '代码驱动证据不足').slice(0, 120);
        toast(`🧯 ${msg.taskId} 质量门未过,自动进入第 ${msg.nextRound || '?'} 轮修复: ${reason}`, 'warn', 7000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_quality_gate_resume') {
        const reason = (msg.reason || '继续修复质量门失败项').slice(0, 140);
        toast(`↻ ${msg.taskId} 从质量门失败处续跑: ${reason}`, 'info', 7000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_acceptance_remediation') {
        const reason = (msg.reason || '自动验收未通过,回到失败阶段补救').slice(0, 150);
        toast(`↩ 交付验收触发返工: ${reason}`, 'warn', 8000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_acceptance_auto_rework') {
        const reason = (msg.reason || '验收失败后自动返工').slice(0, 150);
        toast(`🔁 自动返工 ${msg.pass || '?'} / ${msg.maxPasses || '?'}: ${reason}`, 'warn', 9000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_goal_mode_rework') {
        const reason = (msg.message || '目标未完成,继续自动返工').slice(0, 180);
        toast(`🎯 目标模式继续执行: ${reason}`, 'warn', 10000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cv_quality_gate_failed') {
        const reason = (msg.reason || '关键阶段质量门未通过').slice(0, 160);
        toast(`🛑 ${msg.taskId} 质量门失败,已阻断后续阶段: ${reason}`, 'error', 9000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'cv_escalated') {
        toast(`⚠️ ${msg.maxRounds} 轮集群未达成一致,task ${msg.taskId} 升级等用户裁定`, 'error', 6000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cross_verify_done') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('done');
        const cwd = window.PanelRoomsCore.roomState?.activeRoom?.cwd || '';
        const text = cwd ? `🎯 集群协同完成 产物在: ${cwd}` : '🎯 集群协同完成';
        toast(text, 'success', 8000);
        if (cwd && navigator.clipboard?.writeText) navigator.clipboard.writeText(cwd).catch(() => {});
        window.PanelRoomsActions?.pullRoomAndRender?.();
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'cross_verify_paused') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('paused');
        const reason = msg.reason === 'quality_gate_failed'
          ? `质量门失败: ${(msg.error || '关键阶段证据不足').slice(0, 140)}`
          : '可点 ↻ 续跑';
        toast(`集群协同已暂停 — ${reason}`, msg.reason === 'quality_gate_failed' ? 'error' : 'info', 8000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
      if (msg.type === 'cross_verify_error') {
        window.PanelRoomsMembers?.updateRoomStatusChip?.('error');
        toast('集群协同出错: ' + msg.error, 'error');
        window.PanelRoomsCore?.loadRooms?.();
        return;
      }
    }

    function handleClusterEvent(msg) {
      if (msg.type === 'cluster_runtime_metric') {
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cluster_runtime_output') {
        if (window.PanelRoomsCore.roomState.activeRoom && msg.output) {
          const prev = Array.isArray(window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput) ? window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput : [];
          window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput = [...prev, msg.output].slice(-160);
          const list = document.querySelector('[data-runtime-output]');
          if (list) list.innerHTML = window.PanelRoomsClusterLive?.renderClusterRuntimeOutputRows?.(window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput) ?? '';
          const badge = document.querySelector('.cluster-runtime-output-head span');
          if (badge) badge.textContent = `最近 ${window.PanelRoomsCore.roomState.activeRoom.clusterRuntimeOutput.length} 条`;
        }
        return;
      }
      if (msg.type === 'cluster_evidence_auto_linked') {
        const stage = msg.stageLabel || msg.stageId || '代码驱动阶段';
        toast(`🔗 ${stage} 已自动绑定 Agent Run 证据 ${msg.evidenceCount || 0} 项`, 'success', 5000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
      if (msg.type === 'cluster_delivery_ready') {
        toast(`✅ 集群协同交付门禁已通过，交付包 ${msg.packageStatus || 'ready'}`, 'success', 7000);
        window.PanelRoomsActions?.pullRoomAndRender?.();
        return;
      }
    }

    window.PanelRoomsEventsCollab = {
      handleSquadEvent,
      handleCrossVerifyEvent,
      handleClusterEvent,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
