// @ts-check
// SileroVadClient — 神经网络语音活动检测（接本地吃灰的 silero_vad.onnx，借鉴 ricky0123/vad 思路本地化）。
//
// 治什么：前端 noe-voice.js 的 RMS VAD 只比响度——电视声/空调声/关门声够响就触发录音，烧一次 STT+大脑+TTS。
// silero 是神经网络判"这是不是人声结构"而非响度，区分力强得多（同机实测：人声 detected、纯高斯噪声 rejected，~17ms）。
// 架构位置：和唤醒词门控并列的"语音段录完→发对话前"的精筛层；在 VoiceSession STT 之前过一道，
// 全入口覆盖（实时模式/按住说话/Telegram）。零前端新依赖（不拖 onnxruntime-web 134MB）——
// 复用卡①已装的 sherpa-onnx-node（内置 Vad 类）+ 卡①已下的 silero_vad.onnx。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePcm16Wav } from '../identity/Voiceprint.js';

const require = createRequire(import.meta.url);

const DEFAULT_MODEL = process.env.NOE_SILERO_VAD_MODEL
  || join(homedir(), '.noe-voice', 'models', 'sherpa', 'silero_vad.onnx');
const WINDOW = 512; // silero v4 固定窗口（16kHz）

export class SileroVadClient {
  constructor({
    model = DEFAULT_MODEL,
    threshold = Number(process.env.NOE_SILERO_VAD_THRESHOLD) || 0.5,
    minSilenceDuration = 0.25,
    minSpeechDuration = 0.2,
    bufferSeconds = 30,
    maxAudioSeconds = 120,
    loadAddon = null, // 测试注入位
  } = {}) {
    this.model = model;
    this.threshold = threshold;
    this.minSilenceDuration = minSilenceDuration;
    this.minSpeechDuration = minSpeechDuration;
    this.bufferSeconds = bufferSeconds;
    this.maxAudioSeconds = maxAudioSeconds;
    this._loadAddon = loadAddon || (() => require('sherpa-onnx-node'));
    this._sherpa = null;
    this._vad = null;
  }

  /** 模型文件齐 + 原生 addon 可加载（不建检测器，零开销）。 */
  ready() {
    try {
      if (!existsSync(this.model)) return false;
      this._sherpa = this._sherpa || this._loadAddon();
      return typeof this._sherpa?.Vad === 'function';
    } catch { return false; }
  }

  // 复用单例（量化实测：每次新建 3.4ms 建造开销+模型重载；复用+reset 处理 2s 音频 6.0→3.6ms）。
  // detect 串行调用（VoiceSession 链路同步 await），无并发竞态；每次用完 reset 清状态。
  _ensureVad() {
    if (this._vad) return this._vad;
    this._vad = new this._sherpa.Vad({
      sileroVad: {
        model: this.model,
        threshold: this.threshold,
        minSilenceDuration: this.minSilenceDuration,
        minSpeechDuration: this.minSpeechDuration,
        windowSize: WINDOW,
      },
    }, this.bufferSeconds);
    return this._vad;
  }

  /**
   * 判断一段 16kHz mono PCM16 wav 里是否含有效人声段。
   * @param {Buffer|Uint8Array} wavBuffer
   * @returns {{ok: boolean, hasSpeech: boolean, segments: number, reason: string}}
   *   ok=false 表示 VAD 不可用/异常（调用方应降级放行，绝不因 VAD 自身问题把主人挡在门外）。
   */
  detect(wavBuffer) {
    if (!this.ready()) return { ok: false, hasSpeech: true, segments: 0, reason: 'vad_unavailable' };
    let parsed;
    try { parsed = parsePcm16Wav(wavBuffer); }
    catch { return { ok: false, hasSpeech: true, segments: 0, reason: 'wav_parse_failed' }; }
    const { sampleRate, samples } = parsed;
    if (sampleRate !== 16000) return { ok: false, hasSpeech: true, segments: 0, reason: 'sample_rate_not_16k' };
    if (samples.length > sampleRate * this.maxAudioSeconds) return { ok: false, hasSpeech: true, segments: 0, reason: 'audio_too_long' };
    let vad = null;
    try {
      vad = this._ensureVad();
      let segments = 0;
      for (let i = 0; i + WINDOW <= samples.length; i += WINDOW) {
        vad.acceptWaveform(samples.subarray(i, i + WINDOW));
        while (!vad.isEmpty()) { segments += 1; vad.pop(); }
      }
      vad.flush();
      while (!vad.isEmpty()) { segments += 1; vad.pop(); }
      return { ok: true, hasSpeech: segments > 0, segments, reason: segments > 0 ? 'speech' : 'no_speech' };
    } catch (e) {
      this._vad = null; // 原生实例进入未知状态就弃用，下次重建（宁可多 3.4ms 不复用脏状态）
      return { ok: false, hasSpeech: true, segments: 0, reason: `vad_error:${e?.message || e}` };
    } finally {
      try { vad?.reset(); } catch { this._vad = null; }
    }
  }
}

/**
 * 工厂：NOE_SILERO_VAD=1 且模型就位才返回实例；否则 null（VoiceSession 不过这道精筛，行为同旧）。
 * 默认 OFF——纯加强、可回退，env 开启才通电。
 */
export function makeSileroVad({ env = process.env } = {}) {
  if (env.NOE_SILERO_VAD !== '1') return null;
  const c = new SileroVadClient({
    model: env.NOE_SILERO_VAD_MODEL || DEFAULT_MODEL,
    threshold: Number(env.NOE_SILERO_VAD_THRESHOLD) || 0.5,
  });
  return c.ready() ? c : null;
}
