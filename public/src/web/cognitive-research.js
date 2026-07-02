import './cognitive-attachments.js?v=attach-20260605e';
import './cognitive-profiles.js?v=profiles-20260606c';
import './cognitive-people.js?v=people-split-20260611a';
import './cognitive-vad-settings.js?v=vad-calibration-20260606a';
import './cognitive-evidence-status.js?v=evidence-status-20260606a';
import './cognitive-local-council.js?v=local-council-20260607a'; import './cognitive-command-surface.js?v=command-surface-20260608a';
import './cognitive-taskflow.js?v=taskflow-20260608a'; import './cognitive-acui-lite.js?v=acui-lite-20260608a';
import './cognitive-action-drawer.js?v=action-drawer-20260608b';
import { installNoeUiSignalLifecycle } from './noe-ui-signals.js?v=ui-signals-20260608a';
import { initIdentityBridgeUi, installIdentityFetchBridge, installOwnerGateUI, installBargeThresholdUI, installOwnerIdentityUI } from './cognitive-identity-bridge.js?v=identity-bridge-20260611a';

const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);
// identityModelSettings/window.cog* 身份 API 面已整体迁至 cognitive-identity-bridge.js（单一属主）

function installCompactToolbar() {
  if ($('#cognitiveResearchStyle')) return;
  const style = document.createElement('style');
  style.id = 'cognitiveResearchStyle';
  style.textContent = `
@media(max-width:1500px){#input-row{gap:8px;padding:12px}#input-row .cbtn[data-icon]{width:42px;height:40px;padding:0;font-size:0;letter-spacing:0;display:flex;align-items:center;justify-content:center}#input-row .cbtn[data-icon]::before{content:attr(data-icon);font-size:15px;line-height:1}}
@media(max-width:720px){#input-row{flex-wrap:wrap;align-items:flex-end}#chat-input{flex:1 1 180px}.cbtn,#send-btn{min-height:40px}}
@media(max-width:520px){#chat-input{flex:1 1 calc(100% - 32px)}#send-btn{min-width:64px;padding:0 12px}}
.drawer-field{display:flex;flex-direction:column;gap:5px;margin:7px 0 8px;color:var(--dim);font:11px var(--mono)}
	.drawer-field input{border:1px solid var(--line);border-radius:8px;background:rgba(2,7,16,.56);color:var(--ink);padding:9px 10px;font:12px var(--mono);outline:none}
	.drawer-field input:focus{border-color:var(--warm)}
	.barge-presets{display:flex;gap:6px;flex-wrap:wrap}
	.barge-presets button{border:1px solid var(--line);border-radius:8px;background:rgba(2,7,16,.56);color:var(--ink2);padding:6px 8px;font:11px var(--mono);cursor:pointer}
	.identity-hint{margin:4px 0 8px;padding:0 2px;color:var(--dim);font:11px/1.55 var(--mono)}
.drawer-item.danger{color:#e7a4a4;border-color:rgba(231,164,164,.24)}`;
  document.head.appendChild(style);
}

function iconify(selector, icon) { const el = $(selector); if (el) el.dataset.icon = icon; }

function safeStreamColor(value) {
  const color = String(value || '').trim();
  return /^(?:var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8}|rgba?\([0-9.,% ]+\)|hsla?\([0-9.,% ]+\)|[a-z]+)$/i.test(color)
    ? color
    : 'var(--cool)';
}

