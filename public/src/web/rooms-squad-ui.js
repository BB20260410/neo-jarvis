// @ts-check
// rooms-squad-ui.js — Squad 看板 + 任务详情抽屉（SQUAD_COLS/squadCurrentTasks/_squadTaskStartedAt/renderSquadKanban/retrySquadTask/openSquadDetail）（从 app.js 外迁；app.js 模块化第11批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, escapeHtmlMl, renderMarkdown, toast, confirmModal } = core;

    // ===== v0.41 Squad Kanban 渲染 + 详情抽屉 =====
    const SQUAD_COLS = ['pending', 'in_progress', 'in_review', 'done', 'escalated'];
    let squadCurrentTasks = []; // 缓存最新 taskList 用于抽屉
    // v0.52 task 进入 in_progress/in_review 的起始时间（看板 elapsed 计时用）
    const _squadTaskStartedAt = new Map(); // taskId → { phase: 'dev'|'qa', start: Date.now(), who: 'Claude' }

    function renderSquadKanban(taskList) {
      squadCurrentTasks = taskList || [];
      for (const status of SQUAD_COLS) {
        const col = $('#squadCol' + status.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
        if (!col) continue;
        col.innerHTML = '';
      }
      for (const t of squadCurrentTasks) {
        const col = $('#squadCol' + t.status.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''));
        if (!col) continue;
        const card = document.createElement('div');
        card.className = 'squad-task-card ' + t.status;
        card.dataset.id = t.id;
        const reviewCount = (t.reviews || []).length;
        const lastReject = (t.reviews || []).filter(r => r.verdict === 'reject').length;

        // v0.52 实时状态：in_progress 显示"🧑‍💻 谁 实现中 elapsed"；in_review 显示"🔍 谁 审查中 elapsed"
        let liveBadge = '';
        const tick = _squadTaskStartedAt.get(t.id);
        if (t.status === 'in_progress' && tick?.phase === 'dev') {
          card.dataset.startedAt = String(tick.start);
          liveBadge = `<span class="squad-task-live" data-elapsed="1" data-label="${escapeHtml(tick.who || 'Dev')} 实现中">⏳ ${escapeHtml(tick.who || 'Dev')} 实现中… 00:00</span>`;
          window.PanelRoomsMembers?.startElapsedTicker?.();
        } else if (t.status === 'in_review' && tick?.phase === 'qa') {
          card.dataset.startedAt = String(tick.start);
          liveBadge = `<span class="squad-task-live" data-elapsed="1" data-label="${escapeHtml(tick.who || 'QA')} 审查中">⏳ ${escapeHtml(tick.who || 'QA')} 审查中… 00:00</span>`;
          window.PanelRoomsMembers?.startElapsedTicker?.();
        } else if (t.status === 'escalated' && t.escalateReason) {
          liveBadge = `<span class="squad-task-live error">⚠️ ${escapeHtml(t.escalateReason)}</span>`;
        } else if (t.status === 'done') {
          liveBadge = `<span class="squad-task-live ok">✅ 已完成</span>`;
        }

        // v0.54 Sprint 6：escalated task 卡片显示「🔄 重试此任务」按钮（仅房非 running 时可点）
        const isRunning = window.PanelRoomsDebate?.getCurrentRoomStatus?.() === 'running';
        const retryBtn = t.status === 'escalated'
          ? (isRunning
              ? `<button class="squad-task-retry" disabled title="房间正在跑后续 task，先 ⏹ 暂停再重试">⏸ 等房暂停</button>`
              : `<button class="squad-task-retry" data-task-id="${escapeHtml(t.id)}" title="reset 此 task + 连带被牵连的下游 task，自动 resume 接着跑">🔄 重试此任务</button>`)
          : '';

        card.innerHTML = `
          <span class="squad-task-id">${escapeHtml(t.id)}</span>
          <span class="squad-task-title">${escapeHtml(t.title || '')}</span>
          ${liveBadge}
          <span class="squad-task-meta">
            <span class="iter">迭代 ${t.iterations || 0}/${t.maxIterations || 5}</span>
            ${reviewCount ? `<span>📝 ${reviewCount} 次审查</span>` : ''}
            ${lastReject ? `<span style="color:var(--color-danger);">↩️ 打回 ${lastReject}</span>` : ''}
            ${(t.dependencies || []).length ? `<span>依赖 ${t.dependencies.join('/')}</span>` : ''}
          </span>
          ${retryBtn}`;
        card.addEventListener('click', () => openSquadDetail(t.id));
        // 阻止重试按钮点击冒泡到 card（避免打开 detail drawer）
        card.querySelector('.squad-task-retry')?.addEventListener('click', (e) => {
          e.stopPropagation();
          retrySquadTask(t.id);
        });
        col.appendChild(card);
      }
    }

    async function retrySquadTask(taskId) {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      const ok = await confirmModal({
        title: '重试 task',
        message: `重试 task「${taskId}」？\n\n会同时 reset 所有被它牵连的下游 task（状态变 pending）。`,
        confirmLabel: '重试', cancelLabel: '取消', danger: true,
      });
      if (!ok) return;
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/retry-task`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        }).then(x => x.json());
        if (r.ok) toast(`已开始重试 ${taskId}，等待 dispatcher 重新调度…`, 'info', 3000);
        else toast('重试失败：' + (r.error || 'unknown'), 'error');
      } catch (e) { toast('重试失败：' + e.message, 'error'); }
    }

    function openSquadDetail(taskId) {
      const t = squadCurrentTasks.find(x => x.id === taskId);
      if (!t) return;
      let drawer = $('#squadTaskDetail');
      if (!drawer) {
        drawer = document.createElement('div');
        drawer.id = 'squadTaskDetail';
        drawer.className = 'squad-task-detail hidden';
        document.body.appendChild(drawer);
      }
      const injectionsHtml = (t.userInjections || []).length
        ? `<div class="squad-injections"><b>已注入提示</b>：<ul>${(t.userInjections || []).map(i => `<li>[${(i.at || '').slice(11,19)}] ${escapeHtml(i.content)}</li>`).join('')}</ul></div>`
        : '';
      const canInject = t.status !== 'done';
      drawer.innerHTML = `
        <div class="squad-task-detail-head">
          <h3>${escapeHtml(t.id)} · ${escapeHtml(t.title || '')}</h3>
          <button class="close-btn" id="squadDetailClose" aria-label="关闭任务详情" title="关闭（ESC）">✕</button>
        </div>
        <div><b>描述</b>：${escapeHtml(t.desc || '')}</div>
        <div><b>负责</b>：${escapeHtml(t.assigneeId)} · <b>审查</b>：${escapeHtml(t.reviewerId)}</div>
        <div><b>状态</b>：${escapeHtml(t.status)} · <b>迭代</b>：${t.iterations || 0}/${t.maxIterations || 5}</div>
        ${(t.dependencies || []).length ? `<div><b>依赖</b>：${t.dependencies.map(escapeHtml).join(', ')}</div>` : ''}
        ${injectionsHtml}
        ${canInject ? `<div class="squad-inject-wrap">
          <label class="squad-inject-label">📨 给本 task 追加指示（Dev 下次重做时会看到，QA 死循环时尤其有用）</label>
          <textarea id="squadInjectInput" rows="2" placeholder="例：把方括号改成花括号；或：用 enumerate 不要 range"></textarea>
          <button class="cxbtn cxbtn-primary cxbtn-sm" id="squadInjectBtn">注入指示</button>
        </div>` : ''}
        <hr/>
        <div><b>历史</b></div>
        <div id="squadTaskTimeline"></div>
      `;
      const tl = drawer.querySelector('#squadTaskTimeline');
      const events = [];
      (t.attempts || []).forEach((a, i) => events.push({ kind: 'attempt', i: i + 1, at: a.at, by: a.by, content: a.content, error: a.error }));
      (t.reviews || []).forEach((r, i) => events.push({ kind: 'review', i: i + 1, at: r.at, by: r.by, ...r }));
      events.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
      for (const ev of events) {
        const div = document.createElement('div');
        if (ev.kind === 'attempt') {
          div.className = 'squad-attempt';
          // v0.70.2-t5: 第 2+ 次 attempt 加"对比上次"按钮（W8 squad-diff-preview）
          const diffBtnHtml = ev.i >= 2
            ? `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-attempt-diff="${ev.i - 1}-${ev.i}" data-task-id="${escapeHtml(t.id)}" title="对比第 ${ev.i - 1} 次和第 ${ev.i} 次的内容差异">📐 对比上次</button>`
            : '';
          div.innerHTML = `<div class="squad-attempt-head">🔨 第 ${ev.i} 次提交 · ${escapeHtml(ev.by)} · ${ev.at?.slice(11, 19) || ''} ${diffBtnHtml}</div>${renderMarkdown(ev.content || '')}`;
        } else {
          div.className = 'squad-review ' + (ev.verdict === 'pass' ? 'pass' : 'reject');
          div.innerHTML = `<div class="squad-review-head">${ev.verdict === 'pass' ? '✅ 通过' : '❌ 打回'} · ${escapeHtml(ev.by)} · ${escapeHtml(ev.at?.slice(11, 19) || '')} · 置信度 ${(ev.confidence || 0).toFixed(2)}</div>
            ${ev.reasoning ? `<div><b>结论</b>：${escapeHtmlMl(ev.reasoning)}</div>` : ''}
            ${(ev.issues || []).length ? `<div><b>问题</b>：<ul>${ev.issues.map(it => '<li>' + escapeHtmlMl(it) + '</li>').join('')}</ul></div>` : ''}
            ${(ev.suggestions || []).length ? `<div><b>建议</b>：<ul>${ev.suggestions.map(it => '<li>' + escapeHtmlMl(it) + '</li>').join('')}</ul></div>` : ''}`;
        }
        tl.appendChild(div);
      }
      drawer.classList.remove('hidden');
      drawer.querySelector('#squadDetailClose').addEventListener('click', () => drawer.classList.add('hidden'));
      // v0.70.2-t5: attempt 对比按钮
      drawer.querySelectorAll('[data-attempt-diff]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const [fromStr, toStr] = btn.dataset.attemptDiff.split('-');
          const tid = btn.dataset.taskId;
          const roomId = window.PanelRoomsCore.roomState.activeId;
          if (!roomId || !tid) return;
          try {
            const r = await fetch(`/api/rooms/${roomId}/tasks/${tid}/diff?from=${parseInt(fromStr) - 1}&to=${parseInt(toStr) - 1}`).then(x => x.json());
            if (!r.ok) { toast('对比失败：' + (r.error || ''), 'error'); return; }
            if (!r.diff) { toast(r.reason || 'attempt 不足', 'warn'); return; }
            const d = r.diff;
            await confirmModal({
              title: `📐 attempt ${fromStr} → ${toStr} 对比（+${d.added}/-${d.removed} 行）`,
              message: d.unified || '(无差异)',
              confirmLabel: '关闭', cancelLabel: '',
            });
          } catch (e) { toast('异常：' + e.message, 'error'); }
        });
      });
      const injectBtn = drawer.querySelector('#squadInjectBtn');
      if (injectBtn) {
        injectBtn.addEventListener('click', async () => {
          const input = drawer.querySelector('#squadInjectInput');
          const content = (input?.value || '').trim();
          if (!content) { toast('先填指示内容', 'warn'); return; }
          try {
            const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/tasks/${taskId}/inject`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content }),
            }).then(x => x.json());
            if (r.ok) {
              toast(`已注入：${content.slice(0, 30)}${content.length > 30 ? '…' : ''}`, 'success', 2500);
              input.value = '';
              await core.pullRoomAndRender();
              openSquadDetail(taskId); // 重渲染
            } else {
              toast('注入失败：' + (r.error || ''), 'error');
            }
          } catch (e) { toast('注入失败：' + e.message, 'error'); }
        });
      }
    }

    window.PanelRoomsSquad = {
      SQUAD_COLS,
      get squadCurrentTasks() { return squadCurrentTasks; },
      get _squadTaskStartedAt() { return _squadTaskStartedAt; },
      renderSquadKanban,
      retrySquadTask,
      openSquadDetail,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
