// noe-voice.js — Noe 语音 / 视觉 / 主动陪伴前端
// 录音(getUserMedia → 16kHz mono PCM wav) → /api/noe/voice/chat → 播放甜心小玲回复；
// 看一眼屏幕(/api/noe/vision/glance)；主动陪伴(轮询 /api/noe/proactive/tick，后端 30min 冷却自我克制)。
// 依赖 app.js 已 wrap window.fetch 自动带 X-Panel-Owner-Token（无需手动鉴权）。
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  let recorder = null;
  let recStream = null;
  let recChunks = [];
  let recording = false;
  let proactiveTimer = null;
  let busy = false;
  let recMaxTimer = null;
  let sharedAudio = null;
  let lastAudioSig = '', lastAudioAt = 0;
  // 实时对话（VAD 免按钮连续监听 + barge-in 打断）状态
  let liveOn = false, vadCtx = null, vadAnalyser = null, vadStream = null, vadTimer = null, vadRec = null, vadChunks = [];
  let vadPhase = 'idle', speechFrames = 0, silenceFrames = 0, captureStartAt = 0, liveAbort = null, playbackGuardUntil = 0;
  let manualVoiceModelRestore = false;
  // 阈值（RMS 0~1）：起说够响且持续才算开口；停说留足静音尾；说话(speak)时抬高阈值压回声后才算打断
  const VAD = { start: 0.015, stop: 0.008, bargeIn: bargeThreshold(), startFrames: 3, silenceMs: 900, frameMs: 50, maxCaptureMs: 15000 };
  // 唤醒词门控（C10，卡①前端收尾）：开启后实时模式的语音段先过 /api/noe/voice/wakeword（sherpa KWS 毫秒级），
  // 没喊"嘿Noe"的段直接丢弃——电视声/旁人聊天不再烧大脑和 TTS。命中后 90s 活动窗口内直接对话（每轮刷新）。
  let wakeActiveUntil = 0;
  const WAKE_WINDOW_MS = 90 * 1000;
  function wakewordOn() { return localStorage.getItem('noe-wakeword-mode') === '1'; }
  // C9 流式语音续播：chat 只带首句音频+restTtsText，剩余文本在首句播放期间并行合成，播完无缝接上。
  // barge-in/手动停 → 丢队列；续播获取失败 → 静默放弃（首句已播，体验仍优于全等）。
  let pendingRest = null; // null | 'loading' | {b64, fmt}
  let pendingRestSeq = 0; // 续播代际：防上一轮迟到的合成结果覆盖新一轮的 loading（连说两句时的竞态）
  function fetchRestAudio(text, tts) {
    const seq = ++pendingRestSeq;
    pendingRest = 'loading';
    // 2026-06-11 owner 报障「老是只说前几句」根治之一：剩余段合成偶发失败时原逻辑静默放弃=后面永远没声。
    // 改为自动重试一次（线上 TTS 偶发抖动重试即愈），两次都失败才放弃（后端链尾另有 CosyVoice 本地兜底）。
    const attempt = (retriesLeft) => {
      fetch('/api/noe/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, tts: tts || undefined }) })
        .then((x) => x.json())
        .then((d) => {
          if (seq !== pendingRestSeq || pendingRest !== 'loading') return; // 已被打断/被新一轮续播取代
          if (d && d.ok && d.audioBase64) {
            pendingRest = { b64: d.audioBase64, fmt: d.audioFormat };
            // 首句已播完且还停在等待态 → 立即接上
            if (sharedAudio && (sharedAudio.ended || !sharedAudio.src)) playPendingRest();
          } else if (retriesLeft > 0) attempt(retriesLeft - 1);
          else { pendingRest = null; logVoice('系统', '剩余语音段合成失败（已重试），这轮只播了开头'); }
        })
        .catch(() => {
          if (seq !== pendingRestSeq || pendingRest !== 'loading') return;
          if (retriesLeft > 0) attempt(retriesLeft - 1);
          else { pendingRest = null; logVoice('系统', '剩余语音段合成失败（已重试），这轮只播了开头'); }
        });
    };
    attempt(1);
  }
  function playPendingRest() {
    if (!pendingRest || pendingRest === 'loading') return false;
    // 用户已开口/在转写（capture/think）→ 迟到的续播不该再插嘴，丢弃（打断路径本就由 stopPlayback 清掉）
    if (liveOn && (vadPhase === 'capture' || vadPhase === 'think')) { pendingRest = null; return false; }
    const seg = pendingRest; pendingRest = null;
    lastAudioSig = ''; // 续播段不受重播去重拦截
    // 2026-06-10 owner 报障「语音只说开头」根治：旧逻辑 phase!=='speak' 即丢弃——实时模式下首句播完
    // 已切回 listen，剩余段合成稍慢（长回复常见）回来就被扔掉=只说开头。listen 中迟到的续播应当播：
    // 重新进入 speak 相位无缝接上（保留说话可打断）。
    if (liveOn && vadPhase === 'listen') { vadPhase = 'speak'; speechFrames = 0; setState('🔊 续播中（说话可打断）'); }
    (liveOn ? playReply : playAudio)(seg.b64, seg.fmt);
    return true;
  }
  // 视觉源：'screen' 看屏幕（后端截屏）/ 'camera' 看摄像头（前端抽帧推送）
  let _visionMode = 'screen', camStream = null, camVideo = null, camCanvas = null, camTimer = null;

  function setState(text) { const el = $('#noeVoiceState'); if (el) el.textContent = text; }
  function bargeThreshold() { return Math.min(0.30, Math.max(0.05, Number(localStorage.getItem('noe-barge-threshold')) || 0.12)); }
  function audioSig(base64) { return `${String(base64 || '').length}:${String(base64 || '').slice(0, 80)}`; }
  function audioBusy() { return sharedAudio && !sharedAudio.paused && !sharedAudio.ended; }

  async function getIdentityModelSettings() {
    try {
      const res = await fetch('/api/noe/people/model-settings');
      const data = await res.json().catch(() => ({}));
      return data.settings || null;
    } catch { return null; }
  }

  async function setIdentityModels(patch = {}) {
    try {
      const res = await fetch('/api/noe/people/model-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch || {}) });
      const data = await res.json().catch(() => ({}));
      return data.settings || null;
    } catch { return null; }
  }

  async function enableManualVoiceModel() {
    const before = await getIdentityModelSettings();
    manualVoiceModelRestore = before?.voice?.enabled === false;
    await setIdentityModels({ voiceEnabled: true });
  }

  async function restoreManualVoiceModel() {
    if (!manualVoiceModelRestore) return;
    manualVoiceModelRestore = false;
    if (!liveOn) await setIdentityModels({ voiceEnabled: false });
  }

  function logVoice(role, text) {
    const root = $('#noeVoiceLog');
    if (!root) return;
    const row = document.createElement('div');
    row.className = 'noe-brain-row';
    const r = document.createElement('strong');
    r.textContent = role;
    const s = document.createElement('span');
    s.textContent = text; // textContent 防 XSS
    row.append(r, s);
    root.prepend(row);
    while (root.children.length > 12) root.removeChild(root.lastChild);
  }

  // ---- wav 编码（16kHz mono PCM，whisper server 只吃这个）----
  function encodeWav16(float32, sampleRate) {
    const n = float32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const wr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    wr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wr(36, 'data'); view.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, float32[i])); view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true); off += 2; }
    return new Uint8Array(buf);
  }

  async function blobToWav16k(blob) {
    const arr = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    let decoded;
    try { decoded = await ac.decodeAudioData(arr); }
    finally { try { await ac.close(); } catch { /* 已关就算了，保证不泄漏 AudioContext */ } }
    const target = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * target));
    const off = new OfflineAudioContext(1, frames, target); // 重采样到 16kHz mono
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return encodeWav16(rendered.getChannelData(0), target);
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  function playAudio(base64, format) {
    try {
      const sig = audioSig(base64); const now = Date.now();
      if (sig === lastAudioSig && now - lastAudioAt < 1800) return;
      lastAudioSig = sig; lastAudioAt = now;
      if (!sharedAudio) sharedAudio = new Audio(); // 复用单个 Audio，避免长期运行累积实例
      try { sharedAudio.pause(); sharedAudio.removeAttribute('src'); sharedAudio.load?.(); } catch { /* noop */ }
      playbackGuardUntil = now + 600000;
      sharedAudio.onended = () => { playbackGuardUntil = 0; try { sharedAudio.src = ''; } catch { /* noop */ } if (pendingRest && playPendingRest()) return; if (liveOn && vadPhase === 'speak') { vadPhase = 'listen'; speechFrames = 0; setState('🟢 实时对话中…'); } };
      sharedAudio.src = `data:audio/${format || 'mp3'};base64,${base64}`;
      sharedAudio.play().catch(() => {});
    } catch { /* 自动播放被拦截就算了 */ }
  }

  async function startRecording() {
    if (recording || busy) return;
    try {
      await enableManualVoiceModel();
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { await restoreManualVoiceModel(); setState('✗ 麦克风不可用：' + (e.message || e.name)); return; }
    recChunks = [];
    recorder = new MediaRecorder(recStream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.start();
    recording = true;
    setState('🎙 录音中…松开发送');
    clearTimeout(recMaxTimer);
    recMaxTimer = setTimeout(() => { if (recording) stopRecordingAndSend(); }, 60000); // 最长 60s 自动结束，防超大录音
  }

  async function stopRecordingAndSend() {
    if (!recording || !recorder) return;
    recording = false;
    clearTimeout(recMaxTimer);
    busy = true;
    try {
      // 等 onstop，但加超时兜底：某些浏览器 stop() 异常或 onstop 不触发时不至于永久挂起锁死语音
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        recorder.onstop = finish;
        try { recorder.stop(); } catch { finish(); }
        setTimeout(finish, 3000);
      });
      if (!recChunks.length) { setState('就绪'); return; }
      setState('转写中…');
      const wav = await blobToWav16k(new Blob(recChunks));
      const b64 = bytesToBase64(wav);
      const res = await fetch('/api/noe/voice/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: b64 }) });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) { setState('✗ ' + (data.error || '失败')); if (data.transcript) logVoice('你', data.transcript); return; }
      logVoice('你', data.transcript || '');
      logVoice('Noe', data.reply || '');
      setState(`就绪 · ${data.usedAdapter || ''}${data.ttsError ? ' · 无声(' + data.ttsError + ')' : ''}`);
      if (data.audioBase64) { pendingRest = null; if (data.restTtsText) fetchRestAudio(data.restTtsText, null); playAudio(data.audioBase64, data.audioFormat); }
    } catch (e) {
      setState('✗ ' + (e.message || '录音处理失败'));
    } finally {
      recStream?.getTracks().forEach((t) => t.stop()); // 任何路径都释放麦克风 track
      recStream = null;
      busy = false;
      await restoreManualVoiceModel();
    }
  }

  async function glance() {
    setState('👁 看屏幕中…');
    try {
      await setIdentityModels({ faceEnabled: true });
      const res = await fetch('/api/noe/vision/glance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' });
      const data = await res.json().catch(() => ({}));
      if (data.ok) { logVoice('看到', data.summary || ''); setState('就绪'); }
      else setState('✗ ' + (data.error || '看屏失败'));
    } catch (e) { setState('✗ ' + (e.message || '')); }
  }

  function startProactive() {
    if (proactiveTimer) return;
    const tick = async () => {
      if (busy || recording || liveOn || audioBusy()) return;
      try {
        const res = await fetch('/api/noe/proactive/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.spoke) { logVoice('Noe 主动', data.text || ''); if (data.audioBase64) playAudio(data.audioBase64, data.audioFormat); }
      } catch { /* 主动失败静默，不打扰 */ }
    };
    proactiveTimer = setInterval(tick, 60 * 1000); // 每 1 分钟轮询；是否真开口由后端冷却(NOE_PROACTIVE_COOLDOWN_MS,.env 已设1min)+变化检测决定
    logVoice('系统', '主动陪伴已开启（Noe 会偶尔看一眼屏幕，只在值得时开口）');
  }
  function stopProactive() { if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; logVoice('系统', '主动陪伴已关闭'); } }

  // ===== 实时对话模式（VAD 免按钮连续监听 + barge-in 打断），复用现有 /api/noe/voice/chat 后端 =====
  function stopPlayback(force = false) { if (!force && Date.now() < playbackGuardUntil) return false; playbackGuardUntil = 0; pendingRest = null; try { if (sharedAudio) { sharedAudio.pause(); sharedAudio.src = ''; } } catch { /* noop */ } return true; }

  async function startLive() {
    if (liveOn) return;
    await setIdentityModels({ voiceEnabled: true });
    try { vadStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { await setIdentityModels({ voiceEnabled: false }); setState('✗ 麦克风不可用：' + (e.message || e.name)); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    vadCtx = new AC();
    const src = vadCtx.createMediaStreamSource(vadStream);
    vadAnalyser = vadCtx.createAnalyser(); vadAnalyser.fftSize = 1024;
    src.connect(vadAnalyser);
    liveOn = true; vadPhase = 'listen'; speechFrames = 0; silenceFrames = 0;
    setState('🟢 实时对话中…直接说话');
    logVoice('系统', '实时对话已开启：直接说话即可（说话时屏幕下方蓝条会跳动，过黄线就开始录；条不跳=麦克风没选对/太小声）。建议戴耳机防回声。');
    if (!document.getElementById('noeMicMeter')) {
      const m = document.createElement('div'); m.id = 'noeMicMeter';
      m.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);width:280px;height:5px;border-radius:3px;background:rgba(140,170,205,.15);z-index:99999;overflow:hidden;pointer-events:none';
      m.innerHTML = '<div id="noeMicLevel" style="height:100%;width:0;background:#6cb6ff;transition:width .05s linear,background .1s"></div><div style="position:absolute;left:' + Math.min(95, VAD.start * 600) + '%;top:-2px;bottom:-2px;width:2px;background:#e6a96b;opacity:.8"></div>';
      document.body.appendChild(m);
    }
    const buf = new Uint8Array(vadAnalyser.fftSize);
    vadTimer = setInterval(() => {
      if (!vadAnalyser) return;
      vadAnalyser.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      vadTick(Math.sqrt(sum / buf.length));
    }, VAD.frameMs);
  }

  function stopLive() {
    liveOn = false; clearInterval(vadTimer); vadTimer = null;
    try { if (vadRec && vadRec.state !== 'inactive') vadRec.stop(); } catch { /* noop */ }
    vadRec = null; vadChunks = [];
    try { liveAbort?.abort(); } catch { /* noop */ }
    stopPlayback(true);
    try { vadStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { vadCtx?.close(); } catch { /* noop */ }
    setIdentityModels({ voiceEnabled: false });
    vadStream = null; vadCtx = null; vadAnalyser = null; vadPhase = 'idle';
    document.getElementById('noeMicMeter')?.remove(); setState('就绪'); logVoice('系统', '实时对话已关闭');
  }

  function vadTick(rms) {
    if (!liveOn) return;
    const lvl = document.getElementById('noeMicLevel'); if (lvl) { lvl.style.width = Math.min(100, rms * 600) + '%'; lvl.style.background = rms > VAD.start ? '#e6a96b' : '#6cb6ff'; }
    if (vadPhase === 'listen') {
      if (rms > VAD.start) { if (++speechFrames >= VAD.startFrames) beginCapture(); } else speechFrames = 0;
    } else if (vadPhase === 'capture') {
      if (rms < VAD.stop) { silenceFrames++; if (silenceFrames * VAD.frameMs >= VAD.silenceMs) endCaptureAndSend(); } else silenceFrames = 0;
      if (Date.now() - captureStartAt > VAD.maxCaptureMs) endCaptureAndSend();
    } else if (vadPhase === 'speak') {
      // barge-in：我说话时你一开口（明显高于回声）就打断我
      const bargeIn = bargeThreshold();
      if (rms > bargeIn) { if (++speechFrames >= VAD.startFrames) { if (!stopPlayback()) { speechFrames = 0; return; } try { liveAbort?.abort(); } catch { /* noop */ } beginCapture(); } } else speechFrames = 0;
    }
  }

  function beginCapture() {
    if (!vadStream) return;
    vadPhase = 'capture'; speechFrames = 0; silenceFrames = 0; captureStartAt = Date.now(); vadChunks = [];
    try {
      vadRec = new MediaRecorder(vadStream);
      vadRec.ondataavailable = (e) => { if (e.data && e.data.size) vadChunks.push(e.data); };
      vadRec.start(200);
    } catch (e) { setState('✗ 录音失败:' + (e.message || '')); vadPhase = 'listen'; return; }
    setState('🎙 听你说…');
  }

  async function endCaptureAndSend() {
    if (vadPhase !== 'capture') return;
    vadPhase = 'think'; setState('转写中…');
    await new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } }; if (vadRec) vadRec.onstop = f; try { vadRec?.stop(); } catch { f(); } setTimeout(f, 2500); });
    const chunks = vadChunks; vadChunks = []; // 关键：录音数据只在 stop() 后由 ondataavailable 产出，必须 stop 完再取（否则永远空=没录到声音）
    vadRec = null;
    const backToListen = () => { if (liveOn) { vadPhase = 'listen'; speechFrames = 0; setState('🟢 实时对话中…'); } };
    if (!chunks.length) { backToListen(); return; }
    try {
      const wav = await blobToWav16k(new Blob(chunks));
      const b64 = bytesToBase64(wav);
      // 唤醒词门控：开了且不在活动窗口 → 先过 KWS。只有"检测成功且未命中"才丢段；
      // 服务未就位(501)/网络错 → 降级放行走对话（宁可多答，不可哑掉）。
      if (wakewordOn() && Date.now() > wakeActiveUntil) {
        let wr = null;
        try { wr = await fetch('/api/noe/voice/wakeword', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: b64 }) }).then((x) => x.json()); } catch { /* 降级放行 */ }
        if (wr && wr.ok === true && wr.spotted === false) { setState('🟢 等待「嘿Noe」唤醒…'); backToListen(); return; }
        if (wr && wr.ok === true && wr.spotted === true) { wakeActiveUntil = Date.now() + WAKE_WINDOW_MS; logVoice('系统', `已唤醒（${wr.keyword || '嘿Noe'}），90 秒内直接说话即可`); }
      }
      liveAbort = new AbortController();
      const res = await fetch('/api/noe/voice/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: b64 }), signal: liveAbort.signal });
      const data = await res.json().catch(() => ({}));
      if (!liveOn) return;
      if (data.transcript) logVoice('你', data.transcript);
      if (wakewordOn() && data.ok) wakeActiveUntil = Date.now() + WAKE_WINDOW_MS; // 对话延续唤醒窗口
      if (data.ok && data.audioBase64) { logVoice('Noe', data.reply || ''); vadPhase = 'speak'; speechFrames = 0; setState('🔊 ' + (data.usedAdapter || '') + '（说话可打断）'); pendingRest = null; if (data.restTtsText) fetchRestAudio(data.restTtsText, null); playReply(data.audioBase64, data.audioFormat); return; }
      if (data.ok) logVoice('Noe', data.reply || '');
      else setState('✗ ' + (data.error || '失败'));
    } catch (e) { if (e.name !== 'AbortError' && liveOn) setState('✗ ' + (e.message || '')); }
    backToListen();
  }

  function playReply(b64, fmt) {
    try {
      const sig = audioSig(b64); const now = Date.now();
      if (sig === lastAudioSig && now - lastAudioAt < 1800) return;
      lastAudioSig = sig; lastAudioAt = now;
      if (!sharedAudio) sharedAudio = new Audio();
      try { sharedAudio.pause(); sharedAudio.removeAttribute('src'); sharedAudio.load?.(); } catch { /* noop */ }
      playbackGuardUntil = now + 1600;
      sharedAudio.onended = () => { playbackGuardUntil = 0; try { sharedAudio.src = ''; } catch { /* noop */ } if (pendingRest && playPendingRest()) return; if (liveOn && vadPhase === 'speak') { vadPhase = 'listen'; speechFrames = 0; setState('🟢 实时对话中…'); } };
      sharedAudio.src = `data:audio/${fmt || 'mp3'};base64,${b64}`;
      sharedAudio.play().catch(() => { if (liveOn && vadPhase === 'speak') { vadPhase = 'listen'; setState('🟢 实时对话中…'); } });
    } catch { if (liveOn) vadPhase = 'listen'; }
  }

  // ===== 视觉源切换：看屏幕 / 看摄像头（摄像头帧由前端抽帧推后端，VLM 在主动 tick 时才跑）=====
  async function startCamera() {
    if (camStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) { setState('✗ 当前浏览器不支持摄像头访问'); return false; }
    const constraints = [
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr = null;
    for (const c of constraints) {
      try { camStream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; }
    }
    if (!camStream) {
      const name = lastErr?.name || 'unknown';
      const hint = name === 'NotAllowedError' ? '请在 Safari 地址栏/设置里允许此网站使用摄像头'
        : name === 'NotFoundError' ? '系统没有找到可用摄像头'
        : name === 'NotReadableError' ? '摄像头可能正被其他应用占用'
        : name === 'OverconstrainedError' ? '摄像头不支持当前分辨率约束'
        : (lastErr?.message || name);
      setState('✗ 摄像头不可用：' + hint);
      return false;
    }
    camVideo = document.createElement('video'); camVideo.muted = true; camVideo.playsInline = true; camVideo.srcObject = camStream;
    // 可见自预览：右下角小窗（镜像，像自拍），让你看到自己
    camVideo.id = 'noeCamPreview';
    camVideo.style.cssText = 'position:fixed;right:16px;bottom:16px;width:200px;height:150px;object-fit:cover;border-radius:10px;border:2px solid #4ecdc4;box-shadow:0 6px 20px rgba(0,0,0,.45);z-index:99999;background:#000;transform:scaleX(-1)';
    document.body.appendChild(camVideo);
    try { camVideo.play()?.catch?.(() => {}); } catch { /* noop */ }
    camCanvas = document.createElement('canvas'); camCanvas.width = 640; camCanvas.height = 480;
    const ctx = camCanvas.getContext('2d');
    camTimer = setInterval(async () => {
      try {
        if (!camVideo || camVideo.readyState < 2) return;
        ctx.drawImage(camVideo, 0, 0, camCanvas.width, camCanvas.height);
        const b64 = camCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
        await fetch('/api/noe/vision/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frame: b64, format: 'jpeg' }) });
      } catch { /* 单帧失败忽略 */ }
    }, 4000); // 每 4s 推一帧保持最新；VLM 只在主动 tick(默认3min)/手动看一眼时才真跑
    return true;
  }
  function stopCamera() {
    clearInterval(camTimer); camTimer = null;
    try { camVideo?.remove(); } catch { /* noop */ }
    try { camStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    camStream = null; camVideo = null; camCanvas = null;
  }
  async function setVisionMode(m) {
    const mode = ['screen', 'camera', 'both'].includes(m) ? m : 'screen';
    const needsCamera = (mode === 'camera' || mode === 'both');
    if (needsCamera && !camStream && !(await startCamera())) {
      _visionMode = 'screen'; const s = $('#noeVisionMode'); if (s) s.value = 'screen';
      try { await fetch('/api/noe/vision/ambient', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, mode: 'screen', screenSampleMs: 10000, cameraFrameMs: 4000, source: 'voice-panel' }) }); } catch { /* noop */ }
      return;
    }
    await setIdentityModels({ faceEnabled: true });
    try { await fetch('/api/noe/vision/ambient', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, mode, screenSampleMs: 10000, cameraFrameMs: 4000, source: 'voice-panel' }) }); } catch { /* noop */ }
    if (needsCamera) {
      _visionMode = mode;
      logVoice('系统', mode === 'both'
        ? '视觉已切到 🖥️+📷 屏幕+摄像头：开了「主动陪伴」我会同时看你的屏幕和镜头里的你、值得时主动开口（全本地不外发）'
        : '视觉已切到 📷 摄像头：开了「主动陪伴」我会看着镜头里的你、值得时主动开口（全本地不外发）');
    } else {
      _visionMode = 'screen'; stopCamera(); logVoice('系统', '视觉已切到 👁 屏幕：主动陪伴时我看你的屏幕');
    }
  }

  function init() {
    const talk = $('#btnNoeVoiceTalk');
    if (talk && !talk.dataset.bound) {
      talk.dataset.bound = '1';
      talk.addEventListener('mousedown', startRecording);
      talk.addEventListener('mouseup', stopRecordingAndSend);
      talk.addEventListener('mouseleave', () => { if (recording) stopRecordingAndSend(); });
      talk.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); }, { passive: false });
      talk.addEventListener('touchend', (e) => { e.preventDefault(); stopRecordingAndSend(); }, { passive: false });
    }
    // 注入「实时对话」开关（VAD 免按钮 + barge-in 打断），与"按住说话"并存
    if (talk && talk.parentElement && !document.querySelector('#btnNoeVoiceLive')) {
      const lb = document.createElement('button');
      lb.id = 'btnNoeVoiceLive'; lb.type = 'button'; lb.textContent = '🎙 实时对话';
      lb.title = '免按钮连续语音 + 说话即可打断（建议戴耳机防回声）';
      lb.className = talk.className || '';
      lb.addEventListener('click', () => {
        if (liveOn) { lb.textContent = '🎙 实时对话'; stopLive(); }
        else { lb.textContent = '⏹ 停止实时'; startLive(); }
      });
      talk.parentElement.insertBefore(lb, talk.nextSibling);
    }
    // 注入「嘿Noe 唤醒词」开关：实时模式下未唤醒的语音段直接丢弃（省大脑/TTS；KWS 模型未就位时自动降级放行）
    if (talk && talk.parentElement && !document.querySelector('#btnNoeWakeword')) {
      const wb = document.createElement('button');
      wb.id = 'btnNoeWakeword'; wb.type = 'button';
      wb.className = talk.className || '';
      wb.title = '开启后实时对话需先喊「嘿Noe」唤醒，90 秒没对话自动休眠；治电视声/旁人说话误触发';
      const paint = () => { wb.textContent = wakewordOn() ? '📣 唤醒词:开' : '📣 唤醒词:关'; };
      paint();
      wb.addEventListener('click', () => {
        localStorage.setItem('noe-wakeword-mode', wakewordOn() ? '0' : '1');
        wakeActiveUntil = 0;
        paint();
        logVoice('系统', wakewordOn() ? '唤醒词模式已开：实时对话先喊「嘿Noe」' : '唤醒词模式已关：实时对话直接说话');
      });
      const liveBtn = document.querySelector('#btnNoeVoiceLive');
      talk.parentElement.insertBefore(wb, (liveBtn || talk).nextSibling);
    }
    const g = $('#btnNoeVisionGlance');
    if (g && !g.dataset.bound) { g.dataset.bound = '1'; g.addEventListener('click', glance); }
    // 注入视觉源选择器：看屏幕 / 看摄像头（主动陪伴看哪里）
    if (g && g.parentElement && !document.querySelector('#noeVisionMode')) {
      const sel = document.createElement('select');
      sel.id = 'noeVisionMode'; sel.title = '主动陪伴看哪里：屏幕 或 摄像头';
      sel.innerHTML = '<option value="screen">👁 看屏幕</option><option value="camera">📷 看摄像头</option><option value="both">🖥️+📷 屏幕+摄像头</option>';
      sel.addEventListener('change', (e) => setVisionMode(e.target.value));
      g.parentElement.insertBefore(sel, g.nextSibling);
    }
    // 注入认人模式选择器：off 不认 / ask 问"这是谁"才认 / auto 自动认出熟人主动招呼
    if (g && g.parentElement && !document.querySelector('#noeFaceRecog')) {
      const fr = document.createElement('select');
      fr.id = 'noeFaceRecog'; fr.title = '认人：不认 / 问"这是谁"才认 / 自动认出熟人主动招呼';
      fr.innerHTML = '<option value="off">🚫 不认人</option><option value="ask" selected>❓ 问才认</option><option value="auto">👋 自动认人</option>';
      fr.addEventListener('change', async (e) => {
        const mode = e.target.value;
        try { await fetch('/api/noe/vision/face-recog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); } catch { /* noop */ }
        if (mode === 'auto') {
          // 自动认人依赖摄像头帧 + 主动陪伴轮询，选了就顺手开起来
          const vm = document.querySelector('#noeVisionMode');
          if (vm && !/^(camera|both)$/.test(vm.value)) { vm.value = 'camera'; await setVisionMode('camera'); }
          startProactive();
        }
      });
      g.parentElement.insertBefore(fr, (document.querySelector('#noeVisionMode') || g).nextSibling);
    }
    const p = $('#noeProactiveToggle');
    if (p && !p.dataset.bound) { p.dataset.bound = '1'; p.addEventListener('change', (e) => { if (e.target.checked) startProactive(); else stopProactive(); }); }
  }

  window.NoeVoice = { init, startProactive, stopProactive, glance, startLive, stopLive, setVisionMode };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
