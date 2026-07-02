// @ts-check
// mind.js — 内心透视页逻辑（独立 ES module，不依赖主面板任何模块——零回归半径）。
// 数据源：/api/noe/mind/*（owner-token 鉴权，复用面板已存的 panel-owner-token；支持 ?t= 自举）。
const WORK_MAP_UI_URL = './src/web/noe-work-map-ui.js?v=earth-clean-20260614b';
const WORLD_SOCIAL_ACTIONS_URL = './src/web/noe-world-social-actions.js?v=earth-clean-20260614b';

try {
  history.scrollRestoration = 'manual';
  if (!location.hash) window.scrollTo({ top: 0, left: 0 });
} catch {
  // 浏览器不支持时保持默认滚动行为。
}

function ownerToken() {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('t');
    if (t) { sessionStorage.setItem('panel-owner-token', t); history.replaceState(null, '', u.pathname); }
  } catch { /* 自举失败走存量 */ }
  try { return localStorage.getItem('panel-owner-token') || sessionStorage.getItem('panel-owner-token') || ''; } catch { return ''; }
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': ownerToken() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || `请求失败 ${res.status}`);
  return j;
}

async function apiOutcome(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': ownerToken() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return {
    httpStatus: res.status,
    ok: res.ok && data.ok !== false,
    data,
    error: data.error || data.reason || `请求失败 ${res.status}`,
  };
}

const $ = (id) => /** @type {HTMLElement} */(document.getElementById(id));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function rel(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const fmt2 = (x) => (x >= 0 ? '+' : '') + Number(x).toFixed(2);
const SRC_CN = { owner_interaction: '主人', commitment_due: '到期牵挂', expectation_due: '到期预测', goal_step: '目标步', percept: '眼前', drive: '驱力', last_thought: '上一念' };
const short = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function uiSentence(value, fallback = '内容已记录') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return fallback;
  return /[A-Za-z]{3,}/.test(raw) ? fallback : raw;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
const MISSION_LABEL = { running: '执行中', recovering: '恢复中', waiting_approval: '等审批', blocked: '阻塞', paused: '暂停', cancelled: '取消', succeeded: '完成' };
const WORLD_TONE_LABEL = { ok: '稳定', warn: '需看护', bad: '阻塞', locked: '锁定', idle: '未活跃' };
const TECH_CN = {
  active: '活跃',
  all: '全部',
  available: '可用',
  blocked: '阻塞',
  boot_self_check: '开机自检',
  both: '双向来源',
  brain_ui: '脑内界面',
  candidate: '候选',
  completed: '已完成',
  configured_unavailable: '已配置但不可用',
  connected: '已连接',
  critical: '严重',
  diagnostic: '诊断',
  disconnected: '未连接',
  done: '完成',
  dropped: '已放弃',
  executing: '执行中',
  fact: '事实',
  fact_extract: '事实抽取',
  failed: '失败',
  high: '高',
  idle: '空闲',
  insight: '洞察',
  inner_monologue: '内心独白',
  linked: '有来源',
  local: '本机',
  low: '低',
  memory: '记忆',
  maintenance: '维护拍',
  meso: '中循环',
  missing: '缺失',
  micro: '轻量拍',
  nightly_reflection: '夜间反思',
  none: '无',
  not_configured: '未配置',
  ok: '正常',
  open: '排队',
  orphan: '缺来源',
  passed: '通过',
  paused: '暂停',
  pending: '待处理',
  pending_approval: '等待审批',
  project: '项目',
  proactive: '主动拍',
  proactive_tick: '主动拍',
  quarantined: '隔离中',
  research: '待研究',
  recovering: '恢复中',
  runtime_restart: '运行时重启',
  qq: '扣扣',
  qq_official_webhook: '扣扣官方回调',
  wechat_clawbot: '个人微信',
  wechatOfficial: '微信公众号',
  wecomIncoming: '企业微信',
  feishuVerification: '飞书',
  discordGateway: '外部聊天通道',
  expectation: '期望拍',
  innerReflect: '内循环反思',
  source: '原始',
  succeeded: '完成',
  unknown: '未知',
  unavailable: '不可用',
  user: '用户',
  vision: '视觉',
  waiting_approval: '等待审批',
  warn: '警告',
};
const PROOF_BLOCKER_CN = {
  not_enough_soak_evidence: '自然运行证据不足',
  expectation_settlements_below_20: '期望结算少于 20 条',
  no_owner_confirmed_delivery: '缺少主人确认交付样本',
  no_guard_records: '缺少护栏记录',
  live_expectation_resolved_below_20: '自然期望结算少于 20 条',
};
const MEMORY_SCOPE_CN = { fact: '事实', insight: '洞察', proactive: '主动', project: '项目', user: '用户', vision: '视觉' };
const MEMORY_SOURCE_CN = { both: '双向', brain_ui: '脑内界面', fact_extract: '事实抽取', nightly_reflection: '夜间反思', owner: '主人', runtime: '运行时' };
const GATE_DECISION_CN = { accepted: '已接纳', rejected: '已拒绝', quarantine: '隔离', quarantined: '隔离中', pending: '待审' };
const WORLD_FILTERS = [
  ['all', '全部'],
  ['bad', '阻塞'],
  ['locked', '锁定'],
  ['warn', '需看护'],
  ['ok', '稳定'],
  ['idle', '空闲'],
];
const WORLD_SOCIAL_KEYS = ['wechatOfficial', 'wecomIncoming', 'feishuVerification', 'discordGateway'];
const WORLD_HOTSPOT_LAYOUT = {
  runtime: { x: 486, y: 232, placement: 'orbit', orbitAngle: 338, orbitLane: -0.06, orbitRadius: 1.06, orbitPlaneIndex: 1, orbitSpeed: 0.00045 },
  boot: { x: 176, y: 76, placement: 'orbit', orbitAngle: 130, orbitLane: 0.13, orbitRadius: 1.32, orbitPlaneIndex: 0, orbitSpeed: 0.00039 },
  p6: { x: 502, y: 88, placement: 'orbit', orbitAngle: 26, orbitLane: 0.08, orbitRadius: 1.42, orbitPlaneIndex: 2, orbitSpeed: 0.00042 },
  social: { x: 552, y: 178, placement: 'orbit', orbitAngle: 324, orbitLane: 0.02, orbitRadius: 1.62, orbitPlaneIndex: 0, orbitSpeed: 0.00036 },
  mission: { x: 320, y: 318, placement: 'orbit', orbitAngle: 226, orbitLane: -0.1, orbitRadius: 1.36, orbitPlaneIndex: 3, orbitSpeed: 0.0004 },
  proof: { x: 320, y: 42, placement: 'orbit', orbitAngle: 68, orbitLane: 0.12, orbitRadius: 1.44, orbitPlaneIndex: 1, orbitSpeed: 0.00038 },
  vitals: { x: 94, y: 178, placement: 'orbit', orbitAngle: 178, orbitLane: 0, orbitRadius: 1.54, orbitPlaneIndex: 0, orbitSpeed: 0.00034 },
};
let worldEarthPromise = null;
let worldEarth = null;
let worldSelectedHotspot = '';
let worldActiveFilter = 'all';
let worldHotspotCache = [];
let memoryMode = 'search';
let worldActionMessage = '';
let initialHashSettled = false;
let chinaPanelOpen = false;

function cn(value, fallback = '未知') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (TECH_CN[raw]) return TECH_CN[raw];
  return raw
    .replace(/_/g, ' ')
    .replace(/\bready\b/gi, '就绪')
    .replace(/\bpassed\b/gi, '通过')
    .replace(/\bblocked\b/gi, '阻塞')
    .replace(/\bunknown\b/gi, '未知')
    .replace(/\bok\b/gi, '正常')
    .trim()
    .replace(/[A-Za-z][A-Za-z0-9/-]*/g, fallback);
}

function cnText(value, fallback = '内容已记录') {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return fallback;
  if (TECH_CN[raw]) return TECH_CN[raw];
  return /[A-Za-z]{3,}/.test(raw) ? fallback : raw;
}

function publicError(message, fallback = '读取失败') {
  const raw = String(message || '').trim();
  if (!raw) return fallback;
  if (/owner\s*token|required|owner-token|unauth|401|forbidden|permission/i.test(raw)) {
    return '受保护端点需要授权；公开运行状态仍会显示。';
  }
  return raw
    .replace(/HTTP/gi, '请求失败')
    .replace(/_/g, ' ')
    .trim();
}

function cnProofBlocker(value) {
  const raw = String(value || '').trim();
  return PROOF_BLOCKER_CN[raw] || cn(raw, '未知阻塞');
}

function cnMemoryScope(value) {
  return MEMORY_SCOPE_CN[String(value || '')] || cn(value, '记忆');
}

function cnMemorySource(value) {
  return MEMORY_SOURCE_CN[String(value || '')] || cn(value, '来源');
}

function cnGateDecision(value) {
  return GATE_DECISION_CN[String(value || '')] || cn(value, '待审');
}

function formatCountMap(map = {}, mapper = cn, limit = 5) {
  const entries = Object.entries(map).slice(0, limit);
  return entries.length ? entries.map(([key, value]) => `${mapper(key)} ${value}`).join(' · ') : '—';
}

