// @ts-check
// sessions-tools-ui.js — busy UI/中断/send 发送 + Snapshot/Handoff/ctx 仪表 + 接力/外开/批量开 + 新建会话弹窗
// + F5/F7 message 右键菜单（收藏/分叉）⭐ + F8 ctx 警告条（S24 收尾批22 归位会话域）
// （updateBusyUI/interruptCurrentTurn/send/refreshSnapshot/startSnapshotPolling/refreshCtx/openModal/closeModal/loadQuickCwd
// /toggleStar/forkSession/updateCtxWarningBar
// + #btnSend/#chatInput/#btnInterrupt/#btnSnapRefresh/#btnHandoff/#btnExternal/#btnSpawnAll/#btnNew/#btnCreateConfirm/[data-close] 绑定
// + chatOutput ⭐ click/右键 contextmenu document 级委托 + ctx 警告条 5s setInterval）
// （从 app.js 外迁；app.js 模块化第19批 2026-06-11；star/fork+ctx 第22批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（纯工具可解构；state 实时取 core.state 禁解构快照）。
// 跨文件依赖全走 window 懒解析：appendMessage（PanelSessionsList）/listSessions/createSession/openContextMenu(PanelSessionsCore)/
// selectSession/refreshCostSpark（PanelSessionsStream）。
// 5s snapshot 轮询不在 boot 自起：与原 app.js 行为一致，由 selectSession（sessions-stream 经桥 core.startSnapshotPolling）
// 触发；startSnapshotPolling 自带 clearInterval(core.state.snapshotTimer) 防双轮询；document.hidden 时跳过。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, $$, api, toast, escapeHtml, renderMarkdown, confirmModal, fallbackCopy } = core;

    function updateBusyUI() {
      const btn = $('#btnSend');
      const input = $('#chatInput');
      const interrupt = $('#btnInterrupt');
      if (core.state.activeBusy) {
        btn.disabled = true;
        btn.textContent = '处理中…';
        input.disabled = true;
        if (interrupt) interrupt.style.display = 'inline-flex';
      } else {
        btn.disabled = false;
        btn.textContent = '发送 ↵';
        input.disabled = false;
        if (interrupt) interrupt.style.display = 'none';
      }
    }

    // v0.16/v0.20 中断当前 turn — 双击立即 force reset
    let lastInterruptClickTs = 0;
    async function interruptCurrentTurn() {
      if (!core.state.activeId) return;
      const now = Date.now();
      const doubleClick = now - lastInterruptClickTs < 800;
      lastInterruptClickTs = now;
      try {
        if (doubleClick) {
          // 第二次快速点 = 强制重置（child 卡死时用）
          await api(`/api/sessions/${core.state.activeId}/reset-busy`, { method: 'POST' });
          toast('已强制释放 busy 状态（SIGTERM child）', 'warn', 3000);
        } else {
          await api(`/api/sessions/${core.state.activeId}/interrupt`, { method: 'POST' });
          toast('已发送中断 SIGINT · 不放？双击此按钮强制释放', 'warn', 3500);
        }
      } catch (e) {
        toast('中断失败: ' + e.message + ' · 尝试双击强制释放', 'error');
      }
    }
    $('#btnInterrupt')?.addEventListener('click', interruptCurrentTurn);

    async function send() {
      const input = $('#chatInput');
      const val = input.value.trim();
      if (!val || core.state.activeBusy || !core.state.activeId) return;
      const savedVal = val;
      input.value = '';
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text: val }),
        });
        // v0.31 真测 P2.2 fix: server 可能返回 ok:false（busy / loop_guard_break）
        if (r && r.ok === false) {
          input.value = savedVal; // 回填，让用户能修改
          if (r.error === 'busy') {
            toast(r.message || '上一条还在处理，等完成或点 ⏸', 'warn', 4000);
          } else if (r.error === 'loop_guard_break') {
            const rsn = r.reason || {};
            let label = rsn.type;
            if (rsn.type === 'repeated_instruction') label = `连续 ${rsn.count} 次相同指令被熔断`;
            else if (rsn.type === 'steps_exceeded') label = `任务步数超 ${rsn.max}`;
            else if (rsn.type === 'cost_surge') label = `5min 成本 $${rsn.usdInWindow} 超阈值`;
            toast('🔁 LoopGuard 熔断：' + label, 'error', 5000);
          } else {
            toast('发送被拒：' + (r.message || r.error), 'error', 4000);
          }
        }
      } catch (e) {
        input.value = savedVal;
        window.PanelSessionsList?.appendMessage?.({ role: 'tool_use', content: `❌ 发送失败: ${e.message}`, ts: new Date().toISOString() });
      }
    }

    // ───── Snapshot / Handoff（07 Continuum 集成）─────
    async function refreshSnapshot() {
      if (!core.state.activeId) {
        $('#snapshotBody').innerHTML = '<div class="muted small" style="padding:8px;">— 未选中 session —</div>';
        $('#snapshotMeta').textContent = '—';
        $('#chainBadge').style.display = 'none';
        return;
      }
      const id = core.state.activeId;
      try {
        const [snap, meta] = await Promise.all([
          api(`/api/sessions/${id}/snapshot`),
          api(`/api/sessions/${id}/handoff-meta`),
        ]);
        // 切 session 时可能 id 变了，确保还在
        if (core.state.activeId !== id) return;

        // Chain badge
        if (meta.ok && meta.meta) {
          const d = meta.meta.chain_depth || 0;
          const h = meta.meta.handoff_count || 0;
          const badge = $('#chainBadge');
          if (d > 0 || h > 0) {
            badge.textContent = `链 ${d} · 切 ${h}`;
            badge.style.display = 'inline-block';
            if (d >= 5) badge.classList.add('warn');
            else badge.classList.remove('warn');
          } else {
            badge.style.display = 'none';
          }
        } else {
          $('#chainBadge').style.display = 'none';
        }

        // Snapshot body
        if (!snap.ok) {
          $('#snapshotBody').innerHTML = `
            <div class="muted small" style="padding:12px;line-height:1.6;">
              <strong>暂无快照</strong><br>
              ${escapeHtml(snap.hint || 'snapshot 还没生成')}<br><br>
              <span style="opacity:.7;">cwd hash: <code>${escapeHtml(snap.cwdHash || '?')}</code></span>
            </div>
          `;
          $('#snapshotMeta').textContent = '无快照';
        } else {
          const mtime = new Date(snap.mtime).toLocaleTimeString('zh-CN');
          $('#snapshotMeta').textContent = `${(snap.bytes/1024).toFixed(1)}KB · ${mtime}`;
          $('#snapshotBody').innerHTML = renderMarkdown(snap.content);
        }
      } catch (e) {
        $('#snapshotBody').innerHTML = `<div class="muted small" style="padding:8px;color:#c00;">${escapeHtml(e.message)}</div>`;
      }
    }

    function startSnapshotPolling() {
      if (core.state.snapshotTimer) clearInterval(core.state.snapshotTimer);
      core.state.snapshotTimer = setInterval(() => {
        if (document.hidden) return; // 标签页隐藏时不轮询，省后端 transcript I/O 与请求
        refreshSnapshot();
        refreshCtx();
        window.PanelSessionsStream?.refreshCostSpark?.();
      }, 5000);
    }

    async function refreshCtx() {
      if (!core.state.activeId) {
        $('#ctxMeter').style.display = 'none';
        $('#ctxWarnBanner').style.display = 'none';
        return;
      }
      const id = core.state.activeId;
      try {
        const r = await api(`/api/sessions/${id}/ctx`);
        if (core.state.activeId !== id) return;
        const meter = $('#ctxMeter');
        const banner = $('#ctxWarnBanner');
        if (!r.ok) {
          meter.style.display = 'none';
          banner.style.display = 'none';
          return;
        }
        meter.style.display = 'inline-flex';
        const pct = r.pct || 0;
        const fill = $('#ctxFill');
        fill.style.width = pct + '%';
        const fmtK = n => n >= 1e6 ? (n/1e6).toFixed(2) + 'M' : (n/1000).toFixed(1) + 'k';
        $('#ctxLabel').textContent = `${pct.toFixed(1)}% · ${fmtK(r.ctxTotal)} / ${fmtK(r.maxTokens)}`;
        fill.classList.remove('ctx-warn', 'ctx-danger');
        if (pct >= 90) {
          fill.classList.add('ctx-danger');
          banner.style.display = 'block';
          $('#ctxWarnText').textContent = `⚠️ 上下文已达 ${pct.toFixed(1)}%，建议立即点 🔄 接力换 session（避免 claude 自压缩损失上下文）`;
        } else if (pct >= 70) {
          fill.classList.add('ctx-warn');
          banner.style.display = 'block';
          $('#ctxWarnText').textContent = `📊 上下文 ${pct.toFixed(1)}%，开始累积。到 90% 会强烈建议接力。`;
        } else {
          banner.style.display = 'none';
        }
      } catch {
        // 静默
      }
    }

    $('#btnSnapRefresh')?.addEventListener('click', refreshSnapshot);

    $('#btnHandoff')?.addEventListener('click', async () => {
      if (!core.state.activeId) return;
      const ok = await confirmModal({
        title: '接力当前 session？',
        message: '归档当前 snapshot 并新建接力 session（同 cwd，第一条预置 HANDOFF 上下文让新 claude 接手）',
        confirmLabel: '🔄 接力',
      });
      if (!ok) return;
      try {
        const r = await api(`/api/sessions/${core.state.activeId}/handoff`, { method: 'POST' });
        if (!r.ok) { toast('接力失败: ' + (r.error || JSON.stringify(r)), 'error'); return; }
        window.PanelSessionsList?.appendMessage?.({
          role: 'tool_use',
          content: `✅ 已接力 → 新 session（链层 ${r.chainDepth}, snapshot ${(r.snapshotBytes/1024).toFixed(1)}KB, 归档 ${r.archivedAs || '-'}）`,
          ts: new Date().toISOString(),
        });
        await window.PanelSessionsCore?.listSessions?.();
        window.PanelSessionsStream?.selectSession?.(r.newSessionId);
      } catch (e) {
        toast('接力失败: ' + e.message, 'error');
      }
    });

    // 外部 Terminal 启动当前 session
    $('#btnExternal')?.addEventListener('click', async () => {
      if (!core.state.activeId) return;
      try {
        await api(`/api/sessions/${core.state.activeId}/external`, { method: 'POST' });
        window.PanelSessionsList?.appendMessage?.({ role: 'tool_use', content: '✅ 已在 macOS Terminal 打开独立 claude 窗口', ts: new Date().toISOString() });
      } catch (e) { toast('打开失败: ' + e.message, 'error'); }
    });

    // 批量为所有 session 开 Terminal 窗口
    $('#btnSpawnAll')?.addEventListener('click', async () => {
      if (!core.state.sessions.length) return;
      const ok = await confirmModal({
        title: `批量打开 ${core.state.sessions.length} 个 Terminal 窗口？`,
        message: `每个活跃 session 各开一个 macOS Terminal 窗口跑独立 claude。会同时弹 ${core.state.sessions.length} 个窗口。`,
        confirmLabel: '⤴⤴ 全开',
      });
      if (!ok) return;
      try {
        const r = await api('/api/spawn-batch', {
          method: 'POST',
          body: JSON.stringify({ ids: core.state.sessions.map(s => s.id) }),
        });
        window.PanelSessionsList?.appendMessage?.({ role: 'tool_use', content: `✅ 已开 ${r.spawned.length} 个 Terminal 窗口`, ts: new Date().toISOString() });
      } catch (e) { toast('批量打开失败: ' + e.message, 'error'); }
    });

    $('#btnSend')?.addEventListener('click', send);
    $('#chatInput')?.addEventListener('keydown', e => {
      // v0.50 Q-01 IME fix: 中文选字 Enter 不该触发
      // v0.54 Sprint 7：Enter 发送 / Shift+Enter 换行 / ⌘+Enter 兼容（旧习惯）
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter') return;
      if (e.shiftKey) return;
      e.preventDefault();
      send();
    });

    // 新建弹窗
    function openModal() { $('#newModal').style.display = 'flex'; $('#newName').focus(); loadQuickCwd(); }
    function closeModal() {
      $('#newModal').style.display = 'none';
      $('#newName').value = '';
      $('#newCwd').value = '';
      const g = $('#newMainGoal'); if (g) g.value = '';
    }
    async function loadQuickCwd() {
      const wrap = $('#quickCwd');
      wrap.innerHTML = '<span class="muted small">加载…</span>';
      try {
        const { items } = await api('/api/files?path=' + encodeURIComponent('~/Desktop'));
        wrap.innerHTML = '';
        items.filter(i => i.isDir).slice(0, 12).forEach(it => {
          const c = document.createElement('span');
          c.className = 'chip';
          c.textContent = it.name;
          c.title = it.path;
          c.addEventListener('click', () => $('#newCwd').value = it.path);
          wrap.appendChild(c);
        });
      } catch { wrap.innerHTML = ''; }
    }

    $('#btnNew')?.addEventListener('click', openModal);
    $$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    $('#btnCreateConfirm')?.addEventListener('click', async () => {
      const name = $('#newName').value.trim();
      const cwd = $('#newCwd').value.trim() || null;
      const mainGoal = $('#newMainGoal')?.value.trim() || null;
      try { await window.PanelSessionsCore?.createSession?.(name, cwd, mainGoal); closeModal(); }
      catch (e) { toast('创建失败: ' + e.message, 'error'); }
    });

    // ─── F5 + F7：message 右键菜单（收藏 / 分叉）+ ⭐ 渲染（从 app.js 归位；S24 收尾批22；star/fork 原样走裸 fetch 不加 api 包装，语义随迁不变）─────
    // v0.51 R-04 fix: in-flight 去重，避免快速双击导致 UI 状态错位
    const _toggleStarInflight = new Set();
    async function toggleStar(sessionId, msgIndex) {
      const key = sessionId + '#' + msgIndex;
      if (_toggleStarInflight.has(key)) return; // 同一条正在 toggle，忽略
      _toggleStarInflight.add(key);
      try {
        const r = await fetch(`/api/sessions/${sessionId}/star`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgIndex }) }).then(x => x.json());
        if (r.ok) {
          // 同步更新本地（避免重渲全部）
          if (sessionId === core.state.activeId) core.state.activeStarred = r.starredIndices || [];
          const sess = core.state.sessions.find(s => s.id === sessionId);
          if (sess) sess.starredIndices = r.starredIndices;
          // 重渲该条 msg 的 ⭐ 状态
          const el = document.querySelector(`#chatOutput .msg[data-msg-idx="${msgIndex}"] .msg-star-btn`);
          if (el) el.classList.toggle('starred', r.starredIndices.includes(msgIndex));
          return r.starredIndices;
        } else if (r?.error) {
          toast('收藏失败：' + r.error, 'error');
        }
      } catch (e) {
        toast('收藏失败：' + e.message, 'error');
      } finally {
        _toggleStarInflight.delete(key);
      }
    }
    async function forkSession(sessionId, fromIndex) {
      if (!await confirmModal({ title: '从这条消息分叉？', message: `新 session 会复制前 ${fromIndex + 1} 条消息，cwd 同当前，但 claudeSessionId 重置（新一轮 fresh claude）`, confirmLabel: '分叉' })) return;
      try {
        const r = await fetch(`/api/sessions/${sessionId}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromIndex }) }).then(x => x.json());
        if (r.ok) {
          toast(`分叉成功（复制 ${r.copiedCount} 条）`, 'success');
          await window.PanelSessionsCore?.listSessions?.();
          window.PanelSessionsStream?.selectSession?.(r.newSessionId);
        } else {
          toast('分叉失败：' + r.error, 'error');
        }
      } catch (e) {
        toast('异常：' + e.message, 'error');
      }
    }
    // 用事件委托给 chatOutput 处理 ⭐ 点击 + 右键（document 级，boot 只绑一次）
    document.addEventListener('click', (e) => {
      const star = e.target.closest('.msg-star-btn');
      if (!star) return;
      const msg = star.closest('.msg');
      if (!msg) return;
      const idx = parseInt(msg.dataset.msgIdx, 10);
      if (!Number.isInteger(idx)) return;
      if (!core.state.activeId) return;
      toggleStar(core.state.activeId, idx);
    });
    document.addEventListener('contextmenu', (e) => {
      const msg = e.target.closest('#chatOutput .msg');
      if (!msg) return;
      const idx = parseInt(msg.dataset.msgIdx, 10);
      if (!Number.isInteger(idx)) return;
      if (!core.state.activeId) return;
      e.preventDefault();
      const sess = core.state.sessions.find(s => s.id === core.state.activeId);
      const starred = (sess?.starredIndices || []).includes(idx);
      window.PanelSessionsCore?.openContextMenu?.([
        { label: starred ? '☆ 取消收藏' : '⭐ 收藏', onSelect: () => toggleStar(core.state.activeId, idx) },
        { label: '🍴 从这里分叉新 session', onSelect: () => forkSession(core.state.activeId, idx) },
        { label: '📋 复制内容', onSelect: () => {
          const body = msg.querySelector('.msg-body');
          const text = body?.dataset?.rawText || body?.textContent || '';
          // v0.50 Q-04 fix: clipboard 在非 secure context 或拒绝时降级（fallbackCopy 留守 app.js，经桥解构）
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text)
              .then(() => toast('已复制', 'success'))
              .catch(() => fallbackCopy(text));
          } else {
            fallbackCopy(text);
          }
        }},
      ], e.clientX, e.clientY);
    });

    // ─── F8 ctx 警告条（从 app.js 归位；S24 收尾批22。F3 turn_end 通知 hook 属 prompts-notify-ui，第14批已迁）─────
    async function updateCtxWarningBar() {
      if (!core.state.activeId) { hideCtxBar(); return; }
      try {
        const r = await fetch(`/api/sessions/${core.state.activeId}/ctx`).then(x => x.json());
        if (r?.ok && typeof r.pct === 'number') showCtxBar(r.pct);
        else hideCtxBar();
      } catch {
        hideCtxBar();
      }
    }
    function ensureCtxBar() {
      let bar = document.getElementById('ctxWarningBar');
      if (bar) return bar;
      const chatArea = document.getElementById('chatArea');
      if (!chatArea) return null;
      bar = document.createElement('div');
      bar.id = 'ctxWarningBar';
      bar.className = 'ctx-warning-bar';
      bar.innerHTML = `
        <span class="ctx-warn-msg"></span>
        <button class="cxbtn cxbtn-primary cxbtn-sm ctx-warn-action" id="ctxWarnHandoff" title="开新 session 接力">🔁 接力</button>
      `;
      chatArea.insertBefore(bar, chatArea.firstChild);
      bar.querySelector('#ctxWarnHandoff').addEventListener('click', () => {
        $('#btnHandoff')?.click();
      });
      return bar;
    }
    function showCtxBar(pct) {
      const bar = ensureCtxBar();
      if (!bar) return;
      bar.classList.remove('warn', 'danger');
      if (pct >= 85) {
        bar.classList.add('danger');
        bar.querySelector('.ctx-warn-msg').textContent = `🚨 上下文 ${pct.toFixed(0)}% — 已接近上限，建议立即接力（一键 →）`;
      } else if (pct >= 70) {
        bar.classList.add('warn');
        bar.querySelector('.ctx-warn-msg').textContent = `⚠️ 上下文 ${pct.toFixed(0)}% — 接近上限，考虑接力`;
      }
    }
    function hideCtxBar() {
      const bar = document.getElementById('ctxWarningBar');
      if (bar) bar.classList.remove('warn', 'danger');
    }
    // 每次 ctx 刷新（status bar tick）也检查 bar；标签页隐藏时不轮询（与 snapshotTimer 的
    // refreshCtx 同打 /ctx，后端已有 mtime 缓存兜底重复请求成本）；boot 只跑一次 = 只起一个 interval
    setInterval(() => { if (!document.hidden) updateCtxWarningBar(); }, 5000);

    window.PanelSessionsTools = {
      updateBusyUI,
      interruptCurrentTurn,
      send,
      refreshSnapshot,
      startSnapshotPolling,
      refreshCtx,
      openModal,
      closeModal,
      loadQuickCwd,
      // S24 收尾批22：star/fork + ctx 警告条归位会话域
      toggleStar,
      forkSession,
      updateCtxWarningBar,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
