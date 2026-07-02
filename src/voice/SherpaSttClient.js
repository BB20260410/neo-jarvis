// @ts-check
// SherpaSttClient — 本地流式 STT（sherpa-onnx zipformer 中英双语）+ 唤醒词 KWS，治"整段 POST whisper 3-7s 断顿"。
// 同机实测（M5 Max CPU / int8）：5s 音频 ~110ms 出全文、10s ~210ms，模型加载一次 ~380ms（懒加载）。
// 契约与 LocalSttClient 对齐：transcribe(wavBuffer)→text、available()→bool；
// 另暴露流式接口 createStream()（sherpa 自带端点检测，供后续 WS 推流"边说边出字"）与 detectWakeword()。
// 模型未就位时 ready()=false，makeNoeSttClient() 自动回退 whisper——零破坏可切换。
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePcm16Wav } from '../identity/Voiceprint.js';
import { preprocessVoiceWav } from '../identity/VoiceVad.js';

const require = createRequire(import.meta.url);

const SHERPA_ROOT = join(homedir(), '.noe-voice', 'models', 'sherpa');
const DEFAULT_ASR_DIR = process.env.NOE_SHERPA_MODEL_DIR
  || join(SHERPA_ROOT, 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20');
const DEFAULT_KWS_DIR = process.env.NOE_SHERPA_KWS_DIR
  || join(SHERPA_ROOT, 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
const DEFAULT_KEYWORDS_FILE = process.env.NOE_WAKEWORD_FILE || join(SHERPA_ROOT, 'noe-keywords.txt');

// 唤醒词"嘿 Noe"的拼音 token 变体（Noe 读 /noʊ/ ≈ nuò/nòu；嘿/嗨都算）。
// 行格式 = KWS keywords 约定：`token1 token2 … @显示词`；#后是该词独立阈值（调高=更难触发更少误触）。
const DEFAULT_KEYWORDS = [
  'h ēi n uò @嘿Noe',
  'h ēi n òu @嘿Noe',
  'h āi n uò @嘿Noe',
  'h āi n òu @嘿Noe',
].join('\n') + '\n';

function tailSilence(sampleRate, seconds = 0.66) {
  return new Float32Array(Math.floor(sampleRate * seconds));
}

export class SherpaSttClient {
  constructor({
    modelDir = DEFAULT_ASR_DIR,
    kwsDir = DEFAULT_KWS_DIR,
    keywordsFile = DEFAULT_KEYWORDS_FILE,
    numThreads = 2,
    // VoiceVad 预处理默认关：实测（CosyVoice 合成"…继续陪你聊天"）渐弱尾音会被裁掉导致 STT 丢尾字，
    // 真人说话尾音同样常渐弱；而 sherpa 流式模型本身对静音鲁棒，预处理提速在毫秒级识别下无感——弊大于利。
    preprocess = false,
    loadAddon = null,           // 测试注入位：() => fake addon
    maxAudioSeconds = 120,      // 防超长音频把同步解码拖太久
    kwsThreshold = Number(process.env.NOE_WAKEWORD_THRESHOLD) || 0.25, // 越高越难触发（压同音误触如"黑诺基亚"）
  } = {}) {
    this.modelDir = modelDir;
    this.kwsDir = kwsDir;
    this.keywordsFile = keywordsFile;
    this.numThreads = numThreads;
    this.preprocess = preprocess;
    this.maxAudioSeconds = maxAudioSeconds;
    this.kwsThreshold = kwsThreshold;
    this._loadAddon = loadAddon || (() => require('sherpa-onnx-node'));
    this._sherpa = null;
    this._recognizer = null;
    this._spotter = null;
  }

  _asrFiles() {
    // int8 encoder/joiner（CPU 快 2-3 倍）；decoder 用 fp32（int8 decoder 精度损失大，官方示例同款搭配）
    return {
      encoder: join(this.modelDir, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: join(this.modelDir, 'decoder-epoch-99-avg-1.onnx'),
      joiner: join(this.modelDir, 'joiner-epoch-99-avg-1.int8.onnx'),
      tokens: join(this.modelDir, 'tokens.txt'),
    };
  }

  _kwsFiles() {
    return {
      encoder: join(this.kwsDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: join(this.kwsDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
      joiner: join(this.kwsDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      tokens: join(this.kwsDir, 'tokens.txt'),
    };
  }

  /** 同步就绪检查：ASR 模型文件齐 + 原生 addon 可加载（不建 recognizer，不花那 ~380ms）。 */
  ready() {
    try {
      const f = this._asrFiles();
      if (![f.encoder, f.decoder, f.joiner, f.tokens].every((p) => existsSync(p))) return false;
      this._sherpa = this._sherpa || this._loadAddon();
      return typeof this._sherpa?.OnlineRecognizer === 'function';
    } catch { return false; }
  }

  /** 与 LocalSttClient.available() 契约对齐（async）。 */
  async available() { return this.ready(); }

  _ensureRecognizer() {
    if (this._recognizer) return this._recognizer;
    if (!this.ready()) throw new Error(`sherpa STT 模型未就位: ${this.modelDir}`);
    const f = this._asrFiles();
    this._recognizer = new this._sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
        tokens: f.tokens,
        numThreads: this.numThreads,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      // 端点规则（秒）：说完静音 2.4s（无内容时）/ 1.2s（已出字后）即判定一句结束
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    });
    return this._recognizer;
  }

  /**
   * 整段转写（兼容 LocalSttClient 契约）。16kHz mono PCM16 wav → 文本。
   * @param {Buffer|Uint8Array} wavBuffer
   * @returns {Promise<string>}
   */
  async transcribe(wavBuffer) {
    const recognizer = this._ensureRecognizer();
    const input = this.preprocess ? preprocessVoiceWav(wavBuffer) : wavBuffer;
    const { sampleRate, samples } = parsePcm16Wav(input);
    if (samples.length > sampleRate * this.maxAudioSeconds) {
      throw new Error(`音频过长（>${this.maxAudioSeconds}s），拒绝同步转写`);
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    stream.acceptWaveform({ samples: tailSilence(sampleRate), sampleRate }); // tail padding 让尾字出来
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    return String(recognizer.getResult(stream)?.text || '').trim();
  }

  /**
   * 流式接口：边喂音频边出字 + sherpa 端点检测（供 WS 推流场景；本卡先落能力，前端接线后续做）。
   * @returns {{feed(samples: Float32Array, sampleRate?: number): void, result(): string, isEndpoint(): boolean, reset(): void, finish(): string}}
   */
  createStream() {
    const recognizer = this._ensureRecognizer();
    const stream = recognizer.createStream();
    const drain = () => { while (recognizer.isReady(stream)) recognizer.decode(stream); };
    return {
      feed(samples, sampleRate = 16000) { stream.acceptWaveform({ samples, sampleRate }); drain(); },
      result() { return String(recognizer.getResult(stream)?.text || '').trim(); },
      isEndpoint() { return recognizer.isEndpoint(stream); },
      reset() { recognizer.reset(stream); },
      finish() {
        stream.acceptWaveform({ samples: tailSilence(16000), sampleRate: 16000 });
        stream.inputFinished();
        drain();
        return String(recognizer.getResult(stream)?.text || '').trim();
      },
    };
  }

  kwsReady() {
    try {
      const f = this._kwsFiles();
      if (![f.encoder, f.decoder, f.joiner, f.tokens].every((p) => existsSync(p))) return false;
      this._sherpa = this._sherpa || this._loadAddon();
      return typeof this._sherpa?.KeywordSpotter === 'function';
    } catch { return false; }
  }

  _ensureSpotter() {
    if (this._spotter) return this._spotter;
    if (!this.kwsReady()) throw new Error(`sherpa KWS 模型未就位: ${this.kwsDir}`);
    if (!existsSync(this.keywordsFile)) {
      // 默认唤醒词文件不存在则落一份（模型目录归我们管，不碰用户文件）
      writeFileSync(this.keywordsFile, DEFAULT_KEYWORDS, 'utf-8');
    }
    const f = this._kwsFiles();
    this._spotter = new this._sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
        tokens: f.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: this.keywordsFile,
      keywordsScore: 1.0,
      keywordsThreshold: this.kwsThreshold,
    });
    return this._spotter;
  }

  /**
   * 唤醒词检测："嘿 Noe"（及变体）。整段 wav 进，命中即返回。
   * @param {Buffer|Uint8Array} wavBuffer
   * @returns {Promise<{spotted: boolean, keyword: string}>}
   */
  async detectWakeword(wavBuffer) {
    const spotter = this._ensureSpotter();
    const { sampleRate, samples } = parsePcm16Wav(wavBuffer);
    const stream = spotter.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    stream.acceptWaveform({ samples: tailSilence(sampleRate, 0.4), sampleRate });
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      const r = spotter.getResult(stream);
      if (r?.keyword) return { spotted: true, keyword: String(r.keyword) };
    }
    return { spotted: false, keyword: '' };
  }
}

/**
 * Noe STT 选择工厂（noe.js 构建处用）：
 *   NOE_STT=whisper → null（VoiceSession 默认 LocalSttClient，即原 whisper 链路）
 *   NOE_STT=sherpa  → 纯 sherpa（强制，模型缺失时报错便于排查）
 *   默认 auto       → sherpa 就绪则用之（whisper 作运行时兜底，sherpa 万一失败不哑）；未就绪回退 whisper
 * @param {{env?: object, whisper?: {available():Promise<boolean>, transcribe(b:Buffer):Promise<string>}, sherpa?: SherpaSttClient, log?: Function}} [opts]
 * @returns {object|null} 传给 VoiceSession 的 sttClient；null = 用默认 LocalSttClient
 */
export function makeNoeSttClient({ env = process.env, whisper = null, sherpa = null, log = (...a) => console.warn(...a) } = {}) {
  const pref = String(env.NOE_STT || 'auto').toLowerCase();
  if (pref === 'whisper') return null;
  const s = sherpa || new SherpaSttClient();
  if (pref === 'sherpa') return s;
  if (!s.ready()) return null; // auto：模型没就位 → 默认 whisper 链路，零影响
  if (!whisper) return s;
  return {
    async available() { return true; },
    async transcribe(wavBuffer) {
      try { return await s.transcribe(wavBuffer); }
      catch (e) {
        log('[noe-stt] sherpa 转写失败，回退 whisper:', e?.message || e);
        return whisper.transcribe(wavBuffer);
      }
    },
    sherpa: s, // 暴露给唤醒词端点复用同一实例（模型只加载一份）
  };
}
