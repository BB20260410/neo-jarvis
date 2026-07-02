import { installStyle, dataUrlFromFile, cameraDataUrl, fetchInsightFaceEmbedding, pickFaceFromImage, recordVoice } from './cognitive-people-capture.js?v=people-capture-20260611a';

const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);
let people = [];
let editingId = '';
let creating = false; // 新建态：点「新建」后清空选中；render 不再自动选回第一个（修复"建了又丢/误改成现有人"）
let deleteArmed = false;
let lastMatch = null;
let autoBusy = false;
let ownerStatus = null;
let voiceEngineStatus = null;
let modelSettings = null;

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (path, opts = {}) => fetch(path, { headers, ...opts }).then((r) => r.json()).catch((e) => ({ ok: false, error: e?.message || 'network' }));
const faceCount = (n) => `${Number(n) || 0} 张`;
const voiceCount = (n) => `${Number(n) || 0}/3`;
const voiceEngineLabel = () => {
  if (modelSettings?.voice?.enabled === false) return '声纹模型已关闭';
  if (modelSettings?.voice?.engine === 'voice-lite') return '轻量声纹算法';
  return voiceEngineStatus?.modelReady ? 'CAM++ 中文声纹' : 'CAM++ 未就绪';
};
const reasonText = (s) => ({ no_people: '人物库里还没有可比对样本', not_enough_samples: '样本不足', below_threshold: '分数低于阈值', no_samples: '这个人还没有样本', person_not_found: '人物不存在' }[s] || s || '未确认');
const errText = (s) => /short or silent/i.test(s || '') ? '录音太短或太安静，请靠近麦克风自然说 3 秒后重录。' : (s || '失败');

function current() {
  if (creating) return null; // 新建态：空白表单，不回落到第一个人
  return people.find((p) => p.id === editingId) || people[0] || null;
}

