// @ts-check
// cognitive-identity-bridge.js — 身份/人脸声纹桥 + 主人门禁抽屉 UI（2026-06-11 自 cognitive-research.js 拆出）
// 属主：identityModelSettings 与 window.cog* 身份 API 面（cogSetIdentityModels/cogCurrentFaceEmbedding*/
//   cogFaceEmbeddingFromImageFile/cogFaceModelEnabled/cogVoiceModelEnabled/cogVoiceEngine）单一属主在本文件；
//   消费者：cognitive-people.js（事件回调期）与 cognitive.html（setVision/VAD）。
// installIdentityFetchBridge 是 monkey-patch window.fetch 的唯一属主，必须由入口 boot 调用且早于首个
//   /api/noe/voice/chat 请求（活性探针：documentElement.dataset.cogIdentityFetchBridge === '1'）。
// token/headers/$/api/readJson 与兄弟模块重复是家族先例（模块独立加载），勿顺手去重。
const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);
let identityModelSettings = null; window.cogFaceModelEnabled = true; window.cogVoiceModelEnabled = true; window.cogVoiceEngine = 'campplus';

// msg/stream（聊天消息/事件流渲染）单一来源留在 cognitive-research.js，boot 期注入，避免 ①↔② import 成环
let msg = () => {};
let stream = () => {};
export function initIdentityBridgeUi({ msg: msgFn, stream: streamFn } = {}) {
  if (typeof msgFn === 'function') msg = msgFn;
  if (typeof streamFn === 'function') stream = streamFn;
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return res.json().catch(() => ({}));
}

async function readJson(path) { const res = await fetch(path, { headers }); return res.json().catch(() => ({})); }

function applyIdentityModelSettings(settings = {}) {
  identityModelSettings = settings || {}; window.cogFaceModelEnabled = identityModelSettings.face?.enabled !== false;
  window.cogVoiceModelEnabled = identityModelSettings.voice?.enabled !== false; window.cogVoiceEngine = identityModelSettings.voice?.engine || 'campplus';
  return identityModelSettings;
}

async function setIdentityModels(patch = {}) {
  const out = await api('/api/noe/people/model-settings', patch); if (out?.ok) applyIdentityModelSettings(out.settings); return out;
}
window.cogSetIdentityModels = setIdentityModels;

export function installOwnerGateUI() {
  const anchor = $('#dProactive');
  if (!anchor || $('#dOwnerGate')) return;
  const toggle = document.createElement('div');
  toggle.className = 'drawer-item';
  toggle.id = 'dOwnerGate';
  toggle.textContent = '🔐 只响应主人：读取中';
  const wake = document.createElement('label');
  wake.className = 'drawer-field';
  wake.innerHTML = '<span>唤醒词（逗号分隔）</span><input id="ownerWakeWords" autocomplete="off">';
  const pass = document.createElement('label');
  pass.className = 'drawer-field';
  pass.innerHTML = '<span>口令（可选，逗号分隔）</span><input id="ownerPassphrases" type="password" autocomplete="off">';
  const clearPass = document.createElement('label');
  clearPass.className = 'drawer-field';
  clearPass.innerHTML = '<span>清空已设口令</span><input id="ownerPassphrasesClear" type="checkbox">';
  const save = document.createElement('div');
  save.className = 'drawer-item';
  save.id = 'dOwnerGateSave';
  save.textContent = '💾 保存主人门禁';
  anchor.parentNode.insertBefore(save, anchor.nextSibling);
  anchor.parentNode.insertBefore(clearPass, save);
  anchor.parentNode.insertBefore(pass, clearPass);
  anchor.parentNode.insertBefore(wake, pass);
  anchor.parentNode.insertBefore(toggle, wake);
  let cfg = { enabled: false, wakeWords: [], passphrases: [], passphrasesConfigured: false };
  const paint = () => {
    toggle.textContent = '🔐 只响应主人：' + (cfg.enabled ? '开' : '关');
    $('#ownerWakeWords').value = (cfg.wakeWords || []).join('，');
    $('#ownerPassphrases').value = '';
    $('#ownerPassphrases').placeholder = cfg.passphrasesConfigured ? '已设置；留空不改' : '';
    $('#ownerPassphrasesClear').checked = false;
  };
  const saveCfg = async (enabled = cfg.enabled) => {
    const passphrasesValue = $('#ownerPassphrases').value;
    const body = {
      enabled,
      wakeWords: $('#ownerWakeWords').value,
    };
    if ($('#ownerPassphrasesClear').checked) body.passphrases = '';
    else if (passphrasesValue.trim()) body.passphrases = passphrasesValue;
    const out = await api('/api/noe/owner-gate', body);
    if (out?.ok) { cfg = out.config; paint(); stream('system', '主人门禁已' + (cfg.enabled ? '开启' : '关闭'), 'var(--warm)'); }
    else msg('sys', '✗ 主人门禁保存失败');
  };
  toggle.onclick = () => saveCfg(!cfg.enabled);
  save.onclick = () => saveCfg(cfg.enabled);
  readJson('/api/noe/owner-gate').then((out) => { if (out?.ok) cfg = out.config; paint(); }).catch(paint);
}

