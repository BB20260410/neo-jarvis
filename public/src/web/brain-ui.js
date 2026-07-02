const BRAIN_IDS_TO_HIDE = [
  'mainHeader',
  'overviewArea',
  'termArea',
  'roomArea',
  'pluginArea',
  'mcpArea',
  'archiveArea',
  'webhookArea',
  'autopilotArea',
  'roomAdaptersArea',
  'governanceArea',
  'agentRegistryArea',
  'codebaseCenterArea',
  'knowledgeCenterArea',
  'activityArea',
  'delegationsArea',
];

const thoughtItems = [];
let refreshTimer = null;
let ws = null;

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function fmtTime(ts) {
  if (!ts) return '-';
  try { return new Date(ts).toLocaleTimeString(); } catch { return '-'; }
}

async function noeFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function hideOtherWorkspaces() {
  for (const id of BRAIN_IDS_TO_HIDE) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

function showBrain() {
  const root = $('#noeBrainArea');
  if (!root) return;
  hideOtherWorkspaces();
  root.style.display = 'flex';
  refreshBrain();
  connectThoughtStream();
  if (!refreshTimer) refreshTimer = setInterval(refreshBrain, 10_000);
}

function hideBrain() {
  const root = $('#noeBrainArea');
  if (root) root.style.display = 'none';
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function addThought(item = {}) {
  thoughtItems.unshift({
    at: item.at || item.event?.ts || Date.now(),
    text: item.text || item.type || item.event?.tag || 'noe event',
    detail: item.event ? `tick ${item.event.tickCount || '-'}` : '',
  });
  thoughtItems.splice(20);
  renderThoughts();
}

function renderThoughts() {
  const root = $('#noeThoughtStream');
  const count = $('#noeThoughtCount');
  if (count) count.textContent = String(thoughtItems.length);
  if (!root) return;
  root.innerHTML = thoughtItems.length
    ? thoughtItems.map((item) => `
      <div class="noe-brain-row">
        <strong>${escapeHtml(fmtTime(item.at))}</strong>
        <span>${escapeHtml(item.text)}${item.detail ? ' · ' + escapeHtml(item.detail) : ''}</span>
      </div>
    `).join('')
    : '<div class="noe-brain-empty">暂无 loop 事件。</div>';
}

function buildWsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = window.PanelOwnerAuth?.getToken?.() || '';
  const base = window.PanelWs?.buildWsUrl ? window.PanelWs.buildWsUrl(path) : `${proto}://${location.host}${path}`;
  if (!token || /[?&]token=/.test(base)) return base;
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

function connectThoughtStream() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(buildWsUrl('/ws/global'));
    ws.onmessage = (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { return; }
      if (String(data.type || '').startsWith('noe_')) addThought(data);
    };
    ws.onclose = () => { ws = null; };
  } catch {
    ws = null;
  }
}

function renderMetrics(root, rows) {
  if (!root) return;
  root.innerHTML = rows.map(([key, value]) => `
    <div class="noe-brain-metric"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join('');
}

function renderList(root, items, empty, renderer) {
  if (!root) return;
  root.innerHTML = items.length ? items.map(renderer).join('') : `<div class="noe-brain-empty">${escapeHtml(empty)}</div>`;
}

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = String(value ?? '-');
}

function actLabel(act) {
  if (!act) return '-';
  return `${act.status || 'unknown'} · ${act.title || act.action || act.id}`;
}

function budgetLabel(act) {
  if (!act) return 'unknown';
  const state = act.budgetState || 'unknown';
  const estimate = Number(act.costEstimateUsd) || 0;
  return `${state} · $${estimate.toFixed(4)}`;
}

function renderActLink(act) {
  const link = $('#noeEvidenceLogLink');
  if (!link) return;
  if (act?.logRef) {
    link.textContent = act.logRef;
    link.href = `#${encodeURIComponent(act.logRef)}`;
    link.setAttribute('aria-disabled', 'false');
  } else {
    link.textContent = '暂无可复现日志';
    link.href = '#';
    link.setAttribute('aria-disabled', 'true');
  }
}