function setTextIfPresent(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

let actionNoticeTimer = null;
function showActionNotice(text, tone = 'info') {
  const node = document.getElementById('actionNotice');
  if (!node) return;
  node.textContent = text || '';
  node.dataset.tone = tone;
  if (actionNoticeTimer) window.clearTimeout(actionNoticeTimer);
  if (text) {
    actionNoticeTimer = window.setTimeout(() => {
      node.textContent = '';
      delete node.dataset.tone;
    }, 4200);
  }
}

function cnJobKinds(kinds = []) {
  const values = Array.isArray(kinds) ? kinds : [];
  return values.map((kind) => cn(kind)).join(' / ') || '—';
}

function renderRecentList(box, html, firstKey) {
  const previous = box.dataset.firstKey || '';
  const manualAt = Number(box.dataset.manualScrollAt || 0);
  const recentlyManual = box.scrollTop > 24 && Date.now() - manualAt < 15_000;
  const shouldStick = !previous || box.scrollTop <= 24 || (firstKey && firstKey !== previous && !recentlyManual);
  box.dataset.rendering = '1';
  box.innerHTML = html;
  if (firstKey) box.dataset.firstKey = String(firstKey);
  if (shouldStick) box.scrollTop = 0;
  requestAnimationFrame(() => { delete box.dataset.rendering; });
}

function installRecentListScrollMemory(id) {
  const box = $(id);
  box.addEventListener('scroll', () => {
    if (box.dataset.rendering === '1') return;
    box.dataset.manualScrollAt = String(Date.now());
  }, { passive: true });
}

let workMapPanelPromise = null;
function getWorkMapPanel() {
  if (!workMapPanelPromise) {
    workMapPanelPromise = import(WORK_MAP_UI_URL)
      .then(({ createNoeWorkMapPanel }) => createNoeWorkMapPanel({ api, $, esc, rel, short, renderRecentList }));
  }
  return workMapPanelPromise;
}

let worldSocialActionsPromise = null;
function getWorldSocialActions() {
  if (!worldSocialActionsPromise) worldSocialActionsPromise = import(WORLD_SOCIAL_ACTIONS_URL);
  return worldSocialActionsPromise;
}

// ── 状态条 ──
function renderStrip(o) {
  $('pulseDot').className = 'pulse' + (o.heartbeat?.running ? ' alive' : '');
  const heart = $('statHeart');
  if (o.switches.heartbeat && o.heartbeat) {
    const st = o.tickStats || {};
    heart.classList.remove('off');
    heart.querySelector('.v').textContent = o.heartbeat.running ? '在跳' : '已停';
    heart.querySelector('.s').textContent = `作业 ${cnJobKinds(o.heartbeat.kinds)} · 成 ${st.done || 0} 败 ${st.failed || 0}`;
  } else { heart.classList.add('off'); heart.querySelector('.v').textContent = '未通电'; heart.querySelector('.s').textContent = '心跳服务关闭'; }

  const aff = $('statAffect');
  if (o.switches.affect && o.affect) {
    aff.classList.remove('off');
    aff.querySelector('.v').textContent = o.affect.label || '—';
    aff.querySelector('.s').textContent = `愉悦 ${fmt2(o.affect.v)} · 精神 ${Number(o.affect.a).toFixed(2)} · 掌控 ${fmt2(o.affect.d)}`;
  } else { aff.classList.add('off'); aff.querySelector('.v').textContent = '未通电'; aff.querySelector('.s').textContent = '情绪引擎关闭'; }

  const gl = $('statGoals');
  if (o.switches.goals && o.goals) {
    gl.classList.remove('off');
    gl.querySelector('.v').textContent = `推进中 ${o.goals.active || 0}`;
    gl.querySelector('.s').textContent = `待办 ${o.goals.open || 0} · 完成 ${o.goals.done || 0} · 搁置 ${o.goals.paused || 0}${o.maturity?.goalDoneRate != null ? ` · 完成率 ${Math.round(o.maturity.goalDoneRate * 100)}%/线50%` : ''}`;
  } else { gl.classList.add('off'); gl.querySelector('.v').textContent = '未通电'; gl.querySelector('.s').textContent = '目标系统关闭'; }

  const ex = $('statExpect');
  if (o.switches.expectations && o.expectations) {
    ex.classList.remove('off');
    ex.querySelector('.v').textContent = `未决 ${o.expectations.open}${o.expectations.due ? ` · 待裁 ${o.expectations.due}` : ''}`;
    ex.querySelector('.s').textContent = o.expectations.n ? `校准误差 ${o.expectations.brier}（已结算 ${o.expectations.n}）` : '还没有被结算的预测';
  } else { ex.classList.add('off'); ex.querySelector('.v').textContent = '未通电'; ex.querySelector('.s').textContent = '期望账本关闭'; }

  const ga = $('statGate');
  if (o.gate) {
    ga.classList.remove('off');
    ga.querySelector('.v').textContent = `已用 ${o.gate.usedToday}`;
    ga.querySelector('.s').textContent = `${o.gate.lastAt ? `上次开口 ${rel(o.gate.lastAt)}` : '今天还没开过口'}${o.maturity?.proactiveResponseRate != null ? ` · 30天回应率 ${Math.round(o.maturity.proactiveResponseRate * 100)}%` : ''}`;
  } else { ga.querySelector('.v').textContent = '—'; ga.querySelector('.s').textContent = '还没有浮现记账'; }
}

// ── 证明门 ──
function renderProof(d) {
  const card = $('proofCard');
  const score = $('proofScore');
  const status = $('proofStatus');
  const blockers = $('proofBlockers');
  const lastTick = $('proofLastTick');
  const lastThought = $('proofLastThought');
  const lastAction = $('proofLastAction');
  const lastRecovery = $('proofLastRecovery');
  card.classList.remove('passed', 'blocked');
  if (!d.enabled || !d.readiness) {
    score.textContent = '—';
    status.textContent = '未找到 output/noe-100-readiness 报告';
    blockers.innerHTML = '<span class="badge b-src">证明报告缺失</span>';
    lastTick.textContent = lastThought.textContent = lastAction.textContent = lastRecovery.textContent = '—';
    return;
  }
  const r = d.readiness;
  card.classList.add(r.passed ? 'passed' : 'blocked');
  score.textContent = `${r.score}%`;
  status.textContent = `${r.passedChecks}/${r.passedChecks + r.failedChecks} 项检查 · ${r.reportPath ? '报告已生成' : '未找到最新报告'}`;
  const bs = Array.isArray(r.blockers) ? r.blockers : [];
  blockers.innerHTML = bs.length
    ? bs.slice(0, 8).map((b) => `<span class="badge b-fire">${esc(cnProofBlocker(b))}</span>`).join('')
    : '<span class="ok">全部证明检查已通过</span>';
  const t = d.last?.tick;
  const thought = d.last?.thought;
  const action = d.last?.action;
  const recovery = d.last?.recovery;
  lastTick.textContent = t ? `${cn(t.kind || 'tick')} · ${cn(t.status || 'unknown')} · ${rel(t.finishedAt || t.startedAt || t.dueAt || Date.now())}` : '—';
  lastThought.textContent = thought ? `${cn(thought.type || 'thought')} · ${short(uiSentence(thought.summary, '上一念已记录'), 70)}` : '—';
  lastAction.textContent = action ? `${cn(action.status || 'unknown')} · ${short(uiSentence(action.title || action.action, '行动已记录'), 70)}` : '—';
  lastRecovery.textContent = recovery ? `${cn(recovery.kind || 'recovery')} · ${recovery.ok ? '正常' : '阻塞'} · ${recovery.ok ? '恢复完成' : short(recovery.summary, 80)}` : '—';
}

// ── 长期记忆 v2 ──
function renderMemoryStatus(d) {
  const summary = $('memorySummary');
  const stats = $('memoryStats');
  if (!d?.enabled) {
    summary.textContent = '记忆库未通电';
    stats.innerHTML = '';
    return;
  }
  const counts = d.counts || {};
  const linked = d.sourceLinked || {};
  const gate = d.writeGate || {};
  const retrieval = d.retrieval || {};
  const provider = d.semanticProvider || {};
  // P0-B（v4）：语义召回维度黑洞——queryDimOrphaned（运行时实测，fallback 降级态已由后端排除）或 mixedDim。
  const dh = provider.dimHealth || {};
  const dimBlackHole = Boolean(dh.queryDimOrphaned) || Boolean(dh.mixedDim);
  const dimKeys = Object.keys(dh.dims || {});
  const dimSummary = `可见 ${counts.visible || 0} / 总计 ${counts.total || 0} · 缺来源事实 ${linked.orphanFacts || 0} · 语义 ${provider.enabled ? '已启用' : '关闭'}`;
  summary.innerHTML = esc(dimSummary) + (dimBlackHole ? ' · <span style="color:#ff5a5a">⚠️语义召回维度黑洞</span>' : '');
  setTextIfPresent('memorySummaryRail', dimSummary + (dimBlackHole ? ' · ⚠️维度黑洞' : ''));
  const cells = [
    ['范围', formatCountMap(counts.byScope || {}, cnMemoryScope)],
    ['来源', formatCountMap(counts.bySourceType || {}, cnMemorySource, 4)],
    ['写入门', `接纳 ${gate.byDecision?.accepted || 0} · 拒绝 ${gate.byDecision?.rejected || 0} · 隔离 ${gate.quarantineCount || 0}`],
    ['检索', retrieval.hitRate == null ? `${retrieval.logs || 0} 条日志` : `命中 ${Math.round(retrieval.hitRate * 100)}% · ${retrieval.logs || 0} 条日志`],
    ['维度', dimBlackHole
      ? `⚠️黑洞 查询${dh.lastOrphanEvent?.queryDim ?? '?'}维∉库{${dimKeys.join('/') || '空'}}`
      : (dimKeys.length ? `${dimKeys.join('/')} 维` : '—')],
  ];
  // P2 杠杆2 可追溯：最近召回(真注入对话)用了哪条学过的 lesson——让 owner 看到「学了→被召回→用上」的成效。
  const recentLessons = Array.isArray(retrieval.recentLessons) ? retrieval.recentLessons : [];
  if (recentLessons.length) {
    cells.push(['用上的 lesson', recentLessons.map((l) => `${short(l.title || '', 40)}（累计命中${l.hitCount || 0}）`).join('；')]);
  }
  stats.innerHTML = cells.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

function renderMemoryItems(d) {
  const box = $('memoryItems');
  if (!d?.enabled) { box.innerHTML = '<div class="empty">记忆搜索未通电</div>'; return; }
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) { box.innerHTML = '<div class="empty">没有匹配的长期记忆</div>'; return; }
  box.innerHTML = items.map((m) => `
    <div class="item memory-item ${m.hidden ? 'hidden' : ''}">
      <div class="row1">
        <span class="badge b-src">${esc(cnMemoryScope(m.scope || 'memory'))}</span>
        <span class="badge ${m.sourceEpisodeId ? 'b-think' : 'b-fire'}">${esc(m.sourceEpisodeId ? '有来源' : '缺来源')}</span>
        <b>${esc(short(m.title || m.body, 80))}</b>
        <span class="t">${esc(cnMemorySource(m.sourceType || 'unknown'))} · 置信 ${Math.round(Number(m.confidence || 0) * 100)}%</span>
      </div>
      <div class="txt">${esc(m.body || '')}</div>
      <div class="meta">
        ${m.gate?.decision ? `<span class="chip">写入门 ${esc(cnGateDecision(m.gate.decision))}${m.gate.reason ? ` · ${esc(short(m.gate.reason, 80))}` : ''}</span>` : ''}
        ${Array.isArray(m.links) && m.links.length ? `<span class="chip">关联 ${esc(m.links.length)} 项</span>` : ''}
      </div>
      <textarea class="memory-edit-input" data-memory-edit-input="${esc(m.id)}">${esc(m.body || '')}</textarea>
      <div class="memory-ops">
        ${m.hidden ? `<button data-memory-unhide="${esc(m.id)}">恢复</button>` : `<button data-memory-hide="${esc(m.id)}">隐藏</button>`}
        <button data-memory-save="${esc(m.id)}">保存编辑</button>
        <button data-memory-delete="${esc(m.id)}">删除</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-memory-hide]').forEach((btn) => btn.addEventListener('click', async () => {
    await api('/api/noe/mind/memory/hide', { method: 'POST', body: { id: btn.getAttribute('data-memory-hide') } });
    await loadMemory();
  }));
  box.querySelectorAll('[data-memory-unhide]').forEach((btn) => btn.addEventListener('click', async () => {
    await api('/api/noe/mind/memory/unhide', { method: 'POST', body: { id: btn.getAttribute('data-memory-unhide') } });
    await loadMemory();
  }));
  box.querySelectorAll('[data-memory-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    await api('/api/noe/mind/memory/delete', { method: 'POST', body: { id: btn.getAttribute('data-memory-delete') } });
    await loadMemory();
  }));
  box.querySelectorAll('[data-memory-save]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-memory-save');
    const input = /** @type {HTMLTextAreaElement|null} */(btn.closest('.memory-item')?.querySelector('[data-memory-edit-input]'));
    await api('/api/noe/mind/memory/edit', { method: 'POST', body: { id, body: input?.value || '' } });
    await loadMemory();
  }));
}

function renderMemoryQuarantine(d) {
  const box = $('memoryItems');
  if (!d?.enabled) { box.innerHTML = '<div class="empty">隔离区未通电</div>'; return; }
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) { box.innerHTML = '<div class="empty">当前没有隔离候选</div>'; return; }
  box.innerHTML = items.map((c) => `
    <div class="item memory-item quarantined">
      <div class="row1">
        <span class="badge b-fire">${esc(cnGateDecision(c.decision || 'quarantined'))}</span>
        <span class="badge b-src">${esc(cn(c.kind || 'candidate'))}</span>
        <b>${esc(short(c.title || c.body || c.id, 80))}</b>
      </div>
      <div class="txt">${esc(c.reason || '—')}</div>
      <div class="meta">
        ${c.sourceEpisodeId ? '<span class="chip">有关联片段</span>' : ''}
        ${Array.isArray(c.evidenceRefs) && c.evidenceRefs.length ? `<span class="chip">证据 ${esc(c.evidenceRefs.length)} 项</span>` : ''}
      </div>
      <div class="memory-ops"><button data-candidate-replay="${esc(c.id)}">回放审计</button></div>
    </div>`).join('');
  box.querySelectorAll('[data-candidate-replay]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-candidate-replay');
    const replay = await api(`/api/noe/mind/memory/candidates/${encodeURIComponent(id || '')}/replay`);
    $('memorySummary').textContent = `候选 ${short(id, 28)} · ${cnGateDecision(replay.decision || 'unknown')} · ${short(replay.decisionReason || replay.reason || '', 120)}`;
  }));
}

// ── 意识流 ──
function thoughtBadge(t) {
  if (t.meta?.streamType === 'deliberation') return '<span class="badge b-deep">深思</span>';
  if (t.meta?.streamType === 'awareness' || t.type === 'awareness_tick') return '<span class="badge b-src">轻醒</span>';
  if (t.type === 'dream') return '<span class="badge b-dream">梦</span>';
  if (t.type === 'milestone') return '<span class="badge b-mile">里程碑</span>';
  return '<span class="badge b-think">随想</span>';
}
function renderThoughts(d) {
  const box = $('thoughts');
  if (!d.enabled) { box.innerHTML = '<div class="empty">时间线未通电</div>'; return; }
  if (!d.thoughts.length) { box.innerHTML = '<div class="empty">还没有念头——等下一个心跳周期</div>'; return; }
  const firstKey = d.thoughts[0] ? `${d.thoughts[0].type}:${d.thoughts[0].id || d.thoughts[0].ts}` : '';
  const html = d.thoughts.map((t) => {
    const m = t.meta || {};
    const metaChips = [
      m.focus ? `<span class="chip">焦点：${esc(SRC_CN[m.focus.source] || cn(m.focus.source, '来源'))} ${esc(m.focus.text || '')}</span>` : '',
      Array.isArray(m.echoRefs) && m.echoRefs.length ? `<span class="chip">回声 ${esc(m.echoRefs.join(','))}</span>` : '',
      m.rotated ? '<span class="chip">↻ 断路换题</span>' : '',
      m.affect ? `<span class="chip">心 ${fmt2(m.affect.v)}/${Number(m.affect.a).toFixed(2)}</span>` : '',
      m.prediction ? `<span class="chip">预测 ${esc(m.prediction.claim)}（概率=${m.prediction.p}）</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="item"><div class="row1"><span class="t">${rel(t.ts)}</span>${thoughtBadge(t)}</div><div class="txt">${esc(t.summary)}</div>${metaChips ? `<div class="meta">${metaChips}</div>` : ''}</div>`;
  }).join('');
  renderRecentList(box, html, firstKey);
}

// ── 意识日志 ──
function renderJournal(d) {
  const box = $('journal');
  if (!d.enabled) { box.innerHTML = '<div class="empty">工作区未通电，开了才有「注意力」可看</div>'; return; }
  if (!d.lines.length) { box.innerHTML = '<div class="empty">今天还没有认知周期记录</div>'; return; }
  const first = d.lines[0] || {};
  const firstKey = `${first.kind || 'line'}:${first.ts || ''}:${first.tickId || ''}`;
  const html = d.lines.slice(0, 80).map((l) => {
    if (l.kind === 'attend') {
      const w = l.winner;
      const ru = (l.runnerUps || []).map((r) => `${SRC_CN[r.source] || cn(r.source, '来源')} ${r.score}`).join('、');
      return `<div class="item"><div class="row1"><span class="t">${rel(l.ts)}</span>${w ? `<span class="badge b-src">${esc(SRC_CN[w.source] || cn(w.source, '来源'))}</span><span class="score">${w.score}</span>` : '<span class="badge b-src">无候选</span>'}${l.escalated ? '<span class="badge b-fire">↑深思</span>' : ''}</div>${w ? `<div class="txt">${esc(uiSentence(w.text, '注意内容已记录'))}</div>` : ''}${ru ? `<div class="meta"><span class="chip">落选：${esc(ru)}</span></div>` : ''}</div>`;
    }
    if (l.kind === 'deliberation_done') return `<div class="item"><div class="row1"><span class="t">${rel(l.ts)}</span><span class="badge b-deep">深思完成</span></div><div class="txt dim">${esc(l.topic)}${l.prediction ? ` → 🎯 ${esc(l.prediction.claim)}` : ''}${l.share ? ' → 想说一句' : ''}</div></div>`;
    if (l.kind === 'surfacing') return `<div class="item"><div class="row1"><span class="t">${rel(l.ts)}</span><span class="badge ${l.pass ? 'b-mile' : 'b-src'}">${l.pass ? '浮现放行' : '浮现拦下'}</span><span class="t">${esc(l.reason)}</span></div><div class="txt dim">${esc(l.text || '')}</div></div>`;
    if (l.kind === 'goal_progress') return `<div class="item"><div class="row1"><span class="t">${rel(l.ts)}</span><span class="badge b-mile">目标推进</span><span class="t">步骤 ${l.stepIndex + 1}</span></div></div>`;
    return '';
  }).join('');
  renderRecentList(box, html, firstKey);
}

// ── 情感曲线（纯 SVG，无依赖） ──
function renderAffect(d) {
  const box = $('affectChart');
  if (!d.enabled) { box.innerHTML = '<div class="empty">情感引擎未通电</div>'; $('affectNow').textContent = ''; return; }
  const rows = (d.history || []).slice().reverse(); // 时间正序
  if (rows.length < 2) { box.innerHTML = '<div class="empty">快照还太少，跑一会儿就有曲线了</div>'; }
  else {
    const t0 = rows[0].ts;
    const t1 = rows[rows.length - 1].ts || t0 + 1;
    const X = (ts) => 4 + 392 * ((ts - t0) / Math.max(1, t1 - t0));
    const Yv = (v) => 60 - v * 52;   // v∈[-1,1] → [112,8]
    const Ya = (a) => 112 - a * 104; // a∈[0,1] → [112,8]
    const lv = rows.map((r) => `${X(r.ts).toFixed(1)},${Yv(r.v).toFixed(1)}`).join(' ');
    const la = rows.map((r) => `${X(r.ts).toFixed(1)},${Ya(r.a).toFixed(1)}`).join(' ');
    box.textContent = '';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 400 120');
    svg.setAttribute('preserveAspectRatio', 'none');
    const mid = document.createElementNS(SVG_NS, 'line');
    mid.setAttribute('x1', '4');
    mid.setAttribute('y1', '60');
    mid.setAttribute('x2', '396');
    mid.setAttribute('y2', '60');
    mid.setAttribute('stroke', '#2a3139');
    mid.setAttribute('stroke-dasharray', '3,4');
    const arousal = document.createElementNS(SVG_NS, 'polyline');
    arousal.setAttribute('points', la);
    arousal.setAttribute('fill', 'none');
    arousal.setAttribute('stroke', '#7aa2f7');
    arousal.setAttribute('stroke-width', '1.4');
    arousal.setAttribute('opacity', '0.85');
    const valence = document.createElementNS(SVG_NS, 'polyline');
    valence.setAttribute('points', lv);
    valence.setAttribute('fill', 'none');
    valence.setAttribute('stroke', '#e0af68');
    valence.setAttribute('stroke-width', '1.8');
    svg.append(mid, arousal, valence);
    box.append(svg);
  }
  $('affectNow').textContent = d.now ? `此刻：${d.now.label}（愉悦 ${fmt2(d.now.v)} · 唤醒 ${Number(d.now.a).toFixed(2)} · 掌控 ${fmt2(d.now.d)}）` : '';
}

// ── P2 觉醒驾驶舱（活性可观测，全只读） ──
const fmt3 = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(3));

function renderCuriosityFunnel(d) {
  const box = $('curiosityFunnel');
  if (!box) return;
  if (!d || d.enabled === false) { box.innerHTML = '<div class="empty">期望账本 / 目标系统未通电</div>'; return; }
  const stages = Array.isArray(d.funnel) ? d.funnel : [];
  if (!stages.length) { box.innerHTML = '<div class="empty">暂无漏斗数据</div>'; return; }
  const rows = stages.map((s) => {
    const w = s.ofPrev == null ? 100 : Math.max(0, Math.min(100, s.ofPrev));
    return `<div class="funnel-row"><div class="funnel-meta"><span>${s.label}</span><b>${s.count}</b></div><div class="funnel-track"><i style="width:${w}%"></i></div><span class="funnel-pct">${s.ofPrev == null ? '' : s.ofPrev + '%'}</span></div>`;
  }).join('');
  const diag = Array.isArray(d.diagnostics) && d.diagnostics.length
    ? `<div class="funnel-diag">瓶颈：${(d.diagnostics[0].split(':')[1] || d.diagnostics[0]).trim()}</div>` : '';
  box.innerHTML = rows + diag;
}

function renderModelHealth(d) {
  const box = $('modelHealth');
  if (!box) return;
  if (!d || d.ok === false) { box.innerHTML = '<div class="empty">模型存活探测失败</div>'; return; }
  const dot = (ok) => `<span class="mh-dot ${ok ? 'on' : 'off'}"></span>`;
  const brainRow = (b) => `<div class="mh-row">${dot(b.loaded)}<span>${b.label || b.role || '脑'}</span><em>${b.loaded ? '已就位' : '未加载'}</em></div>`;
  const emb = d.embedding || {};
  const embOk = Boolean(emb.provider) && emb.provider !== 'hash' && emb.provider !== 'unknown' && emb.degraded !== true;
  box.innerHTML = [
    `<div class="mh-row">${dot(d.ollama?.available)}<span>Ollama</span><em>${d.ollama?.status || '—'}</em></div>`,
    `<div class="mh-row">${dot(d.lmstudio?.available)}<span>LM Studio</span><em>${d.lmstudio?.status || '—'}</em></div>`,
    `<div class="mh-sub">三脑就位 ${d.brainsReady ?? 0}/3</div>`,
    brainRow(d.brains?.main || {}), brainRow(d.brains?.review || {}), brainRow(d.brains?.fallback || {}),
    `<div class="mh-row">${dot(embOk)}<span>embedding</span><em>${emb.provider || '—'}${emb.dimension ? ' · ' + emb.dimension + '维' : ''}${emb.degraded ? ' · 降级' : ''}</em></div>`,
  ].join('');
}

function renderCalibration(d) {
  const box = $('calibrationCurve');
  const sum = $('calibrationSummary');
  if (!box) return;
  if (!d || d.enabled === false || !d.n) { box.innerHTML = '<div class="empty">还没有结算过的预测，画不出校准曲线</div>'; if (sum) sum.textContent = ''; return; }
  const bins = Array.isArray(d.bins) ? d.bins : [];
  box.textContent = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('preserveAspectRatio', 'none');
  const diag = document.createElementNS(SVG_NS, 'line');
  diag.setAttribute('x1', '8'); diag.setAttribute('y1', '112'); diag.setAttribute('x2', '112'); diag.setAttribute('y2', '8');
  diag.setAttribute('stroke', '#2a3139'); diag.setAttribute('stroke-dasharray', '3,4');
  svg.append(diag);
  if (bins.length) {
    const pts = bins.map((b) => `${(8 + 104 * b.avgPredicted).toFixed(1)},${(112 - 104 * b.observedRate).toFixed(1)}`).join(' ');
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#7aa2f7'); line.setAttribute('stroke-width', '1.6');
    svg.append(line);
    for (const b of bins) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', (8 + 104 * b.avgPredicted).toFixed(1));
      c.setAttribute('cy', (112 - 104 * b.observedRate).toFixed(1));
      c.setAttribute('r', Math.max(1.2, Math.min(4, Math.sqrt(b.count))).toFixed(1));
      c.setAttribute('fill', '#e0af68');
      svg.append(c);
    }
  }
  box.append(svg);
  const prov = d.provenance || {};
  let provNote = '（点越贴对角线越准）';
  if (prov.selfEvaluated) provNote = ' · ⚠ 全自评，无 owner holdout 旁证（非客观校准）';
  else if (prov.ownerHoldoutN) provNote = ` · owner holdout ${prov.ownerHoldoutN}/${d.n}${prov.ownerBrier != null ? '（owner Brier ' + fmt3(prov.ownerBrier) + '）' : ''}`;
  if (sum) sum.textContent = `Brier ${fmt3(d.brier)} · ECE ${fmt3(d.ece)} · MCE ${fmt3(d.mce)} · 样本 ${d.n}${provNote}`;
}

function renderIntegration(d) {
  const box = $('integrationChart');
  const sum = $('integrationSummary');
  if (!box) return;
  const hist = (d && Array.isArray(d.history)) ? d.history : [];
  if (!hist.length) { box.innerHTML = '<div class="empty">整合度未点火（NOE_INTEGRATION_METRIC）或还没采样</div>'; if (sum) sum.textContent = ''; return; }
  const t0 = hist[0].ts; const t1 = hist[hist.length - 1].ts || t0 + 1;
  const X = (ts) => 4 + 392 * ((ts - t0) / Math.max(1, t1 - t0));
  const Y = (v) => 112 - Math.max(0, Math.min(1, v)) * 104;
  const pts = hist.map((p) => `${X(p.ts).toFixed(1)},${Y(p.integration).toFixed(1)}`).join(' ');
  box.textContent = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 400 120'); svg.setAttribute('preserveAspectRatio', 'none');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#9ece6a'); line.setAttribute('stroke-width', '1.6');
  svg.append(line); box.append(svg);
  const latest = (d && d.latest) || hist[hist.length - 1];
  if (sum) sum.textContent = `最新整合度 ${fmt3(latest.integration)} · TC ${fmt3(latest.totalCorrelation)} bit · ${latest.label || ''}（${hist.length} 个采样点）`;
}

function renderAwakeningSignals(awakening, calib, integ) {
  const box = $('awakeningSignals');
  if (!box) return;
  // P2-B（修三方审查 serious）：4 维直接吃真 sampleAwakening——D4 自发性（独白/episode/自主目标）此前在前端整条丢失，
  //   旧版第 4 格用 funnel.surpriseGoalsActive 拼凑「自主研究」，与觉醒 4 维采样口径不一致。现补真 D4。
  const dim = awakening?.dimensions || {};
  const d1 = dim.d1_predictionLearning || {};
  const d3 = dim.d3_calibration || {};
  const d4 = dim.d4_spontaneity || {};
  const sg = d1.surpriseGoals ?? 0;
  const brier = d3.brier ?? calib?.brier;
  // D3 holdout 分层：有 owner 裁决子集才算客观校准，否则自评（优先 awakening 的 ownerN，回退 calib provenance）
  const selfEval = (d3.ownerN != null) ? (d3.ownerN === 0) : Boolean(calib?.provenance?.selfEvaluated);
  const hasInteg = Boolean(integ?.history?.length || integ?.latest?.samples);
  const tc = integ?.latest?.integration ?? (integ?.history?.length ? integ.history[integ.history.length - 1].integration : null);
  const spont = (d4.monologue24h ?? 0) + (d4.episode24h ?? 0);
  const sig = (label, val, hint, warn) => `<div class="sig"><div class="sig-v">${val}</div><div class="sig-l">${label}</div><div class="sig-h${warn ? ' sig-warn' : ''}">${hint}</div></div>`;
  box.innerHTML = [
    sig('预测-学习', sg, '近 7 天 surprise 立研究'),
    sig('整合度', (tc == null || !hasInteg) ? '—' : fmt3(tc), hasInteg ? '子系统耦合 TC' : '待点火 NOE_INTEGRATION_METRIC', !hasInteg),
    sig('校准', brier == null ? '—' : fmt3(brier), selfEval ? '⚠ 自评·非 holdout' : 'Brier 越低越准', selfEval),
    sig('自发性', spont, `近24h 独白${d4.monologue24h ?? 0}·episode${d4.episode24h ?? 0}·自主目标${d4.activeSelfGoals ?? 0}`),
  ].join('');
}

function renderWallSignals(d) {
  const box = $('wallSignals');
  if (!box) return;
  if (!d || !d.hit) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  // P2[2]（修三方审查 minor）：诚实文案——ON 时后端只写意图 kv(noe.wall.guard.*)，真执行端待 P3 器官接，不夸大"已启用"。
  const guard = d.guardEnabled ? '回滚意图已记录·执行端待 P3 器官接（NOE_WALL_GUARD）' : '仅告警 · 回滚需 owner 点火 NOE_WALL_GUARD';
  const rows = (d.signals || []).map((s) => `<div class="wall-row">⚠ ${esc(s.message)}<span class="wall-act">建议动作：${esc(s.action)}</span></div>`).join('');
  box.innerHTML = `<div class="wall-head">撞墙信号（防 Goodhart 自欺）· ${guard}</div>${rows}`;
}

// P9 自进化健康：把 NoeSelfEvolutionSlo 的三阶段聚合（implementer/apply/runtime_verify）搬上看板。
// 诚实呈现：implementer 仅含失败样本→successRate=null 标「仅失败样本」；耗时无源时 p50/p95=null 标「无耗时源」，不编造 MTTR。
const SE_STAGE_LABEL = { implementer: 'implementer 实现', apply: 'apply 落盘', runtime_verify: '运行时验证' };
const SE_REASON_LABEL = {
  network: '网络/连接', empty_plan: '空补丁计划', other: '其他',
  blocked: '被拦截', skipped: '跳过', dry_run_ready: '仅演练', unknown: '未知',
  tests_failed: '测试失败', report_untrusted: '报告不可信', nonzero_exit: '非零退出', rolled_back: '已回滚',
};
const seReason = (r) => SE_REASON_LABEL[r] || (r ? String(r) : '未知'); // P9-fix:未知 reason 显原文(调用处已 esc)保诊断信息,不吞成"未知"(防 P10 新失败分类丢信息)
const seRatePct = (rate) => (rate == null || Number.isNaN(Number(rate)) ? null : `${Math.round(Number(rate) * 100)}%`);
function seDurText(dur) {
  if (!dur || dur.sampleCount === 0 || (dur.p50Ms == null && dur.p95Ms == null)) return '耗时：无耗时源（产物缺 durationMs）';
  const ms = (v) => (v == null ? '—' : `${Math.round(Number(v))}ms`);
  return `耗时 P50 ${ms(dur.p50Ms)} · P95 ${ms(dur.p95Ms)}（n=${dur.sampleCount}）`;
}
function renderSelfEvolution(d) {
  const box = $('selfEvolution');
  if (!box) return;
  const slo = d && (d.slo || (d.stages ? d : null));
  if (!d || d.ok === false || !slo || !slo.stages) { box.innerHTML = '<div class="empty">自进化 SLO 加载失败</div>'; return; }
  const stages = slo.stages;
  const order = ['implementer', 'apply', 'runtime_verify'];
  const cards = order.map((key) => {
    const s = stages[key] || {};
    const total = Number(s.total) || 0;
    const ratePct = seRatePct(s.successRate);
    const rateHtml = ratePct == null
      ? `<div class="se-rate se-na" title="${esc(s.successRateNote || '无成功样本来源')}">—</div>`
      : `<div class="se-rate">${ratePct}</div>`;
    const reasons = Array.isArray(s.failureReasonsTopN) ? s.failureReasonsTopN.slice(0, 5) : [];
    const reasonHtml = reasons.length
      ? `<div class="se-reasons">${reasons.map((r) => `<div class="se-reason"><span>${esc(seReason(r.reason))}</span><b>${esc(String(r.count))}</b></div>`).join('')}</div>`
      : '';
    const counts = key === 'implementer'
      ? `样本 ${total} · 全为失败`
      : `成功 ${Number(s.success) || 0} / 计入 ${Number(s.ratedTotal ?? total) || 0}${s.legacyUnknown ? ` · 旧产物 ${s.legacyUnknown}` : ''}`;
    return [
      '<div class="se-stage">',
      `<div class="se-name">${esc(SE_STAGE_LABEL[key] || key)}</div>`,
      rateHtml,
      `<div class="se-counts">${esc(counts)}</div>`,
      `<div class="se-dur">${esc(seDurText(s.duration))}</div>`,
      reasonHtml,
      '</div>',
    ].join('');
  }).join('');
  const src = slo.sources || {};
  const srcLine = ['applyReports', 'runtimeVerify', 'implementerFail']
    .map((k) => `${k}=${Number(src[k]?.parsed) || 0}${src[k]?.skipped ? `(畸形${src[k].skipped})` : ''}`)
    .join(' · ');
  const gen = slo.generatedAt ? new Date(slo.generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  box.innerHTML = `<div class="se-stages">${cards}</div><div class="se-foot">产物 ${esc(srcLine)} · 纯只读 SLO · ${esc(gen)}</div>`;
}

async function loadAwakening() {
  try {
    const [mh, funnel, calib, integ, wall, awakening, selfEvo] = await Promise.all([
      api('/api/noe/mind/model-health').catch(() => null),
      api('/api/noe/mind/curiosity-funnel').catch(() => null),
      api('/api/noe/mind/calibration').catch(() => null),
      api('/api/noe/mind/integration/history').catch(() => null),
      api('/api/noe/mind/wall-signals').catch(() => null),
      api('/api/noe/mind/awakening-signals').catch(() => null),
      api('/api/noe/mind/self-evolution').catch(() => null),
    ]);
    renderModelHealth(mh);
    renderCuriosityFunnel(funnel);
    renderCalibration(calib);
    renderIntegration(integ);
    renderAwakeningSignals(awakening, calib, integ);
    renderWallSignals(wall);
    renderSelfEvolution(selfEvo);
  } catch { /* 觉醒看板失败不影响其余区块 */ }
}

// ── 期望账本 ──
async function resolveExpectation(id, outcome) {
  try {
    const r = await api('/api/noe/mind/expectations/resolve', { method: 'POST', body: { id, outcome } });
    if (r.curiosityGoalId) console.log('[mind] 高惊奇 → 已自动立研究目标', r.curiosityGoalId);
    await Promise.all([loadExpectations(), loadOverview(), loadGoals()]);
  } catch (e) { showActionNotice(`裁决失败：${publicError(e.message)}`, 'bad'); }
}
function renderExpectations(d) {
  const box = $('expectations');
  $('calibration').textContent = d.enabled ? (d.calibrationNote || '') : '';
  if (!d.enabled) { box.innerHTML = '<div class="empty">期望账本未通电</div>'; return; }
  const dueIds = new Set((d.due || []).map((x) => x.id));
  const open = (d.open || []).map((x) => {
    const isDue = dueIds.has(x.id);
    return `<div class="item"><div class="row1"><span class="t">${rel(x.created_at)}</span><span class="p-chip">p=${x.p}</span>${isDue ? '<span class="badge b-fire">待你裁决</span>' : (x.due_at ? `<span class="t">到期 ${rel(x.due_at)}</span>` : '')}</div><div class="txt">${esc(x.claim)}</div>${isDue ? `<div class="exp-actions"><button class="yes" data-id="${x.id}" data-oc="1">应验</button><button class="no" data-id="${x.id}" data-oc="0">落空</button><button class="na" data-id="${x.id}" data-oc="null">判不了</button></div>` : ''}</div>`;
  }).join('');
  const hist = (d.history || []).slice(0, 12).map((x) => `<div class="item dim"><div class="row1"><span class="t">${rel(x.resolved_at)}</span><span class="badge ${x.outcome === 1 ? 'b-mile' : x.outcome === 0 ? 'b-fire' : 'b-src'}">${x.outcome === 1 ? '应验' : x.outcome === 0 ? '落空' : '判不了'}</span><span class="p-chip">p=${x.p}</span>${x.surprise != null ? `<span class="surprise">惊奇 ${Number(x.surprise).toFixed(1)}bit</span>` : ''}</div><div class="txt">${esc(x.claim)}</div></div>`).join('');
  box.innerHTML = (open + hist) || '<div class="empty">他还没对世界下过注——念头里出现"明天/应该会"这类预测时会自动入账</div>';
  box.querySelectorAll('.exp-actions button').forEach((b) => b.addEventListener('click', () => {
    const oc = b.getAttribute('data-oc');
    resolveExpectation(Number(b.getAttribute('data-id')), oc === 'null' ? null : Number(oc));
  }));
}

// ── 目标 ──
const GOAL_SRC = { owner: '主人交办', commitment: '自生承诺', reflection: '深思提出', surprise: '好奇回路', drive: '驱力', self: '自生' };
const GOAL_STATUS_LABEL = { active: '推进中', open: '排队', paused: '搁置', done: '✓ 完成', dropped: '已放弃' };
const GOAL_STATUS_BADGE = { active: 'b-mile', done: 'b-think' };
function goalDiagnosticEvidence(g) {
  return (g.plan || [])
    .map((s, i) => {
      const note = String(s.note || '').replace(/\s+/g, ' ').trim();
      if (!/(?:exit=|stdout:|stderr:|行动完成|行动未放行|行动等 owner 审批|blocked|awaiting_approval)/i.test(note)) return null;
      return {
        index: i + 1,
        status: s.status || '',
        step: String(s.step || '').slice(0, 80),
        note: note.slice(0, 520),
      };
    })
    .filter(Boolean)
    .slice(-4);
}
async function setGoalStatus(id, status) {
  try { await api('/api/noe/mind/goals/status', { method: 'POST', body: { id, status } }); await loadGoals(); }
  catch (e) { showActionNotice(`操作失败：${publicError(e.message)}`, 'bad'); }
}
function renderGoals(d) {
  const box = $('goals');
  if (!d.enabled) { box.innerHTML = '<div class="empty">目标系统未通电</div>'; return; }
  const order = { active: 0, open: 1, paused: 2, done: 3, dropped: 4 };
  const goals = (d.goals || []).slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.priority - a.priority).slice(0, 30);
  if (!goals.length) { box.innerHTML = '<div class="empty">还没有目标——上面交办一个，或等好奇回路自己长出来</div>'; return; }
  box.innerHTML = goals.map((g) => {
    const steps = (g.plan || []).map((s) => `<li class="${s.status === 'done' ? 'done' : ''}" title="${esc(s.note || '')}">${esc(s.step)}</li>`).join('');
    const evidence = goalDiagnosticEvidence(g);
    const evidenceHtml = evidence.length ? `<details class="goal-diagnostics"><summary>诊断证据</summary>${evidence.map((e) => `<div class="goal-diagnostic-row"><span class="t">第 ${e.index} 步 · ${esc(cn(e.status, '状态'))}</span><div>${esc(e.step)}</div><pre>${esc(e.note)}</pre></div>`).join('')}</details>` : '';
    const safeGoalId = esc(g.id);
    const ops = g.status === 'done' || g.status === 'dropped' ? '' : `<div class="goal-ops">${g.status === 'paused' ? `<button data-id="${safeGoalId}" data-st="open">继续</button>` : `<button data-id="${safeGoalId}" data-st="paused">暂停</button>`}<button data-id="${safeGoalId}" data-st="dropped">放弃</button></div>`;
    const statusBadge = GOAL_STATUS_BADGE[g.status] || 'b-src';
    const statusLabel = GOAL_STATUS_LABEL[g.status] || esc(g.status);
    const sourceLabel = GOAL_SRC[g.source] || esc(cn(g.source, '来源'));
    const priority = Number.isFinite(Number(g.priority)) ? Number(g.priority) : 0;
    return `<div class="item"><div class="row1"><span class="badge ${statusBadge}">${statusLabel}</span><span class="badge b-src">${sourceLabel}</span><span class="score">${priority}</span></div><div class="txt">${esc(g.title)}</div>${g.why ? `<div class="meta"><span class="chip">${esc(g.why)}</span></div>` : ''}${steps ? `<ul class="goal-steps">${steps}</ul>` : ''}${evidenceHtml}${ops}</div>`;
  }).join('');
  box.querySelectorAll('.goal-ops button').forEach((b) => b.addEventListener('click', () => setGoalStatus(b.getAttribute('data-id'), b.getAttribute('data-st'))));
}

// ── 心跳台账 ──
function renderTicks(d) {
  const box = $('ticks');
  if (!d.enabled) { box.innerHTML = '<div class="empty">心跳未通电，主动性目前依赖前端轮询</div>'; return; }
  if (!d.ticks.length) { box.innerHTML = '<div class="empty">台账空——等第一跳</div>'; return; }
  const first = d.ticks[0] || {};
  const firstKey = `${first.kind || 'tick'}:${first.id || first.started_at || first.due_at || ''}`;
  const html = d.ticks.slice(0, 60).map((t) => {
    const dur = t.finished_at && t.started_at ? `${((t.finished_at - t.started_at) / 1000).toFixed(1)}s` : '';
    let extra = '';
    try { const o = JSON.parse(t.outcome || 'null'); if (o?.spoke === true) extra = `开口：「${o.text || ''}」`; else if (o?.reason) extra = `静默（${cn(o.reason, '原因已记录')}）`; else if (o?.dispatched) extra = '派发反刍'; } catch { /* 原样 */ }
    if (t.status === 'failed') extra = t.error || '失败';
    if (t.status === 'coalesced') { try { extra = `欠账合并 ×${JSON.parse(t.intent).missed}`; } catch { extra = '欠账合并'; } }
    return `<div class="item"><div class="row1"><span class="st-dot st-${esc(t.status)}"></span><span class="badge b-src">${esc(cn(t.kind || 'tick'))}</span><span class="t">${t.started_at ? rel(t.started_at) : rel(t.due_at)}</span><span class="t">${dur}</span></div>${extra ? `<div class="txt dim">${esc(extra)}</div>` : ''}</div>`;
  }).join('');
  renderRecentList(box, html, firstKey);
}

// ── 心智体征（M5 自审仪表：5 分钟一拉，嵌入计算服务端有缓存）──
function renderVitals(d) {
  const el = $('statVitals');
  if (!d.enabled) { el.classList.add('off'); el.querySelector('.v').textContent = '未启用'; el.querySelector('.s').textContent = '需嵌入模型'; return; }
  el.classList.remove('off');
  const div = d.diversity == null ? '—' : `${Math.round(d.diversity * 100)}%`;
  const grd = d.groundedRate == null ? '—' : `${Math.round(d.groundedRate * 100)}%`;
  el.querySelector('.v').textContent = `多样 ${div} · 接地 ${grd}`;
  el.querySelector('.s').textContent = `今日注意 ${d.journal.attend} 次 · 深思 ${d.journal.escalated} · 开口 ${d.journal.surfacedPass}`;
}
async function loadVitals() { try { renderVitals(await api('/api/noe/mind/vitals')); } catch { /* 仪表失败不打扰 */ } }
async function loadProof() { try { renderProof(await api('/api/noe/mind/proof')); } catch { $('proofStatus').textContent = '证明门加载失败'; } }

// ── 长任务运行时：长任务执行态必须持续可见，不能后台假装完成 ──
function renderMissionStat(d = {}) {
  const el = $('statMissions');
  const counts = d.counts || {};
  const active = Number(counts.running || 0) + Number(counts.recovering || 0) + Number(counts.waiting_approval || 0);
  const last = (d.missions || [])[0] || null;
  el.classList.toggle('off', !(d.missions || []).length);
  el.querySelector('.v').textContent = active ? `执行中 ${active}` : ((d.missions || []).length ? `最近 ${MISSION_LABEL[last.status] || last.status}` : '暂无');
  el.querySelector('.s').textContent = last
    ? `片段 ${last.currentSlice || 0} · 证据 ${last.evidenceCount || 0}`
    : '还没有 mission 账本';
}

async function reviewMission(missionId, decision) {
  try {
    await api(`/api/noe/missions/${encodeURIComponent(missionId)}/review`, { method: 'POST', body: { decision } });
    await loadMissions();
  } catch (e) {
    showActionNotice(`审批失败：${publicError(e.message)}`, 'bad');
  }
}

function renderMissions(d = {}) {
  renderMissionStat(d);
  const box = $('missions');
  const missions = d.missions || [];
  if (!missions.length) {
    box.innerHTML = '<div class="empty">还没有长任务运行时任务。启动长任务后会显示在这里。</div>';
    return;
  }
  const first = missions[0] || {};
  const firstKey = `${first.missionId}:${first.status}:${first.currentSlice}:${first.evidenceCount}`;
  const html = missions.slice(0, 20).map((m) => {
    const status = MISSION_LABEL[m.status] || cn(m.status || 'unknown');
    const progress = Math.max(0, Math.min(100, Number(m.progressPct) || 0));
    const heartbeatAt = Date.parse(m.lastHeartbeat || '');
    const hb = Number.isFinite(heartbeatAt) ? rel(heartbeatAt) : '无心跳';
    const next = m.nextAction ? cn(m.nextAction.type || '下一步') : '等待对账或结束';
    const refs = (m.latestEvidenceRefs || []).slice(-4).map((ref, index) => `<span class="badge b-src" title="${esc(ref)}">证据 ${index + 1}</span>`).join('');
    const blockers = (m.blockers || []).map((b) => esc(b.reason || b)).join('；');
    const approval = m.waitingApproval ? `
      <div class="mission-approval">
        <div class="txt">等待审批：${esc(m.waitingApproval.actionId)} · ${esc((m.waitingApproval.reasons || []).join(' / '))}</div>
        <div class="mission-approval-actions">
          <button class="approve" data-mission-review="${esc(m.missionId)}" data-decision="approved">批准继续</button>
          <button class="reject" data-mission-review="${esc(m.missionId)}" data-decision="rejected">驳回阻塞</button>
        </div>
      </div>` : '';
    return `<div class="item">
      <div class="row1">
        <span class="badge mission-status ${esc(m.status)}">${esc(status)}</span>
        <span class="t">任务记录</span>
        <span class="score">${progress}%</span>
        <span class="t">心跳 ${esc(hb)}</span>
      </div>
      <div class="txt">${esc(uiSentence(m.objective, '任务目标已记录'))}</div>
      <div class="meta">
        <span class="chip">片段 ${esc(m.currentSlice)} · 游标 ${esc(m.currentCursor)}/${esc(m.totalActions)}</span>
        <span class="chip">证据 ${esc(m.evidenceCount)} · 恢复 ${esc(m.recoveryAttempts)}</span>
        <span class="chip">下一步 ${esc(next)}</span>
      </div>
      <div class="mission-progress"><span style="width:${progress}%"></span></div>
      ${refs ? `<div class="mission-refs">${refs}</div>` : ''}
      ${blockers ? `<div class="meta"><span class="chip">阻塞：${blockers}</span></div>` : ''}
      ${approval}
    </div>`;
  }).join('');
  renderRecentList(box, html, firstKey);
  box.querySelectorAll('[data-mission-review]').forEach((button) => button.addEventListener('click', () => {
    reviewMission(button.getAttribute('data-mission-review'), button.getAttribute('data-decision'));
  }));
}
async function loadMissions() { try { renderMissions(await api('/api/noe/missions?limit=20')); } catch { $('missions').innerHTML = '<div class="empty">长任务运行时加载失败</div>'; } }

async function loadWorkMap() {
  const panel = await getWorkMapPanel();
  await panel.load();
}

function cnPanelLogStatus(status) {
  return {
    ok: '正常',
    missing: '未出现',
    blocked: '阻塞',
    unknown: '未知',
  }[status] || cn(status || 'unknown');
}

function renderPanelLogTail(data = {}) {
  const tail = data.panelLogTail || {};
  const status = cnPanelLogStatus(tail.status || 'unknown');
  const lineCount = Number(tail.lineCount) || 0;
  const sizeKb = Number(tail.size) > 0 ? `${Math.ceil(Number(tail.size) / 1024)} KB` : '0 KB';
  const flags = [
    tail.truncated ? '已截断' : '未截断',
    tail.reset ? '游标已重置' : '游标正常',
    `行数 ${lineCount}`,
    `大小 ${sizeKb}`,
  ];
  const summary = `${status} · ${flags.join(' · ')}`;
  const statusEl = $('panelLogStatus');
  statusEl.className = `panel-log-status ${tail.status || 'unknown'}`;
  statusEl.textContent = status;
  $('panelLogSummaryRail').textContent = `${status} · ${lineCount} 行 · 脱敏只读`;
  $('panelLogSummary').textContent = summary;
  $('panelLogPolicy').textContent = '只读 · 有界 · 已脱敏 · 未执行动作 · 不显示密钥值';
  $('panelLogCard').dataset.cursor = String(tail.cursor || 0);

  const lines = Array.isArray(tail.lines) ? tail.lines : [];
  const box = $('panelLogLines');
  if (tail.status === 'missing') {
    box.innerHTML = '<div class="empty">51835 日志文件尚未出现；服务仍可通过健康检查单独判断。</div>';
    return;
  }
  if (!lines.length) {
    box.innerHTML = '<div class="empty">当前日志尾部没有新增内容。</div>';
    return;
  }
  box.innerHTML = lines.map((line, index) => `
    <div class="panel-log-line">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <code>${esc(line || ' ')}</code>
    </div>`).join('');
}

async function loadPanelLogTail() {
  const statusEl = $('panelLogStatus');
  statusEl.className = 'panel-log-status loading';
  statusEl.textContent = '读取中';
  $('panelLogSummaryRail').textContent = '正在读取脱敏尾部…';
  try {
    renderPanelLogTail(await api('/api/noe/panel-log-tail?limit=80&maxBytes=32768'));
  } catch (e) {
    statusEl.className = 'panel-log-status blocked';
    statusEl.textContent = '读取失败';
    $('panelLogSummaryRail').textContent = '读取失败 · 需要授权或路由未就绪';
    $('panelLogSummary').textContent = publicError(e?.message || e, '运维日志读取失败');
    $('panelLogLines').innerHTML = '<div class="empty">运维日志读取失败；请先确认 51835 已加载最新服务路由。</div>';
  }
}

// ── 世界态势：BaiLongma 地球界面的 Noe 化版本。先汇真实端点，再考虑 Three.js。──
async function worldApi(path) {
  try {
    return { ok: true, path, data: await api(path) };
  } catch (e) {
    return { ok: false, path, error: publicError(e?.message || e || 'unknown') };
  }
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
}

function worldTone(snapshot, okWhenTrue = true) {
  if (!snapshot?.ok) return /owner|token|401|unauth|授权/i.test(snapshot?.error || '') ? 'locked' : 'bad';
  return okWhenTrue ? 'ok' : 'warn';
}

function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function socialCredentialStats(readiness = {}) {
  const summary = readiness.credentialSummary || {};
  if (Number.isFinite(Number(summary.total))) {
    return {
      total: safeCount(summary.total),
      available: safeCount(summary.available),
      configuredUnavailable: safeCount(summary.configuredUnavailable),
      missing: safeCount(summary.missing),
    };
  }
  const total = WORLD_SOCIAL_KEYS.length;
  const available = WORLD_SOCIAL_KEYS.filter((key) => readiness[key] === true).length;
  return { total, available, configuredUnavailable: 0, missing: Math.max(0, total - available) };
}

function socialCredentialLabel(readiness = {}, key = '', fallback = false) {
  const status = readiness.credentialStatuses?.[key]?.status || (fallback ? 'available' : 'missing');
  if (status === 'available') return '可用';
  if (status === 'configured_unavailable') return '已配置但不可用';
  return '缺失';
}

function socialAdmissionReasonCn(reason = '') {
  const raw = String(reason || '').trim();
  const map = {
    turn_allowed: '允许进入',
    duplicate_message: '重复消息',
    duplicate_content: '重复内容',
    self_message_ignored: '自身回声',
    bot_loop_suppressed: '机器人循环',
    empty_message: '空消息',
  };
  return map[raw] || cn(raw || '未知');
}

function collectSocialTurnGuards(social = {}) {
  return [
    { channel: '公开入站', guard: social.receiver?.turnGuard || null },
    { channel: '个人微信', guard: social.wechatPersonal?.receiver?.turnGuard || null },
    { channel: 'QQ', guard: social.qq?.receiver?.turnGuard || null },
  ].filter((item) => item.guard && typeof item.guard === 'object');
}

function socialAdmissionStats(social = {}) {
  const guards = collectSocialTurnGuards(social);
  const totals = { admitted: 0, accepted: 0, dropped: 0, released: 0 };
  const dropReasons = new Map();
  let last = null;
  for (const { channel, guard } of guards) {
    totals.admitted += safeCount(guard.admittedTurns);
    totals.accepted += safeCount(guard.acceptedTurns);
    totals.dropped += safeCount(guard.droppedTurns);
    totals.released += safeCount(guard.releasedReplayKeys);
    for (const [reason, count] of Object.entries(guard.dropReasons || {})) {
      dropReasons.set(reason, (dropReasons.get(reason) || 0) + safeCount(count));
    }
    const admission = guard.lastAdmission || null;
    if (admission && (!last || safeCount(admission.at) >= safeCount(last.at))) {
      last = { ...admission, surfaceChannel: channel };
    }
  }
  const primaryDropReason = [...dropReasons.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return {
    ...totals,
    hasActivity: totals.admitted > 0,
    primaryDropReason: primaryDropReason ? primaryDropReason[0] : '',
    primaryDropCount: primaryDropReason ? primaryDropReason[1] : 0,
    last,
    guards: guards.length,
    rawIdsReturned: false,
    secretValuesReturned: false,
  };
}

function socialAdmissionSummary(stats = {}) {
  if (!stats.hasActivity) return '入站 0 · 暂无真实消息';
  const last = stats.last
    ? ` · 最近 ${stats.last.surfaceChannel || cn(stats.last.channel || '未知')} ${socialAdmissionReasonCn(stats.last.reason)}`
    : '';
  return `接纳 ${safeCount(stats.accepted)} · 拦截 ${safeCount(stats.dropped)}${last}`;
}

function bootCheckById(boot = {}, id = '') {
  return (boot.checks || []).find((item) => item.id === id) || null;
}

function bootPanelRuntimeText(boot = {}) {
  const panel = bootCheckById(boot, 'panel_runtime_preflight');
  const d = panel?.detail || {};
  if (!panel) return '运行归属未纳入自检';
  if (d.safeToRestart) return `51835 属于本仓库 · 进程 ${safeCount(d.pid)} · 可安全重启`;
  if (d.safeToStart) return '51835 未监听 · 可安全启动';
  const blocker = Array.isArray(d.blockers) && d.blockers.length ? short(d.blockers.join(','), 72) : cn(panel.status || 'unknown');
  return `51835 归属阻断 · ${blocker}`;
}

function bootCompanionToolsText(boot = {}) {
  const companion = bootCheckById(boot, 'companion_tools_preflight');
  const d = companion?.detail || {};
  const tools = d.tools || {};
  const openclaw = tools.openclaw || {};
  const hermes = tools.hermes || {};
  if (!companion) return '伴随工具未纳入自检';
  const drift = Array.isArray(d.warnings) && d.warnings.length ? ` · 漂移 ${safeCount(d.warnings.length)}` : '';
  return `开爪 ${cnText(openclaw.activeVersion, '未发现')} · 赫尔墨斯 ${cnText(hermes.activeVersion, '未发现')}${drift}`;
}

function buildWorldHotspots(snapshots = {}) {
  const readiness = snapshots.readiness?.data || {};
  const readinessStatus = readiness.readiness?.status || 'unknown';
  const counts = readiness.counts || {};
  const p6 = readiness.p6 || {};
  const confirmedDelivery = safeCount(p6.confirmedDelivery ?? counts.p6ConfirmedDelivery);
  const guardRecords = safeCount(p6.guardRecords ?? counts.p6GuardRecords);
  const selfTalkOutcomes = safeCount(p6.selfTalkOutcomes ?? counts.p6SelfTalkOutcomes);
  const ruminationTripRate = Number(p6.ruminationGuardTripRate);

  const boot = snapshots.boot?.data?.bootSelfCheck || {};
  const bootCounts = boot.counts || {};
  const bootStatus = boot.status || (snapshots.boot?.ok ? 'unknown' : 'unavailable');
  const bootBlocked = safeCount(bootCounts.blocked);
  const bootWarn = safeCount(bootCounts.warn);
  const bootRepaired = safeCount(bootCounts.repaired);
  const bootRepairable = safeCount(bootCounts.repairable);
  const bootRepair = boot.repair || {};
  const bootRepairSummary = bootRepair.summary || {};
  const bootRepairAttempted = safeCount(bootRepairSummary.attempted);
  const bootRepairDone = safeCount(bootRepairSummary.repaired);
  const bootRepairText = bootRepairAttempted > 0 ? ` · 自修 ${bootRepairDone}/${bootRepairAttempted}` : '';
  const bootPanelRuntime = bootPanelRuntimeText(boot);
  const bootCompanionTools = bootCompanionToolsText(boot);
  const bootTone = snapshots.boot?.ok
    ? (bootBlocked > 0 ? 'bad' : (bootStatus === 'passed' ? 'ok' : bootRepairable > 0 || bootWarn > 0 || bootRepaired > 0 ? 'warn' : 'idle'))
    : worldTone(snapshots.boot);

  const social = snapshots.social?.data || {};
  const socialReadiness = social.readiness || {};
  const socialCreds = socialCredentialStats(socialReadiness);
  const readySocial = socialCreds.available;
  const wechatPersonal = social.wechatPersonal || {};
  const personalContract = wechatPersonal?.readiness?.outboundRequiresOwnerVisibleEvidence === true
    && wechatPersonal?.ownerVisibleEvidenceRequired === true;
  const qqGate = social.qq || {};
  const qqDryRunReady = qqGate.readyForDryRun === true && qqGate.selectedTransport === 'qq_official_webhook';
  const qqCreds = qqGate.credentialSummary || qqGate.credentials?.credentialSummary || {};
  const socialAdmission = socialAdmissionStats(social);
  const socialAdmissionText = socialAdmissionSummary(socialAdmission);
  const socialStatus = snapshots.social?.ok
    ? `${readySocial}/${socialCreds.total} 可用 · ${socialAdmissionText}`
    : (/owner|token|401|unauth|授权/i.test(snapshots.social?.error || '') ? '状态锁定' : '读取失败');

  const missions = snapshots.missions?.data || {};
  const missionCounts = missions.counts || {};
  const activeMissions = safeCount(missionCounts.running) + safeCount(missionCounts.recovering) + safeCount(missionCounts.waiting_approval);
  const latestMission = (missions.missions || [])[0] || null;

  const proof = snapshots.proof?.data || {};
  const proofReadiness = proof.readiness || null;
  const proofBlockers = Array.isArray(proofReadiness?.blockers) ? proofReadiness.blockers.length : 0;

  const vitals = snapshots.vitals?.data || {};
  const journal = vitals.journal || {};

  return [
    {
      id: 'runtime',
      title: '本机运行',
      value: readinessStatus === 'passed' ? '运行就绪' : cn(readinessStatus),
      detail: `记忆 ${safeCount(counts.memoryVisible)} · 工具 ${safeCount(counts.enabled)}/${safeCount(counts.total)} · 审批 ${safeCount(counts.pendingApprovals)}`,
      tone: snapshots.readiness?.ok && readinessStatus === 'passed' ? 'ok' : worldTone(snapshots.readiness, false),
      reason: snapshots.readiness?.ok
        ? `运行状态 ${cn(readinessStatus)}；已启用工具 ${safeCount(counts.enabled)}/${safeCount(counts.total)}；待审批 ${safeCount(counts.pendingApprovals)}`
        : `运行状态读取失败：${cnText(snapshots.readiness?.error, '读取失败')}`,
      sourcePaths: ['/api/noe/readiness', 'readiness.status', 'counts.enabled', 'counts.pendingApprovals'],
      nextAction: readinessStatus === 'passed' ? '跳到状态条核对心跳、目标和预算。' : '刷新 readiness；若仍失败，检查本机服务和审批队列。',
      targetSelector: '#statusStrip',
      x: 320, y: 178,
    },
    {
      id: 'boot',
      title: '开机自检',
      value: bootStatus === 'passed' ? '全部通过' : cn(bootStatus),
      detail: snapshots.boot?.ok
        ? `检查 ${safeCount(bootCounts.ok)}/${safeCount(bootCounts.total)} · 阻塞 ${bootBlocked} · 可修 ${bootRepairable}${bootRepairText} · ${bootPanelRuntime} · ${bootCompanionTools}`
        : cnText(snapshots.boot?.error, '开机自检不可用'),
      tone: bootTone,
      reason: snapshots.boot?.ok
        ? `自检状态 ${cn(bootStatus)}；阻塞 ${bootBlocked}；警告 ${bootWarn}；已修复 ${bootRepaired}；可自动修复 ${bootRepairable}；自修动作 ${bootRepairDone}/${bootRepairAttempted}；${bootPanelRuntime}；${bootCompanionTools}`
        : `开机自检读取失败：${cnText(snapshots.boot?.error, '读取失败')}`,
      sourcePaths: ['/api/noe/boot-self-check/status', 'bootSelfCheck.status', 'bootSelfCheck.counts', 'bootSelfCheck.checks', 'bootSelfCheck.checks.panel_runtime_preflight.detail', 'bootSelfCheck.checks.companion_tools_preflight.detail', 'bootSelfCheck.reportPath'],
      nextAction: bootRepairable > 0
        ? '点安全修复，让诺伊创建缺失证据目录或刷新自检报告；非自动项保留给主人明确处置。'
        : bootBlocked > 0 ? '运行自检定位非自动 blocker，再按报告处理 51835 或缺失文件。' : '开机门已可用；继续把它作为地球面板的启动健康入口。',
      targetSelector: '#worldSurface',
      actionKind: 'boot-self-check',
      actionData: { boot },
      x: 214, y: 90,
    },
    {
      id: 'p6',
      title: '内循环交付',
      value: `确认交付 ${confirmedDelivery}`,
      detail: `自述 ${selfTalkOutcomes} · 护栏 ${guardRecords} · 触发率 ${Number.isFinite(ruminationTripRate) ? pct(ruminationTripRate) : '—'}`,
      tone: confirmedDelivery > 0 ? (Number.isFinite(ruminationTripRate) && ruminationTripRate > 0.95 ? 'warn' : 'ok') : 'bad',
      reason: confirmedDelivery > 0
        ? `主人确认交付 ${confirmedDelivery}；护栏记录 ${guardRecords}；反刍触发率 ${Number.isFinite(ruminationTripRate) ? pct(ruminationTripRate) : '未知'}`
        : '主人确认交付仍为 0；这不是观感问题，是主人感知交付样本未形成。',
      sourcePaths: ['/api/noe/readiness', 'p6.confirmedDelivery', 'p6.guardRecords', 'p6.ruminationGuardTripRate'],
      nextAction: confirmedDelivery > 0 ? '跳到心跳台账核对真实交付痕迹。' : '补一条真实主人感知交付样本，再让确认交付计数增长。',
      targetSelector: '#ticks',
      x: 416, y: 120,
    },
    {
      id: 'social',
      title: '社交入站',
      value: socialStatus,
      detail: snapshots.social?.ok
        ? `公众号 ${socialCredentialLabel(socialReadiness, 'wechatOfficialToken', socialReadiness.wechatOfficial)} · 个人微信 ${cn(wechatPersonal.loginState || 'unknown')} · 扣扣 ${qqDryRunReady ? '预演就绪' : '研究中'} · 凭据 ${safeCount(qqCreds.available)}/${safeCount(qqCreds.total)} · ${socialAdmissionText} · 企业微信 ${socialCredentialLabel(socialReadiness, 'wecomIncomingToken', socialReadiness.wecomIncoming)} · 飞书 ${socialCredentialLabel(socialReadiness, 'feishuVerificationToken', socialReadiness.feishuVerification)} · 外部聊天通道 ${socialCredentialLabel(socialReadiness, 'discordBotToken', socialReadiness.discordGateway)}`
        : cnText(snapshots.social?.error, '状态不可用'),
      tone: snapshots.social?.ok ? (socialAdmission.dropped > 0 ? 'warn' : (readySocial > 0 || personalContract || qqDryRunReady ? 'ok' : 'warn')) : worldTone(snapshots.social),
      reason: snapshots.social?.ok
        ? `可用入口 ${readySocial}/${socialCreds.total}；已配置但不可用 ${socialCreds.configuredUnavailable}；缺失 ${socialCreds.missing}；入站接纳 ${socialAdmission.accepted}；入站拦截 ${socialAdmission.dropped}${socialAdmission.primaryDropReason ? `；主要拦截原因 ${socialAdmissionReasonCn(socialAdmission.primaryDropReason)} ${socialAdmission.primaryDropCount}` : ''}；个人微信契约 ${personalContract ? '已满足' : '待确认'}；扣扣预演 ${qqDryRunReady ? '就绪' : '未就绪'}`
        : `社交入站读取失败：${cnText(snapshots.social?.error, '读取失败')}`,
      sourcePaths: ['/api/noe/social-inbound/status', 'readiness.credentialSummary', 'readiness.credentialStatuses', 'receiver.turnGuard', 'wechatPersonal.receiver.turnGuard', 'qq.receiver.turnGuard', 'wechatPersonal.readiness', 'qq.credentialSummary', 'qq.readyForDryRun'],
      nextAction: socialAdmission.dropped > 0
        ? '查看入站拦截原因；重复、自回声和机器人循环不应进入智能体回合。'
        : socialCreds.configuredUnavailable > 0
        ? '先修复已配置但当前不可用的社交凭据/回调，再做真实入站回放。'
        : readySocial > 0 || personalContract || qqDryRunReady ? '继续核对真实入站/出站契约，避免只停留在预演。' : '优先补微信/扣扣的可验证入口，再进入真实社交回放。',
      targetSelector: '#worldSurface',
      actionKind: 'social-inbound',
      actionData: { social, socialAdmission },
      x: 500, y: 178,
    },
    {
      id: 'mission',
      title: '任务运行时',
      value: activeMissions ? `活跃 ${activeMissions}` : ((missions.missions || []).length ? '无活跃任务' : '暂无任务'),
      detail: latestMission
        ? `最近任务 · ${MISSION_LABEL[latestMission.status] || cn(latestMission.status)} · 证据 ${safeCount(latestMission.evidenceCount)}`
        : (snapshots.missions?.ok ? '长任务账本为空' : cnText(snapshots.missions?.error, '长任务不可用')),
      tone: snapshots.missions?.ok ? (activeMissions ? 'warn' : 'idle') : worldTone(snapshots.missions),
      reason: snapshots.missions?.ok
        ? `活跃长任务 ${activeMissions}；最近任务 ${latestMission ? `${cn(latestMission.status || 'unknown')} / 证据 ${safeCount(latestMission.evidenceCount)}` : '无'}`
        : `长任务读取失败：${cnText(snapshots.missions?.error, '读取失败')}`,
      sourcePaths: ['/api/noe/missions?limit=10', 'counts.running', 'counts.waiting_approval', 'missions[0].evidenceCount'],
      nextAction: activeMissions ? '跳到长任务运行时看下一步、证据和审批。' : '需要长任务时启动长任务；空闲不是失败。',
      targetSelector: '#missions',
      x: 224, y: 226,
    },
    {
      id: 'proof',
      title: '证明门',
      value: proofReadiness ? `${proofReadiness.score}%` : '无报告',
      detail: proofReadiness
        ? `检查 ${proofReadiness.passedChecks}/${proofReadiness.passedChecks + proofReadiness.failedChecks} · 阻塞 ${proofBlockers}`
        : (snapshots.proof?.ok ? '证明报告缺失' : cnText(snapshots.proof?.error, '证明门不可用')),
      tone: snapshots.proof?.ok ? (proofReadiness?.passed ? 'ok' : 'bad') : worldTone(snapshots.proof),
      reason: proofReadiness
        ? `分数 ${proofReadiness.score}；通过 ${proofReadiness.passedChecks}；失败 ${proofReadiness.failedChecks}；阻塞 ${proofBlockers}`
        : `证明门无可用报告或读取失败：${cnText(snapshots.proof?.error || '缺少报告', '缺少报告')}`,
      sourcePaths: ['/api/noe/mind/proof', 'readiness.score', 'readiness.blockers', 'readiness.reportPath'],
      nextAction: proofBlockers ? '跳到证明门卡片逐条处理阻塞项，不把分数当通过。' : '继续积累自然运行和期望结算证据。',
      targetSelector: '#proofCard',
      x: 302, y: 82,
    },
    {
      id: 'vitals',
      title: '心智体征',
      value: vitals.enabled ? `多样 ${pct(vitals.diversity)} · 接地 ${pct(vitals.groundedRate)}` : '未启用',
      detail: vitals.enabled
        ? `注意 ${safeCount(journal.attend)} · 深思 ${safeCount(journal.escalated)} · 开口 ${safeCount(journal.surfacedPass)}`
        : (snapshots.vitals?.ok ? '体征未启用或模型不可用' : cnText(snapshots.vitals?.error, '体征不可用')),
      tone: snapshots.vitals?.ok ? (vitals.enabled ? 'ok' : 'idle') : worldTone(snapshots.vitals),
      reason: snapshots.vitals?.ok
        ? `体征已启用 ${vitals.enabled === true ? '是' : '否'}；多样性 ${pct(vitals.diversity)}；接地率 ${pct(vitals.groundedRate)}`
        : `体征读取失败：${cnText(snapshots.vitals?.error, '读取失败')}`,
      sourcePaths: ['/api/noe/mind/vitals', 'diversity', 'groundedRate', 'journal.attend'],
      nextAction: vitals.enabled ? '跳到心智体征和意识日志交叉检查是否接地。' : '检查嵌入与体征服务；未启用时不要把体征当真实能力。',
      targetSelector: '#statVitals',
      x: 144, y: 160,
    },
  ].map((point) => ({ ...point, ...(WORLD_HOTSPOT_LAYOUT[point.id] || {}) }));
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function chooseWorldDefaultHotspot(hotspots = []) {
  return ['bad', 'locked', 'warn'].map((tone) => hotspots.find((item) => item.tone === tone)).find(Boolean)
    || hotspots.find((item) => item.id === 'runtime')
    || hotspots[0]
    || null;
}

function filteredWorldHotspots(hotspots = []) {
  if (worldActiveFilter === 'all') return hotspots;
  return hotspots.filter((item) => item.tone === worldActiveFilter);
}

function renderWorldSurfaceSvg(_hotspots = []) {
  const svg = /** @type {SVGSVGElement} */($('worldSurfaceSvg'));
  svg.textContent = '';
  svg.append(svgNode('rect', { x: 0, y: 0, width: 640, height: 360, rx: 18, class: 'world-bg' }));
  svg.append(svgNode('circle', { cx: 320, cy: 180, r: 132, class: 'world-globe' }));
  [42, 74, 106].forEach((rx) => svg.append(svgNode('ellipse', { cx: 320, cy: 180, rx, ry: 132, class: 'world-grid' })));
  [-72, -36, 0, 36, 72].forEach((offset) => svg.append(svgNode('ellipse', { cx: 320, cy: 180, rx: 132, ry: Math.max(4, 68 - Math.abs(offset) * 0.35), transform: `translate(0 ${offset})`, class: 'world-grid' })));
}

function setWorldEarthStatus(kind, text) {
  const orb = $('worldOrb');
  const status = $('worldEarthStatus');
  orb.classList.toggle('ready', kind === 'ready');
  orb.classList.toggle('fallback', kind === 'fallback');
  if (text) status.textContent = text;
}

async function ensureWorldEarth() {
  if (worldEarth) return worldEarth;
  if (worldEarthPromise) return worldEarthPromise;
  const canvas = /** @type {HTMLCanvasElement | null} */(document.getElementById('worldEarthCanvas'));
  if (!canvas) return null;
  setWorldEarthStatus('loading', '正在加载三维地球…');
  worldEarthPromise = import('./src/web/noe-world-earth.js?v=earth-clean-20260614b')
    .then(async ({ NoeWorldEarth }) => {
      const earth = new NoeWorldEarth(canvas);
      await earth.init();
      canvas.addEventListener('noe-world-hotspot-select', (event) => {
        const id = event?.detail?.id;
        if (id) selectWorldHotspot(id, { focusEarth: false });
      });
      worldEarth = earth;
      setWorldEarthStatus('ready', '三维地球已接入昼夜、轨道态势和中国视图');
      return earth;
    })
    .catch((error) => {
      worldEarthPromise = null;
      setWorldEarthStatus('fallback', `三维地球不可用，已切换备用图：${short(error?.message || error, 80)}`);
      return null;
    });
  return worldEarthPromise;
}

async function renderWorldSurfaceEarth(hotspots = []) {
  const earth = await ensureWorldEarth();
  if (!earth) return;
  earth.setHotspots(hotspots);
  earth.setSelectedHotspot(worldSelectedHotspot || hotspots[0]?.id || null, { focus: false });
  if (chinaPanelOpen) earth.focusChina?.();
}

function chinaPanelPoint(lat, lon) {
  const x = Math.max(20, Math.min(241, 20 + ((Number(lon) - 73) / 62) * 221));
  const y = Math.max(20, Math.min(143, 20 + ((54 - Number(lat)) / 36) * 123));
  return { x, y };
}

function setChinaPanel(open, text = '') {
  chinaPanelOpen = open;
  const panel = $('worldChinaPanel');
  if (panel) panel.hidden = !open;
  if (text) $('worldChinaLocationText').textContent = text;
  if (open) worldEarth?.focusChina?.();
  else worldEarth?.resetEarthView?.();
}

function updateChinaLocation(lat, lon, label = '当前位置') {
  const marker = /** @type {SVGCircleElement | null} */(document.getElementById('worldChinaPanelLocation'));
  const point = chinaPanelPoint(lat, lon);
  if (marker) {
    marker.setAttribute('cx', String(point.x));
    marker.setAttribute('cy', String(point.y));
    marker.hidden = false;
  }
  $('worldChinaLocationText').textContent = `${label}：纬度 ${Number(lat).toFixed(3)}，经度 ${Number(lon).toFixed(3)}。`;
  worldEarth?.setUserLocation?.({ lat, lon, label });
}

function fallbackChinaLocation(reason = '浏览器未提供精确定位') {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知时区';
  updateChinaLocation(39.9042, 116.4074, '中国时区参考点');
  $('worldChinaLocationText').textContent = `${reason}；当前仅用本机时区「${zone}」显示中国参考点，精确位置需要浏览器授权。`;
}

function locateWorldUser() {
  setChinaPanel(true, '正在请求浏览器定位授权…');
  if (!navigator.geolocation) {
    fallbackChinaLocation('当前浏览器不支持定位');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      updateChinaLocation(latitude, longitude, `本机位置（误差约 ${Math.round(accuracy || 0)} 米）`);
    },
    () => fallbackChinaLocation('定位未授权或不可用'),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
  );
}

function renderWorldFilters(hotspots = []) {
  const counts = new Map(WORLD_FILTERS.map(([key]) => [key, 0]));
  counts.set('all', hotspots.length);
  hotspots.forEach((item) => counts.set(item.tone, (counts.get(item.tone) || 0) + 1));
  $('worldFilters').innerHTML = WORLD_FILTERS.map(([key, label]) => `
    <button type="button" class="${key === worldActiveFilter ? 'active' : ''}" data-world-filter="${esc(key)}" aria-pressed="${key === worldActiveFilter ? 'true' : 'false'}">
      ${esc(label)} ${counts.get(key) || 0}
    </button>`).join('');
  document.querySelectorAll('[data-world-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      worldActiveFilter = button.getAttribute('data-world-filter') || 'all';
      worldActionMessage = '';
      renderWorldHotspotView(worldHotspotCache);
    });
  });
}

function worldDiagnosticText(item) {
  if (!item) return '';
  return [
    `诺伊态势点：${item.title}`,
    `状态：${WORLD_TONE_LABEL[item.tone] || item.tone}`,
    `数值：${item.value}`,
    `细节：${item.detail}`,
    `原因：${item.reason || '—'}`,
    `证据源：${(item.sourcePaths || []).length || 0} 项`,
    `下一步：${item.nextAction || '—'}`,
  ].join('\n');
}

function setWorldActionState(text) {
  worldActionMessage = text || '';
  const state = document.querySelector('[data-world-copy-state]');
  if (state) state.textContent = text;
}

function worldContextActionButtons(item = {}) {
  if (item.actionKind === 'social-inbound') {
    return [
      '<button type="button" data-world-action="social-checklist">复制接入清单</button>',
      '<button type="button" data-world-action="qq-preview">扣扣预演</button>',
      '<button type="button" data-world-action="wechat-contract">微信契约</button>',
    ].join('');
  }
  if (item.actionKind === 'boot-self-check') {
    return [
      '<button type="button" data-world-action="boot-run">运行自检</button>',
      '<button type="button" data-world-action="boot-repair">安全修复</button>',
    ].join('');
  }
  return '';
}

function worldCardActionLabel(item = {}) {
  if (item.actionKind === 'boot-self-check') return '可自检';
  if (item.actionKind === 'social-inbound') return '可预演';
  if (item.targetSelector === '#missions') return '任务';
  if (item.targetSelector === '#proofCard') return '证明';
  if (item.targetSelector === '#statVitals') return '体征';
  return '查看';
}

async function copyWorldText(text, successText = '已复制') {
  if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
  await navigator.clipboard.writeText(text);
  setWorldActionState(successText);
}

async function copyWorldSocialChecklist(item = {}) {
  const social = item.actionData?.social || {};
  const { buildSocialIntegrationChecklist } = await getWorldSocialActions();
  await copyWorldText(buildSocialIntegrationChecklist(social), '接入清单已复制');
}

function summarizeBootSelfCheck(data = {}) {
  const boot = data.bootSelfCheck || data;
  const counts = boot.counts || {};
  const repairSummary = boot.repair?.summary || {};
  const repairAttempted = safeCount(repairSummary.attempted);
  const repairDone = safeCount(repairSummary.repaired);
  const parts = [
    `自检 ${cn(boot.status || 'unknown')}`,
    `阻塞 ${safeCount(counts.blocked)}`,
    `修复 ${safeCount(counts.repaired)}`,
  ];
  if (repairAttempted > 0) parts.push(`动作 ${repairDone}/${repairAttempted}`);
  if (boot.reportPath || boot.latestPath) parts.push(short(boot.reportPath || boot.latestPath, 72));
  return parts.join(' · ');
}

async function runWorldBootSelfCheck({ repair = false } = {}) {
  setWorldActionState(repair ? '安全修复中…' : '自检运行中…');
  const outcome = repair
    ? await apiOutcome('/api/noe/boot-self-check/repair', { method: 'POST' })
    : await apiOutcome('/api/noe/boot-self-check/run', { method: 'POST' });
  if (!outcome.ok) {
    setWorldActionState(`自检失败：${short(outcome.error, 120)}`);
    return;
  }
  setWorldActionState(summarizeBootSelfCheck(outcome.data));
  await loadWorldSurface();
}

async function runWorldQqPreview() {
  setWorldActionState('扣扣预演中…');
  const { buildQqPreviewEvent, summarizeQqPreview } = await getWorldSocialActions();
  const outcome = await apiOutcome('/api/noe/social-inbound/qq/preview', {
    method: 'POST',
    body: buildQqPreviewEvent(),
  });
  setWorldActionState(summarizeQqPreview(outcome.data || { ok: false, reason: outcome.error }));
}

async function runWorldWeChatContractProbe() {
  setWorldActionState('微信契约检查中…');
  const { buildWeChatContractProbe, summarizeWeChatContract } = await getWorldSocialActions();
  const outcome = await apiOutcome('/api/noe/social-inbound/wechat-personal/outbound-dry-run', {
    method: 'POST',
    body: buildWeChatContractProbe(),
  });
  setWorldActionState(summarizeWeChatContract(outcome.data || { ok: false, reason: outcome.error }));
}

function renderWorldInsight(hotspots = []) {
  const panel = $('worldInsight');
  const item = hotspots.find((point) => point.id === worldSelectedHotspot);
  if (!item) {
    panel.innerHTML = '<div class="world-insight-reason">当前筛选没有匹配态势点。</div>';
    return;
  }
  const sourceCount = Array.isArray(item.sourcePaths) ? item.sourcePaths.length : 0;
  const sources = sourceCount ? `<span>本机证据源 ${sourceCount} 项</span>` : '<span>暂无证据源</span>';
  panel.innerHTML = `
    <div class="world-insight-head">
      <div class="world-insight-title">${esc(item.title)}</div>
      <span class="badge b-src">${esc(WORLD_TONE_LABEL[item.tone] || item.tone)}</span>
    </div>
    <div class="world-insight-value">${esc(item.value)}</div>
    <div class="world-insight-reason">${esc(item.reason || item.detail || '没有解释字段')}</div>
    <div class="world-insight-next">${esc(item.nextAction || '没有下一步')}</div>
    <div class="world-source-list">${sources}</div>
    <div class="world-command-row">
      <button type="button" data-world-action="focus">聚焦地球</button>
      <button type="button" data-world-action="jump">跳到证据</button>
      <button type="button" data-world-action="refresh">刷新态势</button>
      ${worldContextActionButtons(item)}
      <button type="button" data-world-action="copy">复制诊断</button>
      <span class="world-copy-state" data-world-copy-state></span>
    </div>`;
  bindWorldInsightActions(item);
  if (worldActionMessage) setWorldActionState(worldActionMessage);
}

function bindWorldInsightActions(item) {
  const panel = $('worldInsight');
  panel.querySelector('[data-world-action="focus"]')?.addEventListener('click', () => {
    if (worldEarth) worldEarth.setSelectedHotspot(item.id, { focus: true });
  });
  panel.querySelector('[data-world-action="jump"]')?.addEventListener('click', () => {
    const target = document.querySelector(item.targetSelector || '#worldSurface');
    openContainingDetails(target);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  panel.querySelector('[data-world-action="refresh"]')?.addEventListener('click', () => {
    setWorldActionState('刷新中…');
    loadWorldSurface().finally(() => { setWorldActionState('已刷新'); });
  });
  panel.querySelector('[data-world-action="copy"]')?.addEventListener('click', async () => {
    try {
      await copyWorldText(worldDiagnosticText(item));
    } catch {
      setWorldActionState('复制不可用');
    }
  });
  panel.querySelector('[data-world-action="social-checklist"]')?.addEventListener('click', async () => {
    try { await copyWorldSocialChecklist(item); } catch { setWorldActionState('复制不可用'); }
  });
  panel.querySelector('[data-world-action="qq-preview"]')?.addEventListener('click', () => {
    runWorldQqPreview().catch((error) => setWorldActionState(`扣扣预演失败：${short(error?.message || error, 120)}`));
  });
  panel.querySelector('[data-world-action="wechat-contract"]')?.addEventListener('click', () => {
    runWorldWeChatContractProbe().catch((error) => setWorldActionState(`微信契约检查失败：${short(error?.message || error, 120)}`));
  });
  panel.querySelector('[data-world-action="boot-run"]')?.addEventListener('click', () => {
    runWorldBootSelfCheck({ repair: false }).catch((error) => setWorldActionState(`自检失败：${short(error?.message || error, 120)}`));
  });
  panel.querySelector('[data-world-action="boot-repair"]')?.addEventListener('click', () => {
    runWorldBootSelfCheck({ repair: true }).catch((error) => setWorldActionState(`安全修复失败：${short(error?.message || error, 120)}`));
  });
}

function openContainingDetails(target) {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    if (node instanceof HTMLDetailsElement) node.open = true;
    node = node.parentElement;
  }
}

function selectWorldHotspot(id, { focusEarth = true } = {}) {
  if (!id) return;
  if (id !== worldSelectedHotspot) worldActionMessage = '';
  worldSelectedHotspot = id;
  document.querySelectorAll('[data-world-hotspot-card]').forEach((card) => {
    card.classList.toggle('selected', card.getAttribute('data-world-hotspot-card') === id);
  });
  if (worldEarth) worldEarth.setSelectedHotspot(id, { focus: focusEarth });
  renderWorldInsight(worldHotspotCache);
}

function bindWorldHotspotCards() {
  document.querySelectorAll('[data-world-hotspot-card]').forEach((card) => {
    const id = card.getAttribute('data-world-hotspot-card');
    card.addEventListener('click', () => selectWorldHotspot(id || '', { focusEarth: true }));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectWorldHotspot(id || '', { focusEarth: true });
      }
    });
  });
}

function renderWorldHotspotView(hotspots = worldHotspotCache) {
  const visibleHotspots = filteredWorldHotspots(hotspots);
  if (!visibleHotspots.some((item) => item.id === worldSelectedHotspot)) {
    worldSelectedHotspot = chooseWorldDefaultHotspot(visibleHotspots)?.id || '';
  }
  renderWorldFilters(hotspots);
  renderWorldSurfaceSvg(visibleHotspots);
  renderWorldSurfaceEarth(visibleHotspots).catch((error) => {
    setWorldEarthStatus('fallback', `三维地球不可用，已切换备用图：${short(error?.message || error, 80)}`);
  });
  const hotspotBox = $('worldHotspots');
  hotspotBox.classList.toggle('empty', visibleHotspots.length === 0);
  if (!visibleHotspots.length) {
    hotspotBox.innerHTML = `${WORLD_TONE_LABEL[worldActiveFilter] || worldActiveFilter} 无匹配态势点`;
    renderWorldInsight([]);
    return;
  }
  hotspotBox.innerHTML = visibleHotspots.map((item, index) => `
    <div class="world-hotspot-card ${esc(item.tone)} ${item.id === worldSelectedHotspot ? 'selected' : ''}" data-world-hotspot-card="${esc(item.id)}" role="button" tabindex="0" aria-label="${esc(item.title)} ${esc(WORLD_TONE_LABEL[item.tone] || item.tone)}">
      <div class="world-card-led">
        <span class="world-tone"></span>
        <span class="world-card-index">${String(index + 1).padStart(2, '0')}</span>
      </div>
      <div class="world-card-main">
        <div class="row1"><b>${esc(item.title)}</b><span class="badge b-src">${esc(WORLD_TONE_LABEL[item.tone] || item.tone)}</span></div>
        <div class="world-detail">${esc(item.detail)}</div>
        <div class="world-card-meta"><span>${esc(item.value)}</span><span>${esc(worldCardActionLabel(item))}</span></div>
      </div>
      <div class="world-card-chevron" aria-hidden="true">›</div>
    </div>`).join('');
  bindWorldHotspotCards();
  renderWorldInsight(hotspots);
}

function focusWorldRisk() {
  const target = chooseWorldDefaultHotspot(worldHotspotCache);
  if (!target) return;
  worldActiveFilter = 'all';
  worldActionMessage = '';
  renderWorldHotspotView(worldHotspotCache);
  selectWorldHotspot(target.id, { focusEarth: true });
}

function renderWorldSurface(snapshots = {}) {
  const hotspots = buildWorldHotspots(snapshots);
  worldHotspotCache = hotspots;
  if (!hotspots.some((item) => item.id === worldSelectedHotspot)) worldSelectedHotspot = chooseWorldDefaultHotspot(hotspots)?.id || '';
  const bad = hotspots.filter((item) => item.tone === 'bad').length;
  const locked = hotspots.filter((item) => item.tone === 'locked').length;
  const warn = hotspots.filter((item) => item.tone === 'warn').length;
  const ok = hotspots.filter((item) => item.tone === 'ok').length;
  const topTone = bad ? 'bad' : locked ? 'locked' : warn ? 'warn' : 'ok';
  $('worldHealth').className = `world-health ${topTone}`;
  $('worldHealth').textContent = `${WORLD_TONE_LABEL[topTone]} · 已稳 ${ok}/${hotspots.length}`;
  const focusButton = $('worldFocusRisk');
  focusButton.classList.toggle('active', topTone !== 'ok');
  focusButton.textContent = topTone === 'ok' ? '聚焦稳定' : '聚焦风险';
  const overview = snapshots.overview?.data || {};
  const goals = overview.goals || {};
  const expectations = overview.expectations || {};
  $('worldSummary').textContent = snapshots.overview?.ok
    ? `目标推进中 ${safeCount(goals.active)} · 期望未决 ${safeCount(expectations.open)} · 这些热点来自本机实时接口`
    : `部分受保护端点不可读：${cnText(snapshots.overview?.error, '总览不可用')}；公开运行状态仍会显示。`;
  renderWorldHotspotView(hotspots);
  $('worldLegend').innerHTML = [
    ['ok', '已通过或可用'],
    ['warn', '需要看护但不阻塞'],
    ['bad', '真实阻塞或证明门失败'],
    ['locked', '授权锁定/不可读'],
    ['idle', '真实空闲'],
  ].map(([tone, label]) => `<span class="world-legend-item ${tone}"><i></i>${esc(label)}</span>`).join('');
}

async function loadWorldSurface() {
  const [readiness, social, boot, missions, proof, vitals, overview] = await Promise.all([
    worldApi('/api/noe/readiness'),
    worldApi('/api/noe/social-inbound/status'),
    worldApi('/api/noe/boot-self-check/status'),
    worldApi('/api/noe/missions?limit=10'),
    worldApi('/api/noe/mind/proof'),
    worldApi('/api/noe/mind/vitals'),
    worldApi('/api/noe/mind/overview'),
  ]);
  renderWorldSurface({ readiness, social, boot, missions, proof, vitals, overview });
}

// ── 装载 ──
async function loadOverview() { try { renderStrip(await api('/api/noe/mind/overview')); } catch (e) { $('statHeart').querySelector('.s').textContent = publicError(e.message); } }
async function loadThoughts() { try { renderThoughts(await api('/api/noe/mind/thoughts?limit=80')); } catch { $('thoughts').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadJournal() { try { renderJournal(await api('/api/noe/mind/journal?limit=120')); } catch { $('journal').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadAffect() { try { renderAffect(await api('/api/noe/mind/affect?hours=24')); } catch { $('affectChart').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadExpectations() { try { renderExpectations(await api('/api/noe/mind/expectations')); } catch { $('expectations').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadGoals() { try { renderGoals(await api('/api/noe/mind/goals')); } catch { $('goals').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadTicks() { try { renderTicks(await api('/api/noe/mind/ticks?limit=80')); } catch { $('ticks').innerHTML = '<div class="empty">加载失败</div>'; } }
async function loadMemory() {
  try {
    const q = /** @type {HTMLInputElement} */($('memoryQuery')).value.trim();
    const searchBtn = $('memorySearchBtn');
    const quarantineBtn = $('memoryQuarantineBtn');
    searchBtn.classList.toggle('active', memoryMode === 'search');
    quarantineBtn.classList.toggle('active', memoryMode === 'quarantine');
    const [status, items] = await Promise.all([
      api('/api/noe/mind/memory'),
      memoryMode === 'quarantine'
        ? api('/api/noe/mind/memory/quarantine?limit=30')
        : api(`/api/noe/mind/memory/search?limit=12${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    ]);
    renderMemoryStatus(status);
    if (memoryMode === 'quarantine') renderMemoryQuarantine(items);
    else renderMemoryItems(items);
  } catch {
    $('memorySummary').textContent = '记忆状态加载失败';
    $('memoryItems').innerHTML = '<div class="empty">加载失败</div>';
  }
}