export function installBargeThresholdUI() {
  const anchor = $('#dOwnerGateSave') || $('#dProactive');
  if (!anchor || $('#bargeThreshold')) return;
  const box = document.createElement('label');
  box.className = 'drawer-field';
  box.innerHTML = '<span>打断音量阈值：<b id="bargeThresholdValue"></b> · 推荐 12-18%，外放/录屏 20-25%</span><input id="bargeThreshold" type="range" min="0.05" max="0.30" step="0.01"><span class="barge-presets"><button type="button" data-barge="0.12">推荐 12%</button><button type="button" data-barge="0.18">强抗干扰 18%</button><button type="button" data-barge="0.22">外放/录屏 22%</button></span>';
  anchor.parentNode.insertBefore(box, anchor.nextSibling);
  const input = $('#bargeThreshold');
  const value = $('#bargeThresholdValue');
  const norm = (v) => Math.min(0.30, Math.max(0.05, Number(v) || 0.12));
  const paint = (n = norm(localStorage.getItem('noe-barge-threshold'))) => {
    input.value = String(n);
    value.textContent = Math.round(n * 100) + '%';
  };
  input.oninput = () => {
    const n = norm(input.value);
    localStorage.setItem('noe-barge-threshold', String(n));
    paint(n);
  };
  box.querySelectorAll('[data-barge]').forEach((b) => { b.onclick = () => { const n = norm(b.dataset.barge); localStorage.setItem('noe-barge-threshold', String(n)); paint(n); }; });
  paint();
}

function ownerStatusText(s) {
  const v = s?.voice || {};
  const f = s?.face || {};
  const vo = v.ownerPerson?.displayName ? ` · 声纹主人=${v.ownerPerson.displayName}` : '';
  const fo = f.ownerPerson?.displayName ? ` · 人脸主人=${f.ownerPerson.displayName}` : '';
  const vs = v.lastVerification ? ` · 声纹${v.lastVerification.ok ? '通过' : '未过'} ${v.lastVerification.score}` : '';
  const fs = f.lastVerification ? ` · 人脸${f.lastVerification.ok ? '通过' : '未过'} ${f.lastVerification.score}` : '';
  return `声纹 ${v.samples || 0}/3${v.ready ? ' 就绪' : ' 未就绪'}${v.enabled ? ' 开' : ''}${vo} · 人脸 ${f.samples || 0}/1${f.ready ? ' 就绪' : ' 未就绪'}${f.enabled ? ' 开' : ''}${fo}${vs}${fs}`;
}

async function recordVoiceSample() {
  const streamObj = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const rec = new MediaRecorder(streamObj);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.start();
  stream('identity', '正在录入声纹，请自然说 3 秒', 'var(--warm)');
  await new Promise((r) => setTimeout(r, 3200));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  streamObj.getTracks().forEach((t) => t.stop());
  const wav = await window.blob16k(new Blob(chunks));
  return window.b64of(wav);
}

async function detectFaceBox(source) {
  if (!window.FaceDetector) return null;
  try {
    const faces = await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }).detect(source);
    const box = faces?.[0]?.boundingBox;
    if (!box?.width || !box?.height) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch { return null; }
}

function sourceSize(source) {
  return {
    width: source.videoWidth || source.naturalWidth || source.width || 640,
    height: source.videoHeight || source.naturalHeight || source.height || 480,
  };
}

