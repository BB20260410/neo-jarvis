import { parsePcm16Wav } from './Voiceprint.js';

// 声纹前处理:高通去低频底噪(50/60Hz 电源/空调嗡声、桌面震动)+ 自适应 VAD 裁掉
// 静音与非语音段(别人声、键盘、远场杂音多落在低能量段)。原则是"只清洗、绝不破坏":
// 任何不确定(非法 WAV / 没有明显语音-静音对比 / 裁完过短)都原样返回。

const DEFAULTS = {
  frameMs: 30,        // 分帧长度
  hopMs: 10,          // 帧移
  hangoverFrames: 3,  // 语音段前后各保留的缓冲帧(防切掉词头词尾的弱辅音)
  minVoicedMs: 300,   // 裁完语音不足此长度则放弃裁剪(返回原始)
  floorPct: 0.2,      // 噪声底:能量分布的 20 分位
  peakPct: 0.95,      // 语音峰:能量分布的 95 分位
  thresholdRatio: 0.12, // 阈值 = floor + ratio*(peak-floor),低位以保留弱音
  minContrast: 1.5,   // peak 至少为 floor 的这么多倍才认为存在"语音/静音对比"
  highpassA: 0.97,    // 一阶高通系数(≈ 截止 78Hz @16k)
  // 语音活动门禁(防杂音冒充人声进声纹比对)
  vadMinVoicedMs: 350,   // 至少这么长的"语音段"才算有人在说话(否则=静音/杂音)
  vadMinPeakRms: 0.02,   // 峰值能量低于此=太安静(纯静音/极弱底噪),不是有效说话
  vadMinVoicedRatio: 0.12, // 语音帧占比下限,防"全程低频嗡嗡但无语音"
};

// 语音活动检测：判断这段音频里到底有没有"足够清晰的人在说话"。
// 杂音/静音/远场底噪 → ok:false，声纹验证据此直接拒绝，不让它进比对被误判成主人。
// 任何解析异常都返回 ok:true（降级放行，绝不因 VAD 自身问题把主人锁在门外）。
export function analyzeVoiceActivity(wavBuffer, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  try {
    const { sampleRate, samples: raw } = parsePcm16Wav(wavBuffer);
    if (!sampleRate || raw.length < sampleRate * 0.15) return { ok: false, reason: 'too_short', voicedMs: 0, voicedRatio: 0, peak: 0 };
    const samples = highpass(raw, cfg.highpassA);
    const frame = Math.max(160, Math.floor(sampleRate * cfg.frameMs / 1000));
    const hop = Math.max(80, Math.floor(sampleRate * cfg.hopMs / 1000));
    const energies = [];
    for (let s = 0; s + frame <= samples.length; s += hop) {
      let e = 0;
      for (let i = s; i < s + frame; i += 1) e += samples[i] * samples[i];
      energies.push(Math.sqrt(e / frame));
    }
    if (energies.length < 4) return { ok: false, reason: 'too_short', voicedMs: 0, voicedRatio: 0, peak: 0 };
    const sorted = [...energies].sort((a, b) => a - b);
    const floor = percentile(sorted, cfg.floorPct);
    const peak = percentile(sorted, cfg.peakPct);
    // 整段太安静（纯静音/极弱底噪）→ 没人说话
    if (peak < cfg.vadMinPeakRms) return { ok: false, reason: 'too_quiet', voicedMs: 0, voicedRatio: 0, peak };
    const threshold = Math.max(cfg.vadMinPeakRms * 0.6, floor + cfg.thresholdRatio * (peak - floor));
    let voiced = 0;
    for (const e of energies) if (e >= threshold) voiced += 1;
    const voicedMs = voiced * cfg.hopMs;
    const voicedRatio = voiced / energies.length;
    const ok = voicedMs >= cfg.vadMinVoicedMs && voicedRatio >= cfg.vadMinVoicedRatio;
    return { ok, reason: ok ? '' : 'insufficient_speech', voicedMs, voicedRatio: Math.round(voicedRatio * 1000) / 1000, peak: Math.round(peak * 1e4) / 1e4 };
  } catch {
    return { ok: true, reason: 'vad_skipped', voicedMs: 0, voicedRatio: 0, peak: 0 }; // 降级放行,不锁主人
  }
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// 一阶高通:y[n] = a*(y[n-1] + x[n] - x[n-1]),去 DC 与低频底噪。
function highpass(samples, a) {
  const out = new Float32Array(samples.length);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];
    const y = a * (prevY + x - prevX);
    out[i] = y;
    prevX = x;
    prevY = y;
  }
  return out;
}

