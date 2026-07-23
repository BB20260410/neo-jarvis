// @ts-check
// cognitive-people-capture.js — 人物库「采集/识别」无状态部分（2026-06-11 自 cognitive-people.js 拆出）
// 纪律：本文件不持有人物库状态（people/editingId/modelSettings 等全留 cognitive-people.js）；
// token/headers/$/esc 与兄弟模块重复是家族先例（模块独立加载），勿顺手去重。
const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (path, opts = {}) => fetch(path, { headers, ...opts }).then((r) => r.json()).catch((e) => ({ ok: false, error: e?.message || 'network' }));
// 状态提示写回人物库面板结果行（与主文件 result() 同一目标 DOM）
const resultText = (text) => { const el = $('#peopleResult'); if (el) el.textContent = text; };

export function installStyle() {
  if ($('#peopleKbStyle')) return;
  const style = document.createElement('style');
  style.id = 'peopleKbStyle';
  style.textContent = `
.people-sheet{position:fixed;inset:0;z-index:90;display:none;align-items:flex-end;justify-content:center;background:rgba(2,7,16,.58);backdrop-filter:blur(14px)}
.people-sheet.on{display:flex}.people-panel{width:min(1040px,calc(100vw - 28px));max-height:min(780px,calc(100vh - 34px));overflow:auto;background:rgba(7,13,25,.97);border:1px solid var(--border);border-radius:12px 12px 0 0;padding:18px}
.people-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.people-head h3{margin:0;color:var(--text);font-size:16px}
.people-grid{display:grid;grid-template-columns:minmax(360px,440px) 1fr;gap:14px}.people-list{border:1px solid var(--border);border-radius:8px;background:rgba(2,7,16,.34);overflow:auto;max-height:620px}.people-table{width:100%;border-collapse:collapse;font:700 11px var(--mono);color:var(--muted)}.people-table th{position:sticky;top:0;background:rgba(7,13,25,.98);color:var(--dim);text-align:left;padding:9px 8px;border-bottom:1px solid var(--border);white-space:nowrap}.people-table td{padding:9px 8px;border-bottom:1px solid rgba(143,182,216,.13);vertical-align:top}.people-table tr[data-person]{cursor:pointer}.people-table tr[data-person]:hover{background:rgba(143,182,216,.08);color:var(--text)}.people-table tr.active{background:rgba(212,162,123,.13);color:var(--text)}.people-table .name{color:var(--text);font-size:12px}.people-table .badge{display:inline-block;margin-right:4px;color:var(--warm)}.people-empty{padding:14px;color:var(--dim);font:12px/1.55 var(--mono)}
.people-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.people-form label{display:flex;flex-direction:column;gap:6px;color:var(--dim);font:700 12px var(--mono)}.people-form input,.people-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;background:rgba(2,7,16,.72);color:var(--text);padding:10px;font:600 13px var(--mono);outline:none}.people-form textarea{grid-column:1/-1;min-height:108px;resize:vertical;line-height:1.5}
.people-drop{grid-column:1/-1;border:1px dashed rgba(212,162,123,.45);border-radius:8px;background:rgba(212,162,123,.08);color:var(--muted);padding:10px 12px;font:12px/1.5 var(--mono)}.people-drop.on{border-color:var(--warm);color:var(--text);background:rgba(212,162,123,.15)}
.people-samples{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.people-sample-box{border:1px solid var(--border);border-radius:8px;background:rgba(2,7,16,.45);padding:10px}.people-sample-box h4{margin:0 0 8px;color:var(--text);font:800 12px var(--mono)}.people-sample-box ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}.people-sample-box li{color:var(--muted);font:11px/1.45 var(--mono);display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}.people-sample-box .sample-del{border:0;background:transparent;color:#ffb7b7;font:800 11px var(--mono);cursor:pointer;padding:2px 4px}.people-sample-box .empty{color:var(--dim);font:11px/1.5 var(--mono)}
.people-owner-line{grid-column:1/-1;color:var(--dim);font:12px/1.5 var(--mono)}.people-owner{color:var(--warm);font-weight:800}.people-thresholds{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.people-thresholds label{border:1px solid var(--border);border-radius:8px;background:rgba(2,7,16,.38);padding:9px}.people-thresholds input{padding:0}
.people-actions{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}.people-actions button{border:1px solid var(--border);background:rgba(7,12,24,.64);color:var(--muted);border-radius:8px;padding:8px 10px;font:700 12px var(--mono);cursor:pointer}.people-actions .danger{border-color:rgba(220,92,92,.58);color:#ffb7b7}.people-result{grid-column:1/-1;color:var(--warm);font:12px/1.5 var(--mono);min-height:18px}.people-stat{color:var(--dim);font-weight:600}
.people-facepick{position:fixed;inset:0;z-index:95;display:none;align-items:center;justify-content:center;background:rgba(2,7,16,.74);backdrop-filter:blur(8px)}.people-facepick.on{display:flex}.fp-box{max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;background:rgba(7,13,25,.98);border:1px solid var(--border);border-radius:12px;padding:16px}.fp-head{color:var(--text);font:700 13px/1.5 var(--mono);margin-bottom:12px}.fp-stage{position:relative;display:inline-block;line-height:0}.fp-img{display:block;border-radius:8px;max-width:100%}.fp-cv{position:absolute;left:0;top:0;cursor:pointer}
@media(max-width:820px){.people-grid{grid-template-columns:1fr}.people-list{max-height:260px}.people-form,.people-samples,.people-thresholds{grid-template-columns:1fr}}`;
  document.head.appendChild(style);
}

