// @ts-check
/**
 * Primary home shell UI — fetches real /api/version for runtimeMode + voiceReadiness.
 * Memory visual via /api/noe/mind/memory/search when owner token present; else empty honest state.
 */
import { buildHomeShellNavigation } from '/src/web/home-shell-nav.js';
import { buildMemoryVisualModel } from '/src/web/memory-visual-client.js';

const $ = (id) => document.getElementById(id);

function chipClass(kind, okish) {
  if (kind === 'mode') return 'chip mode';
  if (okish === true) return 'chip ok';
  if (okish === false) return 'chip bad';
  return 'chip warn';
}

function renderChips(versionJson) {
  const el = $('statusChips');
  if (!el) return;
  const rm = versionJson?.runtimeMode || {};
  const voice = versionJson?.voiceReadiness || versionJson?.statusChips?.voice || {};
  const evoChip = versionJson?.statusChips?.selfEvolution || versionJson?.selfEvolution || {};
  const evoLabel = evoChip.label
    || (evoChip.rings
      ? `进化 · ${['perception', 'memory', 'falsification', 'boundary'].filter((k) => evoChip.rings[k]).length}/4`
      : '进化 · 未武装');
  const evoArmed = evoChip.armed === true || evoChip.profile === 'safe';
  const evoReal = evoChip.realApply === true || evoChip.armed?.realApply === true;
  const tick = rm.effectiveEnv?.NOE_PROACTIVE_TICK_MS || rm.landedBorrow?.proactiveTickMs || '—';
  const modeLabel = rm.bailongmaStyle ? '白龙马式' : (rm.label || rm.modeId || '模式');
  const voiceOk = voice.ready === true;
  const voiceStatus = voice.status || 'unknown';
  el.innerHTML = '';
  const chips = [
    { text: `模式 · ${modeLabel}`, cls: 'chip mode' },
    { text: `心跳 ${tick}ms`, cls: 'chip' },
    {
      text: voiceOk ? '语音就绪' : `语音 · ${voiceStatus}`,
      cls: chipClass('voice', voiceOk ? true : voiceStatus === 'degraded' ? null : false),
    },
    {
      // 有感知/记忆/证伪/边界四环可观测；真改默认 OFF → warn 而非 ok，避免误解为无人值守自改。
      text: evoLabel,
      cls: chipClass('evo', evoReal ? true : evoArmed ? null : false),
    },
  ];
  for (const c of chips) {
    const s = document.createElement('span');
    s.className = c.cls;
    s.textContent = c.text;
    el.appendChild(s);
  }
  if (voice.uiHint) {
    const hint = $('footerHint');
    if (hint) hint.textContent = voice.uiHint;
  }
}

function appendBubble(role, text) {
  const feed = $('chatFeed');
  if (!feed) return;
  const d = document.createElement('div');
  d.className = `bubble ${role}`;
  d.textContent = text;
  feed.appendChild(d);
  feed.scrollTop = feed.scrollHeight;
}

