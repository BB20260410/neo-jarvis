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

function clean(value, max = 1200) {
  return String(value || '').trim().slice(0, max);
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

async function getJson(path) {
  const res = await fetch(path, { headers: headers() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

function postUiSignal(event, extra = {}) {
  postNoeUiSignal(event, {
    component: 'CommandSurfacePanel',
    cardId: 'dCommandSurface',
    target: extra.target || 'command-surface-drawer',
    action: extra.action || '',
    message: extra.message || '',
    payload: extra.payload || {},
  });
}

export function selectCommandFromDiscovery(discovery = {}) {
  const results = discovery.search?.results || discovery.visibleCommands || [];
  return results.find((item) => item?.id && !item.hiddenReason) || null;
}

export function formatCommandHelp(help = {}, dryRun = {}) {
  if (!help?.ok) return `命令帮助不可用：${help?.error || 'unknown'}`;
  const properties = Object.keys(help.inputSchema?.properties || {});
  const risk = help.permissionRequired ? `${help.riskLevel} · 需要授权` : `${help.riskLevel} · 只读/低风险`;
  const preview = dryRun?.ok
    ? '预演结果：不会执行，只展示 schema 和输入预览。'
    : `预演被阻断：${dryRun?.error || 'unknown'}`;
  return [
    `命令：${help.title || help.commandId}`,
    `ID：${help.commandId}`,
    `风险：${risk}`,
    `说明：${clean(help.description, 500) || '无'}`,
    `输入：${properties.length ? properties.join('、') : '无必填 schema 字段'}`,
    preview,
  ].join('\n');
}

async function showCommandHelp() {
  const input = $('#chat-input');
  const query = clean(input?.value || '工具 帮助', 400);
  postUiSignal('card.action', { action: 'show-command-help', payload: { queryChars: query.length } });
  stream('commands', `查找命令：${query || '全部'}`, 'var(--warm)');
  const discovery = await getJson(`/api/noe/commands/discover?q=${encodeURIComponent(query)}&limit=5`);
  const command = selectCommandFromDiscovery(discovery);
  if (!command) {
    addMsg('sys', '没有找到可预演的命令；换个关键词试试。');
    postUiSignal('card.error', { message: 'command_not_found' });
    return;
  }
  const id = encodeURIComponent(command.id);
  const help = await getJson(`/api/noe/commands/${id}/help`);
  const dryRun = await postJson(`/api/noe/commands/${id}/dry-run`, { input: { query } });
  addMsg('noe', formatCommandHelp(help, dryRun));
  stream('commands', `${command.id} · dry-run=${dryRun.ok ? 'ok' : 'blocked'}`, dryRun.ok ? 'var(--cool)' : 'var(--bad)');
  postUiSignal('card.action', { action: 'command-help-shown', payload: { commandId: command.id, dryRunOk: Boolean(dryRun.ok) } });
}

export function installCognitiveCommandSurface({ root = document } = {}) {
  let installed = false;
  const row = root.querySelector('#input-row');
  const send = root.querySelector('#send-btn');
  if (row && send && !root.querySelector('#btnCommandSurface')) {
    const button = document.createElement('button');
    button.className = 'cbtn';
    button.id = 'btnCommandSurface';
    button.dataset.icon = '🧭';
    button.type = 'button';
    button.title = '查看 Neo 贾维斯工具命令的 help/schema/dry-run，不执行真实动作';
    button.textContent = '🧭 命令';
    button.onclick = showCommandHelp;
    row.insertBefore(button, send);
    installed = true;
  }
  const anchor = root.querySelector('#dLocalCouncil') || root.querySelector('#dResearch') || root.querySelector('#dDeepResearch') || root.querySelector('#dProactive');
  if (anchor && !root.querySelector('#dCommandSurface')) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.id = 'dCommandSurface';
    item.textContent = '🧭 命令帮助 / 预演';
    item.title = '查看 Neo 贾维斯工具命令的 help/schema/dry-run，不执行真实动作';
    item.onclick = showCommandHelp;
    anchor.parentNode.insertBefore(item, anchor.nextSibling);
    installed = true;
  }
  if (!installed) return { ok: false, reason: 'anchor_missing_or_installed' };
  postUiSignal('card.mounted', { payload: { mode: 'help-schema-dry-run' } });
  return { ok: true };
}

if (typeof document !== 'undefined') {
  const timer = setInterval(() => { if (installCognitiveCommandSurface().ok) clearInterval(timer); }, 500);
  installCognitiveCommandSurface();
}