async function refreshBrain() {
  const root = $('#noeBrainArea');
  if (!root || root.style.display === 'none') return;
  try {
    const health = await noeFetch('/api/noe/health');
    const loop = health.loop || {};
    if ($('#noeLoopState')) $('#noeLoopState').textContent = loop.state || 'unknown';
    if ($('#noeMemoryCount')) $('#noeMemoryCount').textContent = String(health.memory?.visible || 0);
    if ($('#noeFocusDepth')) $('#noeFocusDepth').textContent = String(health.focus?.depth || 0);
    if ($('#noeToolCount')) $('#noeToolCount').textContent = `${health.tools?.enabled || 0}/${health.tools?.total || 0}`;
    if ($('#noeHealthStatus')) $('#noeHealthStatus').textContent = health.health?.status || 'ok';
    renderMetrics($('#noeLoopMetrics'), [
      ['enabled', loop.enabled ? 'true' : 'false'],
      ['actMode', loop.actMode ? 'true' : 'false'],
      ['ticks', loop.tickCount || 0],
      ['last', fmtTime(loop.lastTickAt)],
      ['error', loop.lastError || '-'],
    ]);
    renderMetrics($('#noeHealthMetrics'), [
      ['memory fts', health.memory?.fts ? 'on' : 'off'],
      ['focus depth', health.focus?.depth || 0],
      ['pending approvals', health.approvals?.pending || 0],
      ['pending acts', health.acts?.pending || 0],
      ['tools disabled', health.tools?.disabled || 0],
    ]);
    await Promise.all([refreshFocus(), refreshTools(), refreshApprovals(), refreshActs()]);
  } catch (e) {
    if ($('#noeHealthStatus')) $('#noeHealthStatus').textContent = 'error';
    renderMetrics($('#noeHealthMetrics'), [['error', e.message || String(e)]]);
  }
}

async function refreshActs() {
  const data = await noeFetch('/api/noe/acts?limit=12');
  const items = data.items || [];
  const current = data.summary?.current || items[0] || null;
  setText('#noeActPendingCount', data.summary?.pending ?? items.length);
  setText('#noeCurrentAct', actLabel(current));
  setText('#noeApprovalStatus', current?.approvalId ? `${current.status} · ${current.approvalId}` : (current?.status === 'awaiting_approval' ? 'approval_required' : 'none'));
  setText('#noeToolPermissionStatus', current?.permissionState || 'unknown');
  setText('#noeBudgetStatus', budgetLabel(current));
  setText('#noeFailureReason', current?.failureReason || '-');
  renderActLink(current);
  renderList($('#noeActQueue'), items, '暂无 act；点击 Act Tick 生成一次 dry-run 证据。', (act) => `
    <div class="noe-brain-row noe-act-row" data-act-status="${escapeHtml(act.status)}">
      <strong>${escapeHtml(act.status)}</strong>
      <span>${escapeHtml(act.title || act.action)} · ${escapeHtml(act.riskLevel || 'low')} · ${escapeHtml(budgetLabel(act))}</span>
      <button class="cxbtn cxbtn-tertiary cxbtn-xs" data-noe-cancel-act="${escapeHtml(act.id)}">Cancel</button>
    </div>
  `);
}

async function refreshFocus() {
  const data = await noeFetch('/api/noe/focus?limit=20');
  renderList($('#noeFocusList'), data.items || [], '当前没有焦点。', (item) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.summary || 'depth ' + item.depth)}</span>
      <button class="cxbtn cxbtn-tertiary cxbtn-xs" data-noe-pop-focus="${escapeHtml(item.id)}">Pop</button>
    </div>
  `);
}

async function refreshMemory() {
  const q = encodeURIComponent($('#noeMemoryQuery')?.value || '');
  const data = await noeFetch(`/api/noe/memory?q=${q}&limit=10`);
  renderList($('#noeMemoryList'), data.items || [], '没有召回结果。', (item) => {
    // M1：展示来源与可信度（数据来自 MemoryCore，之前 UI 未渲染）
    const conf = typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '-';
    const src = item.sourceType || 'manual';
    const scope = item.scope ? ` · ${item.scope}` : '';
    const expired = item.expired ? ' · 已过期' : '';
    const merged = Array.isArray(item.mergeTrace) && item.mergeTrace.length ? ` · 合并×${item.mergeTrace.length}` : '';
    return `
    <div class="noe-brain-row">
      <strong>${escapeHtml(item.title || item.id)}</strong>
      <span>${escapeHtml(item.body || '').slice(0, 160)}</span>
      <span class="noe-brain-meta">可信度 ${escapeHtml(conf)} · 来源 ${escapeHtml(src)}${escapeHtml(scope)}${escapeHtml(expired)}${escapeHtml(merged)}</span>
    </div>
  `;
  });
}

async function refreshTools() {
  const data = await noeFetch('/api/noe/tools');
  renderList($('#noeToolsList'), data.tools || [], '暂无工具 manifest；默认不会执行任何工具。', (tool) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(tool.name)}</strong>
      <span>${escapeHtml(tool.riskLevel)} · ${tool.enabled ? 'enabled' : 'disabled'}</span>
    </div>
  `);
}