function renderAwareness(versionJson, readinessJson) {
  const el = $('awarenessList');
  if (!el) return;
  el.innerHTML = '';
  const se = versionJson?.selfEvolution || versionJson?.statusChips?.selfEvolution || {};
  const rings = se.rings || {};
  const voice = versionJson?.voiceReadiness || {};
  const items = [
    {
      title: '进化边界',
      body: se.profile === 'safe' || se.armed
        ? (se.realApply || se.armed?.realApply
          ? '真改已开启（请确认你知情）'
          : 'dry-run · 默认不真改源码')
        : '未武装 profile',
      cls: (se.realApply || se.armed?.realApply) ? 'warn' : 'ok',
    },
    {
      title: '四环',
      body: `感知${rings.perception ? '✓' : '·'} 记忆${rings.memory ? '✓' : '·'} 证伪${rings.falsification ? '✓' : '·'} 边界${rings.boundary !== false ? '✓' : '·'}`,
      cls: rings.boundary === false ? 'warn' : '',
    },
    {
      title: '语音',
      body: voice.ready ? '就绪' : (voice.uiHint || voice.status || '未知'),
      cls: voice.ready ? 'ok' : 'warn',
    },
  ];
  const checks = readinessJson?.checks;
  if (checks && typeof checks === 'object') {
    const parts = Object.entries(checks).map(([k, v]) => `${k}:${v}`).slice(0, 4);
    items.push({ title: '就绪', body: parts.join(' · ') || '—', cls: readinessJson?.ok ? 'ok' : 'warn' });
  }
  const pending = readinessJson?.counts || readinessJson?.pending;
  if (pending && typeof pending === 'object') {
    const ap = pending.approvals ?? pending.pendingApprovals;
    const acts = pending.acts ?? pending.pendingActs;
    if (ap != null || acts != null) {
      items.push({
        title: '待你确认',
        body: `审批 ${ap ?? '—'} · 行动 ${acts ?? '—'}`,
        cls: (Number(ap) > 0 || Number(acts) > 0) ? 'warn' : 'ok',
      });
    }
  }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = `rail-item ${it.cls || ''}`.trim();
    d.innerHTML = `<strong>${it.title}</strong>${it.body}`;
    el.appendChild(d);
  }
}

function renderMemory(model) {
  const el = $('memoryList');
  if (!el) return;
  el.innerHTML = '';
  if (!model || model.empty) {
    const p = document.createElement('p');
    p.className = 'empty-hint';
    p.textContent = model?.emptyHint || '还没有记忆。说「记一下：…」或先聊几句。';
    el.appendChild(p);
    return;
  }
  for (const n of (model.timeline || model.nodes || []).slice(0, 40)) {
    const card = document.createElement('div');
    card.className = 'mem-card';
    const strong = document.createElement('strong');
    strong.textContent = n.title || n.id;
    card.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = n.bodyPreview || '';
    card.appendChild(span);
    if (n.tags?.length) {
      const tags = document.createElement('div');
      tags.className = 'mem-tags';
      for (const t of n.tags.slice(0, 6)) {
        const tag = document.createElement('span');
        tag.className = 'mem-tag';
        tag.textContent = t;
        tags.appendChild(tag);
      }
      card.appendChild(tags);
    }
    el.appendChild(card);
  }
  if (model.clusters?.length) {
    const p = document.createElement('p');
    p.className = 'empty-hint';
    p.textContent = `主题簇：${model.clusters.slice(0, 6).map((c) => `${c.label}(${c.size})`).join(' · ')}`;
    el.appendChild(p);
  }
}

// Align with public/app.js SSOT: panel-owner-token + URL ?t= bootstrap (length >= 32).
const PANEL_OWNER_TOKEN_KEY = 'panel-owner-token';
let panelOwnerTokenMemory = '';

function bootstrapOwnerTokenFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const t = (params.get('t') || '').trim();
    if (t && t.length >= 32) {
      panelOwnerTokenMemory = t;
      window.__panelOwnerToken = t;
      try { sessionStorage.setItem(PANEL_OWNER_TOKEN_KEY, t); } catch { /* ignore */ }
      try { localStorage.setItem(PANEL_OWNER_TOKEN_KEY, t); } catch { /* ignore */ }
      params.delete('t');
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
    }
  } catch { /* ignore */ }
}

function getOwnerToken() {
  try {
    return (
      sessionStorage.getItem(PANEL_OWNER_TOKEN_KEY)
      || localStorage.getItem(PANEL_OWNER_TOKEN_KEY)
      || panelOwnerTokenMemory
      || window.__panelOwnerToken
      || ''
    );
  } catch {
    return panelOwnerTokenMemory || window.__panelOwnerToken || '';
  }
}

/** SSOT header for requireOwnerToken middleware. */
function ownerAuthHeaders() {
  const token = getOwnerToken();
  return token ? { 'X-Panel-Owner-Token': token } : {};
}

