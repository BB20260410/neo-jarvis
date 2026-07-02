// MiniMaxTtsClient — MiniMax T2A 语音合成（默认甜心小玲），从命令行验证正式化进 Noe
// 用户已订阅 MiniMax；同一个 API key。默认本地优先策略外的"说"端走 MiniMax。

import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';
import { normalizeTtsText } from './TtsTextNormalizer.js';

const ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';

export class MiniMaxTtsClient {
  constructor({
    apiKey,
    secretResolver = resolveNoeProviderSecret,
    groupId = process.env.MINIMAX_GROUP_ID || '',
    model = process.env.NOE_TTS_MODEL || 'speech-2.6-hd',
    voiceId = process.env.NOE_TTS_VOICE || 'tianxin_xiaoling',
    emotion = process.env.NOE_TTS_EMOTION || 'happy',
    timeoutMs = 30000,
  } = {}) {
    const resolution = apiKey
      ? { ok: true, value: apiKey, source: 'caller', sourceRef: 'apiKey' }
      : secretResolver('minimax');
    this.apiKey = resolution?.value || '';
    this.secretStatus = {
      ok: !!resolution?.ok,
      source: resolution?.source || 'unconfigured',
      sourceRef: resolution?.sourceRef || null,
      message: resolution?.ok
        ? `MiniMax TTS key resolved from ${resolution.source}`
        : describeNoeProviderSecretFailure('minimax', resolution),
    };
    this.groupId = groupId;
    this.model = model;
    this.voiceId = voiceId;
    this.emotion = emotion;
    this.timeoutMs = timeoutMs;
  }

  configured() { return Boolean(this.apiKey); }

  // 剥 markdown / emoji（统一抽到 TtsTextNormalizer 共享纯函数，回退链所有引擎复用，见该文件注释）
  static cleanText(text) {
    return normalizeTtsText(text);
  }

  /**
   * 合成语音。
   * @param {string} text
   * @param {object} [opts] {voiceId, emotion, model, speed}
   * @returns {Promise<{audioBuffer: Buffer, format: string}>}
   */
  async synthesize(text, opts = {}) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const clean = MiniMaxTtsClient.cleanText(text).slice(0, 8000);
    if (!clean) throw new Error('TTS 文本为空');
    const url = this.groupId ? `${ENDPOINT}?GroupId=${encodeURIComponent(this.groupId)}` : ENDPOINT;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model || this.model,
          text: clean,
          stream: false,
          voice_setting: { voice_id: opts.voiceId || this.voiceId, emotion: opts.emotion || this.emotion, speed: opts.speed || 1.0 },
          audio_setting: { format: 'mp3', sample_rate: 32000 },
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await resp.json().catch(() => ({}));
      if (data?.base_resp && data.base_resp.status_code !== 0) {
        // 只取白名单字段，绝不把第三方原始错误体（可能含计费/账户/请求回显）整体转发到响应与前端
        throw new Error(`MiniMax TTS 错误(${data.base_resp.status_code}): ${data.base_resp.status_msg || 'unknown'}`);
      }
      const hex = data?.data?.audio;
      if (!hex) throw new Error('MiniMax TTS 无音频返回');
      return { audioBuffer: Buffer.from(hex, 'hex'), format: 'mp3' };
    } catch (e) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('MiniMax TTS 超时');
      throw e;
    }
  }
}
