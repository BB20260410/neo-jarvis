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
    component: 'TaskFlowPanel',
    cardId: 'dTaskFlow',
    target: extra.target || 'taskflow-drawer',
    action: extra.action || '',
    message: extra.message || '',
    payload: extra.payload || {},
  });
}

export function formatTaskFlowSummary(summary = {}) {
  if (!summary?.flowId) return '还没有任务流记录。';
  const current = summary.currentStep ? `${summary.currentStep.title || summary.currentStep.id}（${summary.currentStep.status}）` : '无';
  const counts = summary.stepCounts || {};
  return [
    `任务流：${summary.flowId}`,
    `目标：${clean(summary.goal, 300) || '未填写'}`,
    `状态：${summary.status || 'unknown'}${summary.cancelRequested ? ' · 已请求取消' : ''}`,
    `当前步骤：${current}`,
    `进度：通过 ${counts.passed || 0} / 失败 ${counts.failed || 0} / 待处理 ${counts.pending || 0}`,
    `证据：${summary.evidenceCount || 0} 条`,
  ].join('\n');
}

export function shouldCreateTaskFlow(summary = null) {
  if (!summary?.flowId) return true;
  return !['running'].includes(summary.status);
}

async function showOrCreateTaskFlow() {
  const goal = clean($('#chat-input')?.value || '观察当前任务进展', 500);
  postUiSignal('card.action', { action: 'show-taskflow', payload: { goalChars: goal.length } });
  const list = await getJson('/api/noe/taskflows?limit=1');
  let summary = list.flows?.[0] || null;
  if (shouldCreateTaskFlow(summary)) {
    const flowId = `ui-${Date.now()}`;
    const created = await postJson('/api/noe/taskflows', {
      flowId,
      kind: 'ui-supervision',
      goal,
      steps: ['context', 'plan', 'execute', 'verify', 'review'],
      metadata: { source: 'cognitive-taskflow' },
    });
    summary = created.summary;
    stream('taskflow', `已创建任务流 ${flowId}`, 'var(--warm)');
  } else {
    stream('taskflow', `读取任务流 ${summary.flowId}`, 'var(--cool)');
  }
  addMsg('noe', formatTaskFlowSummary(summary));
}

export function installCognitiveTaskFlow({ root = document } = {}) {
  const row = root.querySelector('#input-row');
  const send = root.querySelector('#send-btn');
  if (!row || !send || root.querySelector('#btnTaskFlow')) return { ok: false, reason: 'input_row_missing_or_installed' };
  const button = document.createElement('button');
  button.className = 'cbtn';
  button.id = 'btnTaskFlow';
  button.dataset.icon = '📋';
  button.type = 'button';
  button.title = '查看或创建当前任务流，只记录步骤和证据，不执行动作';
  button.textContent = '📋 任务';
  button.onclick = showOrCreateTaskFlow;
  row.insertBefore(button, send);
  postUiSignal('card.mounted', { payload: { mode: 'taskflow-supervision' } });
  return { ok: true };
}

if (typeof document !== 'undefined') {
  const timer = setInterval(() => { if (installCognitiveTaskFlow().ok) clearInterval(timer); }, 500);
  installCognitiveTaskFlow();
}
