import { postNoeUiSignal } from './noe-ui-signals.js?v=ui-signals-20260608a';

const $ = (selector) => document.querySelector(selector);

function token() {
  return new URLSearchParams(location.search).get('t')
    || localStorage.getItem('panel-owner-token')
    || sessionStorage.getItem('panel-owner-token')
    || '';
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token() };
}

function clean(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function addMsg(role, text) {
  const host = $('#chat-messages');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `msg msg-${role}`;
  const label = document.createElement('span');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? '用户' : 'Neo 贾维斯';
  const body = document.createElement('span');
  body.textContent = text;
  node.append(label, body);
  host.appendChild(node);
  host.scrollTop = 1e9;
}

async function getCards(fetchImpl = fetch) {
  const res = await fetchImpl('/api/noe/acui/cards?limit=8', { headers: headers() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

export function formatNoeAcuiCard(card = {}) {
  const parts = [
    `${clean(card.type, 40) || 'task'} / ${clean(card.status, 40) || 'pending'}`,
    clean(card.title, 160),
    clean(card.message, 500),
  ].filter(Boolean);
  const refs = Array.isArray(card.evidenceRefs) && card.evidenceRefs.length ? `证据：${card.evidenceRefs.map((item) => clean(item, 160)).join(', ')}` : '';
  const blockers = Array.isArray(card.blockers) && card.blockers.length ? `阻断：${card.blockers.map((item) => clean(item, 160)).join(', ')}` : '';
  return [...parts, refs, blockers].filter(Boolean).join('\n');
}

export function renderNoeAcuiCards(cards = [], { add = addMsg } = {}) {
  const visible = (Array.isArray(cards) ? cards : []).filter((card) => !card.hidden).slice(-8);
  const text = visible.length
    ? visible.map(formatNoeAcuiCard).join('\n\n')
    : '当前没有活动状态卡片。';
  add('noe', text);
  return { ok: true, count: visible.length, text };
}

async function showAcuiCards() {
  postNoeUiSignal('card.action', { component: 'AcuiLitePanel', cardId: 'btnAcuiCards', action: 'show-acui-cards' });
  const json = await getCards();
  if (!json.ok) {
    addMsg('noe', `状态卡片读取失败：${clean(json.error || 'unknown', 200)}`);
    return;
  }
  renderNoeAcuiCards(json.cards || []);
}

export function installCognitiveAcuiLite({ root = document } = {}) {
  const row = root.querySelector('#input-row');
  const send = root.querySelector('#send-btn');
  const doc = root.ownerDocument || globalThis.document;
  if (!row || !send || !doc?.createElement || root.querySelector('#btnAcuiCards')) return { ok: false, reason: 'input_row_missing_or_installed' };
  const button = doc.createElement('button');
  button.className = 'cbtn';
  button.id = 'btnAcuiCards';
  button.dataset.icon = '🧭';
  button.type = 'button';
  button.title = '查看 Neo 贾维斯当前状态卡片';
  button.textContent = '🧭 状态';
  button.onclick = showAcuiCards;
  row.insertBefore(button, send);
  postNoeUiSignal('card.mounted', { component: 'AcuiLitePanel', cardId: 'btnAcuiCards', payload: { mode: 'acui-lite' } });
  return { ok: true };
}

if (typeof document !== 'undefined') {
  const timer = setInterval(() => { if (installCognitiveAcuiLite().ok) clearInterval(timer); }, 500);
  installCognitiveAcuiLite();
}
