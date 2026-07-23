const token = new URLSearchParams(location.search).get('t')
  || localStorage.getItem('panel-owner-token')
  || sessionStorage.getItem('panel-owner-token')
  || '';
const headers = { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': token };
const $ = (s) => document.querySelector(s);

const MAX_ITEMS = 8;
const MAX_CONTEXT = 3200;
const TEXT_LIMIT = 1800;
const IMAGE_MAX_SIDE = 1280;
const IMAGE_MAX_BYTES = 18 * 1024 * 1024;
const VIDEO_MAX_BYTES = 120 * 1024 * 1024;
let seq = 0;
const attachments = [];

function fmtBytes(n = 0) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function isTextFile(file) {
  return /^text\//i.test(file.type)
    || /\.(txt|md|markdown|json|csv|log|yaml|yml|xml|html|css|js|ts|tsx|jsx|py|sh)$/i.test(file.name);
}

function isImageFile(file) {
  return /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

function isVideoFile(file) {
  return /^video\//i.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

function visualSizeLimit(file) {
  if (isImageFile(file)) return IMAGE_MAX_BYTES;
  if (isVideoFile(file)) return VIDEO_MAX_BYTES;
  return 0;
}

function markVisualTooLarge(item, limit) {
  item.status = 'meta';
  item.skipReason = `视觉分析跳过：文件过大（${fmtBytes(item.size)} > ${fmtBytes(limit)}）`;
  item.textPreview = `[${item.skipReason}]`;
}

function readAsText(file, limit = TEXT_LIMIT) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').slice(0, limit));
    reader.onerror = () => resolve('');
    reader.readAsText(file.slice(0, limit), 'utf-8');
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve(video);
    video.onerror = reject;
    video.src = url;
    video.load();
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    const done = () => { video.onseeked = null; resolve(); };
    video.onseeked = done;
    video.currentTime = Math.max(0, Math.min(time, Math.max(0, (video.duration || 0) - 0.05)));
    setTimeout(done, 900);
  });
}

async function videoPayload(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = await loadVideo(objectUrl);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const points = [...new Set([0.4, duration / 2, Math.max(0.4, duration - 0.6)].map((v) => Math.round(v * 10) / 10))].slice(0, 3);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
    const ctx = canvas.getContext('2d');
    const frames = [];
    for (const at of points) {
      await seekVideo(video, at);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ at, frame: canvas.toDataURL('image/jpeg', 0.68).split(',')[1] || '', format: 'jpeg' });
    }
    return { objectUrl, previewUrl: frames[0]?.frame ? `data:image/jpeg;base64,${frames[0].frame}` : '', width: video.videoWidth || canvas.width, height: video.videoHeight || canvas.height, duration, frames };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return { previewUrl: '', width: 0, height: 0, duration: 0, frames: [] };
  }
}

async function imagePayload(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return {
      previewUrl: url,
      width: img.naturalWidth || canvas.width,
      height: img.naturalHeight || canvas.height,
      frame: canvas.toDataURL('image/jpeg', 0.72).split(',')[1] || '',
      format: 'jpeg',
    };
  } catch {
    URL.revokeObjectURL(url);
    return { previewUrl: '', width: 0, height: 0, frame: '', format: 'jpeg' };
  }
}

async function analyzeImage(item) {
  if (!item.frame) return;
  item.status = 'analyzing';
  render();
  try {
    const res = await fetch('/api/noe/vision/attachment', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        frame: item.frame,
        format: item.format,
        name: item.name,
        type: item.type,
        prompt: '这是用户刚添加到认知界面的图片附件。请用中文客观描述图片里可见内容，重点说和用户可能提问相关的信息，不要编造。',
      }),
    });
    const data = await res.json().catch(() => ({}));
    item.status = data?.ok && data.summary ? 'ready' : 'meta';
    item.visionSummary = data?.summary || '';
  } catch {
    item.status = 'meta';
  }
  render();
}

