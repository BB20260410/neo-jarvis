import { postNoeUiSignal } from './noe-ui-signals.js?v=ui-signals-20260608a';

const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);
const ROUND_STORAGE_KEY = 'noe-local-council-review-rounds';
let mountedSignalSent = false;

function cleanReviewRounds(value, fallback = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(3, Math.trunc(n)));
}

function getReviewRounds() {
  return cleanReviewRounds(localStorage.getItem(ROUND_STORAGE_KEY) || 2);
}

function setReviewRounds(value) {
  const rounds = cleanReviewRounds(value);
  localStorage.setItem(ROUND_STORAGE_KEY, String(rounds));
  document.querySelectorAll('.local-council-round-button').forEach((button) => {
    const active = Number(button.dataset.rounds) === rounds;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.style.background = active ? 'var(--warm)' : 'rgba(255,255,255,.06)';
    button.style.color = active ? '#101014' : 'var(--muted)';
    button.style.borderColor = active ? 'var(--warm)' : 'rgba(255,255,255,.14)';
  });
  const item = $('#dLocalCouncil');
  if (item) item.textContent = `🧠 本地多模型讨论 · ${rounds}轮`;
  return rounds;
}

function safeStreamColor(value) {
  const color = String(value || '').trim();
  return /^(?:var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8}|rgba?\([0-9.,% ]+\)|hsla?\([0-9.,% ]+\)|[a-z]+)$/i.test(color)
    ? color
    : 'var(--cool)';
}

function addMsg(role, text) {
  const host = $('#chat-messages');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `msg msg-${role}`;
  if (role !== 'sys') {
    const label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? '用户' : 'Neo 贾维斯';
    node.appendChild(label);
  }
  const body = document.createElement('span');
  body.textContent = text;
  node.appendChild(body);
  host.appendChild(node);
  host.scrollTop = 1e9;
}

