const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);

const evidence = {
  source: '未观察',
  mode: 'off',
  summary: '还没有新的视觉依据。',
  at: 0,
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function timeText(ts) {
  if (!ts) return '-';
  try { return new Date(ts).toLocaleTimeString(); } catch { return '-'; }
}

function sourceLabel(source, mode) {
  if (source === 'attachment') return '附件';
  if (source === 'glance') return mode === 'camera' ? '摄像头' : mode === 'both' ? '屏幕 + 摄像头' : '屏幕';
  if (source === 'mode') return mode === 'off' ? '视觉关闭' : '视觉模式';
  return source || '未观察';
}

function installStyle() {
  if ($('#cogEvidenceStatusStyle')) return;
  const style = document.createElement('style');
  style.id = 'cogEvidenceStatusStyle';
  style.textContent = `
#visionEvidenceCard{margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:rgba(6,12,22,.44);color:var(--ink2);font:11px/1.55 var(--mono)}
.evidence-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;color:var(--dim)}
.evidence-row strong{color:var(--warm);font-size:11px}.evidence-summary{color:var(--ink2);max-height:82px;overflow:auto}
#memoryStatusSheet{position:fixed;inset:5vh 7vw;z-index:76;display:none;background:linear-gradient(160deg,rgba(8,14,25,.97),rgba(4,8,15,.98));border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 24px 90px rgba(0,0,0,.48);padding:22px;overflow:auto}
#memoryStatusSheet.on{display:block}.status-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.status-sheet-head h2{margin:0;color:var(--ink);font-size:24px;letter-spacing:0}.status-close{border:1px solid var(--line);border-radius:8px;background:rgba(6,12,22,.6);color:var(--ink);padding:8px 10px;cursor:pointer}
.status-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.status-block{min-width:0}.status-block h3{margin:0 0 8px;color:var(--dim);font:12px var(--mono)}
.status-list{display:flex;flex-direction:column;gap:8px}.status-item{border:1px solid var(--line);border-radius:8px;background:rgba(2,7,16,.52);padding:10px 11px;color:var(--ink2);font:12px/1.55 var(--mono)}
.status-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}.status-item-title{font-weight:700;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-meta{color:var(--dim);font-size:11px}.status-body{white-space:pre-wrap;word-break:break-word;max-height:92px;overflow:auto}.status-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:7px}
.status-actions button{border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink2);padding:5px 8px;cursor:pointer}.status-actions button:hover{color:var(--warm);border-color:var(--warm)}
.status-actions .danger{color:#e7a4a4;border-color:rgba(231,164,164,.32)}.status-empty{padding:16px;border:1px dashed var(--line);border-radius:8px;color:var(--dim);font:12px var(--mono)}
@media(max-width:900px){#memoryStatusSheet{inset:3vh 14px;padding:16px}.status-grid{grid-template-columns:1fr}}`;
  document.head.appendChild(style);
}

function renderEvidence() {
  const card = $('#visionEvidenceCard');
  if (!card) return;
  card.innerHTML = `
    <div class="evidence-row"><strong>${esc(sourceLabel(evidence.source, evidence.mode))}</strong><span>${esc(timeText(evidence.at))}</span></div>
    <div class="evidence-summary">${esc(evidence.summary)}</div>
  `;
}

function updateEvidence(next = {}) {
  Object.assign(evidence, next, { at: Date.now() });
  renderEvidence();
}

function installEvidenceCard() {
  const anchor = $('#perceptionText');
  if (!anchor || $('#visionEvidenceCard')) return;
  const card = document.createElement('div');
  card.id = 'visionEvidenceCard';
  anchor.insertAdjacentElement('afterend', card);
  renderEvidence();
}

function parseRequestBody(init = {}) {
  if (typeof init.body !== 'string') return {};
  try { return JSON.parse(init.body); } catch { return {}; }
}

function pathOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : input?.url || '', location.href).pathname;
  } catch {
    return '';
  }
}

function installFetchEvidenceBridge() {
  if (window.__cogEvidenceFetchBridge) return;
  window.__cogEvidenceFetchBridge = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    const requestBody = parseRequestBody(init);
    const response = await originalFetch(input, init);
    if (!path.startsWith('/api/noe/vision/')) return response;
    response.clone().json().then((data) => {
      if (path === '/api/noe/vision/mode' && data?.ok) {
        updateEvidence({
          source: 'mode',
          mode: data.mode || requestBody.mode || 'off',
          summary: data.mode === 'off' ? '视觉已关闭，不会再用屏幕或摄像头内容回答。' : `视觉模式已切到 ${data.mode || requestBody.mode}。`,
        });
      }
      if (path === '/api/noe/vision/glance' && data?.ok && data.summary) {
        updateEvidence({ source: 'glance', mode: evidence.mode || 'screen', summary: data.summary });
      }
      if (path === '/api/noe/vision/attachment' && data?.ok && data.summary) {
        const name = requestBody.name ? `「${requestBody.name}」：` : '';
        updateEvidence({ source: 'attachment', mode: 'attachment', summary: `${name}${data.summary}` });
      }
    }).catch(() => {});
    return response;
  };
}

async function readJson(path) {
  const res = await fetch(path, { headers });
  return res.json().catch(() => ({}));
}

async function sendJson(path, body = {}, method = 'POST') {
  const res = await fetch(path, { method, headers, body: JSON.stringify(body) });
  return res.json().catch(() => ({}));
}