function msg(role, text) {
  const host = $('#chat-messages');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `msg msg-${role}`;
  if (role !== 'sys') {
    const label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? '用户' : 'Noe';
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

function busyText(label = 'research') {
  return ({ search: '正在搜索', wiki: '正在查 Wiki', research: '正在研究' })[label] || '处理中';
}

function setBusy(on, label = 'research') {
  const state = $('#stState');
  if (state) {
    state.innerHTML = on ? '<span class="live-dot"></span>' + busyText(label) : '<span class="live-dot"></span>待命';
    state.className = 'stat-value live';
  }
  window.pulseGraph?.(on ? 10 : 4);
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return res.json().catch(() => ({}));
}

function queryText(prefix) {
  const input = $('#chat-input');
  const q = String(window.cogAttachText?.(input?.value) || input?.value || '').trim();
  if (!q) {
    msg('sys', '先输入要搜索或研究的问题。');
    return '';
  }
  if (input) input.value = ''; window.cogAttachSent?.();
  msg('user', `${prefix}：${q}`);
  return q;
}

async function runSearch() {
  const q = queryText('联网搜索');
  if (!q) return;
  setBusy(true, 'search');
  stream('搜索', q, 'var(--warm)');
  try {
    const out = await api('/api/noe/do', { text: `搜索 ${q}`, count: 6 });
    if (out?.ok && out.matched) {
      msg('noe', out.reply || String(out.result || '').slice(0, 1800));
      stream('搜索', `${out.count || 0} 条结果 · ${out.query || q}`, 'var(--cool)');
    } else {
      msg('sys', '✗ ' + (out?.error || out?.hint || '搜索没有返回结果'));
    }
  } catch (e) {
    msg('sys', '✗ ' + (e?.message || '搜索失败'));
  } finally {
    setBusy(false);
  }
}

async function runWiki() {
  const q = queryText('本地 Wiki');
  if (!q) return;
  setBusy(true, 'wiki');
  stream('Wiki', q, 'var(--cool)');
  try {
    const out = await api('/api/noe/do', { text: q, localWiki: true, topK: 4 });
    if (out?.ok && out.matched) {
      msg('noe', out.reply || '本地 Wiki 没有返回内容。');
      stream('Wiki', `${out.count || 0} 条命中 · ${out.query || q}`, 'var(--cool)');
    } else {
      msg('sys', '✗ ' + (out?.error || out?.hint || '本地 Wiki 没有命中'));
    }
  } catch (e) {
    msg('sys', '✗ ' + (e?.message || '本地 Wiki 查询失败'));
  } finally {
    setBusy(false);
  }
}

function parseSseChunk(buffer, onEvent) {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() || '';
  for (const part of parts) {
    const ev = (part.match(/^event:\s*(.+)$/m) || [])[1] || 'message';
    const data = (part.match(/^data:\s*(.+)$/m) || [])[1] || '{}';
    try { onEvent(ev, JSON.parse(data)); } catch { onEvent(ev, {}); }
  }
  return rest;
}

function researchProgressText(data = {}) {
  const round = data.round ? `（第 ${data.round} 轮）` : '';
  const phase = data.phase || 'progress';
  if (data.stillWorking && phase === 'plan') return `仍在规划研究方向${round}`;
  if (data.stillWorking && phase === 'search') return `仍在搜索资料${round}`;
  if (data.stillWorking && phase === 'fetch') return `仍在打开资料来源${round}`;
  if (data.stillWorking && phase === 'synthesize') return `仍在整理成报告${round}`;
  if (data.stillWorking) return `仍在研究${round}`;
  if (phase === 'plan') return `正在规划研究方向${round}`;
  if (phase === 'search') return `正在搜索资料${round}`;
  if (phase === 'fetch') return `正在打开资料来源${round}`;
  if (phase === 'synthesize') return `正在整理成报告${round}`;
  if (phase === 'done') return `研究整理完成${round}`;
  return `正在研究${round}`;
}

async function runDeep() {
  const q = queryText('深度研究');
  if (!q) return;
  setBusy(true, 'research');
  stream('研究', `开始研究：${q}`, 'var(--warm)');
  let finalText = '';
  try {
    const res = await fetch('/api/noe/research/deep', { method: 'POST', headers, body: JSON.stringify({ question: q, maxRounds: 3 }) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const onEvent = (ev, data) => {
      if (ev === 'progress') stream('研究', researchProgressText(data), 'var(--warm)');
      if (ev === 'result') finalText = data.report || '';
      if (ev === 'error') msg('sys', '✗ ' + (data.error || '研究失败'));
      if (ev === 'done') stream('研究', researchProgressText({ phase: 'done', round: data.round }), 'var(--cool)');
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = parseSseChunk(buffer + decoder.decode(value, { stream: true }), onEvent);
    }
    if (buffer) parseSseChunk(buffer + '\n\n', onEvent);
    msg('noe', finalText ? finalText.slice(0, 2600) : '研究结束，但没有形成有效报告。');
    stream('研究', '已生成研究结果', 'var(--cool)');
  } catch (e) {
    msg('sys', '✗ ' + (e?.message || '深度研究失败'));
  } finally {
    setBusy(false);
  }
}

function button(id, text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'cbtn';
  b.id = id;
  b.dataset.icon = text.slice(0, 2).trim();
  b.type = 'button';
  b.title = title;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

const row = $('#input-row');
const send = $('#send-btn');
if (row && send) {
  initIdentityBridgeUi({ msg, stream }); // 把聊天/事件流渲染注入身份桥（msg/stream 单一来源留本文件）
  installIdentityFetchBridge();
  installNoeUiSignalLifecycle();
  installCompactToolbar();
  installOwnerGateUI();
  installBargeThresholdUI();
  installOwnerIdentityUI();
  iconify('#btnVision', '👁');
  iconify('#btnLive', '🎙');
  row.insertBefore(button('btnLocalWiki', '📚 Wiki', '查询本地 LLM Wiki', runWiki), send);
  row.insertBefore(button('btnWebSearch', '🔍 搜索', '联网搜索当前输入', runSearch), send);
  row.insertBefore(button('btnDeepResearch', '🔬 研究', '多步深度研究当前输入', runDeep), send);
}