async function faceEmbeddingFromSource(source) {
  const { width, height } = sourceSize(source);
  const box = await detectFaceBox(source);
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('2d');
  const side = box ? Math.max(box.width, box.height) * 1.35 : Math.min(width, height);
  const cx = box ? box.x + box.width / 2 : width / 2;
  const cy = box ? box.y + box.height / 2 : height / 2;
  const sx = Math.max(0, Math.min(width - side, cx - side / 2));
  const sy = Math.max(0, Math.min(height - side, cy - side / 2));
  ctx.drawImage(source, sx, sy, Math.min(side, width), Math.min(side, height), 0, 0, 16, 16);
  const pixels = ctx.getImageData(0, 0, 16, 16).data;
  const gray = [];
  for (let i = 0; i < pixels.length; i += 4) gray.push((pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 255);
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const base = gray.map((v) => Math.round((v - mean) * 10000) / 10000);
  const edge = gray.map((v, i) => {
    const x = i % 16;
    const y = Math.floor(i / 16);
    const right = x < 15 ? gray[i + 1] : v;
    const down = y < 15 ? gray[i + 16] : v;
    return Math.round(((right - v) + (down - v)) * 10000) / 10000;
  });
  return [...base, ...edge];
}

async function faceEmbeddingFromCamera({ allowStart = true } = {}) {
  const video = $('#selfVideo');
  if (!video?.srcObject && allowStart && window.setVision) await window.setVision('camera');
  if (!video || video.readyState < 2) await new Promise((r) => setTimeout(r, 1200));
  if (!video || video.readyState < 2) throw new Error('摄像头还没有画面');
  return faceEmbeddingFromSource(video);
}

async function cameraImageDataUrl({ allowStart = true } = {}) {
  const video = $('#selfVideo');
  if (!video?.srcObject && allowStart && window.setVision) await window.setVision('camera');
  if (!video || video.readyState < 2) await new Promise((r) => setTimeout(r, 1200));
  if (!video || video.readyState < 2) throw new Error('摄像头还没有画面');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

async function insightFaceEmbeddingFromImage(imageDataUrl) {
  const out = await api('/api/noe/people/face-embedding', { image: imageDataUrl });
  if (!out?.ok || !Array.isArray(out.embedding)) throw new Error(out?.error || 'InsightFace 不可用');
  return { embedding: out.embedding, engine: out.engine || 'insightface' };
}

async function faceEmbeddingPayloadFromCamera({ allowStart = true } = {}) {
  if (window.cogFaceModelEnabled === false) throw new Error('人脸识别模型已关闭');
  try {
    const strong = await insightFaceEmbeddingFromImage(await cameraImageDataUrl({ allowStart }));
    return { faceEmbedding: strong.embedding, faceEmbeddingEngine: strong.engine };
  } catch (e) {
    if (/no face detected|未检测到|没有检测到/i.test(e?.message || '')) throw e;
    const emb = await faceEmbeddingFromCamera({ allowStart });
    return { faceEmbedding: emb, faceEmbeddingEngine: 'browser-lite' };
  }
}

async function faceEmbeddingFromImageFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片过大，请换 12MB 以内的照片');
  const bitmap = await createImageBitmap(file);
  try {
    return { embedding: await faceEmbeddingFromSource(bitmap), fileName: file.name || 'photo' };
  } finally {
    bitmap.close?.();
  }
}

window.cogCurrentFaceEmbeddingPayload = () => faceEmbeddingPayloadFromCamera({ allowStart: false }).catch(() => null);
window.cogCurrentFaceEmbedding = () => window.cogCurrentFaceEmbeddingPayload().then((x) => x?.faceEmbedding || null);
window.cogFaceEmbeddingFromImageFile = faceEmbeddingFromImageFile;
document.documentElement.dataset.cogFaceBridge = '1';

export function installIdentityFetchBridge() {
  if (window.__cogIdentityFetchBridge) return;
  window.__cogIdentityFetchBridge = true;
  document.documentElement.dataset.cogIdentityFetchBridge = '1';
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url.includes('/api/noe/voice/chat') && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if ((body?.audio || body?.text) && !body.faceEmbedding && window.cogFaceModelEnabled !== false && window.cogCurrentFaceEmbeddingPayload) {
          const facePayload = await window.cogCurrentFaceEmbeddingPayload();
          if (facePayload?.faceEmbedding) init = { ...init, body: JSON.stringify({ ...body, ...facePayload }) };
        }
      } catch { /* 保持原请求 */ }
    }
    return originalFetch(input, init);
  };
}

