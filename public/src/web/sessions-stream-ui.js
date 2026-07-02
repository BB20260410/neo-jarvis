// @ts-check
// sessions-stream-ui.js — selectSession + attachSessionWS（会话 WS 总分发）+ stderr 流式聚合 + partial 流式渲染
// + 状态/成本 chip + danger/loopGuard/focusChain banner
// （selectSession/attachSessionWS/handleStderrChunk/finalizeStderrDiv/handlePartialStart|Delta|Stop/
//   STATE_LABELS/updateStateChip/updateCostChip/refreshCostSpark/showDangerBanner/showLoopGuardBanner/showFocusChainBanner
//   + #btnDangerDismiss/#btnLoopGuardDismiss 绑定）（从 app.js 外迁；app.js 模块化第18批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 跨文件依赖全走 window 懒解析：appendMessage/renderList/showChat（PanelSessionsList）、listSessions（PanelSessionsCore）、
// showWatcherVerdict/updateWatcherToggleUI（PanelWatcher）、handleApprovalRequired（PanelApprovals）；
// 批19 留守 app.js 的 updateBusyUI/refreshCtx/refreshSnapshot/startSnapshotPolling/loadFiles/currentTab/maybeRefreshSafetyIfOpen
// 经 core 桥调用时实时取（迁走后桥改 window 懒转发）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, toast, escapeHtml, shortenPath, renderMarkdown, wsUrl } = core;

    async function selectSession(id) {
      const prevId = core.state.activeId;
      core.state.activeId = id;
      core.state.streamingDivs.clear(); // v0.15 切 session 清流式状态
      core.state.stderrCurrentDiv = null; // v0.21 切 session 清 stderr 累积
      if (core.state.ws) { try { core.state.ws.close(); } catch {} core.state.ws = null; }
      window.PanelSessionsList?.renderList?.();
      let s;
      try {
        s = await api(`/api/sessions/${id}`);
      } catch (e) {
        // 拉取失败：回滚高亮，避免 UI 卡在「列表选中但聊天区空白」的半初始化状态（原需刷新页面才恢复）
        core.state.activeId = prevId;
        window.PanelSessionsList?.renderList?.();
        toast('加载 session 失败：' + e.message, 'error');
        return;
      }
      core.state.activeCwd = s.cwd;
      // v0.51 R-14 fix: 用独立 core.state.activeStarred，确保 appendMessage 渲染 ★ 状态
      core.state.activeStarred = Array.isArray(s.starredIndices) ? s.starredIndices.slice() : [];
      // 同步到 core.state.sessions 缓存供其他地方读
      const cached = core.state.sessions.find(x => x.id === id);
      if (cached) cached.starredIndices = core.state.activeStarred;
      window.PanelSessionsList?.showChat?.();
      $('#chatOutput').innerHTML = '';
      $('#chatHeaderName').textContent = s.name;
      $('#chatHeaderInfo').textContent = shortenPath(s.cwd);
      // Main goal
      const goalEl = $('#chatHeaderGoal');
      if (s.mainGoal) {
        goalEl.textContent = '🎯 ' + s.mainGoal;
        goalEl.style.display = '';
      } else {
        goalEl.style.display = 'none';
      }
      // 状态/成本 chip 初始化
      updateStateChip(s.runState || 'idle');
      updateCostChip(s.totalUSD || 0, 0);
      // 隐藏所有 banner
      $('#dangerBanner').style.display = 'none';
      $('#loopGuardBanner').style.display = 'none';
      $('#focusChainBanner').style.display = 'none';
      $('#sessionInfo').innerHTML = `
        <div class="info-row"><strong>${escapeHtml(s.name)}</strong></div>
        <div class="info-row muted small" style="font-family:var(--mono);word-break:break-all;">${escapeHtml(shortenPath(s.cwd))}</div>
        ${s.claudeSessionId ? `<div class="info-row muted small" style="margin-top:6px;">SID: ${s.claudeSessionId.substring(0,8)}…</div>` : ''}
        <div class="info-row muted small" style="margin-top:6px;">${s.busy ? '⚡ 处理中' : '空闲'} · ${s.messages.length} 消息</div>
      `;
      if (s.messages) s.messages.forEach((m, i) => window.PanelSessionsList?.appendMessage?.(m, i));
      // 切到文件 tab 时刷新文件列表
      if (core.currentTab === 'files') core.loadFiles?.(s.cwd);
      // 加载 snapshot + meta + ctx（不论 tab 是哪个，badge 都要更新）
      core.refreshSnapshot?.();
      core.refreshCtx?.();
      core.startSnapshotPolling?.();
      window.PanelWatcher?.updateWatcherToggleUI?.();
      $('#watcherVerdictBanner').style.display = 'none'; // 切 session 关闭旧 verdict

      // v0.50 Q-03 fix: WS 自动重连（指数退避，限 5 次）
      core.state.wsReconnectAttempts = 0;
      attachSessionWS(id);
    }
    function attachSessionWS(id) {
      core.state.ws = new WebSocket(wsUrl(`/ws/${id}`));
      core.state.ws.addEventListener('close', () => {
        // 用户切走或会话被删则不重连
        if (core.state.activeId !== id) return;
        core.state.wsReconnectAttempts = (core.state.wsReconnectAttempts || 0) + 1;
        if (core.state.wsReconnectAttempts > 5) {
          toast('WS 连接丢失（已重试 5 次），刷新页面试试', 'error', 5000);
          return;
        }
        const delay = Math.min(8000, 800 * Math.pow(2, core.state.wsReconnectAttempts - 1));
        setTimeout(() => { if (core.state.activeId === id) attachSessionWS(id); }, delay);
      });
      core.state.ws.addEventListener('error', () => { /* close 会随后触发，统一在 close 处理 */ });
      core.state.ws.addEventListener('open', () => { core.state.wsReconnectAttempts = 0; });
      core.state.ws.addEventListener('message', ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'message') {
            window.PanelSessionsList?.appendMessage?.(msg.message);
          } else if (msg.type === 'messages_capped') {
            // v0.51 R-17 fix: server 截断了最前面 N 条，前端同步偏移 data-msg-idx + starredIndices
            const removed = msg.removed | 0;
            if (removed > 0) {
              // 移除最前面 removed 个 DOM 节点
              const out = $('#chatOutput');
              for (let k = 0; k < removed; k++) {
                const first = out.querySelector('.msg');
                if (first) first.remove();
              }
              // 剩余 .msg 节点的 data-msg-idx 全减 removed
              out.querySelectorAll('.msg').forEach(el => {
                const old = parseInt(el.dataset.msgIdx, 10);
                if (Number.isInteger(old)) el.dataset.msgIdx = old - removed;
              });
              // core.state.activeStarred 同步
              if (Array.isArray(core.state.activeStarred)) {
                core.state.activeStarred = core.state.activeStarred.filter(i => i >= removed).map(i => i - removed);
              }
            }
          } else if (msg.type === 'busy') {
            core.state.activeBusy = msg.busy;
            core.updateBusyUI?.();
            window.PanelSessionsCore?.listSessions?.();
            // 每次 busy 切换（一次 turn 完成）刷一次 ctx + 兜底 finalize 所有流式状态
            if (!msg.busy) {
              core.refreshCtx?.();
              finalizeStderrDiv(); // v0.21: turn 完成 → stderr div 收尾
              // v0.30 fix: partial_stop 可能丢失 → 兜底 finalize 所有 streaming div
              for (const [, div] of core.state.streamingDivs) {
                if (div && !div.classList.contains('msg-finalized')) {
                  const body = div.querySelector('.msg-body');
                  if (body) {
                    const fullText = body.dataset.rawText || body.textContent || '';
                    body.innerHTML = renderMarkdown(fullText);
                    div.dataset.fullText = fullText;
                  }
                  div.classList.remove('msg-streaming');
                  div.classList.add('msg-finalized');
                }
              }
              core.state.streamingDivs.clear();
            }
          } else if (msg.type === 'stderr') {
            handleStderrChunk(msg.data);
          } else if (msg.type === 'error') {
            window.PanelSessionsList?.appendMessage?.({ role: 'tool_use', content: `❌ 错误: ${msg.error}`, ts: new Date().toISOString() });
          } else if (msg.type === 'state_change') {
            updateStateChip(msg.state);
          } else if (msg.type === 'cost_update') {
            if (msg.snapshot) updateCostChip(msg.snapshot.totalUSD, msg.snapshot.ratePerMinute);
          } else if (msg.type === 'danger_blocked') {
            showDangerBanner(msg);
            core.maybeRefreshSafetyIfOpen?.();
          } else if (msg.type === 'approval_required') {
            window.PanelApprovals?.handleApprovalRequired?.(msg);
            core.maybeRefreshSafetyIfOpen?.();
          } else if (msg.type === 'danger_warn') {
            showDangerBanner({ ...msg, blocked: false });
            core.maybeRefreshSafetyIfOpen?.();
          } else if (msg.type === 'loop_guard_break') {
            showLoopGuardBanner(msg);
            core.maybeRefreshSafetyIfOpen?.();
          } else if (msg.type === 'focus_chain_injected') {
            showFocusChainBanner(msg);
          } else if (msg.type === 'watcher_judging') {
            toast(`👁️ ${msg.provider} 监视者分析中…`, 'info', 2500);
          } else if (msg.type === 'watcher_verdict') {
            window.PanelWatcher?.showWatcherVerdict?.(msg);
          } else if (msg.type === 'watcher_skipped') {
            toast(`👁️ 监视者跳过：${msg.reason}（${msg.limit || msg.max || ''}）`, 'warn', 3000);
          } else if (msg.type === 'watcher_error') {
            toast('👁️ 监视者出错：' + msg.error, 'error', 4000);
          } else if (msg.type === 'watcher_auto_executing') {
            toast(`🤖 监视者自动发送：${msg.prompt.slice(0, 60)}…（第 ${msg.autoPromptCount} 次）`, 'info', 4000);
          } else if (msg.type === 'partial_start') {
            handlePartialStart(msg);
          } else if (msg.type === 'partial_delta') {
            handlePartialDelta(msg);
          } else if (msg.type === 'partial_stop') {
            handlePartialStop(msg);
          }
        } catch {}
      });
    }

    // ─── v0.21 stderr 流式聚合 + 折叠 ─────
    function handleStderrChunk(chunk) {
      if (!chunk) return;
      let div = core.state.stderrCurrentDiv;
      if (!div || div.dataset.finalized === 'true') {
        div = document.createElement('div');
        div.className = 'msg msg-stderr msg-stderr-collapsed';
        div.dataset.finalized = 'false';
        div.innerHTML = `
          <button class="stderr-toggle" type="button" aria-expanded="false" aria-label="展开/折叠 stderr">
            <span class="stderr-arrow" aria-hidden="true">▶</span>
            <span class="stderr-label">⚠️ stderr</span>
            <span class="stderr-bytes">0 B</span>
            <span class="stderr-time">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </button>
          <pre class="stderr-body"></pre>
        `;
        const toggle = div.querySelector('.stderr-toggle');
        toggle.addEventListener('click', () => {
          const collapsed = div.classList.toggle('msg-stderr-collapsed');
          div.querySelector('.stderr-arrow').textContent = collapsed ? '▶' : '▼';
          toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });
        $('#chatOutput').appendChild(div);
        core.state.stderrCurrentDiv = div;
      }
      const body = div.querySelector('.stderr-body');
      // 200KB 上限：防单 turn stderr（编译日志/重试日志等）无界累积撑爆 DOM（卡顿甚至 tab OOM）
      const MAX_STDERR_CHARS = 200 * 1024;
      const merged = body.textContent + chunk;
      body.textContent = merged.length > MAX_STDERR_CHARS
        ? '…<前部已截断>\n' + merged.slice(merged.length - MAX_STDERR_CHARS)
        : merged;
      // 字节数显示（多字节字符按 byte length）
      const bytes = new Blob([body.textContent]).size;
      const fmtBytes = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
      div.querySelector('.stderr-bytes').textContent = fmtBytes;
      const out = $('#chatOutput');
      out.scrollTop = out.scrollHeight;
    }

    function finalizeStderrDiv() {
      if (core.state.stderrCurrentDiv) {
        core.state.stderrCurrentDiv.dataset.finalized = 'true';
        core.state.stderrCurrentDiv = null;
      }
    }

    // ─── v0.15 流式渲染（content_block_delta）─────
    function handlePartialStart(msg) {
      if (msg.blockType !== 'text' && msg.blockType !== 'thinking') return; // tool_use 走完整 message
      const out = $('#chatOutput');
      const div = document.createElement('div');
      div.className = 'msg msg-assistant msg-streaming';
      div.dataset.blockIndex = msg.blockIndex;
      const time = new Date(msg.ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const label = msg.blockType === 'thinking' ? 'thinking' : 'assistant';
      const icon = msg.blockType === 'thinking' ? '💭' : '🤖';
      div.innerHTML = `
        <div class="msg-head">
          <span class="msg-icon">${icon}</span>
          <span class="msg-role">${label}</span>
          <span class="msg-time">${time}</span>
        </div>
        <div class="msg-body" data-raw-text=""></div>
      `;
      out.appendChild(div);
      out.scrollTop = out.scrollHeight;
      core.state.streamingDivs.set(msg.blockIndex, div);
    }
    function handlePartialDelta(msg) {
      const div = core.state.streamingDivs.get(msg.blockIndex);
      if (!div) return;
      const body = div.querySelector('.msg-body');
      const next = (body.dataset.rawText || '') + (msg.textDelta || '');
      body.dataset.rawText = next;
      body.textContent = next; // 流式期间纯文本（避免 reflow / 减少 markdown 重渲染开销）
      const out = $('#chatOutput');
      out.scrollTop = out.scrollHeight;
    }
    function handlePartialStop(msg) {
      const div = core.state.streamingDivs.get(msg.blockIndex);
      if (!div) return;
      const body = div.querySelector('.msg-body');
      const fullText = body.dataset.rawText || msg.finalText || '';
      // 最后一次渲染 markdown（取代纯文本）
      body.innerHTML = renderMarkdown(fullText);
      div.classList.remove('msg-streaming');
      div.classList.add('msg-finalized');
      div.dataset.fullText = fullText;
      core.state.streamingDivs.delete(msg.blockIndex);
    }

    // ───── v0.5 思维镜融合：状态 / 成本 / 警告 chip & banner ─────
    const STATE_LABELS = {
      idle: '空闲', thinking: '思考中…', running: '执行中…',
      completed: '完成', error: '出错',
    };
    function updateStateChip(st) {
      const chip = $('#stateChip');
      if (!st) { chip.style.display = 'none'; return; }
      chip.style.display = 'inline-block';
      chip.textContent = STATE_LABELS[st] || st;
      chip.className = 'state-chip state-' + st;
    }
    function updateCostChip(totalUSD, ratePerMin) {
      const chip = $('#costChip');
      if (!totalUSD && !ratePerMin) { chip.style.display = 'none'; return; }
      chip.style.display = 'inline-flex';
      const rate = ratePerMin || 0;
      const txt = $('#costChipText');
      if (txt) txt.textContent = `$${totalUSD.toFixed(3)}${rate > 0 ? ` · $${rate.toFixed(3)}/min` : ''}`;
      if (rate > 0.5) chip.classList.add('cost-warn');
      else chip.classList.remove('cost-warn');
    }

    // v0.28 cost 30min mini 折线图
    async function refreshCostSpark() {
      const svg = $('#costSpark');
      const path = $('#costSparkPath');
      if (!core.state.activeId || !svg || !path) return;
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/cost-series?windowMin=30`);
        const series = (r.series || []).map(p => p.usd);
        if (series.length < 2 || series.every(v => v === 0)) {
          svg.style.display = 'none';
          return;
        }
        svg.style.display = 'inline-block';
        const w = 60, h = 14;
        const max = Math.max(...series, 0.0001);
        const points = series.map((v, i) => {
          const x = (i / (series.length - 1)) * w;
          const y = h - 1 - (v / max) * (h - 2);
          return [x, y];
        });
        // area path: 起点底 → 折线 → 终点底 close
        const d = `M 0,${h} L ${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} L ${w},${h} Z`;
        path.setAttribute('d', d);
      } catch {
        svg.style.display = 'none';
      }
    }
    function showDangerBanner(msg) {
      const banner = $('#dangerBanner');
      const text = $('#dangerBannerText');
      const blocked = msg.blocked !== false;
      const sev = msg.severity || 'high';
      const cats = (msg.hits || []).map(h => `[${h.severity}] ${h.category}: ${h.advice}`).join('；') || '危险命令';
      text.textContent = `${blocked ? '已拦截' : '检测到'} ${sev.toUpperCase()} 级危险命令：${cats}`;
      banner.style.display = 'flex';
      banner.classList.toggle('danger-critical', sev === 'critical');
    }
    function showLoopGuardBanner(msg) {
      const banner = $('#loopGuardBanner');
      const text = $('#loopGuardBannerText');
      const r = msg.reason || {};
      let label = '';
      if (r.type === 'steps_exceeded') label = `单任务步数超限（${r.current}/${r.max}），claude 可能陷入循环`;
      else if (r.type === 'repeated_instruction') label = `检测到连续 ${r.count} 次相同指令，可能在卡死`;
      else if (r.type === 'cost_surge') label = `5min 成本激增 $${r.usdInWindow}（阈值 $${r.threshold}），可能在烧钱`;
      else if (r.type === 'file_churn') label = `文件 ${r.file} 10min 内修改 ${r.churnCount} 次，可能在反复改`;
      else label = '检测到异常循环';
      text.textContent = `LoopGuard 熔断：${label}`;
      banner.style.display = 'flex';
    }
    function showFocusChainBanner(msg) {
      const banner = $('#focusChainBanner');
      const text = $('#focusChainBannerText');
      text.textContent = `Focus Chain 已注入（第 ${msg.step} 轮，每 5 轮提醒一次）`;
      banner.style.display = 'flex';
      setTimeout(() => { banner.style.display = 'none'; }, 4000);
    }

    $('#btnDangerDismiss')?.addEventListener('click', () => $('#dangerBanner').style.display = 'none');
    $('#btnLoopGuardDismiss')?.addEventListener('click', () => $('#loopGuardBanner').style.display = 'none');

    window.PanelSessionsStream = {
      selectSession,
      attachSessionWS,
      handleStderrChunk,
      finalizeStderrDiv,
      handlePartialStart,
      handlePartialDelta,
      handlePartialStop,
      STATE_LABELS,
      updateStateChip,
      updateCostChip,
      refreshCostSpark,
      showDangerBanner,
      showLoopGuardBanner,
      showFocusChainBanner,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
