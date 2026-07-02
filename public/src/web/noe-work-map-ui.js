// @ts-check

const WORK_KIND_LABEL = { goal: '目标', mission: '长任务', reportback: '回报', room: '房间', session: '会话', delegation: '委派', autopilot: '自动化', observation: '观察门' };
const WORK_TONE_LABEL = { active: '活跃', blocked: '阻塞', idle: '空闲', done: '完成' };
const WORK_STATUS_LABEL = { active: '活跃', archived: '归档', blocked: '阻塞', busy: '忙碌', current: '当前', done: '完成', idle: '空闲', loaded: '已加载', local: '本机', 'not running': '未运行', open: '排队', observe_due_expectations: '等期望判证', ready: '就绪', running: '执行中', stale: '过期', succeeded: '完成', total: '总数', unknown: '未知', waiting_approval: '等审批', waiting_for_natural_judgement: '等自然判证', wait_for_expectation_due: '等期望到期' };
const WORK_MAP_FILTERS = [
  ['all', '全部'],
  ['active', '活跃'],
  ['blocked', '阻塞'],
  ['goal', '目标'],
  ['mission', '长任务'],
  ['reportback', '回报'],
  ['room', '房间'],
  ['autopilot', '自动化'],
  ['observation', '观察门'],
];

export function createNoeWorkMapPanel({ api, $, esc, rel, short, renderRecentList }) {
  let activeFilter = 'all';
  let latestSnapshot = null;

  function stat(label, value, sub, tone = '') {
    return `<div class="work-map-stat ${esc(tone)}"><span>${esc(label)}</span><b>${esc(value)}</b><em>${esc(sub)}</em></div>`;
  }

  function cnStatus(value) {
    const raw = String(value || '').trim();
    const spaced = raw.replace(/_/g, ' ');
    return WORK_STATUS_LABEL[raw] || (/[A-Za-z]{3,}/.test(spaced) ? '状态已记录' : spaced) || '未知';
  }

  function cnReadable(value, fallback = '内容已记录') {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw) return fallback;
    return /[A-Za-z]{3,}/.test(raw) ? fallback : raw;
  }

  function fixed1(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(1) : '—';
  }

  function publicError(message, fallback = '读取失败') {
    const raw = String(message || '').trim();
    if (!raw) return fallback;
    if (/owner\s*token|required|owner-token|unauth|401|forbidden|permission/i.test(raw)) {
      return '受保护端点需要授权；公开运行状态仍会显示。';
    }
    return raw.replace(/HTTP/gi, '请求失败').replace(/_/g, ' ').trim();
  }

  function filterCount(items, key) {
    if (key === 'all') return items.length;
    if (['active', 'blocked', 'idle', 'done'].includes(key)) return items.filter((item) => item.tone === key).length;
    return items.filter((item) => item.kind === key).length;
  }

  function applyFilter(items) {
    if (activeFilter === 'all') return items;
    if (['active', 'blocked', 'idle', 'done'].includes(activeFilter)) return items.filter((item) => item.tone === activeFilter);
    return items.filter((item) => item.kind === activeFilter);
  }

  function renderFilters(items = []) {
    const box = $('workMapFilters');
    if (!box) return;
    box.innerHTML = WORK_MAP_FILTERS.map(([key, label]) => `
      <button type="button" class="${key === activeFilter ? 'active' : ''}" data-work-map-filter="${esc(key)}" aria-pressed="${key === activeFilter ? 'true' : 'false'}">
        ${esc(label)} ${filterCount(items, key)}
      </button>`).join('');
    box.querySelectorAll?.('[data-work-map-filter]')?.forEach((button) => {
      button.addEventListener('click', () => {
        activeFilter = button.getAttribute('data-work-map-filter') || 'all';
        render(latestSnapshot || {});
      });
    });
  }

  function render(d = {}) {
    latestSnapshot = d;
    const status = $('workMapStatus');
    const summary = $('workMapSummary');
    const stats = $('workMapStats');
    const list = $('workMapItems');
    const counts = d.counts || {};
    const active = Number(counts.activeWorkItems || 0);
    const blocked = Number(counts.blockedWorkItems || 0);
    const sqliteAvailable = d.sources?.sqlite?.available === true;
    const scheduler = counts.observationStatus?.followup?.scheduler;
    const schedulerExpectation = counts.observationStatus?.followup?.schedulerExpectation;
    const schedulerLogsOk = scheduler?.logs?.stdout?.exists === true || scheduler?.logs?.stderr?.exists === true;
    const p8Daily = counts.observationStatus?.p8DailyObservation;
    const schedulerNextText = schedulerExpectation?.expectedNextRunAtLocal
      ? ` · 下次 ${short(schedulerExpectation.expectedNextRunAtLocal, 16)}`
      : '';
    const schedulerStaleText = schedulerExpectation?.staleIfNoRunAfterLocal
      ? ` · 超时 ${short(schedulerExpectation.staleIfNoRunAfterLocal, 16)}`
      : '';
    const schedulerEvidenceText = schedulerExpectation?.lastEvidenceAtLocal
      ? ` · 证据 ${short(schedulerExpectation.lastEvidenceAtLocal, 16)}`
      : '';
    const p8DailyText = p8Daily?.available
      ? ` · P8 ${p8Daily.observationDayIndex || 0}/${p8Daily.minObservationDays || 7}天 · 剩 ${fixed1(p8Daily.daysRemaining)}天`
      : '';
    const p8StopText = p8Daily?.doNotStartNextStage ? ' · 禁止P9/R' : '';
    const completionGate = counts.observationStatus?.followup?.completionGate;
    const resumeProtocol = counts.observationStatus?.followup?.resumeProtocol;
    const staleReportbacks = Number(counts.reportbacks?.staleActive || 0);
    const tone = blocked ? 'blocked' : active ? 'active' : 'idle';
    status.className = `work-map-status ${tone}`;
    status.textContent = `${WORK_TONE_LABEL[tone] || tone} · 活跃 ${active}`;
    summary.textContent = sqliteAvailable
      ? `本机数据库与运行状态已汇总 · ${new Date(d.generatedAt || Date.now()).toLocaleTimeString('zh-CN')}`
      : `文件态已汇总 · 本机数据库不可读：${short(publicError(d.sources?.sqlite?.error || '不可用'), 90)}`;
    stats.innerHTML = [
      stat('会话', counts.sessions?.active || 0, `忙碌 ${counts.sessions?.busy || 0}`),
      stat('房间', counts.rooms?.activeCount || 0, `归档 ${counts.rooms?.archivedCount || 0}`),
      stat('目标', counts.goals?.active || 0, `总数 ${counts.goals?.total || 0}`, counts.goals?.active ? 'active' : ''),
      stat('目标链路', counts.goals?.hygiene?.withoutCheckpoints || 0, `已检查 ${counts.goals?.hygiene?.checkpointBacked || 0}`, counts.goals?.hygiene?.withoutCheckpoints ? 'blocked' : ''),
      stat('长任务', counts.missions?.active || 0, `总数 ${counts.missions?.total || 0}`, counts.missions?.active ? 'active' : ''),
      stat(
        '回报',
        counts.reportbacks?.active || 0,
        `当前 ${counts.reportbacks?.current || 0}${staleReportbacks ? ` · 过期 ${staleReportbacks}` : ''}`,
        staleReportbacks ? 'blocked' : (counts.reportbacks?.active ? 'active' : ''),
      ),
      stat('委派', counts.delegations?.total || 0, `作业 ${counts.autopilot?.total || 0}`),
      stat('观察门', counts.observationStatus?.readyForNextStageReview ? '就绪' : cnStatus(counts.observationStatus?.status || '—'), `${counts.observationStatus?.blockerCount || 0} 阻塞 · 跟进 ${cnStatus(counts.observationStatus?.followup?.status || '—')}${p8DailyText}${p8StopText}${completionGate ? ` · 完成门 ${completionGate.canMarkComplete ? '可完成' : '不可完成'}` : ''}${resumeProtocol ? ` · 续跑 ${resumeProtocol.canRunNow ? '可运行' : resumeProtocol.waitingForNaturalJudgement ? '等判证' : '等待'}` : ''}${scheduler?.available ? ` · 调度 ${cnStatus(scheduler.state || 'loaded')}` : ''}${schedulerLogsOk ? ' · 日志 ok' : ''}${schedulerEvidenceText}${schedulerNextText}${schedulerStaleText}`, counts.observationStatus?.readyForNextStageReview ? 'done' : 'blocked'),
      stat('阻塞', blocked, `条目 ${d.workItems?.length || 0}`, blocked ? 'blocked' : ''),
    ].join('');

    const allItems = d.workItems || [];
    renderFilters(allItems);
    const items = applyFilter(allItems).slice(0, 50);
    if (!items.length) {
      list.innerHTML = activeFilter === 'all'
        ? '<div class="empty">当前没有可显示的活跃任务条目</div>'
        : '<div class="empty">当前筛选没有匹配任务条目</div>';
      return;
    }
    const first = items[0] || {};
    const firstKey = `${first.kind}:${first.id}:${first.status}:${first.updatedAt || ''}`;
    const html = items.map((item) => {
      const when = item.updatedAt ? rel(Date.parse(item.updatedAt)) : '无时间';
      const kind = WORK_KIND_LABEL[item.kind] || item.kind || '任务';
      const toneLabel = WORK_TONE_LABEL[item.tone] || cnStatus(item.tone || item.status || 'unknown');
      const evidence = Number(item.evidenceCount || 0) ? `<span class="chip">证据 ${esc(item.evidenceCount)}</span>` : '';
      const parent = item.parentId ? `<span class="chip">父项 ${esc(short(item.parentId, 36))}</span>` : '';
      const ref = item.ref ? `<span class="chip" title="${esc(item.ref)}">引用已记录</span>` : '';
      const stale = item.stale ? `<span class="chip">过期 ${esc(item.staleAgeMinutes || 0)} 分钟</span>` : '';
      const nextAction = item.nextAction ? `<span class="chip">${esc(short(cnReadable(item.nextAction, '下一步已记录'), 52))}</span>` : '';
      const title = cnReadable(item.title || '', item.id ? `${kind}已记录` : '未命名任务');
      return `<div class="item work-map-item ${esc(item.tone || '')}">
        <div class="row1">
          <span class="badge work-kind">${esc(kind)}</span>
          <span class="badge work-tone ${esc(item.tone || '')}">${esc(toneLabel)}</span>
          <span class="t">${esc(cnStatus(item.status || 'unknown'))}</span>
          <span class="t">${esc(when)}</span>
        </div>
        <div class="txt">${esc(title)}</div>
        <div class="meta">
          <span class="chip">${esc(cnStatus(item.source || 'local'))}</span>
          ${item.detail ? `<span class="chip">${esc(cnReadable(item.detail, '详情已记录'))}</span>` : ''}
          ${stale}${nextAction}${evidence}${parent}${ref}
        </div>
      </div>`;
    }).join('');
    renderRecentList(list, html, firstKey);
  }

  async function load() {
    try { render(await api('/api/noe/work-map?limit=80')); }
    catch (e) {
      $('workMapStatus').className = 'work-map-status blocked';
      $('workMapStatus').textContent = '加载失败';
      $('workMapItems').innerHTML = `<div class="empty">任务地图加载失败：${esc(publicError(e.message))}</div>`;
    }
  }

  return { render, load };
}