async function fetchVersion() {
  const r = await fetch('/api/version', {
    credentials: 'same-origin',
    headers: ownerAuthHeaders(),
  });
  if (!r.ok) throw new Error(`version_http_${r.status}`);
  return r.json();
}

/**
 * Load memory items with owner token; returns blocked=true on 401 (honest empty UI).
 * Exported path for tests via window.__homeShellTest
 */
export async function fetchMemoriesForHome(fetchImpl = fetch, getToken = getOwnerToken) {
  const token = getToken();
  const headers = token ? { 'X-Panel-Owner-Token': token } : {};
  try {
    const r = await fetchImpl('/api/noe/mind/memory/search?q=&limit=40', {
      credentials: 'same-origin',
      headers,
    });
    if (r.status === 401 || r.status === 403) return { items: [], blocked: true, status: r.status };
    if (!r.ok) return { items: [], blocked: true, status: r.status };
    const j = await r.json();
    return { items: Array.isArray(j.items) ? j.items : [], blocked: false, status: r.status };
  } catch {
    return { items: [], blocked: true, status: 0 };
  }
}

async function fetchMemories() {
  return fetchMemoriesForHome();
}

function openSettings(open) {
  $('settingsDrawer')?.classList.toggle('open', open);
  $('settingsBackdrop')?.classList.toggle('open', open);
  if (open) loadProductSettingsForm().catch(() => {});
}

/** @type {{ pendingCount: number, cards: object[] }} */
let lastPendingConfirms = { pendingCount: 0, cards: [] };