// 照片先等比压到最长边 1600 + jpeg 0.85 再上传：手机原图常 >7.5MB，base64 膨胀后会撞 server 10MB body 限制(413)
export async function dataUrlFromFile(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bitmap.width || 1, bitmap.height || 1));
    const w = Math.max(1, Math.round((bitmap.width || 1) * scale));
    const h = Math.max(1, Math.round((bitmap.height || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    // 兜底：不支持 createImageBitmap 时退回原图 base64
    return new Promise((resolveRead, rejectRead) => {
      const reader = new FileReader();
      reader.onload = () => resolveRead(String(reader.result || ''));
      reader.onerror = () => rejectRead(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }
}

export async function cameraDataUrl() {
  const video = $('#selfVideo');
  if (!video?.srcObject && window.setVision) await window.setVision('camera');
  if (!video || video.readyState < 2) await new Promise((r) => setTimeout(r, 1200));
  if (!video || video.readyState < 2) throw new Error('摄像头还没有画面');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

// InsightFace 模板 API 调用本体（模型开关门控读 modelSettings 状态，留主文件 insightFaceEmbedding 包装）
export async function fetchInsightFaceEmbedding(imageDataUrl) {
  const out = await api('/api/noe/people/face-embedding', { method: 'POST', body: JSON.stringify({ image: imageDataUrl }) });
  if (!out.ok || !Array.isArray(out.embedding)) throw new Error(out.error || 'InsightFace 不可用');
  return { embedding: out.embedding, engine: out.engine || 'insightface', faceCount: out.faceCount || 0, faces: Array.isArray(out.faces) ? out.faces : [] };
}

// 多人照选脸：在照片上画框编号，用户点选要建档的那张脸，返回其下标(-1=取消/跳过)
export function pickFaceFromImage(dataUrl, faces, fileName = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'people-facepick on';
    ov.innerHTML = `<div class="fp-box"><div class="fp-head">「${esc(fileName || '照片')}」检测到 ${faces.length} 张脸，点选要建档的那一张（点周围空白=跳过这张）</div><div class="fp-stage"><img class="fp-img" alt=""><canvas class="fp-cv"></canvas></div></div>`;
    document.body.appendChild(ov);
    const cleanup = () => ov.remove();
    const img = ov.querySelector('.fp-img');
    const cv = ov.querySelector('.fp-cv');
    img.onload = () => {
      const maxW = Math.min(760, (window.innerWidth || 800) - 80);
      const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
      const w = Math.round((img.naturalWidth || maxW) * scale);
      const h = Math.round((img.naturalHeight || maxW) * scale);
      img.style.width = `${w}px`; img.style.height = `${h}px`;
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      faces.forEach((f, i) => {
        const b = f.bbox || [0, 0, 0, 0];
        const x = b[0] * scale; const y = b[1] * scale; const bw = (b[2] - b[0]) * scale; const bh = (b[3] - b[1]) * scale;
        ctx.strokeStyle = '#d4a27b'; ctx.lineWidth = 3; ctx.strokeRect(x, y, bw, bh);
        ctx.fillStyle = '#d4a27b'; ctx.fillRect(x, Math.max(0, y - 20), 26, 20);
        ctx.fillStyle = '#06101e'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(String(i + 1), x + 7, Math.max(15, y - 5));
      });
      cv.onclick = (e) => {
        const r = cv.getBoundingClientRect();
        const px = e.clientX - r.left; const py = e.clientY - r.top;
        // 命中点击点的脸里取最贴合的(面积最小)：嵌套小脸不会被外层大脸抢走
        const hit = faces.reduce((best, f, i) => {
          const b = f.bbox || [];
          if (px < b[0] * scale || px > b[2] * scale || py < b[1] * scale || py > b[3] * scale) return best;
          const area = (b[2] - b[0]) * (b[3] - b[1]);
          return (best.idx < 0 || area < best.area) ? { idx: i, area } : best;
        }, { idx: -1, area: Infinity }).idx;
        // 无论点中脸还是图内空白都收尾：点脸→下标，空白→-1(跳过本张)，消除永久挂起
        cleanup();
        resolve(hit);
      };
    };
    img.onerror = () => { cleanup(); resolve(-1); };
    img.src = dataUrl;
    ov.addEventListener('click', (e) => { if (e.target === ov) { cleanup(); resolve(-1); } });
  });
}

export async function recordVoice() {
  if (!window.blob16k || !window.b64of) throw new Error('声纹录制桥接未就绪');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.start();
  resultText('正在录入声纹，请自然说 3 秒');
  await new Promise((r) => setTimeout(r, 3200));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  stream.getTracks().forEach((t) => t.stop());
  return window.b64of(await window.blob16k(new Blob(chunks)));
}
