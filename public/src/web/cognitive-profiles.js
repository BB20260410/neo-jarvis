const KEY = 'noe.cognitive.chatProfile';
const token = new URLSearchParams(location.search).get('t') || localStorage.getItem('panel-owner-token') || sessionStorage.getItem('panel-owner-token') || '';
const profileAliases = { m3_thinking: 'm3_assistant', m27_highspeed: 'm3_fast' };
const fallback = [
  { id: 'default', name: '默认模式', adapterId: 'auto', model: '', mode: 'companion', personaName: '宝贝', temperature: 0.4, maxCompletionTokens: 0, noAbort: true, thinkingMode: 'default', builtIn: true, systemPrompt: '' },
  { id: 'm3_companion', name: '亲密模式', adapterId: 'minimax', model: 'MiniMax-M3', mode: 'companion', personaName: '宝贝', temperature: 0.55, maxCompletionTokens: 8192, noAbort: true, thinkingMode: 'disabled', builtIn: true, systemPrompt: '' },
  { id: 'm3_assistant', name: '工作模式', adapterId: 'minimax', model: 'MiniMax-M3', mode: 'assistant', personaName: 'Noe', temperature: 0.25, maxCompletionTokens: 16384, noAbort: true, thinkingMode: 'default', builtIn: true, systemPrompt: '' },
  { id: 'm3_fast', name: '快速模式', adapterId: 'minimax', model: 'MiniMax-M3', mode: 'assistant', personaName: 'Noe', temperature: 0.2, maxCompletionTokens: 8192, noAbort: true, thinkingMode: 'disabled', builtIn: true, systemPrompt: '' },
];
let profiles = fallback;
let modelCatalog = null;
let editingId = localStorage.getItem(KEY) || 'default';
let draftNew = false;
let deleteArmed = false;

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizeProfileId = (id) => profileAliases[String(id || '').trim()] || String(id || '').trim() || 'default';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const api = (path, opts = {}) => fetch(path, { headers, ...opts }).then((r) => r.json()).catch((e) => ({ ok: false, error: e?.message || 'network' }));

function adapterMeta(p) {
  if (!p || p.adapterId === 'auto') return '自动路由';
  const isM3 = p.adapterId === 'minimax' && (!p.model || /MiniMax-M3/i.test(p.model));
  const thinking = isM3 ? ` · ${p.thinkingMode === 'disabled' ? '无思考' : '默认思考'}` : '';
  return `${p.adapterId}${p.model ? ` · ${p.model}` : ''}${thinking}`;
}

function compactMeta(p) {
  if (!p || p.adapterId === 'auto') return '自动';
  const model = /minimax/i.test(p.adapterId) && /M2\.7-highspeed/i.test(p.model || '') ? 'M2.7 极速' : (/minimax/i.test(p.adapterId) ? 'M3' : (p.model || p.adapterId));
  const isM3 = p.adapterId === 'minimax' && (!p.model || /MiniMax-M3/i.test(p.model));
  const thinking = isM3 ? ` · ${p.thinkingMode === 'disabled' ? '无思考' : '思考开'}` : '';
  return `${model}${thinking}`;
}

function displayName(p) {
  const name = String(p?.name || '').replace(/\s*M3$/, '').trim();
  return p?.adapterId === 'minimax' ? name.replace(/^M3\s*/, '').trim() : name;
}

