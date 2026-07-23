// timeline-ui.js — 📈 房间时间线（从 app.js 外迁；app.js 模块化第6批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, toast } = core;

    // ========== v0.55 Sprint 13-D — 📈 时间线 ==========
    const timelineState = { chart: null };

    async function openTimelineModal() {
      if (!core.roomState.activeId) { toast('先选一个房间', 'warn'); return; }
      $('#timelineModal').style.display = 'flex';
      const root = $('#timelineModalBody');
      root.innerHTML = '<div class="muted small" style="padding:20px;">加载中…</div>';
      try {
        const r = await fetch('/api/metrics/by-room?roomId=' + encodeURIComponent(core.roomState.activeId)).then(x => x.json());
        if (!r.ok || !r.turns) { root.innerHTML = `<div class="muted small" style="padding:20px;">加载失败：${escapeHtml(r.error || 'unknown')}</div>`; return; }
        renderTimeline(r.turns);
      } catch (e) {
        root.innerHTML = `<div class="muted small" style="padding:20px;color:var(--color-danger-alt);">异常：${escapeHtml(e.message)}</div>`;
      }
    }
    function closeTimelineModal() {
      $('#timelineModal').style.display = 'none';
      if (timelineState.chart) { try { timelineState.chart.destroy(); } catch {} timelineState.chart = null; }
    }

    async function renderTimeline(turns) {
      const root = $('#timelineModalBody');
      if (turns.length === 0) {
        root.innerHTML = `<div class="muted small" style="padding:20px;">此房还没有任何 turn 被 metrics 记录（说明房还没真跑过 turn，或者 v0.53 metrics 引入前的旧房）</div>`;
        return;
      }
      // 排序 ascending
      turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const tStart = new Date(turns[0].ts).getTime();
      const tEnd = new Date(turns[turns.length - 1].ts).getTime();
      const totalLatency = turns.reduce((s, t) => s + (t.latencyMs || 0), 0);
      const totalTokIn = turns.reduce((s, t) => s + (t.tokensIn || 0), 0);
      const totalTokOut = turns.reduce((s, t) => s + (t.tokensOut || 0), 0);
      const totalCost = turns.reduce((s, t) => s + (t.estCostUSD || 0), 0);
      const errCount = turns.filter(t => !t.success).length;
      const adapters = [...new Set(turns.map(t => t.adapter))];

      root.innerHTML = `
        <div class="timeline-stats">
          <span><strong>${turns.length}</strong> turns</span>
          <span><strong>${adapters.length}</strong> adapters: ${escapeHtml(adapters.join(' / '))}</span>
          <span>跨度 <strong>${((tEnd - tStart) / 1000 / 60).toFixed(1)}</strong> min</span>
          <span>总 latency <strong>${(totalLatency / 1000).toFixed(1)}</strong> s</span>
          <span>tokens <strong>${totalTokIn}</strong> in / <strong>${totalTokOut}</strong> out</span>
          <span>估算成本 <strong>$${totalCost.toFixed(4)}</strong></span>
          <span class="${errCount > 0 ? 'badge-err' : ''}">错误 <strong>${errCount}</strong></span>
        </div>
        <div class="timeline-chart-wrap"><canvas id="timelineChart"></canvas></div>
        <div>
          <div class="timeline-row" style="font-weight:600;border-bottom:2px solid var(--line);">
            <span>时间</span><span>adapter</span><span>turn</span><span style="text-align:right;">latency</span><span style="text-align:right;">tokens out</span><span style="text-align:center;">状态</span>
          </div>
          <div class="timeline-list" id="timelineList"></div>
        </div>
      `;
      // 行列表
      const listRoot = $('#timelineList');
      listRoot.innerHTML = turns.map(t => {
        const ts = new Date(t.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const latencyStr = t.latencyMs >= 1000 ? (t.latencyMs / 1000).toFixed(1) + 's' : t.latencyMs + 'ms';
        return `<div class="timeline-row ${t.success ? '' : 'err'}">
          <span class="ts">${ts}</span>
          <span class="adapter">${escapeHtml(t.adapter)}</span>
          <span class="turn">${escapeHtml(t.turn)}</span>
          <span class="latency">${latencyStr}</span>
          <span class="tokens">${t.tokensOut || 0}</span>
          <span style="text-align:center;" class="${t.success ? 'badge-ok' : 'badge-err'}">${t.success ? '✓' : '✕'}</span>
        </div>`;
      }).join('');

      // Chart.js scatter（按 adapter 分组着色）
      try {
        const Chart = await window.PanelOverview.ensureChartLib();
        const canvas = $('#timelineChart');
        const colorMap = { claude: '#a855f7', codex: '#22c55e', 'gemini-cli': '#3b82f6', gemini: '#06b6d4', minimax: '#eab308', ollama: '#0ea5e9', plugin: '#f97316', report: '#c15f3c', 'openai-api': '#6366f1' };
        const datasets = adapters.map((a) => ({
          label: a,
          data: turns.filter(t => t.adapter === a).map(t => ({
            x: new Date(t.ts).getTime() - tStart,
            y: t.latencyMs || 0,
            rawTurn: t.turn,
            success: t.success,
          })),
          backgroundColor: colorMap[a] || '#6b7280',
          borderColor: colorMap[a] || '#6b7280',
          pointRadius: 5,
        }));
        if (timelineState.chart) { try { timelineState.chart.destroy(); } catch {} }
        timelineState.chart = new Chart(canvas, {
          type: 'scatter',
          data: { datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
              x: { title: { display: true, text: 'time elapsed (ms from first turn)' } },
              y: { title: { display: true, text: 'latency (ms)' }, beginAtZero: true },
            },
            plugins: {
              legend: { position: 'bottom' },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const p = ctx.raw;
                    return `${ctx.dataset.label} · ${p.rawTurn} · ${p.y}ms · ${p.success ? '✓' : '✕'}`;
                  },
                },
              },
            },
          },
        });
      } catch (e) {
        // S20 X5：chart 渲染失败用户应感知（Chart.js 卡死 / 数据格式错）
        console.warn('chart render failed:', e.message);
        toast('趋势图渲染失败：' + e.message, 'error', 4000);
      }
    }

    $('#btnTimeline')?.addEventListener('click', openTimelineModal);
    document.querySelectorAll('[data-close-timeline]').forEach(el => el.addEventListener('click', closeTimelineModal));

    window.PanelTimeline = {
      openTimelineModal,
      closeTimelineModal,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