async function refreshApprovals() {
  const data = await noeFetch('/api/noe/approvals?status=pending&limit=10');
  renderList($('#noeApprovalsList'), data.approvals || [], '没有待处理审批。', (approval) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(approval.type || approval.id)}</strong>
      <span>${escapeHtml(approval.status || 'pending')}</span>
    </div>
  `);
}

function bindBrainUi() {
  $('#btnNoeBrain')?.addEventListener('click', () => {
    const root = $('#noeBrainArea');
    if (root && root.style.display !== 'none') hideBrain();
    else showBrain();
  });
  $('#btnNoeBrainBack')?.addEventListener('click', hideBrain);
  $('#btnNoeBrainRefresh')?.addEventListener('click', refreshBrain);
  $('#btnNoeLoopStart')?.addEventListener('click', async () => { await noeFetch('/api/noe/loop/start', { method: 'POST', body: '{}' }); await refreshBrain(); });
  $('#btnNoeLoopStop')?.addEventListener('click', async () => { await noeFetch('/api/noe/loop/stop', { method: 'POST', body: '{}' }); await refreshBrain(); });
  $('#btnNoeLoopTick')?.addEventListener('click', async () => { const r = await noeFetch('/api/noe/loop/tick', { method: 'POST', body: '{"force":true}' }); addThought({ type: 'manual_tick', event: r.event }); await refreshBrain(); });
  $('#btnNoeLoopActTick')?.addEventListener('click', async () => {
    await noeFetch('/api/noe/loop/start', { method: 'POST', body: '{"actMode":true}' });
    const r = await noeFetch('/api/noe/loop/tick', { method: 'POST', body: '{"force":true}' });
    addThought({ type: 'manual_act_tick', event: r.event });
    await refreshBrain();
  });
  $('#btnNoeMemorySearch')?.addEventListener('click', refreshMemory);
  $('#btnNoeMemoryWrite')?.addEventListener('click', async () => {
    const body = $('#noeMemoryBody')?.value || '';
    if (!body.trim()) return;
    await noeFetch('/api/noe/memory', { method: 'POST', body: JSON.stringify({ body, sourceType: 'brain_ui' }) });
    $('#noeMemoryBody').value = '';
    await refreshMemory();
    await refreshBrain();
  });
  $('#btnNoeFocusPush')?.addEventListener('click', async () => {
    const title = $('#noeFocusTitle')?.value || '';
    if (!title.trim()) return;
    await noeFetch('/api/noe/focus', { method: 'POST', body: JSON.stringify({ title, sourceType: 'brain_ui' }) });
    $('#noeFocusTitle').value = '';
    await refreshBrain();
  });
  $('#noeFocusList')?.addEventListener('click', async (event) => {
    const id = event.target?.dataset?.noePopFocus;
    if (!id) return;
    await noeFetch(`/api/noe/focus/${encodeURIComponent(id)}/pop`, { method: 'POST', body: '{}' });
    await refreshBrain();
  });
  $('#noeActQueue')?.addEventListener('click', async (event) => {
    const id = event.target?.dataset?.noeCancelAct;
    if (!id) return;
    await noeFetch(`/api/noe/acts/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
    await refreshBrain();
  });
  document.querySelectorAll('.nav-action').forEach((button) => {
    if (button.id !== 'btnNoeBrain') button.addEventListener('click', hideBrain);
  });
  renderThoughts();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindBrainUi, { once: true });
} else {
  bindBrainUi();
}