export function installOwnerIdentityUI() {
  const save = $('#dOwnerGateSave');
  if (!save || $('#identityStatus')) return;
  const item = (id, text, danger = false) => { const node = document.createElement('div'); node.className = 'drawer-item' + (danger ? ' danger' : ''); node.id = id; node.textContent = text; return node; };
  const status = item('identityStatus', '🧬 主人识别：读取中');
  const hint = document.createElement('div');
  hint.className = 'identity-hint'; hint.id = 'identityHint'; hint.textContent = '这里录入会写入人物库的“主人”档案；旧门禁模板会自动同步到人物库。';
  const faceModelToggle = item('identityFaceModelToggle', '🧠 人脸识别模型：开');
  const voiceModelToggle = item('identityVoiceModelToggle', '🎛 声纹模型：开');
  const voiceEngineToggle = item('identityVoiceEngineToggle', '🎚 声纹技术：CAM++ 中文强识别');
  const voiceAdd = item('identityVoiceAdd', '🎙 录入一段声纹');
  const voiceToggle = item('identityVoiceToggle', '🔐 声纹门禁：关');
  const voiceClear = item('identityVoiceClear', '清空声纹模板', true);
  const faceAdd = item('identityFaceAdd', '📷 采集一张人脸');
  const faceToggle = item('identityFaceToggle', '🧿 人脸门禁：关');
  const faceClear = item('identityFaceClear', '清空人脸模板', true);
  const parent = save.parentNode;
  let after = save;
  for (const node of [status, hint, faceModelToggle, voiceModelToggle, voiceEngineToggle, voiceAdd, voiceToggle, voiceClear, faceAdd, faceToggle, faceClear]) {
    parent.insertBefore(node, after.nextSibling);
    after = node;
  }
  let st = null;
  let armed = '';
  let syncingOld = false;
  const syncOldSamples = async () => {
    if (syncingOld) return;
    if ((st?.voice?.ownerPersonId || st?.face?.ownerPersonId) || !((st?.voice?.samples || 0) || (st?.face?.samples || 0))) return;
    syncingOld = true;
    const out = await api('/api/noe/identity/import-owner-samples', {});
    if (out?.ok) { st = out.status; window.cogReloadPeople?.(); stream('identity', '旧主人门禁模板已同步到人物库', 'var(--warm)'); }
  };
  const load = async () => {
    const [out, modelOut] = await Promise.all([readJson('/api/noe/identity/status'), readJson('/api/noe/people/model-settings')]);
    if (out?.ok) st = out.status;
    if (modelOut?.ok) applyIdentityModelSettings(modelOut.settings);
    await syncOldSamples();
    status.textContent = '🧬 主人识别：' + ownerStatusText(st) + ` · 模型${window.cogVoiceModelEnabled ? '声纹开' : '声纹关'}/${window.cogFaceModelEnabled ? '人脸开' : '人脸关'}`;
    faceModelToggle.textContent = '🧠 人脸识别模型：' + (window.cogFaceModelEnabled ? '开' : '关');
    voiceModelToggle.textContent = '🎛 声纹模型：' + (window.cogVoiceModelEnabled ? '开' : '关');
    voiceEngineToggle.textContent = '🎚 声纹技术：' + (window.cogVoiceEngine === 'voice-lite' ? '轻量算法（省内存）' : 'CAM++ 中文强识别');
    voiceToggle.textContent = '🔐 声纹门禁：' + (st?.voice?.enabled ? '开' : '关') + (st?.voice?.ready ? '' : '（需 3 段）');
    faceToggle.textContent = '🧿 人脸门禁：' + (st?.face?.enabled ? '开' : '关') + (st?.face?.ready ? '' : '（需 1 张正脸）');
    voiceClear.textContent = armed === 'voice' ? '再次点击确认清空声纹' : '清空声纹模板';
    faceClear.textContent = armed === 'face' ? '再次点击确认清空人脸' : '清空人脸模板';
  };
  faceModelToggle.onclick = async () => { await setIdentityModels({ faceEnabled: !window.cogFaceModelEnabled }); await load(); };
  voiceModelToggle.onclick = async () => { await setIdentityModels({ voiceEnabled: !window.cogVoiceModelEnabled }); await load(); };
  voiceEngineToggle.onclick = async () => { await setIdentityModels({ voiceEngine: window.cogVoiceEngine === 'voice-lite' ? 'campplus' : 'voice-lite', voiceEnabled: true }); await load(); };
  voiceAdd.onclick = async () => { try { await setIdentityModels({ voiceEnabled: true }); await api('/api/noe/identity/voice/enroll', { audio: await recordVoiceSample(), name: `声纹 ${Date.now()}` }); await load(); window.cogReloadPeople?.(); } catch (e) { msg('sys', '✗ 声纹录入失败：' + (e?.message || '')); } };
  voiceToggle.onclick = async () => { const next = !(st?.voice?.enabled); await api('/api/noe/identity/voice/config', { enabled: next, threshold: st?.voice?.threshold || 0.78 }); await load(); };
  faceAdd.onclick = async () => { try { await setIdentityModels({ faceEnabled: true }); const face = await faceEmbeddingPayloadFromCamera(); await api('/api/noe/identity/face/enroll', { embedding: face.faceEmbedding, name: `人脸 ${Date.now()}` }); await load(); window.cogReloadPeople?.(); } catch (e) { msg('sys', '✗ 人脸采集失败：' + (e?.message || '')); } };
  faceToggle.onclick = async () => { const next = !(st?.face?.enabled); await api('/api/noe/identity/face/config', { enabled: next, threshold: st?.face?.threshold || 0.9 }); await load(); };
  voiceClear.onclick = async () => { if (armed !== 'voice') { armed = 'voice'; await load(); return; } armed = ''; await api('/api/noe/identity/voice/clear', {}); await load(); };
  faceClear.onclick = async () => { if (armed !== 'face') { armed = 'face'; await load(); return; } armed = ''; await api('/api/noe/identity/face/clear', {}); await load(); };
  load();
}