function renderList() {
  const list = $('#peopleList');
  if (!list) return;
  if (!people.length) {
    list.innerHTML = '<div class="people-empty">还没有人物资料。先在右侧填写姓名并保存，再录入人脸或声纹样本。</div>';
    return;
  }
  const rows = people.map((p) => {
    const badges = [ownerStatus?.face?.ownerPersonId === p.id ? '主脸' : '', ownerStatus?.voice?.ownerPersonId === p.id ? '主声' : ''].filter(Boolean);
    return `<tr data-person="${esc(p.id)}" class="${p.id === editingId ? 'active' : ''}" tabindex="0">
      <td><div class="name">${esc(p.displayName)}</div><div>${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('') || '可点击修改'}</div></td>
      <td>${esc(p.relation || '未填')}</td><td>${faceCount(p.faceSamples)}</td><td>${voiceCount(p.voiceSamples)}</td>
      <td>${esc(p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '')}</td>
    </tr>`;
  }).join('');
  list.innerHTML = `<table class="people-table"><thead><tr><th>人物</th><th>关系</th><th>人脸</th><th>声纹</th><th>更新</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function sampleList(title, rows = [], count = 0, kind = 'voice') {
  const items = rows.length
    ? rows.map((s) => `<li><span>${esc(s.name || s.id)}</span><span>${esc(s.createdAt ? new Date(s.createdAt).toLocaleString() : '')} · ${Number(s.dimension) || 0}维${s.engine ? ' · ' + esc(s.engine) : ''}</span><button type="button" class="sample-del" data-sample-kind="${kind}" data-sample-id="${esc(s.id)}">删除</button></li>`).join('')
    : `<div class="empty">暂无样本；${kind === 'face' ? '1 张清晰正脸即可建档，多角度更稳。' : '建议录满 3 段不同语句。'}</div>`;
  const label = kind === 'face' ? `${faceCount(count)}（1 张起可用）` : voiceCount(count);
  return `<section class="people-sample-box"><h4>${esc(title)} ${label}</h4>${rows.length ? `<ul>${items}</ul>` : items}</section>`;
}

function thresholdControls() {
  const face = Number(ownerStatus?.face?.threshold) || 0.55;
  const voice = Number(ownerStatus?.voice?.threshold) || 0.78;
  return `<div class="people-thresholds">
    <label>人脸阈值 <b id="peopleFaceThresholdValue">${Math.round(face * 100)}%</b><input id="peopleFaceThreshold" data-threshold="face" type="range" min="0.35" max="0.99" step="0.01" value="${face}"><span>低=更容易通过，高=更严格。推荐 55%。</span></label>
    <label>声纹阈值 <b id="peopleVoiceThresholdValue">${Math.round(voice * 100)}%</b><input id="peopleVoiceThreshold" data-threshold="voice" type="range" min="0.50" max="0.99" step="0.01" value="${voice}"><span>${esc(voiceEngineLabel())}；推荐 72-82%，环境变化大就先用 72-76%。</span></label>
  </div>`;
}

function ownerLine(p) {
  const faceName = ownerStatus?.face?.ownerPerson?.displayName || (ownerStatus?.face?.ownerPersonId ? '已绑定但人物不存在' : '未设置');
  const voiceName = ownerStatus?.voice?.ownerPerson?.displayName || (ownerStatus?.voice?.ownerPersonId ? '已绑定但人物不存在' : '未设置');
  const faceMark = p?.id && ownerStatus?.face?.ownerPersonId === p.id ? 'people-owner' : '';
  const voiceMark = p?.id && ownerStatus?.voice?.ownerPersonId === p.id ? 'people-owner' : '';
  return `<div class="people-owner-line">主人绑定：脸库=<span class="${faceMark}">${esc(faceName)}</span> · 声纹库=<span class="${voiceMark}">${esc(voiceName)}</span></div>`;
}

function renderForm() {
  const p = current() || { id: '', displayName: '', aliases: [], relation: '', notes: '', tags: [], consentNote: '', faceSamples: 0, voiceSamples: 0 };
  const form = $('#peopleForm');
  if (!form) return;
  form.innerHTML = `
    <label>姓名<input id="personName" name="displayName" value="${esc(p.displayName)}" autocomplete="off"></label>
    <label>关系<input id="personRelation" name="relation" value="${esc(p.relation)}" autocomplete="off"></label>
    <label>别名<input id="personAliases" name="aliases" value="${esc((p.aliases || []).join('，'))}" autocomplete="off"></label>
    <label>标签<input id="personTags" name="tags" value="${esc((p.tags || []).join('，'))}" autocomplete="off"></label>
    <label><span>人物资料</span><textarea id="personNotes" name="notes">${esc(p.notes)}</textarea></label>
    <label><span>同意/来源记录</span><textarea id="personConsent" name="consentNote">${esc(p.consentNote)}</textarea></label>
    <div class="people-drop" id="peopleDrop">可以把照片拖到这里，或点「导入照片」。1 张清晰正脸即可建档，继续添加不同角度会更稳；照片只生成本地模板，不保存原图。</div>
    ${ownerLine(p)}
    ${thresholdControls()}
    <div class="people-samples">${sampleList('人脸样本', p.faceSampleList || [], p.faceSamples, 'face')}${sampleList('声纹样本', p.voiceSampleList || [], p.voiceSamples, 'voice')}</div>
    <div class="people-result" id="peopleResult">样本：人脸 ${faceCount(p.faceSamples)} · 声纹 ${voiceCount(p.voiceSamples)}；声纹引擎：${esc(voiceEngineLabel())}；只保存本地模板，不保存原始照片和录音。</div>
    <input id="peoplePhotoInput" type="file" accept="image/*" multiple hidden>
    <div class="people-actions">
      <button type="button" id="peopleNew">新建</button><button type="button" id="peopleSave">保存资料</button>
      <button type="button" id="peoplePhoto">导入照片</button><button type="button" id="peopleFace">录入人脸</button><button type="button" id="peopleVoice">录入声纹</button>
      <button type="button" id="peopleOwnerFace" ${p.id ? '' : 'disabled'}>${p.id && ownerStatus?.face?.ownerPersonId === p.id ? '已是主人脸库' : '设为主人脸库'}</button>
      <button type="button" id="peopleOwnerVoice" ${p.id ? '' : 'disabled'}>${p.id && ownerStatus?.voice?.ownerPersonId === p.id ? '已是主人声纹库' : '设为主人声纹库'}</button>
      <button type="button" id="peopleIdentify">识别摄像头</button><button type="button" id="peopleDelete" class="danger" ${p.id ? '' : 'disabled'}>删除</button>
    </div>`;
}

function render() {
  // 仅在"非新建态且没有选中"时默认选第一个；新建态保持空白表单（这行原来会让「新建」立刻失效）
  if (!editingId && !creating && people[0]) editingId = people[0].id;
  renderList(); renderForm();
}

async function loadPeople() {
  const [out, idOut, voiceOut, modelOut] = await Promise.all([api('/api/noe/people'), api('/api/noe/identity/status'), api('/api/noe/people/voice-engine'), api('/api/noe/people/model-settings')]);
  if (out.ok) people = out.people || [];
  if (idOut.ok) ownerStatus = idOut.status || null;
  if (voiceOut.ok) voiceEngineStatus = voiceOut.status || null;
  if (modelOut.ok) modelSettings = modelOut.settings || null;
  render();
}

function formBody() {
  const fd = new FormData($('#peopleForm'));
  return {
    id: editingId || undefined,
    displayName: fd.get('displayName'),
    relation: fd.get('relation'),
    aliases: fd.get('aliases'),
    tags: fd.get('tags'),
    notes: fd.get('notes'),
    consentNote: fd.get('consentNote'),
  };
}

function result(text) {
  const el = $('#peopleResult');
  if (el) el.textContent = text;
}

function setMatch(match, { quiet = false } = {}) {
  const oldId = lastMatch?.person?.id || '';
  lastMatch = match?.ok ? match : null;
  window.cogLastPersonMatch = lastMatch;
  if (!match?.person) return;
  const text = match.ok
    ? `人物库：${match.person.displayName} · ${match.person.relation || '未填关系'} · ${match.score}`
    : `人物库候选：${match.person.displayName} · ${reasonText(match.reason)} · 分数 ${match.score} / 阈值 ${match.threshold || ownerStatus?.face?.threshold || ''}`;
  if (!quiet) result(text);
  const perception = $('#identityPerceptionText') || $('#perceptionText');
  if (perception) perception.textContent = (match.ok ? `人物库：${match.person.displayName}，分数 ${match.score}。${match.person.notes || ''}` : `人物库候选：${match.person.displayName}，${reasonText(match.reason)}，分数 ${match.score}。`).slice(0, 500);
  if (match.ok) {
    if (!quiet || oldId !== match.person.id) window.addStream?.('people', `识别到 ${match.person.displayName} · ${match.score}`, 'var(--warm)');
  }
}

async function savePerson() {
  const body = formBody();
  const path = editingId ? `/api/noe/people/${encodeURIComponent(editingId)}` : '/api/noe/people';
  const out = await api(path, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  if (!out.ok) { result('保存失败：' + (out.error || '')); return null; }
  people = out.people || people; editingId = out.person.id; creating = false; deleteArmed = false; render(); result(`已保存人物资料：${out.person.displayName}（已永久保存）`);
  return out.person;
}

async function ensurePerson() {
  return editingId ? current() : savePerson();
}

async function insightFaceEmbedding(imageDataUrl) {
  if (modelSettings?.face?.enabled === false || window.cogFaceModelEnabled === false) throw new Error('人脸识别模型已关闭');
  return fetchInsightFaceEmbedding(imageDataUrl); // API 调用本体在 cognitive-people-capture.js；模型开关门控留此（读 modelSettings 状态）
}

async function faceEmbedding({ preferInsight = true } = {}) {
  if (preferInsight) {
    try {
      result('正在用 InsightFace 识别人脸模板…');
      return (await insightFaceEmbedding(await cameraDataUrl())).embedding;
    } catch (e) {
      result('InsightFace 不可用，改用轻量本地模板：' + (e?.message || e));
    }
  }
  if (!$('#selfVideo')?.srcObject && window.setVision) await window.setVision('camera');
  const emb = await window.cogCurrentFaceEmbedding?.();
  if (!emb) throw new Error('摄像头还没有可用画面');
  return emb;
}

async function enrollFace() {
  const p = await ensurePerson();
  if (!p) return;
  try {
    await window.cogSetIdentityModels?.({ faceEnabled: true });
    modelSettings = { ...(modelSettings || {}), face: { ...(modelSettings?.face || {}), enabled: true } };
    const out = await api(`/api/noe/people/${encodeURIComponent(p.id)}/face/enroll`, { method: 'POST', body: JSON.stringify({ embedding: await faceEmbedding(), name: `人脸 ${new Date().toLocaleTimeString()}` }) });
    if (!out.ok) throw new Error(out.error || '录入失败');
    await loadPeople(); result(`已录入 ${out.person.displayName} 的人脸样本：共 ${faceCount(out.person.faceSamples)}`);
  } catch (e) { result('人脸录入失败：' + (e?.message || e)); }
}

async function enrollPhotoFiles(files) {
  const rows = Array.from(files || []).filter((f) => String(f.type || '').startsWith('image/'));
  if (!rows.length) { result('请选择图片文件'); return; }
  const p = await ensurePerson();
  if (!p) return;
  await window.cogSetIdentityModels?.({ faceEnabled: true });
  modelSettings = { ...(modelSettings || {}), face: { ...(modelSettings?.face || {}), enabled: true } };
  if (!window.cogFaceEmbeddingFromImageFile) { result('照片导入桥接未就绪，刷新页面后重试'); return; }
  let done = 0;
  let skipped = 0;
  for (const file of rows) {
    try {
      result(`正在处理照片 ${done + 1}/${rows.length}：${file.name || 'photo'}`);
      let extracted;
      try {
        const url = await dataUrlFromFile(file);
        const strong = await insightFaceEmbedding(url);
        let embedding = strong.embedding;
        let faceTag = '';
        // 多人照：弹选脸，让用户点选要建档的那张；不再默认闷头取最大脸
        if (Array.isArray(strong.faces) && strong.faces.length > 1) {
          const idx = await pickFaceFromImage(url, strong.faces, file.name);
          if (idx < 0) { skipped += 1; result(`已跳过多人照：${file.name || 'photo'}（${strong.faces.length} 张脸，未选）`); continue; }
          if (Array.isArray(strong.faces[idx]?.embedding) && strong.faces[idx].embedding.length) embedding = strong.faces[idx].embedding;
          faceTag = `·脸${idx + 1}/${strong.faces.length}`;
        }
        extracted = { embedding, fileName: file.name, engine: strong.engine, faceTag };
      } catch {
        extracted = await window.cogFaceEmbeddingFromImageFile(file);
      }
      const out = await api(`/api/noe/people/${encodeURIComponent(p.id)}/face/enroll`, {
        method: 'POST',
        body: JSON.stringify({ embedding: extracted.embedding, name: `${extracted.engine === 'insightface' ? 'InsightFace照片' : '照片'} ${extracted.fileName || file.name || Date.now()}${extracted.faceTag || ''}` }),
      });
      if (!out.ok) throw new Error(out.error || '导入失败');
      done += 1;
    } catch (e) {
      result(`照片导入中断：${file.name || 'photo'} · ${e?.message || e}`);
      break;
    }
  }
  await loadPeople();
  if (done || skipped) result(`已导入 ${done} 张人脸样本${skipped ? `，跳过 ${skipped} 张多人照` : ''}；1 张正脸即可识别，更多角度更稳。`);
}

async function enrollVoice() {
  const p = await ensurePerson();
  if (!p) return;
  try {
    await window.cogSetIdentityModels?.({ voiceEnabled: true });
    modelSettings = { ...(modelSettings || {}), voice: { ...(modelSettings?.voice || {}), enabled: true } };
    const out = await api(`/api/noe/people/${encodeURIComponent(p.id)}/voice/enroll`, { method: 'POST', body: JSON.stringify({ audio: await recordVoice(), name: `声纹 ${new Date().toLocaleTimeString()}` }) });
    if (!out.ok) throw new Error(out.error || '录入失败');
    await loadPeople(); result(`已录入 ${out.person.displayName} 的声纹样本：${out.person.voiceSamples}/3`);
  } catch (e) { result('声纹录入失败：' + errText(e?.message || e)); }
}

async function identifyCamera() {
  try {
    await window.cogSetIdentityModels?.({ faceEnabled: true });
    modelSettings = { ...(modelSettings || {}), face: { ...(modelSettings?.face || {}), enabled: true } };
    const out = await api('/api/noe/people/identify/face', { method: 'POST', body: JSON.stringify({ embedding: await faceEmbedding({ preferInsight: true }), threshold: ownerStatus?.face?.threshold || 0.55 }) });
    const m = out.match || {};
    if (m.ok && m.person) {
      setMatch(m);
    } else if (m.person) { setMatch(m); result(`最接近 ${m.person.displayName}，但未确认：${reasonText(m.reason)} · 分数 ${m.score} / 阈值 ${ownerStatus?.face?.threshold || 0.55}`); }
    else result(reasonText(m.reason));
  } catch (e) { result('识别失败：' + (e?.message || e)); }
}

async function setOwnerPerson(kind) {
  const p = await ensurePerson();
  if (!p) return;
  const currentSamples = kind === 'face' ? (p.faceSamples || 0) : (p.voiceSamples || 0);
  const ready = kind === 'face' ? currentSamples >= 1 : currentSamples >= 3;
  const out = await api(`/api/noe/identity/${kind}/owner-person`, { method: 'POST', body: JSON.stringify({ personId: p.id, enabled: ready }) });
  if (!out.ok) { result('设置主人绑定失败：' + (out.error || '')); return; }
  ownerStatus = out.status || ownerStatus;
  await loadPeople();
  const samples = kind === 'face' ? (out.face?.samples || currentSamples) : (out.voice?.samples || currentSamples);
  result(`已设为主人${kind === 'face' ? '脸库' : '声纹库'}；当前样本 ${kind === 'face' ? faceCount(samples) : voiceCount(samples)}${ready ? '，门禁已开启。' : '，样本不足，门禁未开启。'}`);
}

async function autoIdentifyCamera() {
  if (modelSettings?.face?.enabled === false || window.cogFaceModelEnabled === false) return;
  if (autoBusy || !people.some((p) => (p.faceSamples || 0) >= 1)) return;
  const video = $('#selfVideo');
  if (!video?.srcObject || video.readyState < 2) return;
  autoBusy = true;
  try {
    const emb = await window.cogCurrentFaceEmbedding?.();
    if (!emb) return;
    const out = await api('/api/noe/people/identify/face', { method: 'POST', body: JSON.stringify({ embedding: emb, threshold: ownerStatus?.face?.threshold || 0.55 }) });
    const m = out.match || {};
    if (m.person) setMatch(m, { quiet: true });
    else { lastMatch = null; window.cogLastPersonMatch = null; }
  } catch { /* 自动识别失败不打扰用户 */ }
  finally { autoBusy = false; }
}

async function deleteSample(kind, sampleId) {
  if (!editingId || !sampleId) return;
  const out = await api(`/api/noe/people/${encodeURIComponent(editingId)}/samples/${kind}/${encodeURIComponent(sampleId)}`, { method: 'DELETE' });
  if (!out.ok) { result('删除样本失败：' + (out.error || '')); return; }
  people = out.people || people;
  render();
  result(`已删除${kind === 'face' ? '人脸' : '声纹'}样本`);
}

async function saveThreshold(kind, value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  const out = await api(`/api/noe/identity/${kind}/config`, { method: 'POST', body: JSON.stringify({ enabled: ownerStatus?.[kind]?.enabled === true, threshold: n }) });
  if (!out.ok) { result('保存阈值失败：' + (out.error || '')); return; }
  ownerStatus = { ...(ownerStatus || {}), [kind]: out[kind] };
  result(`${kind === 'face' ? '人脸' : '声纹'}阈值已保存为 ${Math.round(n * 100)}%`);
}

async function deletePerson() {
  if (!editingId) return;
  if (!deleteArmed) { deleteArmed = true; result('再点一次删除此人物'); return; }
  const out = await api(`/api/noe/people/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
  deleteArmed = false;
  if (!out.ok) { result('删除失败：' + (out.error || '')); return; }
  people = out.people || []; editingId = people[0]?.id || ''; render(); result('已删除人物');
}