async function analyzeVideo(item) {
  if (!Array.isArray(item.frames) || !item.frames.length) return;
  item.status = 'analyzing';
  render();
  const summaries = [];
  for (const frame of item.frames.slice(0, 3)) {
    try {
      const res = await fetch('/api/noe/vision/attachment', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          frame: frame.frame,
          format: frame.format,
          name: `${item.name}@${frame.at}s`,
          type: item.type,
          prompt: '这是用户添加到认知界面的视频抽帧。请用中文客观描述这一帧里可见内容，不要编造；如果是连续动作，只描述当前帧能看出来的变化线索。',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.ok && data.summary) summaries.push(`${frame.at}s：${data.summary}`);
    } catch { /* 单帧失败不阻断其他帧 */ }
  }
  item.status = summaries.length ? 'ready' : 'meta';
  item.visionSummary = summaries.length ? `视频抽帧理解：${summaries.join('；')}` : '';
  render();
}

function installStyle() {
  if ($('#cognitiveAttachmentStyle')) return;
  const style = document.createElement('style');
  style.id = 'cognitiveAttachmentStyle';
  style.textContent = `
#attach-tray{display:none;flex:0 0 auto;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(15,24,34,.34);backdrop-filter:blur(12px)}
#attach-tray.has-items{display:flex}
.attach-chip{display:flex;align-items:center;gap:8px;min-width:0;max-width:260px;padding:7px 8px;border:1px solid var(--line-strong);border-radius:10px;background:rgba(6,10,16,.44);color:var(--ink2);font:11px var(--mono)}
.attach-thumb{width:34px;height:34px;border-radius:7px;object-fit:cover;border:1px solid var(--line);background:rgba(143,182,216,.08);flex:0 0 auto}
.attach-fileicon{width:34px;height:34px;border-radius:7px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--warm);flex:0 0 auto}
.attach-meta{min-width:0;display:flex;flex-direction:column;gap:2px}.attach-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}.attach-sub{color:var(--dim)}
.attach-remove{border:0;background:transparent;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;padding:2px}.attach-remove:hover{color:var(--bad)}
#btnAttach{width:38px;padding:0;display:flex;align-items:center;justify-content:center;font-size:16px}
#cogDropOverlay{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;background:rgba(6,10,16,.45);backdrop-filter:blur(10px);color:var(--ink);font:13px var(--mono);letter-spacing:.04em}
#cogDropOverlay.on{display:flex}.console.attach-hover #input-row{border-color:var(--warm);box-shadow:0 0 0 1px color-mix(in srgb,var(--warm) 45%,transparent)}
@media(max-width:720px){.attach-chip{max-width:100%}#attach-tray{margin-top:8px}}`;
  document.head.appendChild(style);
}

function statusText(item) {
  if (item.status === 'analyzing') return '正在理解';
  if (item.skipReason) return item.skipReason;
  if (item.visionSummary) return '已读视觉';
  return item.textPreview ? '已读文本' : '已附加';
}

function render() {
  const tray = $('#attach-tray');
  if (!tray) return;
  tray.classList.toggle('has-items', attachments.length > 0);
  tray.innerHTML = '';
  for (const item of attachments) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = item.previewUrl
      ? `<img class="attach-thumb" alt="">`
      : `<span class="attach-fileicon">📄</span>`;
    if (item.previewUrl) chip.querySelector('img').src = item.previewUrl;
    const meta = document.createElement('div');
    meta.className = 'attach-meta';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = item.name;
    const sub = document.createElement('span');
    sub.className = 'attach-sub';
    sub.textContent = `${fmtBytes(item.size)} · ${statusText(item)}`;
    meta.append(name, sub);
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.type = 'button';
    rm.title = '移除附件';
    rm.textContent = '×';
    rm.onclick = () => removeAttachment(item.id);
    chip.append(meta, rm);
    tray.appendChild(chip);
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  for (const file of files) {
    if (attachments.length >= MAX_ITEMS) break;
    if (typeof file.content === 'string') {
      attachments.push({
        id: `att-${++seq}`,
        name: file.name || 'inline.txt',
        type: file.type || 'text/plain',
        size: file.content.length,
        status: 'ready',
        textPreview: file.content.slice(0, TEXT_LIMIT),
      });
      render();
      continue;
    }
    const item = { id: `att-${++seq}`, file, name: file.name || '未命名文件', type: file.type || '', size: file.size || 0, status: 'reading' };
    attachments.push(item);
    render();
    const visualLimit = visualSizeLimit(file);
    if (visualLimit && item.size > visualLimit) {
      markVisualTooLarge(item, visualLimit);
      render();
    } else if (isImageFile(file)) {
      Object.assign(item, await imagePayload(file));
      item.status = 'ready';
      render();
      analyzeImage(item);
    } else if (isVideoFile(file)) {
      Object.assign(item, await videoPayload(file));
      item.status = 'ready';
      render();
      analyzeVideo(item);
    } else if (isTextFile(file)) {
      item.textPreview = await readAsText(file);
      item.status = 'ready';
      render();
    } else {
      item.status = 'meta';
      render();
    }
  }
  window.addStream?.('attach', `已添加 ${Math.min(files.length, MAX_ITEMS)} 个附件`, 'var(--warm)');
}

