const $ = (s) => document.querySelector(s);

const defs = {
  start: { key: 'noe-vad-start-threshold', def: 0.015, min: 0.005, max: 0.08, label: '起说线', hint: '推荐 1.5%，说话过线才开始录。' },
  stop: { key: 'noe-vad-stop-threshold', def: 0.008, min: 0.003, max: 0.05, label: '停说线', hint: '推荐 0.8%，低于这条才结束本句。' },
  barge: { key: 'noe-barge-threshold', def: 0.12, min: 0.05, max: 0.30, label: '打断线', hint: '推荐 12-18%，外放/录屏用 20-25%。' },
};

function clamp(kind, value) {
  const d = defs[kind];
  return Math.min(d.max, Math.max(d.min, Number(value) || d.def));
}

function read(kind) {
  return clamp(kind, localStorage.getItem(defs[kind].key));
}

function save(kind, value) {
  const n = clamp(kind, value);
  localStorage.setItem(defs[kind].key, String(n));
  return n;
}

function percent(n) {
  return `${Math.round(n * 1000) / 10}%`;
}

function installStyle() {
  if ($('#vadSettingsStyle')) return;
  const style = document.createElement('style');
  style.id = 'vadSettingsStyle';
  style.textContent = `
.vad-card{border:1px solid var(--line);border-radius:8px;background:rgba(2,7,16,.45);padding:10px;margin:8px 0;color:var(--ink2);font:11px/1.5 var(--mono)}
.vad-card h4{margin:0 0 8px;color:var(--ink);font-size:12px}
.vad-row{display:grid;grid-template-columns:58px 1fr 46px;align-items:center;gap:8px;margin:6px 0}.vad-row input{padding:0}.vad-hint{color:var(--dim)}
.vad-level{height:6px;border-radius:4px;background:rgba(143,182,216,.13);overflow:hidden;margin:8px 0;position:relative}.vad-fill{height:100%;width:0;background:var(--cool);transition:width .06s linear}
.vad-preset{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.vad-preset button,.vad-card .vad-cal{border:1px solid var(--line);border-radius:8px;background:rgba(2,7,16,.56);color:var(--ink2);padding:6px 8px;font:11px var(--mono);cursor:pointer}`;
  document.head.appendChild(style);
}

function renderRows() {
  return Object.entries(defs).map(([kind, d]) => {
    const n = read(kind);
    return `<div class="vad-row"><span>${d.label}</span><input data-vad="${kind}" type="range" min="${d.min}" max="${d.max}" step="0.001" value="${n}"><b id="vad-${kind}-value">${percent(n)}</b></div><div class="vad-hint">${d.hint}</div>`;
  }).join('');
}

function paint(kind) {
  const el = $(`#vad-${kind}-value`);
  if (el) el.textContent = percent(read(kind));
}

async function calibrate() {
  const fill = $('#vadLiveFill');
  const text = $('#vadLiveText');
  let stream = null;
  let ctx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let peak = 0;
    const started = Date.now();
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      peak = Math.max(peak, rms);
      if (fill) fill.style.width = `${Math.min(100, rms * 600)}%`;
      if (text) text.textContent = `当前 ${percent(rms)} · 峰值 ${percent(peak)} · 起说 ${percent(read('start'))} · 打断 ${percent(read('barge'))}`;
      if (Date.now() - started < 8000) requestAnimationFrame(tick);
      else if (text) text.textContent += ' · 校准结束';
    };
    tick();
  } catch (e) {
    if (text) text.textContent = `麦克风不可用：${e?.message || e?.name || '失败'}`;
  } finally {
    setTimeout(() => { try { stream?.getTracks().forEach((t) => t.stop()); } catch {} try { ctx?.close(); } catch {} }, 8500);
  }
}

function install() {
  if ($('#vadSettingsCard')) return;
  const anchor = $('#bargeThreshold')?.closest('.drawer-field') || $('#dOwnerGateSave') || $('#dProactive');
  if (!anchor?.parentNode) return;
  installStyle();
  const card = document.createElement('section');
  card.id = 'vadSettingsCard';
  card.className = 'vad-card';
  card.innerHTML = `<h4>语音校准</h4>${renderRows()}<div class="vad-level"><div class="vad-fill" id="vadLiveFill"></div></div><div class="vad-hint" id="vadLiveText">点校准后说话，看电平是否过起说线。</div><div class="vad-preset"><button type="button" data-vad-preset="quiet">安静环境</button><button type="button" data-vad-preset="speaker">外放/录屏</button><button type="button" class="vad-cal" id="vadCalibrate">校准麦克风电平</button></div>`;
  anchor.parentNode.insertBefore(card, anchor.nextSibling);
  card.addEventListener('input', (e) => {
    const kind = e.target?.dataset?.vad;
    if (!kind) return;
    save(kind, e.target.value);
    paint(kind);
  });
  card.addEventListener('click', (e) => {
    const preset = e.target?.dataset?.vadPreset;
    if (preset === 'quiet') { save('start', 0.015); save('stop', 0.008); save('barge', 0.12); }
    if (preset === 'speaker') { save('start', 0.02); save('stop', 0.01); save('barge', 0.22); }
    if (preset) { for (const kind of Object.keys(defs)) { const input = card.querySelector(`[data-vad="${kind}"]`); if (input) input.value = read(kind); paint(kind); } }
    if (e.target?.id === 'vadCalibrate') calibrate();
  });
}

const timer = setInterval(() => { install(); if ($('#vadSettingsCard')) clearInterval(timer); }, 500);
