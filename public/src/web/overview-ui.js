// overview-ui.js — 📊 总览面板（从 app.js 外迁；app.js 模块化第4批）
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, safeClassToken, showRoomArea, loadRooms, selectRoom, promptModal, confirmModal } = window.PanelCore;

    // ========== v0.53 Sprint 3 — 📊 总览面板 ==========
    const overviewState = {
      shown: false,
      range: '7d',
      byAdapterMetric: 'totalTokens',
      charts: { ts: null, byAdapter: null },
      globalWs: null,
      refreshTimer: null,
      chartLibLoading: null,   // Promise，避免重复注入
    };

    // budget 格式化函数已外迁 → public/src/web/budget-utils.js (window.BudgetUtils)

    async function ensureChartLib() {
      if (window.Chart) return window.Chart;
      if (overviewState.chartLibLoading) return overviewState.chartLibLoading;
      overviewState.chartLibLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/chart.umd.min.js';
        s.onload = () => resolve(window.Chart);
        s.onerror = () => reject(new Error('chart.js 加载失败'));
        document.head.appendChild(s);
      });
      return overviewState.chartLibLoading;
    }

    function showOverviewArea() {
      $('#mainHeader').style.display = 'none';
      $('#chatArea').style.display = 'none';
      $('#termArea').style.display = 'none';
      $('#roomArea').style.display = 'none';
      $('#pluginArea') && ($('#pluginArea').style.display = 'none');
      $('#overviewArea').style.display = 'flex';
      overviewState.shown = true;
      refreshOverview();
      window.PanelGlobalWs?.ensure();
      if (!overviewState.refreshTimer) {
        overviewState.refreshTimer = setInterval(refreshOverview, 30000);
      }
    }
    function hideOverviewArea() {
      $('#overviewArea').style.display = 'none';
      overviewState.shown = false;
      if (window.PanelCore.state.activeId) $('#chatArea').style.display = 'flex';
      else $('#mainHeader').style.display = 'flex';
      if (overviewState.refreshTimer) {
        clearInterval(overviewState.refreshTimer);
        overviewState.refreshTimer = null;
      }
    }

    async function refreshOverview() {
      if (!overviewState.shown) return;
      try {
        const range = overviewState.range;
        const fromIso = window.BudgetUtils.rangeToFromIso(range);
        const bucket = window.BudgetUtils.rangeBucket(range);
        const [ov, ts, ba, health, budgetIncidents, budgetPolicies, governance] = await Promise.all([
          fetch('/api/metrics/overview').then(r => r.json()).catch(() => ({})),
          fetch('/api/metrics/timeseries?from=' + encodeURIComponent(fromIso) + '&bucket=' + bucket).then(r => r.json()).catch(() => ({})),
          fetch('/api/metrics/by-adapter?from=' + encodeURIComponent(fromIso)).then(r => r.json()).catch(() => ({})),
          fetch('/api/metrics/health').then(r => r.json()).catch(() => ({})),
          fetch('/api/budgets/incidents?status=open&limit=20').then(r => r.json()).catch(() => ({})),
          fetch('/api/budgets/policies?activeOnly=true&limit=50').then(r => r.json()).catch(() => ({})),
          fetch('/api/governance/summary').then(r => r.json()).catch(() => ({})),
        ]);
        renderOverviewBlockA(ov);
        await renderOverviewBlockB(ts);
        await renderOverviewBlockC(ba);
        renderOverviewBlockD(health);
        renderOverviewBlockE({
          incidents: budgetIncidents?.incidents || [],
          policies: budgetPolicies?.policies || [],
        });
        renderOverviewBlockF(governance);
      } catch (e) {
        console.warn('refreshOverview failed:', e?.message);
      }
    }

    function renderOverviewBlockA(ov) {
      const rooms = ov?.rooms || { running: 0, paused: 0, idle: 0, error: 0, done: 0, auto_paused: 0 };
      const numbers = $('#ovRoomsNumbers');
      if (numbers) {
        const cells = [
          { lbl: '运行中', n: rooms.running || 0, cls: 'is-running' },
          { lbl: '暂停', n: (rooms.paused || 0) + (rooms.auto_paused || 0), cls: 'is-paused' },
          { lbl: '闲置', n: rooms.idle || 0, cls: '' },
          { lbl: '错误', n: rooms.error || 0, cls: 'is-error' },
          { lbl: '完成', n: rooms.done || 0, cls: 'is-done' },
        ];
        numbers.innerHTML = cells.map(c =>
          `<div class="overview-room-num ${safeClassToken(c.cls)}"><div class="n">${Number(c.n) || 0}</div><div class="lbl">${escapeHtml(c.lbl)}</div></div>`
        ).join('');
      }
      const active = $('#ovActiveRooms');
      if (active) {
        const list = ov?.activeRooms || [];
        if (list.length === 0) {
          active.innerHTML = '<div class="overview-active-room-empty">当前没有运行/暂停的房间</div>';
        } else {
          active.innerHTML = list.map(r => {
            const modeLabel = ({ debate: '多模型辩论', squad: '团队拆活', arena: '联网核对', chat: '单聊' })[r.mode] || r.mode;
            const stCls = 'is-' + (r.status || 'idle');
            const safeName = String(r.name || '未命名').replace(/[<>&"]/g, '');
            return `<div class="overview-active-room-item" data-room-id="${r.id}">
              <span class="room-status-dot ${stCls}"></span>
              <span class="name">${safeName}</span>
              <span class="mode-chip">${modeLabel}</span>
            </div>`;
          }).join('');
          active.querySelectorAll('.overview-active-room-item').forEach(el => {
            el.addEventListener('click', () => {
              const rid = el.dataset.roomId;
              hideOverviewArea();
              showRoomArea();
              loadRooms().then(() => {
                selectRoom && selectRoom(rid);
              });
            });
          });
        }
      }
      // 顶部今日数字
      const stats = $('#ovTsStats');
      const t = ov?.today || {};
      if (stats) {
        stats.innerHTML = `
          <span class="overview-ts-stat">今日 in <strong>${window.BudgetUtils.fmtBigInt(t.tokensIn || 0)}</strong></span>
          <span class="overview-ts-stat">今日 out <strong>${window.BudgetUtils.fmtBigInt(t.tokensOut || 0)}</strong></span>
          <span class="overview-ts-stat">估算 <strong>${window.BudgetUtils.fmtUSD(t.costUSD || 0)}</strong></span>
          <span class="overview-ts-stat">turns <strong>${t.turns || 0}</strong></span>
        `;
      }
    }

    async function renderOverviewBlockB(ts) {
      const canvas = $('#ovChartTimeseries');
      if (!canvas) return;
      let Chart;
      try { Chart = await ensureChartLib(); }
      catch (e) {
        canvas.outerHTML = '<div class="overview-active-room-empty">图表库加载失败：' + e.message + '</div>';
        return;
      }
      const series = (ts?.series) || [];
      // 把 ts 字符串("2026-05-20T03" 或 "2026-05-20")格式化成更短显示
      const labels = series.map(p => p.ts.length > 10 ? p.ts.slice(5, 13).replace('T', ' ') + ':00' : p.ts.slice(5));
      const tokensIn = series.map(p => p.tokensIn || 0);
      const tokensOut = series.map(p => p.tokensOut || 0);
      const cost = series.map(p => p.costUSD || 0);
      if (overviewState.charts.ts) {
        overviewState.charts.ts.data.labels = labels;
        overviewState.charts.ts.data.datasets[0].data = tokensIn;
        overviewState.charts.ts.data.datasets[1].data = tokensOut;
        overviewState.charts.ts.data.datasets[2].data = cost;
        overviewState.charts.ts.update('none');
        return;
      }
      overviewState.charts.ts = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'tokens in', data: tokensIn, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.08)', tension: 0.25, yAxisID: 'y' },
            { label: 'tokens out', data: tokensOut, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', tension: 0.25, yAxisID: 'y' },
            { label: 'USD（右轴）', data: cost, borderColor: '#c15f3c', borderDash: [4, 4], backgroundColor: 'transparent', tension: 0.25, yAxisID: 'y1', pointRadius: 2 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          scales: {
            y:  { beginAtZero: true, position: 'left', ticks: { callback: (v) => window.BudgetUtils.fmtBigInt(v) } },
            y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (v) => '$' + v.toFixed(3) } },
          },
          plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
        },
      });
    }

    async function renderOverviewBlockC(ba) {
      const canvas = $('#ovChartByAdapter');
      if (!canvas) return;
      let Chart;
      try { Chart = await ensureChartLib(); }
      catch { return; }
      const list = (ba?.adapters || []).slice();
      const metric = overviewState.byAdapterMetric;
      list.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
      const labels = list.map(a => a.id);
      const values = list.map(a => a[metric] || 0);
      const metricLabel = {
        totalTokens: '总 tokens',
        totalCostUSD: '总成本 USD',
        avgLatencyMs: '平均延迟 ms',
        successRate: '成功率',
        count: '调用次数',
      }[metric] || metric;

      if (overviewState.charts.byAdapter) {
        overviewState.charts.byAdapter.data.labels = labels;
        overviewState.charts.byAdapter.data.datasets[0].data = values;
        overviewState.charts.byAdapter.data.datasets[0].label = metricLabel;
        overviewState.charts.byAdapter.update('none');
      } else {
        overviewState.charts.byAdapter = new Chart(canvas, {
          type: 'bar',
          data: { labels, datasets: [{ label: metricLabel, data: values, backgroundColor: '#c15f3c' }] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
              x: { beginAtZero: true, ticks: { callback: (v) => {
                if (metric === 'totalCostUSD') return '$' + v.toFixed(2);
                if (metric === 'avgLatencyMs') return window.BudgetUtils.fmtMs(v);
                if (metric === 'successRate') return (v * 100).toFixed(0) + '%';
                return window.BudgetUtils.fmtBigInt(v);
              } } },
            },
            plugins: { legend: { display: false } },
          },
        });
      }
      const note = $('#ovByAdapterNote');
      if (note) {
        note.textContent = list.length
          ? `共 ${list.length} 个 adapter（${overviewState.range} 窗口）。成本为估算，可能与实际账单 ±20% 偏差。`
          : '所选时间窗内无数据。跑一个房（debate / squad / arena / chat）就会出现。';
      }
    }

    function renderOverviewBlockD(health) {
      const stats = $('#ovHealthStats');
      const warns = $('#ovHealthWarnings');
      const p = health?.panel || {};
      const f = health?.files || {};
      if (stats) {
        const rows = [
          { k: 'panel RSS', v: (p.rssMB || 0) + ' MB' },
          { k: 'panel 堆', v: (p.heapMB || 0) + ' MB' },
          { k: 'uptime', v: window.BudgetUtils.fmtMs((p.uptimeS || 0) * 1000) },
          { k: '活跃房', v: health?.activeRooms || 0 },
          { k: 'data.json', v: (f.dataJsonMB || 0) + ' MB' },
          { k: 'rooms.json', v: (f.roomsJsonMB || 0) + ' MB' },
          { k: 'metrics', v: (f.metricsMB || 0) + ' MB' },
          { k: 'pid', v: p.pid || '-' },
        ];
        stats.innerHTML = rows.map(r =>
          `<div class="overview-health-row"><span class="k">${escapeHtml(r.k)}</span><span class="v">${escapeHtml(r.v)}</span></div>`
        ).join('');
      }
      if (warns) {
        const list = health?.warnings || [];
        const warningsHtml = list.length === 0
          ? '<div class="overview-health-ok">✓ 一切正常</div>'
          : list.map(w => `<div class="overview-health-warn">⚠ ${w.replace(/[<>&"]/g, '')}</div>`).join('');
        // v0.53 Sprint 3.5：retention 一键清理按钮
        warns.innerHTML = warningsHtml + `
          <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnRetentionClean" style="margin-top:10px;width:100%;" title="删除 X 月之前的 metrics-*.jsonl 文件">🗑 清理老 metrics</button>
        `;
        $('#btnRetentionClean')?.addEventListener('click', cleanOldMetrics);
      }
    }

    function renderOverviewBlockE(budget) {
      const summary = $('#ovBudgetSummary');
      const root = $('#ovBudgetIncidents');
      if (!root) return;
      const incidents = Array.isArray(budget?.incidents) ? budget.incidents : [];
      const policies = Array.isArray(budget?.policies) ? budget.policies : [];
      const hardStops = incidents.filter(i => i.thresholdType === 'hard_stop').length;
      const warnings = incidents.filter(i => i.thresholdType === 'warning').length;

      if (summary) {
        summary.innerHTML = `<span class="overview-budget-summary">
          <span class="overview-budget-pill ${hardStops ? 'is-hard' : ''}">hard-stop ${hardStops}</span>
          <span class="overview-budget-pill ${warnings ? 'is-warn' : ''}">warning ${warnings}</span>
          <span class="overview-budget-pill">active policy ${policies.length}</span>
        </span>`;
      }

      if (incidents.length === 0) {
        root.innerHTML = '<div class="overview-budget-empty">当前没有未处理预算事件。</div>';
        return;
      }

      root.innerHTML = incidents.map(i => {
        const hard = i.thresholdType === 'hard_stop';
        const kind = hard ? 'Hard stop' : 'Warning';
        const usage = `${window.BudgetUtils.fmtBudgetMetric(i.metric, i.observedAmount)} / ${window.BudgetUtils.fmtBudgetMetric(i.metric, i.limitAmount)}`;
        const pct = i.limitAmount > 0 ? Math.round((i.observedAmount / i.limitAmount) * 100) : 0;
        const scope = window.BudgetUtils.budgetScopeLabel(i.scopeType, i.scopeId);
        return `<div class="overview-budget-incident ${hard ? 'is-hard' : 'is-warn'}" data-incident-id="${escapeHtml(i.id)}">
          <div>
            <div class="kind">${kind}</div>
            <div class="meta">${escapeHtml(i.windowKind || '-')} · ${window.BudgetUtils.fmtBudgetTime(i.createdAt)}</div>
          </div>
          <div class="scope" title="${escapeHtml(scope)}">
            作用域 <code>${escapeHtml(scope)}</code>
          </div>
          <div class="usage">
            <strong>${escapeHtml(usage)}</strong> · ${pct}%
          </div>
          <div class="actions">
            <button class="cxbtn cxbtn-secondary cxbtn-sm" data-budget-resolve="${escapeHtml(i.id)}">标记已处理</button>
          </div>
        </div>`;
      }).join('');

      root.querySelectorAll('[data-budget-resolve]').forEach(btn => {
        btn.addEventListener('click', () => resolveBudgetIncident(btn.dataset.budgetResolve));
      });
    }

    // cleanOldMetrics 第15批从 app.js 迁入（overview 是语义属主：retention 清理按钮在区块D）
    async function cleanOldMetrics() {
      // 默认建议：3 个月前的删
      const now = new Date();
      const ago = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const defaultMonth = `${ago.getFullYear()}-${String(ago.getMonth() + 1).padStart(2, '0')}`;
      const month = await promptModal(
        '清理 metrics（输入 YYYY-MM，删除该月份及之前的 metrics-*.jsonl）',
        defaultMonth
      );
      if (!month) return;
      if (!/^\d{4}-\d{2}$/.test(month)) { toast('格式应为 YYYY-MM', 'error'); return; }
      const confirm = await confirmModal({
        title: '清理老 metrics',
        message: `将删除 ${month} 及之前的所有 metrics-*.jsonl 文件。此操作不可撤销。`,
        confirmLabel: '删除', cancelLabel: '取消',
      });
      if (!confirm) return;
      try {
        const r = await fetch('/api/metrics?olderThan=' + encodeURIComponent(month), { method: 'DELETE' }).then(x => x.json());
        if (r.ok) {
          toast(`已删除 ${r.count} 个文件：${(r.deleted || []).join(', ') || '（无）'}`, 'success', 3500);
          refreshOverview();
        } else {
          toast('清理失败：' + (r.error || 'unknown'), 'error');
        }
      } catch (e) {
        toast('清理失败：' + e.message, 'error');
      }
    }

    async function resolveBudgetIncident(id) {
      if (!id) return;
      try {
        const r = await fetch(`/api/budgets/incidents/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).then(x => x.json());
        if (!r.ok) {
          toast('处理失败：' + (r.error || 'unknown'), 'error');
          return;
        }
        toast('预算事件已处理', 'success', 1500);
        refreshOverview();
      } catch (e) {
        toast('处理失败：' + e.message, 'error');
      }
    }

    function governanceKindLabel(kind) {
      return ({
        approval: '审批',
        budget: '预算',
        delegation: '委派',
        autopilot_job: '调度',
      })[kind] || kind || '事件';
    }

    function governanceTarget(kind) {
      if (kind === 'approval') return () => window.PanelCore.openApprovalModal?.();
      if (kind === 'budget') return () => showOverviewArea();
      if (kind === 'delegation') return () => window.PanelCore.openDelegationModal?.();
      if (kind === 'autopilot_job') return () => window.PanelAutopilot?.open();
      return null;
    }

    function renderOverviewBlockF(governance) {
      const summary = $('#ovGovernanceSummary');
      const root = $('#ovGovernanceList');
      if (!root) return;
      const counts = governance?.counts || {};
      const blockers = Array.isArray(governance?.blockers) ? governance.blockers : [];
      if (summary) {
        summary.innerHTML = `<span class="overview-governance-summary">
          <span class="overview-governance-pill ${counts.hardBlockers ? 'is-hard' : ''}">hard ${counts.hardBlockers || 0}</span>
          <span class="overview-governance-pill ${counts.attention ? 'is-warn' : ''}">attention ${counts.attention || 0}</span>
          <span class="overview-governance-pill">open ${counts.totalOpen || 0}</span>
        </span>`;
      }
      if (!blockers.length) {
        root.innerHTML = '<div class="overview-governance-empty">当前没有待处理治理事项。</div>';
        return;
      }
      root.innerHTML = blockers.slice(0, 12).map(b => {
        const sev = safeClassToken(b.severity || 'info');
        const title = String(b.title || b.id || '').slice(0, 160);
        return `<button class="overview-governance-item sev-${sev}" data-governance-kind="${escapeHtml(b.kind)}">
          <span class="kind">${escapeHtml(governanceKindLabel(b.kind))}</span>
          <span class="title" title="${escapeHtml(title)}">${escapeHtml(title || b.id)}</span>
          <span class="status">${escapeHtml(b.status || '-')}</span>
        </button>`;
      }).join('');
      root.querySelectorAll('[data-governance-kind]').forEach(btn => {
        const open = governanceTarget(btn.dataset.governanceKind);
        if (open) btn.addEventListener('click', open);
      });
    }

    // ② 总览 WS 订阅器（搬进模块 boot，用 window.PanelGlobalWs.subscribe）
    window.PanelGlobalWs?.subscribe((msg) => {
      if (msg.type === 'metrics_update') {
        if (overviewState.shown) {
          if (overviewState._pendingRefresh) return;
          overviewState._pendingRefresh = setTimeout(() => {
            overviewState._pendingRefresh = null;
            refreshOverview();
          }, 1500);
        }
      } else if (msg.type === 'health_warning') {
        // 任何时候都 toast 提醒
        const warnings = Array.isArray(msg.warnings) ? msg.warnings : [];
        for (const w of warnings.slice(0, 3)) toast('⚠️ ' + w, 'error', 8000);
        if (overviewState.shown) refreshOverview();
      } else if (msg.type === 'reconnected') {
        // WS 重连成功：断线期间指标推送可能丢失，若总览打开则立即补刷
        if (overviewState.shown) refreshOverview();
      }
    });

    // ③ #btnOverview 点击处理
    $('#btnOverview')?.addEventListener('click', () => {
      if (overviewState.shown) hideOverviewArea();
      else showOverviewArea();
    });

    // ④ 总览 4 绑定
    $('#btnOverviewBack')?.addEventListener('click', hideOverviewArea);
    $('#btnOverviewRefresh')?.addEventListener('click', refreshOverview);
    $('#overviewRangeSelect')?.addEventListener('change', (e) => {
      overviewState.range = e.target.value;
      // 切换时间窗时销毁旧 chart 重建（避免坐标轴遗留）
      if (overviewState.charts.ts) { overviewState.charts.ts.destroy(); overviewState.charts.ts = null; }
      if (overviewState.charts.byAdapter) { overviewState.charts.byAdapter.destroy(); overviewState.charts.byAdapter = null; }
      refreshOverview();
    });
    $('#ovByAdapterMetric')?.addEventListener('change', (e) => {
      overviewState.byAdapterMetric = e.target.value;
      if (overviewState.charts.byAdapter) { overviewState.charts.byAdapter.destroy(); overviewState.charts.byAdapter = null; }
      refreshOverview();
    });

    window.PanelOverview = {
      get state() { return overviewState; },
      showOverviewArea,
      hideOverviewArea,
      refreshOverview,
      ensureChartLib,
      cleanOldMetrics,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
