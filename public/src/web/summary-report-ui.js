// summary-report-ui.js — 生成总结报告 modal（从 app.js 外迁；app.js 模块化第3批）
// 依赖经 window.PanelCore / window.PanelGlobalWs 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, roomState, startElapsedTicker, renderMarkdown } = window.PanelCore;

    // ========== v0.54 Sprint 9 — 📝 生成总结报告 ==========
    // activeJob 让 ws.onmessage 按 jobId 分发回调，WS 重连后旧 listener 失效的问题靠这个绕开
    const reportState = { lastResult: null, activeJob: null };

    function openReportModal() {
      if (!roomState.activeId) { toast('先选一个房间', 'warn'); return; }
      $('#reportModal').style.display = 'flex';
      renderReportForm();
    }
    function closeReportModal() {
      $('#reportModal').style.display = 'none';
      reportState.lastResult = null;
      // 关 modal 视为放弃当前生成任务：清掉 activeJob + 超时定时器，避免事件到达时往隐藏 modal 里写
      if (reportState.activeJob?.timer) { clearTimeout(reportState.activeJob.timer); }
      if (reportState.activeJob?.pollTimer) { clearTimeout(reportState.activeJob.pollTimer); }
      reportState.activeJob = null;
    }

    function getAvailableAdapters() {
      // 从 roomState 当前房的 members 拿默认 adapter，加上常见 fallback
      const members = (roomState.rooms || []).find(r => r.id === roomState.activeId)?.members || [];
      const ids = new Set(members.map(m => m.adapterId));
      // 加常见 fallback（即使本房没用过这个 adapter，也可能用来跑报告）
      ['claude', 'codex', 'gemini-cli', 'minimax'].forEach(id => ids.add(id));
      return Array.from(ids);
    }

    // 各 adapter 的可选 model 列表 + 默认推荐（数组首项为预选）
    // 第一项 = 该 adapter 当家最强模型（生成报告时优先用），其后按降级排
    const REPORT_MODEL_OPTIONS = {
      claude: [
        { value: 'claude-opus-4-8', label: 'claude-opus-4-8（xhigh + workflows · 推荐）' },
        { value: 'claude-opus-4-7', label: 'claude-opus-4-7（上一代 Opus）' },
        { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6（平衡 · CLI 默认）' },
        { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5（快·便宜）' },
        { value: '', label: '（留空 / 让 CLI 自己选）' },
      ],
      codex: [
        { value: 'gpt-5.5', label: 'gpt-5.5（xhigh 推理 · 推荐）' },
        { value: '', label: '（留空 / 让 CLI 自己选）' },
      ],
      'gemini-cli': [
        { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro（最强 · 推荐）' },
        { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash（快 · CLI 默认）' },
        { value: '', label: '（留空 / 让 CLI 自己选）' },
      ],
    };
    // __custom__ 哨兵 → 切换到手填文本框，覆盖 select 的预定义项
    const REPORT_MODEL_CUSTOM = '__custom__';

    function getReportModelOptions(adapterId) {
      return REPORT_MODEL_OPTIONS[adapterId] || null;
    }

    /** 根据当前 adapter 渲染 model 选择区（已知 adapter → select；未知 → input） */
    function renderReportModelArea() {
      const area = document.getElementById('rpModelArea');
      if (!area) return;
      const adapter = document.getElementById('rpAdapter')?.value || '';
      const opts = getReportModelOptions(adapter);

      if (!opts) {
        // 未知 adapter（如用户自定义的 OpenAI 兼容条目）→ 纯文本输入兜底
        area.innerHTML = `
      <input id="rpModelCustom" maxlength="100" placeholder="如 deepseek-v3 / 留空走默认" />
      <input type="hidden" id="rpModelSelect" value="${REPORT_MODEL_CUSTOM}" />
      <div class="help">该 adapter 无预设 model 列表，可手填具体型号或留空。</div>
    `;
        return;
      }
      const selectHtml = opts.map((o, i) => `<option value="${escapeHtml(o.value)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
      area.innerHTML = `
    <select id="rpModelSelect">
      ${selectHtml}
      <option value="${REPORT_MODEL_CUSTOM}">自定义（手填型号名）...</option>
    </select>
    <input id="rpModelCustom" maxlength="100" placeholder="自定义型号名" style="display:none;margin-top:6px;" />
    <div class="help">报告浓缩任务推荐用最强模型；快/便宜模型可能漏掉细节。</div>
  `;
      const sel = document.getElementById('rpModelSelect');
      const cus = document.getElementById('rpModelCustom');
      sel?.addEventListener('change', () => {
        if (sel.value === REPORT_MODEL_CUSTOM) {
          cus.style.display = '';
          cus.focus();
        } else {
          cus.style.display = 'none';
          cus.value = '';
        }
      });
    }

    /** runReport 取最终 model：自定义 → 文本框值；预设 → select 值 */
    function getReportModelValue() {
      const sel = document.getElementById('rpModelSelect');
      const cus = document.getElementById('rpModelCustom');
      if (!sel) return (cus?.value || '').trim();
      if (sel.value === REPORT_MODEL_CUSTOM) return (cus?.value || '').trim();
      return (sel.value || '').trim();
    }

    function renderReportForm() {
      const root = $('#reportModalBody');
      if (!root) return;
      const adapters = getAvailableAdapters();
      root.innerHTML = `
    <div class="muted small">让 AI 把本房所有 turn 浓缩成一份人类可读报告（按房模式不同输出 5-6 节）。原始记录不动，报告作为独立 markdown 输出。</div>
    <div class="report-form-row">
      <label>用哪个 AI 总结？</label>
      <select id="rpAdapter">
        ${adapters.map(a => `<option value="${escapeHtml(a)}" ${a === 'claude' ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <div class="help">推荐 claude（指令遵循 + 中文输出最稳）。注意：会调一次该 adapter 的真 LLM 请求，会算成本。</div>
    </div>
    <div class="report-form-row">
      <label>具体型号</label>
      <div id="rpModelArea"></div>
    </div>
    <div class="report-form-row">
      <label>保存路径（可空 → 不写盘，只在 modal 里看 + 下载）</label>
      <input id="rpOutputPath" maxlength="1024" placeholder="如 ~/Documents/<房名>-report.md，或留空" />
      <div class="help">填路径会写盘到该文件；勾下面的"自动路径"则用归档配置的 rootPath。</div>
    </div>
    <div class="report-form-row">
      <label><input type="checkbox" id="rpAutoPath" /> 自动路径（用归档配置的 rootPath/&lt;房名&gt;-report-&lt;时间&gt;.md）</label>
    </div>
    <div class="report-actions">
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-report>取消</button>
      <button class="cxbtn cxbtn-primary" id="btnReportGo">▶ 生成报告</button>
    </div>
  `;
      $('#btnReportGo')?.addEventListener('click', runReport);
      root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
      // adapter 切换时重渲染 model 区域；初次进入也渲一次
      $('#rpAdapter')?.addEventListener('change', renderReportModelArea);
      renderReportModelArea();
    }

    async function runReport() {
      const adapterId = $('#rpAdapter').value;
      const model = getReportModelValue();
      const outputPath = ($('#rpOutputPath').value || '').trim();
      const autoPath = $('#rpAutoPath').checked;

      // 渲染 progress
      const root = $('#reportModalBody');
      root.innerHTML = `
    <div class="report-progress" data-started-at="${Date.now()}">
      <span class="spinner"></span>
      正在让 ${escapeHtml(adapterId)} 总结全房聊天 — 长聊天可能 30s~5min，结果通过 WS 推送回来…
      <div style="margin-top:6px;"><span data-elapsed="1" data-label="生成中">⏳ 生成中… 00:00</span></div>
      <div class="muted small" id="rpJobMeta" style="margin-top:10px;font-family:ui-monospace,monospace;font-size:11px;"></div>
    </div>
  `;
      startElapsedTicker();

      // v0.55 Sprint 14 F1：改异步 job 模式（修 Safari fetch 60s timeout 报 "Load failed"）
      // 1) POST 立即返 jobId
      // 2) 注册到 reportState.activeJob，ws.onmessage 按 jobId 分发（WS 重连免疫）
      let jobId = null;
      let resolved = false;
      let pollTimer = null;

      function cleanup() {
        if (reportState.activeJob?.timer) { clearTimeout(reportState.activeJob.timer); }
        if (reportState.activeJob?.pollTimer) { clearTimeout(reportState.activeJob.pollTimer); }
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        reportState.activeJob = null;
      }

      function fail(msg) {
        if (resolved) return; resolved = true; cleanup();
        root.innerHTML = `
      <div class="muted" style="padding:20px;color:var(--color-danger-alt);">❌ 生成失败：${escapeHtml(msg)}</div>
      <div class="report-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpBack">← 重试</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-report>关闭</button>
      </div>`;
        $('#rpBack')?.addEventListener('click', renderReportForm);
        root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
      }

      function succeed(data) {
        if (resolved) return; resolved = true; cleanup();
        reportState.lastResult = data;
        renderReportPreview(data);
      }

      function reportDataFromJob(job) {
        return {
          content: job.content, path: job.path,
          tokensIn: job.tokensIn, tokensOut: job.tokensOut,
          elapsedMs: job.elapsedMs, truncated: job.truncated,
        };
      }

      function updateJobMeta(text) {
        const meta = $('#rpJobMeta');
        if (meta) meta.textContent = text;
      }

      function scheduleReportPoll(delay = 2000) {
        if (resolved || !jobId) return;
        pollTimer = setTimeout(async () => {
          pollTimer = null;
          if (resolved || !jobId) return;
          try {
            const resp = await fetch(`/api/reports/${encodeURIComponent(jobId)}`);
            const r = await resp.json().catch(() => ({}));
            if (!resp.ok || !r.ok) {
              if (resp.status === 404) fail('报告任务状态不存在，可能 panel 已重启或任务缓存过期');
              else scheduleReportPoll(5000);
              return;
            }
            const job = r.job || {};
            if (job.status === 'done') {
              succeed(reportDataFromJob(job));
              return;
            }
            if (job.status === 'error') {
              fail(job.error || 'unknown');
              return;
            }
            updateJobMeta(`jobId: ${jobId}（${job.status || 'queued'}，WS + 轮询双通道等待 AI 返回）`);
            scheduleReportPoll(2500);
          } catch {
            scheduleReportPoll(5000);
          }
        }, delay);
        if (reportState.activeJob) reportState.activeJob.pollTimer = pollTimer;
      }

      // 先连/确保 WS 已连
      window.PanelGlobalWs?.ensure();

      try {
        const resp = await fetch(`/api/rooms/${roomState.activeId}/report`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adapterId, model, outputPath: outputPath || undefined, autoPath }),
        });
        const r = await resp.json();
        if (!resp.ok || r.error) { fail(r.error || `HTTP ${resp.status}`); return; }
        jobId = r.jobId;
        updateJobMeta(`jobId: ${jobId}（已排队，WS + 轮询双通道等待 AI 返回）`);
      } catch (e) {
        fail('提交任务异常：' + e.message);
        return;
      }

      // 注册 jobId 回调到 reportState.activeJob，ws.onmessage 按 jobId 路由
      reportState.activeJob = {
        jobId,
        onDone: (msg) => {
          // v0.70.2-t2: assertion warning → toast（学自 W11 promptfoo）
          if (Array.isArray(msg.assertionFailed) && msg.assertionFailed.length > 0) {
            const summary = msg.assertionFailed.map(f => `${f.type}: ${f.reason}`).join(' / ');
            toast(`⚠️ 报告质量校验 ${msg.assertionFailed.length} 项未通过：${summary}`, 'warn', 8000);
          }
          succeed({
            content: msg.content, path: msg.path,
            tokensIn: msg.tokensIn, tokensOut: msg.tokensOut,
            elapsedMs: msg.elapsedMs, truncated: msg.truncated,
          });
        },
        onError: (msg) => { fail(msg.error || 'unknown'); },
        timer: setTimeout(() => fail('超时 10 分钟未收到 AI 响应；可能 adapter 配置错或 LLM 卡了'), 10 * 60 * 1000),
        pollTimer: null,
      };
      scheduleReportPoll(500);
    }

    function renderReportPreview(r) {
      const root = $('#reportModalBody');
      const tokens = `${r.tokensIn || 0} in / ${r.tokensOut || 0} out`;
      const elapsed = (r.elapsedMs / 1000).toFixed(1) + 's';
      const pathLine = r.path
        ? `<div>📂 已保存到：<code>${escapeHtml(r.path)}</code></div>`
        : `<div class="muted">未保存到磁盘（仅在此处预览，可点下方"💾 下载"保存）</div>`;
      const truncated = r.truncated ? '<div style="color:#c15f3c;">⚠️ 原内容超过 1.5M 字符上限，末尾已截断（后续 turn 未喂给 AI）</div>' : '';
      root.innerHTML = `
    <div class="report-preview-wrap">
      <div class="report-preview-meta">
        ✓ 生成完成 · 耗时 ${elapsed} · ${tokens} tokens
        ${pathLine}
        ${truncated}
      </div>
      <div class="report-preview-content" id="rpPreviewBody"></div>
      <div class="report-actions">
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpDownload">💾 下载 .md</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="rpCopy">📋 复制全文</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="rpRegenerate">↻ 换 AI 重生成</button>
        <button class="cxbtn cxbtn-primary" data-close-report>关闭</button>
      </div>
    </div>
  `;
      $('#rpPreviewBody').innerHTML = renderMarkdown(r.content || '');
      $('#rpDownload')?.addEventListener('click', () => {
        const blob = new Blob([r.content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safe = (roomState.rooms || []).find(x => x.id === roomState.activeId)?.name || 'room';
        a.href = url; a.download = safe.replace(/[\/\\:*?"<>|]/g, '_') + '-report.md';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      $('#rpCopy')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(r.content || '').then(() => toast('已复制', 'success', 1500));
      });
      $('#rpRegenerate')?.addEventListener('click', renderReportForm);
      root.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));
    }

    // —— 注册 WS handler（report_done / report_error 路由到 activeJob）——
    window.PanelGlobalWs?.subscribe((msg) => {
      const job = reportState.activeJob;
      if (job && msg.jobId === job.jobId) {
        if (msg.type === 'report_done') { try { job.onDone?.(msg); } catch {} }
        else if (msg.type === 'report_error') { try { job.onError?.(msg); } catch {} }
      }
    });

    // —— 绑定入口按钮 ——
    $('#btnReportNow')?.addEventListener('click', openReportModal);
    document.querySelectorAll('[data-close-report]').forEach(el => el.addEventListener('click', closeReportModal));

    // —— 导出 ——
    window.PanelReport = { open: openReportModal, close: closeReportModal, get state() { return reportState; } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);
})();