function setProductSettingsMsg(text, isErr = false) {
  const el = $('productSettingsMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isErr ? 'var(--home-bad)' : 'var(--home-muted)';
}

async function loadProductSettingsForm() {
  if (!getOwnerToken()) {
    setProductSettingsMsg('需要 owner token 才能读写设置。');
    return;
  }
  const r = await fetch('/api/noe/product-settings', {
    credentials: 'same-origin',
    headers: ownerAuthHeaders(),
  });
  if (!r.ok) {
    setProductSettingsMsg(`加载失败 HTTP ${r.status}`, true);
    return;
  }
  const j = await r.json();
  const s = j.settings || {};
  const base = /** @type {HTMLInputElement|null} */ ($('setModelBaseUrl'));
  const mid = /** @type {HTMLInputElement|null} */ ($('setModelId'));
  const voice = /** @type {HTMLInputElement|null} */ ($('setVoiceEnabled'));
  if (base) base.value = s.modelBaseUrl || '';
  if (mid) mid.value = s.modelId || '';
  if (voice) voice.checked = s.voiceEnabled !== false;
  setProductSettingsMsg(s.updatedAt ? `已加载 · 更新于 ${s.updatedAt}` : '已加载');
}

async function saveProductSettingsForm() {
  if (!getOwnerToken()) {
    setProductSettingsMsg('需要 owner token。', true);
    return;
  }
  const base = /** @type {HTMLInputElement|null} */ ($('setModelBaseUrl'));
  const mid = /** @type {HTMLInputElement|null} */ ($('setModelId'));
  const voice = /** @type {HTMLInputElement|null} */ ($('setVoiceEnabled'));
  const body = {
    modelBaseUrl: base?.value || '',
    modelId: mid?.value || '',
    voiceEnabled: voice?.checked !== false,
  };
  const r = await fetch('/api/noe/product-settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...ownerAuthHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    setProductSettingsMsg(err.error || `保存失败 HTTP ${r.status}`, true);
    return;
  }
  const j = await r.json();
  const s = j.settings || {};
  // Round-trip: reflect server DTO (never echo secrets — API strips them)
  if (base) base.value = s.modelBaseUrl || '';
  if (mid) mid.value = s.modelId || '';
  if (voice) voice.checked = s.voiceEnabled !== false;
  setProductSettingsMsg('已保存（持久化到本机 product-daily-settings）。');
  appendBubble('sys', '设置已保存：模型 URL / 模型 ID / 语音开关。');
}

function renderPendingChip(count) {
  const chip = $('pendingChip');
  if (!chip) return;
  const n = Number(count) || 0;
  if (n <= 0) {
    chip.hidden = true;
    chip.textContent = '待确认 0';
    return;
  }
  chip.hidden = false;
  chip.textContent = `待确认 ${n}`;
}

/**
 * Render high-risk confirm cards; optional file diff preview for file-kind cards.
 * @param {object[]} cards
 */
function renderConfirmCards(cards) {
  const panel = $('confirmPanel');
  const list = $('confirmCards');
  if (!panel || !list) return;
  list.innerHTML = '';
  const items = Array.isArray(cards) ? cards : [];
  if (!items.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const c of items.slice(0, 20)) {
    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.dataset.id = c.id || '';
    card.dataset.source = c.source || 'act';
    const risk = document.createElement('div');
    risk.className = 'risk';
    risk.textContent = `风险 · ${c.riskLabel || c.riskKind || '高风险'}`;
    const strong = document.createElement('strong');
    strong.textContent = c.actionType || '待确认';
    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = c.summary || c.path || c.command || '';
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'btn deny';
    deny.textContent = '拒绝';
    deny.addEventListener('click', () => decideConfirm(c, 'deny'));
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'btn allow';
    allow.textContent = '允许';
    allow.addEventListener('click', () => decideConfirm(c, 'allow'));
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'btn';
    previewBtn.textContent = 'diff 预览';
    previewBtn.hidden = c.riskKind !== 'file' && !c.path;
    previewBtn.addEventListener('click', () => showDiffForCard(c));
    actions.appendChild(deny);
    actions.appendChild(allow);
    actions.appendChild(previewBtn);
    card.appendChild(risk);
    card.appendChild(strong);
    card.appendChild(summary);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

/**
 * Client-side unified-ish preview when server has before/after; else demo structure for path.
 * Prefer POST /api/noe/diff-preview when contents available on card.
 */
async function showDiffForCard(card) {
  const box = $('diffPreviewBox');
  const pre = $('diffPreviewPre');
  if (!box || !pre) return;
  box.hidden = false;
  const path = card.path || card.payload?.path || 'unknown';
  const before = card.before ?? card.oldContent ?? card.payload?.before ?? '';
  const after = card.after ?? card.newContent ?? card.payload?.after ?? '';
  if (before || after) {
    try {
      const r = await fetch('/api/noe/diff-preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...ownerAuthHeaders(),
        },
        body: JSON.stringify({ path, before, after }),
      });
      if (r.ok) {
        const j = await r.json();
        const u = j.preview?.unified || '';
        pre.textContent = `${path}\n${u || '(无差异)'}`;
        return;
      }
    } catch { /* fall through */ }
  }
  pre.textContent = `${path}\n# 无 before/after 内容时可在确认后查看完整 diff\n# risk=${card.riskKind || ''} action=${card.actionType || ''}`;
}

async function decideConfirm(card, decision) {
  if (!getOwnerToken()) {
    appendBubble('err', '需要 owner token 才能确认/拒绝。');
    return;
  }
  const id = card.id;
  if (!id) {
    appendBubble('err', '缺少确认项 id。');
    return;
  }
  const source = card.source || 'act';
  try {
    let r;
    if (source === 'approval') {
      const path = decision === 'allow'
        ? `/api/approvals/${encodeURIComponent(id)}/approve`
        : `/api/approvals/${encodeURIComponent(id)}/reject`;
      r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...ownerAuthHeaders(),
        },
        body: JSON.stringify({ reason: decision === 'deny' ? 'home_deny' : 'home_allow' }),
      });
    } else if (decision === 'deny') {
      r = await fetch(`/api/noe/acts/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...ownerAuthHeaders(),
        },
        body: JSON.stringify({ reason: 'home_deny' }),
      });
    } else {
      // Allow: act pipeline may require separate resume; surface honest note.
      appendBubble('sys', `已标记允许 ${id}（若需继续执行，请在专家工作台完成审批恢复）。`);
      await refreshPendingConfirms();
      return;
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      appendBubble('err', err.error || `确认失败 HTTP ${r.status}`);
      return;
    }
    appendBubble('sys', decision === 'deny' ? `已拒绝 ${id}（未执行）` : `已允许 ${id}`);
    await refreshPendingConfirms();
  } catch (e) {
    appendBubble('err', e instanceof Error ? e.message : String(e));
  }
}

async function refreshPendingConfirms() {
  if (!getOwnerToken()) {
    renderPendingChip(0);
    renderConfirmCards([]);
    return lastPendingConfirms;
  }
  try {
    const r = await fetch('/api/noe/pending-confirms', {
      credentials: 'same-origin',
      headers: ownerAuthHeaders(),
    });
    if (!r.ok) {
      renderPendingChip(0);
      return lastPendingConfirms;
    }
    const j = await r.json();
    lastPendingConfirms = {
      pendingCount: Number(j.pendingCount) || (j.cards || []).length,
      cards: Array.isArray(j.cards) ? j.cards : [],
    };
    renderPendingChip(lastPendingConfirms.pendingCount);
    renderConfirmCards(lastPendingConfirms.cards);
    return lastPendingConfirms;
  } catch {
    return lastPendingConfirms;
  }
}

function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportMemories() {
  if (!getOwnerToken()) {
    appendBubble('err', '需要 owner token 才能导出记忆。');
    return;
  }
  try {
    const r = await fetch('/api/noe/memory-export-package?limit=200', {
      credentials: 'same-origin',
      headers: ownerAuthHeaders(),
    });
    if (!r.ok) {
      // Fallback to classic mind export
      const r2 = await fetch('/api/noe/mind/memory/export?limit=200', {
        credentials: 'same-origin',
        headers: ownerAuthHeaders(),
      });
      if (!r2.ok) {
        appendBubble('err', `记忆导出失败 HTTP ${r.status}`);
        return;
      }
      const j2 = await r2.json();
      downloadText(`neo-memory-${Date.now()}.json`, JSON.stringify(j2, null, 2));
      appendBubble('sys', `已导出记忆 ${Array.isArray(j2.items) ? j2.items.length : 0} 条（JSON）。`);
      return;
    }
    const j = await r.json();
    const pkg = j.package || {};
    if (pkg.json) downloadText(`neo-memory-${Date.now()}.json`, pkg.json, 'application/json');
    if (pkg.markdown) downloadText(`neo-memory-${Date.now()}.md`, pkg.markdown, 'text/markdown');
    appendBubble('sys', `已导出记忆 ${pkg.count ?? 0} 条（JSON${pkg.markdown ? ' + Markdown' : ''}）。`);
  } catch (e) {
    appendBubble('err', e instanceof Error ? e.message : String(e));
  }
}

function fillSettings() {
  const nav = buildHomeShellNavigation();
  const common = $('settingsCommon');
  const expert = $('settingsExpert');
  if (!common || !expert) return;
  common.innerHTML = '';
  expert.innerHTML = '';
  for (const item of nav.settings) {
    const a = document.createElement(item.href ? 'a' : 'button');
    a.className = 'settings-item';
    if (item.href) a.href = item.href;
    else a.type = 'button';
    a.innerHTML = `<strong>${item.title}</strong><small>${item.description}</small>`;
    if (!item.href) {
      a.addEventListener('click', () => {
        if (item.action === 'focus_product_settings') {
          $('productSettingsSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          loadProductSettingsForm().catch(() => {});
          return;
        }
        appendBubble('sys', `${item.title}：${item.description}（白龙马式模式用环境变量 NOE_RUNTIME_MODE=bailongma_style 启动）`);
        openSettings(false);
      });
    }
    common.appendChild(a);
  }
  for (const item of nav.expertReachable) {
    const a = document.createElement('a');
    a.className = 'settings-item';
    a.href = item.href || '#';
    a.innerHTML = `<strong>${item.title}</strong><small>${item.description}</small>`;
    expert.appendChild(a);
  }
}

/** Voice / text automation: map short phrases to navigation without extra buttons. */
function handleAutomation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/打开设置|设置|settings/i.test(t)) {
    openSettings(true);
    appendBubble('sys', '已打开设置。');
    return true;
  }
  if (/沉浸|认知|驾驶舱|cognitive/i.test(t)) {
    location.href = '/cognitive.html';
    return true;
  }
  if (/记忆|memory/i.test(t)) {
    document.getElementById('memoryList')?.scrollIntoView({ behavior: 'smooth' });
    appendBubble('sys', '记忆面板已在右侧/下方。');
    return true;
  }
  if (/专家|工作台|旧界面/i.test(t)) {
    location.href = '/index.html';
    return true;
  }
  return false;
}

/** Home chat room id (chat mode) — reused for the session. */
let homeChatRoomId = '';

async function ensureHomeChatRoom() {
  if (homeChatRoomId) return homeChatRoomId;
  const headers = {
    'Content-Type': 'application/json',
    ...ownerAuthHeaders(),
  };
  const r = await fetch('/api/rooms', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      name: 'Home',
      mode: 'chat',
      defaultPartner: 'codex',
    }),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error('需要 owner token（请用启动日志里带 ?t= 的链接打开）');
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `创建对话房间失败 HTTP ${r.status}`);
  }
  const j = await r.json();
  const id = j.id || j.room?.id || j.roomId;
  if (!id) throw new Error('创建房间未返回 id');
  homeChatRoomId = id;
  return id;
}

async function pollRoomReply(roomId, afterLen, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 800));
    const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      credentials: 'same-origin',
      headers: ownerAuthHeaders(),
    });
    if (!r.ok) continue;
    const room = await r.json();
    const conv = Array.isArray(room.conversation) ? room.conversation : [];
    if (conv.length > afterLen) {
      // Prefer last assistant/agent message
      for (let i = conv.length - 1; i >= afterLen; i--) {
        const m = conv[i];
        const role = String(m.role || m.speaker || m.from || '');
        const text = String(m.text || m.content || m.message || '').trim();
        if (!text) continue;
        if (/assistant|agent|ai|bot|model|codex|claude|neo/i.test(role) || m.role === 'assistant') {
          return text;
        }
      }
      const last = conv[conv.length - 1];
      const t = String(last?.text || last?.content || '').trim();
      if (t) return t;
    }
  }
  return null;
}

async function sendMessage(text) {
  const msg = String(text || '').trim();
  if (!msg) return;
  appendBubble('user', msg);
  if (handleAutomation(msg)) return;

  if (!getOwnerToken()) {
    appendBubble('err', '需要 owner token：请用终端启动日志里打印的完整 URL（含 ?t=…）打开本页。');
    return;
  }

  try {
    const roomId = await ensureHomeChatRoom();
    // Snapshot conversation length before send
    let beforeLen = 0;
    try {
      const gr = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
        credentials: 'same-origin',
        headers: ownerAuthHeaders(),
      });
      if (gr.ok) {
        const room = await gr.json();
        beforeLen = Array.isArray(room.conversation) ? room.conversation.length : 0;
      }
    } catch { /* ignore */ }

    const cr = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...ownerAuthHeaders(),
      },
      body: JSON.stringify({ text: msg }),
    });
    if (cr.status === 409) {
      appendBubble('sys', '上一条还在处理，请稍候。');
      return;
    }
    if (!cr.ok) {
      const err = await cr.json().catch(() => ({}));
      appendBubble('err', err.error || `发送失败 HTTP ${cr.status}`);
      return;
    }
    appendBubble('sys', '思考中…');
    const reply = await pollRoomReply(roomId, beforeLen);
    // Remove last "思考中" sys bubble if present
    const feed = $('chatFeed');
    if (feed?.lastChild?.classList?.contains('sys') && /思考中/.test(feed.lastChild.textContent || '')) {
      feed.lastChild.remove();
    }
    if (reply) {
      appendBubble('agent', reply);
    } else {
      appendBubble(
        'agent',
        '暂时没等到回复（可能未配置本地/云模型，或仍在生成）。可检查 LM Studio/Ollama，或说「沉浸」进认知舱。',
      );
    }
    // Refresh memory after chat
    try {
      const mem = await fetchMemories();
      const model = buildMemoryVisualModel(mem.items || []);
      if (mem.blocked && model.empty) {
        model.emptyHint = '登录 owner 后可加载记忆；当前显示为空状态（非假数据）。';
      }
      renderMemory(model);
    } catch { /* ignore */ }
  } catch (e) {
    appendBubble('err', e instanceof Error ? e.message : String(e));
  }
}

async function init() {
  bootstrapOwnerTokenFromUrl();
  fillSettings();
  $('btnOpenSettings')?.addEventListener('click', (e) => {
    e.preventDefault();
    openSettings(true);
  });
  $('btnCloseSettings')?.addEventListener('click', () => openSettings(false));
  $('settingsBackdrop')?.addEventListener('click', () => openSettings(false));
  $('btnSaveProductSettings')?.addEventListener('click', () => {
    saveProductSettingsForm().catch((e) => setProductSettingsMsg(e instanceof Error ? e.message : String(e), true));
  });
  $('btnMemoryExport')?.addEventListener('click', () => {
    exportMemories().catch(() => {});
  });
  $('pendingChip')?.addEventListener('click', () => {
    const panel = $('confirmPanel');
    if (panel && !panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    else refreshPendingConfirms().then(() => {
      $('confirmPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  $('composerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = /** @type {HTMLInputElement|null} */ ($('composerInput'));
    const v = input?.value || '';
    if (input) input.value = '';
    sendMessage(v);
  });

  $('btnVoice')?.addEventListener('click', async () => {
    appendBubble('sys', '正在检查语音就绪…');
    try {
      const j = await fetchVersion();
      renderChips(j);
      const voice = j.voiceReadiness;
      if (voice?.ready) {
        appendBubble('agent', '语音就绪。请使用系统麦克风权限；连续对话可说「沉浸」进入认知舱。');
      } else {
        appendBubble('agent', voice?.uiHint || '语音未就绪，请先打字。');
      }
    } catch {
      appendBubble('agent', '无法读取语音状态（面板离线？）。');
    }
  });

  let ver = null;
  try {
    ver = await fetchVersion();
    renderChips(ver);
    if (ver.appName) {
      const t = $('appTitle');
      if (t) t.textContent = ver.appName;
    }
  } catch (e) {
    renderChips({
      runtimeMode: { modeId: 'unknown', label: '离线' },
      voiceReadiness: { status: 'external_blocked', ready: false, uiHint: '面板未连接' },
    });
  }

  let readiness = null;
  try {
    const rr = await fetch('/api/noe/readiness', {
      credentials: 'same-origin',
      headers: ownerAuthHeaders(),
    });
    if (rr.ok) readiness = await rr.json();
  } catch { /* ignore */ }
  renderAwareness(ver || {}, readiness || {});
  await refreshPendingConfirms();

  try {
    const mem = await fetchMemories();
    const model = buildMemoryVisualModel(mem.items || []);
    if (mem.blocked && model.empty) {
      model.emptyHint = '登录 owner 后可加载记忆；当前显示为空状态（非假数据）。';
    }
    renderMemory(model);
  } catch {
    renderMemory(buildMemoryVisualModel([]));
  }

  if (!getOwnerToken()) {
    appendBubble('sys', '提示：请用启动日志中的完整链接打开（含 ?t=token），否则无法对话与加载记忆。');
  }
}

// Test hooks (shipped entry; no secrets logged)
if (typeof window !== 'undefined') {
  window.__homeShellTest = {
    getOwnerToken,
    bootstrapOwnerTokenFromUrl,
    fetchMemoriesForHome,
    ownerAuthHeaders,
    refreshPendingConfirms,
    exportMemories,
    loadProductSettingsForm,
    saveProductSettingsForm,
  };
}

init();