function encodePcm16Wav(samples, sampleRate) {
  const n = samples.length;
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i += 1) {
    let v = Math.round(samples[i] * 32767);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

// 主入口:输入/输出都是 PCM16 WAV Buffer。失败或不确定一律返回原始 buffer。
export function preprocessVoiceWav(wavBuffer, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  try {
    const { sampleRate, samples: raw } = parsePcm16Wav(wavBuffer);
    if (!sampleRate || raw.length < sampleRate * 0.2) return wavBuffer; // 太短不动
    const samples = highpass(raw, cfg.highpassA);

    const frame = Math.max(160, Math.floor(sampleRate * cfg.frameMs / 1000));
    const hop = Math.max(80, Math.floor(sampleRate * cfg.hopMs / 1000));
    const energies = [];
    const starts = [];
    for (let s = 0; s + frame <= samples.length; s += hop) {
      let e = 0;
      for (let i = s; i < s + frame; i += 1) e += samples[i] * samples[i];
      energies.push(Math.sqrt(e / frame));
      starts.push(s);
    }
    if (energies.length < 4) return wavBuffer;

    const sorted = [...energies].sort((a, b) => a - b);
    const floor = percentile(sorted, cfg.floorPct);
    const peak = percentile(sorted, cfg.peakPct);
    // 没有明显语音/静音对比(整段均匀,如纯音、全程说话)→ 不冒险裁剪。
    if (peak <= floor * cfg.minContrast) return wavBuffer;
    const threshold = floor + cfg.thresholdRatio * (peak - floor);

    // 标记语音帧 + hangover 缓冲
    const voiced = new Array(energies.length).fill(false);
    for (let i = 0; i < energies.length; i += 1) {
      if (energies[i] >= threshold) {
        const lo = Math.max(0, i - cfg.hangoverFrames);
        const hi = Math.min(energies.length - 1, i + cfg.hangoverFrames);
        for (let j = lo; j <= hi; j += 1) voiced[j] = true;
      }
    }

    // 收集语音帧覆盖的样本区间并拼接(去重叠)
    // 审计 §3.4 P0-5：先收集区间算精确总长，再按需分配——不再预分配整段 samples.length
    // （120s 16k 音频整段 ~7.7MB，裁掉静音后实际 kept 常远小于全长，预分配纯浪费峰值内存）。
    const segments = []; // 扁平 [from0,to0,from1,to1,...]
    let kept = 0;
    let lastEnd = 0;
    for (let i = 0; i < voiced.length; i += 1) {
      if (!voiced[i]) continue;
      const from = Math.max(lastEnd, starts[i]);
      const to = Math.min(samples.length, starts[i] + frame);
      if (to > from) { segments.push(from, to); kept += to - from; lastEnd = to; }
    }

    if (kept < sampleRate * (cfg.minVoicedMs / 1000)) return wavBuffer; // 裁太狠 → 放弃
    if (kept >= samples.length) return wavBuffer; // 没裁掉什么 → 省一次重编码
    const keep = new Float32Array(kept); // 精确分配（kept），不再是 samples.length
    let w = 0;
    for (let si = 0; si < segments.length; si += 2) {
      for (let k = segments[si]; k < segments[si + 1]; k += 1) { keep[w] = samples[k]; w += 1; }
    }
    return encodePcm16Wav(keep, sampleRate);
  } catch {
    return wavBuffer; // 非法 WAV 等任何异常都不破坏原信号
  }
}

export const __vadInternals = { highpass, encodePcm16Wav, percentile };