function removeAttachment(id) {
  const index = attachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = attachments.splice(index, 1);
  if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  render();
}

function clearAttachments() {
  while (attachments.length) removeAttachment(attachments[0].id);
}

function attachmentContext() {
  if (!attachments.length) return '';
  const blocks = attachments.map((item, i) => {
    const dims = item.width && item.height ? `, ${item.width}x${item.height}` : '';
    const duration = item.duration ? `, ${Math.round(item.duration * 10) / 10}s` : '';
    const head = `${i + 1}. ${item.name} (${item.type || 'unknown'}, ${fmtBytes(item.size)}${dims}${duration})`;
    const vision = item.visionSummary ? `\n视觉理解: ${item.visionSummary}` : '';
    const text = item.textPreview ? `\n文件摘录:\n${item.textPreview}` : '';
    return `${head}${vision}${text}`;
  }).join('\n\n');
  return `\n\n[用户添加的附件]\n${blocks}`.slice(0, MAX_CONTEXT);
}

function buildText(raw) {
  const base = String(raw || '').trim();
  const ctx = attachmentContext();
  return (base || ctx) ? `${base || '请查看我添加的附件。'}${ctx}`.slice(0, MAX_CONTEXT + 800) : '';
}

function installEvents() {
  const row = $('#input-row');
  const input = $('#chat-input');
  const consoleEl = $('.console');
  if (!row || !input || !consoleEl || $('#btnAttach')) return;
  const tray = document.createElement('div');
  tray.id = 'attach-tray';
  row.parentNode.insertBefore(tray, row);
  const picker = document.createElement('input');
  picker.id = 'cogAttachmentInput';
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  picker.accept = 'image/*,video/*,.txt,.md,.json,.csv,.log,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip';
  const btn = document.createElement('button');
  btn.id = 'btnAttach';
  btn.className = 'cbtn';
  btn.type = 'button';
  btn.title = '添加照片和文件';
  btn.textContent = '📎';
  btn.onclick = () => picker.click();
  picker.onchange = () => { addFiles(picker.files); picker.value = ''; };
  row.insertBefore(btn, input);
  row.appendChild(picker);
  const overlay = document.createElement('div');
  overlay.id = 'cogDropOverlay';
  overlay.textContent = '松手添加照片和文件';
  document.body.appendChild(overlay);
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    overlay.classList.add('on');
    consoleEl.classList.add('attach-hover');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.clientX || e.clientY) return;
    overlay.classList.remove('on');
    consoleEl.classList.remove('attach-hover');
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    overlay.classList.remove('on');
    consoleEl.classList.remove('attach-hover');
    addFiles(e.dataTransfer.files);
  });
  input.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items || []).map((it) => it.kind === 'file' ? it.getAsFile() : null).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  render();
}

window.cogAttachText = buildText;
window.cogAttachSent = clearAttachments;
document.addEventListener('cognitive:add-attachments', (e) => addFiles(e.detail?.files || []));
installStyle();
installEvents();