function installSheet() {
  if ($('#peopleSheet')) return;
  const sheet = document.createElement('div');
  sheet.id = 'peopleSheet';
  sheet.className = 'people-sheet';
  sheet.innerHTML = `<section class="people-panel"><div class="people-head"><h3>人物库</h3><button type="button" id="peopleClose">关闭</button></div><div class="people-grid"><div class="people-list" id="peopleList"></div><form class="people-form" id="peopleForm"></form></div></section>`;
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-person]');
    if (e.target.id === 'peopleSheet' || e.target.id === 'peopleClose') sheet.classList.remove('on');
    if (pick) { editingId = pick.dataset.person; creating = false; deleteArmed = false; render(); }
    if (e.target.id === 'peopleNew') { editingId = ''; creating = true; deleteArmed = false; render(); result('新建人物：填姓名后点「保存资料」即永久保存'); }
    if (e.target.id === 'peopleSave') savePerson();
    if (e.target.id === 'peoplePhoto') $('#peoplePhotoInput')?.click();
    if (e.target.id === 'peopleFace') enrollFace();
    if (e.target.id === 'peopleVoice') enrollVoice();
    if (e.target.id === 'peopleOwnerFace') setOwnerPerson('face');
    if (e.target.id === 'peopleOwnerVoice') setOwnerPerson('voice');
    if (e.target.id === 'peopleIdentify') identifyCamera();
    if (e.target.id === 'peopleDelete') deletePerson();
    const del = e.target.closest('[data-sample-kind][data-sample-id]');
    if (del) deleteSample(del.dataset.sampleKind, del.dataset.sampleId);
  });
  sheet.addEventListener('keydown', (e) => {
    const pick = e.target.closest('[data-person]');
    if (pick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); editingId = pick.dataset.person; creating = false; deleteArmed = false; render(); }
  });
  sheet.addEventListener('change', (e) => {
    if (e.target.id === 'peoplePhotoInput') {
      enrollPhotoFiles(e.target.files);
      e.target.value = '';
    }
    if (e.target?.dataset?.threshold) saveThreshold(e.target.dataset.threshold, e.target.value);
  });
  sheet.addEventListener('input', (e) => {
    if (e.target?.id === 'peopleFaceThreshold') $('#peopleFaceThresholdValue').textContent = Math.round(Number(e.target.value) * 100) + '%';
    if (e.target?.id === 'peopleVoiceThreshold') $('#peopleVoiceThresholdValue').textContent = Math.round(Number(e.target.value) * 100) + '%';
  });
  sheet.addEventListener('dragover', (e) => {
    if (!e.target.closest('#peopleDrop')) return;
    e.preventDefault();
    $('#peopleDrop')?.classList.add('on');
  });
  sheet.addEventListener('dragleave', (e) => {
    if (e.target.closest('#peopleDrop')) $('#peopleDrop')?.classList.remove('on');
  });
  sheet.addEventListener('drop', (e) => {
    if (!e.target.closest('#peopleDrop')) return;
    e.preventDefault();
    $('#peopleDrop')?.classList.remove('on');
    enrollPhotoFiles(e.dataTransfer?.files);
  });
}

function installEntry() {
  const anchor = $('#dProactive');
  if (!anchor || $('#dPeopleKb')) return;
  const item = document.createElement('div');
  item.className = 'drawer-item';
  item.id = 'dPeopleKb';
  item.textContent = '🧑 人物库';
  anchor.parentNode.insertBefore(item, anchor.nextSibling);
  item.onclick = () => { $('#peopleSheet')?.classList.add('on'); loadPeople(); };
}

installStyle();
installSheet();
installEntry();
render();
loadPeople();
window.cogReloadPeople = loadPeople;
setInterval(autoIdentifyCamera, 6500);
