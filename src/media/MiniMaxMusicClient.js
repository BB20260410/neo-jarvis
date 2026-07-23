// MiniMaxMusicClient — MiniMax 音乐生成（波次5 P2 收尾）。
//
// API 形状核实自**官方 CLI/SDK 源码**（github.com/MiniMax-AI/cli src/sdk/music + test fixture，2026-06-10）：
//   POST {base}/v1/music_generation
//   body: { model, prompt, lyrics, is_instrumental, lyrics_optimizer, output_format }
//   纯音乐时 lyrics 兜底 '[intro] [outro]'（官方 SDK 同款行为）
//   响应（同步）: { data: { audio_url | audio_base64 }, base_resp: { status_code } }
// lyrics 支持结构标签 [Intro][Verse][Chorus][Bridge][Outro] 等（标签内不能写描述，会被唱出来）。
// 同款纪律：key 走 resolver 不打印；错误体白名单；不设硬超时（生成时长不可预测）。

import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';

const DEFAULT_BASE = 'https://api.minimax.chat/v1';

export class MiniMaxMusicClient {
  constructor({
    apiKey,
    secretResolver = resolveNoeProviderSecret,
    model = process.env.NOE_MUSIC_MODEL || 'music-2.6-free',   // free 档所有 API key 可用；付费档 env 覆盖 music-2.6
    baseUrl = process.env.MINIMAX_MUSIC_BASE || DEFAULT_BASE,
    fetchImpl = fetch,
  } = {}) {
    const resolution = apiKey
      ? { ok: true, value: apiKey, source: 'caller' }
      : secretResolver('minimax');
    this.apiKey = resolution?.value || '';
    this.secretStatus = {
      ok: !!resolution?.ok,
      source: resolution?.source || 'unconfigured',
      message: resolution?.ok ? `MiniMax music key resolved from ${resolution.source}` : describeNoeProviderSecretFailure('minimax', resolution),
    };
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  configured() { return Boolean(this.apiKey); }

  /**
   * 生成音乐（同步接口，可能跑分钟级——不设硬超时）。
   * @param {string} prompt 风格描述（如 "钢琴轻音乐，雨夜放松"，≤2000 字符）
   * @param {object} [opts] { lyrics, instrumental=false, lyricsOptimizer=false, model, outputFormat }
   * @returns {Promise<{audioUrl:string|null, audioBase64:string|null}>}
   */
  async generate(prompt, opts = {}) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const clean = String(prompt || '').trim().slice(0, 2000);
    if (!clean) throw new Error('音乐 prompt 为空');
    let lyrics = String(opts.lyrics || '').slice(0, 3500);
    // 官方 SDK 同款：纯音乐 / 无歌词 → 兜底结构标签
    if (opts.instrumental || !lyrics) lyrics = '[intro] [outro]';
    const body = {
      model: opts.model || this.model,
      prompt: clean,
      lyrics,
      is_instrumental: !!opts.instrumental,
    };
    if (opts.lyricsOptimizer) body.lyrics_optimizer = true;
    if (opts.outputFormat) body.output_format = opts.outputFormat;
    const resp = await this.fetchImpl(`${this.baseUrl}/music_generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = typeof resp?.json === 'function' ? await resp.json().catch(() => ({})) : resp;
    const code = data?.base_resp?.status_code;
    if (code != null && code !== 0) {
      const err = new Error(`MiniMax 音乐错误(${code}): ${data?.base_resp?.status_msg || 'unknown'}`);
      err.statusCode = code;
      throw err;
    }
    const audioUrl = data?.data?.audio_url || null;
    const audioBase64 = data?.data?.audio_base64 || null;
    if (!audioUrl && !audioBase64) throw new Error('MiniMax 音乐无音频返回');
    return { audioUrl, audioBase64 };
  }
}