function stream(type, text, color = 'var(--cool)') {
  const host = $('#streamHost');
  if (!host) return;
  const line = document.createElement('div');
  line.className = 'stream-line';
  const header = document.createElement('div');
  header.className = 'line-header';
  const dot = document.createElement('span');
  dot.className = 'line-dot';
  const resolvedColor = safeStreamColor(color);
  dot.style.background = resolvedColor;
  const label = document.createElement('span');
  label.className = 'line-type';
  label.style.color = resolvedColor;
  label.textContent = type;
  const time = document.createElement('span');
  time.className = 'line-time';
  time.textContent = new Date().toTimeString().slice(0, 8);
  const body = document.createElement('div');
  body.className = 'line-text';
  body.textContent = text;
  header.append(dot, label, time);
  line.append(header, body);
  host.prepend(line);
  while (host.children.length > 14) host.lastChild.remove();
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

function postUiSignal(event, extra = {}) {
  postNoeUiSignal(event, {
    event,
    component: 'LocalCouncilPanel',
    cardId: 'dLocalCouncil',
    target: extra.target || 'local-council-drawer',
    action: extra.action || '',
    dwellMs: extra.dwellMs || 0,
    message: extra.message || '',
    payload: extra.payload || {},
  });
}

async function getJson(path) {
  const res = await fetch(path, { headers });
  return res.json().catch(() => ({}));
}

async function runLocalCouncil() {
  const input = $('#chat-input');
  const goal = (input?.value || '').trim();
  postUiSignal('card.action', { action: 'run-local-council', payload: { goalChars: goal.length, reviewRounds: getReviewRounds() } });
  if (!goal) {
    addMsg('sys', '先输入要让本地模型共同讨论的问题');
    postUiSignal('card.error', { message: 'goal_missing' });
    return;
  }
  stream('local council', '正在发现 LM Studio / Ollama 本地模型', 'var(--warm)');
  const discovery = await getJson('/api/noe/local-models/discover');
  const available = (discovery.models || []).length;
  const reviewRounds = getReviewRounds();
  if (available < 2) {
    addMsg('sys', `本地 council 需要至少 2 个真实可调用模型；当前 ${available} 个。`);
    postUiSignal('card.error', { message: 'insufficient_local_models', payload: { available } });
    return;
  }
  stream('local council', `发现 ${available} 个本地模型，开始 ${reviewRounds} 轮互评`, 'var(--warm)');
  const out = await postJson('/api/noe/local-council/run', { goal, evidenceText: '来自 cognitive 页面用户输入', maxParticipants: 4, reviewRounds });
  if (!out.ok) {
    addMsg('sys', `本地多模型讨论未通过：${(out.blockers || [out.error || 'unknown']).join('；')}`);
    if (out.ledgerPath) stream('ledger', out.ledgerPath, 'var(--bad)');
    postUiSignal('card.error', { message: 'local_council_failed', payload: { blockers: (out.blockers || []).slice(0, 4), hasLedger: Boolean(out.ledgerPath) } });
    return;
  }
  addMsg('noe', out.finalAnswer || '本地多模型讨论完成，但综合答案为空。');
  stream('ledger', out.ledgerPath || 'ledger 未返回', 'var(--warm)');
  postUiSignal('card.action', { action: 'local-council-completed', payload: { participantCount: (out.participants || []).length, hasLedger: Boolean(out.ledgerPath) } });
}

function makeRoundButtons() {
  const group = document.createElement('div');
  group.className = 'drawer-item';
  group.id = 'dLocalCouncilRounds';
  group.title = '选择本地模型互评轮次';
  group.style.display = 'flex';
  group.style.alignItems = 'center';
  group.style.justifyContent = 'space-between';
  group.style.gap = '8px';
  group.style.cursor = 'default';
  const label = document.createElement('span');
  label.textContent = '互评轮次';
  label.style.whiteSpace = 'nowrap';
  const controls = document.createElement('span');
  controls.style.display = 'inline-flex';
  controls.style.gap = '4px';
  for (const rounds of [1, 2, 3]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'local-council-round-button';
    button.dataset.rounds = String(rounds);
    button.textContent = `${rounds}轮`;
    button.title = `${rounds} 轮本地模型交叉互评`;
    button.style.border = '1px solid rgba(255,255,255,.14)';
    button.style.borderRadius = '6px';
    button.style.padding = '3px 6px';
    button.style.font = 'inherit';
    button.style.fontSize = '12px';
    button.style.lineHeight = '1.2';
    button.style.cursor = 'pointer';
    button.onclick = (event) => {
      event.stopPropagation();
      setReviewRounds(rounds);
      postUiSignal('card.action', { action: 'set-review-rounds', payload: { rounds } });
    };
    controls.appendChild(button);
  }
  group.append(label, controls);
  setTimeout(() => setReviewRounds(getReviewRounds()), 0);
  return group;
}

function install() {
  const anchor = $('#dResearch') || $('#dDeepResearch') || $('#dProactive');
  if (!anchor || $('#dLocalCouncil')) return;
  const item = document.createElement('div');
  item.className = 'drawer-item';
  item.id = 'dLocalCouncil';
  item.textContent = '🧠 本地多模型讨论';
  item.title = '真实调用 LM Studio / Ollama 多个本地模型，互评后合成最佳答案';
  item.onclick = runLocalCouncil;
  const rounds = makeRoundButtons();
  anchor.parentNode.insertBefore(rounds, anchor.nextSibling);
  anchor.parentNode.insertBefore(item, rounds.nextSibling);
  setReviewRounds(getReviewRounds());
  if (!mountedSignalSent) {
    mountedSignalSent = true;
    postUiSignal('card.mounted', { payload: { reviewRounds: getReviewRounds() } });
    window.addEventListener('beforeunload', () => postUiSignal('card.dismissed', { action: 'page-unload' }), { once: true });
  }
}

const timer = setInterval(() => { install(); if ($('#dLocalCouncil')) clearInterval(timer); }, 500);
install();