function sourceText(item = {}) {
  const type = item.sourceType || 'manual';
  const id = item.sourceId ? ` · ${item.sourceId}` : '';
  const conf = item.confidence === undefined ? '' : ` · 可信度 ${Math.round(Number(item.confidence) * 100)}%`;
  return `${type}${id}${conf}`;
}

function memoryHtml(item = {}) {
  return `
    <div class="status-item" data-memory-id="${esc(item.id)}">
      <div class="status-item-head">
        <span class="status-item-title">${esc(item.title || item.id)}</span>
        <span class="status-meta">${esc(item.scope || 'project')}</span>
      </div>
      <div class="status-meta">${esc(sourceText(item))} · ${esc(timeText(item.updatedAt || item.createdAt))}</div>
      <div class="status-body">${esc(item.body || '')}</div>
      <div class="status-actions"><button type="button" class="danger" data-delete-memory="${esc(item.id)}">删除这条记忆</button></div>
    </div>
  `;
}

function actText(act = {}) {
  const title = act.title || act.action || act.id || '未命名执行';
  const reason = act.failureReason || act.blockReason || act.reason || '';
  const risk = act.riskLevel ? ` · 风险 ${act.riskLevel}` : '';
  return { title, meta: `${act.status || 'unknown'}${risk}`, body: reason || act.summary || act.description || '暂无失败原因或执行说明。' };
}

function actHtml(act = {}) {
  const data = actText(act);
  const canCancel = ['pending', 'proposed', 'awaiting_approval', 'running'].includes(String(act.status || ''));
  return `
    <div class="status-item" data-act-id="${esc(act.id)}">
      <div class="status-item-head"><span class="status-item-title">${esc(data.title)}</span><span class="status-meta">${esc(timeText(act.updatedAt || act.createdAt))}</span></div>
      <div class="status-meta">${esc(data.meta)}</div>
      <div class="status-body">${esc(data.body)}</div>
      ${canCancel ? `<div class="status-actions"><button type="button" data-cancel-act="${esc(act.id)}">取消执行</button></div>` : ''}
    </div>
  `;
}

function sheetHtml() {
  return `
    <div class="status-sheet-head">
      <h2>记忆 / 执行状态</h2>
      <button type="button" class="status-close" id="memoryStatusClose">关闭</button>
    </div>
    <div class="status-grid">
      <section class="status-block"><h3>最近记忆</h3><div class="status-list" id="memoryStatusMemories"></div></section>
      <section class="status-block"><h3>执行队列</h3><div class="status-list" id="memoryStatusActs"></div></section>
    </div>
  `;
}

function installStatusSheet() {
  if (!$('#memoryStatusSheet')) {
    const sheet = document.createElement('section');
    sheet.id = 'memoryStatusSheet';
    sheet.innerHTML = sheetHtml();
    document.body.appendChild(sheet);
  }
  const anchor = $('#dPeopleKb') || $('#dProactive');
  if (anchor && !$('#dMemoryStatus')) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.id = 'dMemoryStatus';
    item.textContent = '🧾 记忆 / 执行状态';
    anchor.insertAdjacentElement('afterend', item);
    item.onclick = openStatusSheet;
  }
  $('#memoryStatusClose')?.addEventListener('click', () => $('#memoryStatusSheet')?.classList.remove('on'));
}

function renderList(root, html, empty) {
  if (!root) return;
  root.innerHTML = html || `<div class="status-empty">${esc(empty)}</div>`;
}

async function refreshStatusSheet() {
  const [mem, acts] = await Promise.all([
    readJson('/api/noe/memory?limit=12'),
    readJson('/api/noe/acts?limit=12'),
  ]);
  const memories = Array.isArray(mem.items) ? mem.items : [];
  const actItems = Array.isArray(acts.items) ? acts.items : [];
  renderList($('#memoryStatusMemories'), memories.map(memoryHtml).join(''), '还没有可显示的记忆。');
  renderList($('#memoryStatusActs'), actItems.map(actHtml).join(''), '当前没有执行队列。');
}

async function deleteMemory(id) {
  if (!id) return;
  const out = await sendJson(`/api/noe/memory/${encodeURIComponent(id)}?reason=cognitive_ui_delete`, {}, 'DELETE');
  if (!out?.ok) throw new Error(out?.error || '删除失败');
  await refreshStatusSheet();
}

async function cancelAct(id) {
  if (!id) return;
  const out = await sendJson(`/api/noe/acts/${encodeURIComponent(id)}/cancel`, { reason: 'cognitive_ui_cancel' });
  if (!out?.ok) throw new Error(out?.error || '取消失败');
  await refreshStatusSheet();
}

async function openStatusSheet() {
  const sheet = $('#memoryStatusSheet');
  if (!sheet) return;
  sheet.classList.add('on');
  await refreshStatusSheet();
}

document.addEventListener('click', async (event) => {
  const memoryId = event.target?.dataset?.deleteMemory;
  const actId = event.target?.dataset?.cancelAct;
  try {
    if (memoryId) await deleteMemory(memoryId);
    if (actId) await cancelAct(actId);
  } catch (e) {
    const host = $('#memoryStatusMemories') || $('#chat-messages');
    if (host) host.insertAdjacentHTML('afterbegin', `<div class="status-empty">操作失败：${esc(e?.message || e)}</div>`);
  }
});

installStyle();
installEvidenceCard();
installFetchEvidenceBridge();
installStatusSheet();
document.documentElement.dataset.cogEvidenceStatus = '1';