async function loadAll() {
  const jobs = [loadOverview(), loadProof(), loadMemory(), loadWorkMap(), loadWorldSurface(), loadThoughts(), loadJournal(), loadAffect(), loadExpectations(), loadGoals(), loadTicks(), loadMissions()];
  if ($('opsLogDetails')?.open) jobs.push(loadPanelLogTail());
  if ($('awakeningDetails')?.open) jobs.push(loadAwakening());
  await Promise.allSettled(jobs);
  $('lastSync').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  settleInitialHashAnchor();
}

function settleInitialHashAnchor() {
  if (initialHashSettled) return;
  const id = decodeURIComponent(String(location.hash || '').replace(/^#/, ''));
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  initialHashSettled = true;
  openContainingDetails(target);
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

$('refreshBtn').addEventListener('click', loadAll);
$('tickBtn').addEventListener('click', async () => {
  const btn = /** @type {HTMLButtonElement} */($('tickBtn'));
  btn.disabled = true; btn.textContent = '认知周期跑动中…';
  try { await api('/api/noe/mind/tick', { method: 'POST', body: { kind: 'meso' } }); setTimeout(loadAll, 1200); }
  catch (e) { showActionNotice(`踩拍失败：${publicError(e.message)}`, 'bad'); }
  finally { btn.disabled = false; btn.textContent = '跑一拍'; }
});
$('goalAdd').addEventListener('click', async () => {
  const input = /** @type {HTMLInputElement} */($('goalTitle'));
  const title = input.value.trim();
  if (!title) return;
  try { await api('/api/noe/mind/goals', { method: 'POST', body: { title } }); input.value = ''; await loadGoals(); }
  catch (e) { showActionNotice(`交办失败：${publicError(e.message)}`, 'bad'); }
});
$('goalTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('goalAdd').click(); });
$('worldFocusRisk').addEventListener('click', focusWorldRisk);
$('worldChinaView').addEventListener('click', () => setChinaPanel(true, '中国轮廓已高亮；点击「定位我」可请求浏览器授权。'));
$('worldEarthView').addEventListener('click', () => setChinaPanel(false));
$('worldChinaClose').addEventListener('click', () => setChinaPanel(false));
$('worldLocateMe').addEventListener('click', locateWorldUser);
$('memorySearchBtn').addEventListener('click', () => { memoryMode = 'search'; loadMemory(); });
$('memoryQuarantineBtn').addEventListener('click', () => { memoryMode = 'quarantine'; loadMemory(); });
$('memoryQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { memoryMode = 'search'; loadMemory(); } });
$('panelLogRefreshBtn').addEventListener('click', () => loadPanelLogTail());
$('opsLogDetails').addEventListener('toggle', () => {
  if ($('opsLogDetails').open && !$('panelLogCard').dataset.cursor) loadPanelLogTail();
});
$('awakeningDetails')?.addEventListener('toggle', () => {
  if ($('awakeningDetails').open) loadAwakening();
});
['thoughts', 'journal', 'ticks', 'memoryItems'].forEach(installRecentListScrollMemory);
installRecentListScrollMemory('missions');
installRecentListScrollMemory('workMapItems');

loadAll();
loadVitals();
setInterval(loadAll, 30_000);
setInterval(loadWorkMap, 15_000);
setInterval(loadMissions, 10_000);
setInterval(loadWorldSurface, 15_000);
setInterval(loadVitals, 5 * 60_000);