function providers() {
  return modelCatalog?.providers?.length ? modelCatalog.providers : [
    { id: 'auto', label: '自动路由', available: true, status: '按任务自动选择', models: [{ id: '', label: '自动选择', available: true }] },
    { id: 'claude', label: 'Claude Code', available: true, status: '本机 CLI', models: [{ id: '', label: '账号默认模型', available: true }, { id: 'opus', label: 'opus', available: true }, { id: 'sonnet', label: 'sonnet', available: true }] },
    { id: 'codex', label: 'Codex / GPT', available: true, status: '本机 CLI', models: [{ id: '', label: '账号默认模型', available: true }, { id: 'gpt-5', label: 'gpt-5', available: true }, { id: 'gpt-5-codex', label: 'gpt-5-codex', available: true }] },
    { id: 'minimax', label: 'MiniMax', available: true, status: '默认', models: [{ id: 'MiniMax-M3', label: 'MiniMax-M3', available: true }, { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax-M2.7-highspeed', available: true }, { id: 'MiniMax-M2.7', label: 'MiniMax-M2.7', available: true }] },
    { id: 'ollama', label: 'Ollama', available: true, status: '本地', models: [] },
    { id: 'ollama-9b', label: 'Ollama 9B', available: true, status: '本地', models: [] },
    { id: 'lmstudio', label: 'LM Studio', available: true, status: '本地', models: [] },
  ];
}

function providerOf(id) {
  return providers().find((p) => p.id === id) || providers()[0];
}

function modelOptions(adapterId, currentModel = '') {
  const p = providerOf(adapterId);
  const rows = Array.isArray(p?.models) ? [...p.models] : [];
  if (currentModel && !rows.some((m) => m.id === currentModel)) rows.unshift({ id: currentModel, label: `${currentModel}（当前保存）`, available: p?.available !== false });
  if (!rows.length) rows.push({ id: currentModel || '', label: currentModel || '使用通道默认模型', available: !!p?.available });
  return rows;
}

function refreshModelSelect() {
  const form = document.querySelector('#profileForm');
  const adapter = form?.querySelector('[name="adapterId"]');
  const model = form?.querySelector('[name="model"]');
  const note = form?.querySelector('#modelNote');
  if (!adapter || !model) return;
  const p = providerOf(adapter.value);
  const sameAdapter = (model.dataset.adapter || adapter.value) === adapter.value;
  const old = sameAdapter ? (model.value || model.dataset.savedModel || '') : '';
  const rows = modelOptions(adapter.value, old);
  model.innerHTML = rows.map((m) => `<option value="${esc(m.id)}" ${m.id === old ? 'selected' : ''} ${m.available === false && m.id !== old ? 'disabled' : ''}>${esc(m.label || m.id || '默认模型')}${m.available === false ? ' · 不可用' : ''}</option>`).join('');
  if (!rows.some((m) => m.id === old)) model.value = rows.find((m) => m.available !== false)?.id || '';
  model.dataset.savedModel = model.value || '';
  model.dataset.adapter = adapter.value;
  if (note) note.textContent = `${p?.label || adapter.value} · ${p?.status || ''}`;
}

function current() {
  const id = normalizeProfileId(localStorage.getItem(KEY) || editingId || 'default');
  if (id !== localStorage.getItem(KEY)) localStorage.setItem(KEY, id);
  return profiles.find((p) => p.id === id) || profiles[0] || fallback[0];
}

function css() {
  if (document.querySelector('#cogProfileStyle')) return;
  const style = document.createElement('style');
  style.id = 'cogProfileStyle';
  style.textContent = `
#chat-profile-bar{display:flex;align-items:center;gap:8px;margin:0 0 10px;color:var(--muted);font-family:var(--mono);font-size:12px}
#chat-profile-bar .profile-tabs{display:flex;gap:6px;min-width:0;overflow:auto;scrollbar-width:none}
#chat-profile-bar .profile-tabs::-webkit-scrollbar{display:none}
#chat-profile-bar button,.profile-sheet button{border:1px solid var(--border);background:rgba(7,12,24,.64);color:var(--muted);border-radius:8px;padding:8px 10px;min-height:36px;font:700 12px var(--mono);cursor:pointer;display:flex;gap:6px;align-items:center;white-space:nowrap}
#chat-profile-bar button span{color:var(--dim);font-weight:600}.profile-settings-btn{width:38px;justify-content:center}
#chat-profile-bar button.active{border-color:var(--warm);color:var(--text);background:rgba(205,158,118,.16);box-shadow:0 0 0 1px rgba(205,158,118,.18) inset}
.profile-sheet{position:fixed;inset:0;z-index:80;display:none;align-items:flex-end;justify-content:center;background:rgba(2,7,16,.58);backdrop-filter:blur(14px)}
.profile-sheet.on{display:flex}.profile-panel{width:min(980px,calc(100vw - 28px));max-height:min(760px,calc(100vh - 34px));overflow:auto;background:rgba(7,13,25,.96);border:1px solid var(--border);border-radius:12px 12px 0 0;padding:18px;box-shadow:0 -20px 70px rgba(0,0,0,.42)}
.profile-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.profile-panel-head h3{margin:0;font-size:16px;color:var(--text)}
.profile-editor{display:grid;grid-template-columns:minmax(180px,260px) 1fr;gap:14px}.profile-list{display:flex;flex-direction:column;gap:8px}.profile-list button{justify-content:space-between}.profile-list button.active{border-color:var(--warm);color:var(--text)}
.profile-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.profile-form label{display:flex;flex-direction:column;gap:6px;color:var(--dim);font:700 12px var(--mono)}
.profile-form input,.profile-form select,.profile-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;background:rgba(2,7,16,.72);color:var(--text);padding:10px;font:600 13px var(--mono);outline:none}.profile-form textarea{grid-column:1/-1;min-height:190px;resize:vertical;line-height:1.55}
.model-note{color:var(--dim);font-size:11px;line-height:1.35;min-height:15px}
.profile-actions{grid-column:1/-1;display:flex;align-items:center;gap:8px;justify-content:flex-end}.profile-actions .danger{border-color:rgba(220,92,92,.58);color:#ffb7b7}.profile-toast{min-height:18px;color:var(--warm);font-size:12px}
@media(max-width:820px){#chat-profile-bar{align-items:flex-start;flex-direction:column}.profile-editor{grid-template-columns:1fr}.profile-form{grid-template-columns:1fr}}`;
  document.head.appendChild(style);
}

function renderTabs() {
  const active = current();
  const tabs = document.querySelector('#chatProfileTabs');
  if (tabs) tabs.innerHTML = profiles.map((p) => `<button type="button" data-profile="${esc(p.id)}" title="${esc(adapterMeta(p))}" class="${p.id === active.id ? 'active' : ''}">${esc(displayName(p))}<span>${esc(compactMeta(p))}</span></button>`).join('');
  const brain = document.querySelector('#stBrain');
  if (brain) brain.textContent = active.adapterId === 'auto' ? '自动路由' : (active.model || active.adapterId);
}

function profileByEdit() {
  return profiles.find((p) => p.id === editingId) || profiles[0] || fallback[0];
}

function renderEditor() {
  const p = draftNew ? { id: `custom_${Date.now().toString(36)}`, name: '自定义配置', adapterId: 'auto', model: '', mode: 'general', personaName: 'Noe', temperature: 0.4, maxCompletionTokens: 0, noAbort: true, thinkingMode: 'default', builtIn: false, systemPrompt: '你是 Noe 的自定义聊天配置。中文回答，清晰自然。' } : profileByEdit();
  const list = document.querySelector('#profileList');
  if (list) list.innerHTML = profiles.map((row) => `<button type="button" data-edit="${esc(row.id)}" title="${esc(row.name)}" class="${row.id === editingId && !draftNew ? 'active' : ''}"><b>${esc(displayName(row))}</b><span>${esc(row.builtIn ? '内置' : '自定义')}</span></button>`).join('');
  const form = document.querySelector('#profileForm');
  if (!form) return;
  form.innerHTML = `
    <label>ID<input name="id" value="${esc(p.id)}" ${p.builtIn && !draftNew ? 'disabled' : ''}></label>
    <label>名称<input name="name" value="${esc(p.name)}"></label>
    <label>通道<select name="adapterId">${providers().map((v) => `<option value="${esc(v.id)}" ${p.adapterId === v.id ? 'selected' : ''} ${v.available === false && p.adapterId !== v.id ? 'disabled' : ''}>${esc(v.label || v.id)}${v.available === false ? ' · 不可用' : ''}</option>`).join('')}</select></label>
    <label>模型<select name="model"></select><span class="model-note" id="modelNote"></span></label>
    <label>模式<select name="mode">${['general','companion','assistant'].map((v) => `<option value="${v}" ${p.mode === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>M3 思考<select name="thinkingMode"><option value="default" ${p.thinkingMode !== 'disabled' ? 'selected' : ''}>默认思考</option><option value="disabled" ${p.thinkingMode === 'disabled' ? 'selected' : ''}>关闭思考</option></select></label>
    <label>温度<input name="temperature" type="number" min="0" max="2" step="0.05" value="${esc(p.temperature ?? 0.4)}"></label>
    <label>最大输出 tokens<input name="maxCompletionTokens" type="number" min="0" max="200000" step="1024" value="${esc(p.maxCompletionTokens ?? 0)}"></label>
    <label>称呼替换<input name="personaName" value="${esc(p.personaName || 'Noe')}"></label>
    <label><span>系统提示词</span><textarea name="systemPrompt">${esc(p.systemPrompt || '')}</textarea></label>
    <div class="profile-actions"><label style="flex-direction:row;align-items:center"><input name="noAbort" type="checkbox" ${p.noAbort ? 'checked' : ''}>模型不设本地超时</label><span class="profile-toast" id="profileToast"></span><button type="button" id="profileNew">新增</button><button type="button" id="profileDelete" class="danger" ${p.builtIn || draftNew ? 'disabled' : ''}>删除</button><button type="button" id="profileSave">保存</button></div>`;
  form.querySelector('[name="model"]').dataset.savedModel = p.model || '';
  form.querySelector('[name="model"]').dataset.adapter = p.adapterId || 'auto';
  form.querySelector('[name="model"]').value = p.model || '';
  refreshModelSelect();
}

function readForm() {
  const fd = new FormData(document.querySelector('#profileForm'));
  return { id: fd.get('id'), name: fd.get('name'), adapterId: fd.get('adapterId'), model: fd.get('model'), mode: fd.get('mode'), thinkingMode: fd.get('thinkingMode'), temperature: Number(fd.get('temperature')), maxCompletionTokens: Number(fd.get('maxCompletionTokens')), personaName: fd.get('personaName'), systemPrompt: fd.get('systemPrompt'), noAbort: fd.get('noAbort') === 'on' };
}

function toast(s) { const el = document.querySelector('#profileToast'); if (el) el.textContent = s || ''; }

async function loadProfiles() {
  const out = await api('/api/noe/chat/profiles');
  if (out.ok && Array.isArray(out.profiles) && out.profiles.length) profiles = out.profiles;
  const stored = normalizeProfileId(localStorage.getItem(KEY));
  localStorage.setItem(KEY, profiles.some((p) => p.id === stored) ? stored : 'default');
  editingId = current().id; renderTabs(); renderEditor();
}

async function loadModels() {
  const out = await api('/api/noe/chat/models');
  if (out.ok && Array.isArray(out.providers)) modelCatalog = out;
  renderEditor();
}

async function saveProfile() {
  const body = readForm();
  const path = draftNew ? '/api/noe/chat/profiles' : `/api/noe/chat/profiles/${encodeURIComponent(editingId)}`;
  const out = await api(path, { method: draftNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
  if (!out.ok) { toast(out.error || '保存失败'); return; }
  profiles = out.profiles || profiles; draftNew = false; editingId = out.profile?.id || body.id; localStorage.setItem(KEY, editingId); toast('已保存'); renderTabs(); renderEditor();
}

async function deleteProfile() {
  if (!deleteArmed) { deleteArmed = true; toast('再点一次删除'); return; }
  const out = await api(`/api/noe/chat/profiles/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
  deleteArmed = false;
  if (!out.ok) { toast(out.error || '删除失败'); return; }
  profiles = out.profiles || profiles; editingId = 'default'; localStorage.setItem(KEY, 'default'); renderTabs(); renderEditor();
}

function installSheet() {
  if (document.querySelector('#profileSheet')) return;
  const sheet = document.createElement('div');
  sheet.id = 'profileSheet'; sheet.className = 'profile-sheet';
  sheet.innerHTML = `<section class="profile-panel"><div class="profile-panel-head"><h3>聊天配置</h3><button type="button" id="profileClose">关闭</button></div><div class="profile-editor"><div class="profile-list" id="profileList"></div><form class="profile-form" id="profileForm"></form></div></section>`;
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target.id === 'profileSheet' || e.target.id === 'profileClose') sheet.classList.remove('on');
    const edit = e.target.closest('button[data-edit]'); if (edit) { editingId = edit.dataset.edit; draftNew = false; deleteArmed = false; renderEditor(); }
    if (e.target.id === 'profileNew') { draftNew = true; deleteArmed = false; renderEditor(); }
    if (e.target.id === 'profileSave') saveProfile();
    if (e.target.id === 'profileDelete') deleteProfile();
  });
  sheet.addEventListener('change', (e) => { if (e.target?.name === 'adapterId') refreshModelSelect(); });
}

function install() {
  const row = document.querySelector('#input-row');
  if (!row || document.querySelector('#chat-profile-bar')) return;
  css(); installSheet();
  const bar = document.createElement('div');
  bar.id = 'chat-profile-bar';
  bar.innerHTML = '<div class="profile-tabs" id="chatProfileTabs"></div><button type="button" class="profile-settings-btn" id="chatProfileSettings" title="聊天配置">⚙</button>';
  row.parentNode.insertBefore(bar, row);
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-profile]');
    if (btn) { localStorage.setItem(KEY, btn.dataset.profile); editingId = btn.dataset.profile; renderTabs(); return; }
    if (e.target.closest('#chatProfileSettings')) { document.querySelector('#profileSheet')?.classList.add('on'); renderEditor(); }
  });
  renderTabs(); loadProfiles(); loadModels();
}

window.cogChatProfileId = () => current().id;
window.cogChatProfileLabel = () => current().name;
window.cogActiveModelLabel = () => { const p = current(); return p.adapterId === 'auto' ? '' : (p.model || p.adapterId || ''); };
window.cogModelCatalog = () => modelCatalog;
install();
