// @ts-check
// OpenAICompatibleVoiceGatewayClient — 可选本地语音网关适配器（OpenMeow 等）。
// 默认不装配；启用后作为 VoiceSession 的一个 TTS client，接口与 MiniMax/Kokoro/CosyVoice 对齐。
const DEFAULT_BASE_URL = process.env.NOE_VOICE_GATEWAY_BASE_URL || 'http://127.0.0.1:23333/v1';

export class OpenAICompatibleVoiceGatewayClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    model = process.env.NOE_VOICE_GATEWAY_MODEL || 'tts-1',
    voice = process.env.NOE_VOICE_GATEWAY_VOICE || 'alloy',
    responseFormat = process.env.NOE_VOICE_GATEWAY_FORMAT || 'wav',
    timeoutMs = 0,
  } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.model = model;
    this.voice = voice;
    this.responseFormat = responseFormat;
    this.timeoutMs = timeoutMs; // 默认 0=不限制模型合成；仅健康检查短超时
  }

  configured() { return Boolean(this.baseUrl); }

  async available() {
    if (!this.configured()) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const resp = await fetch(`${this.baseUrl}/models`, { signal: ctrl.signal });
      return resp.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} text
   * @param {{voice?:string, model?:string, responseFormat?:string, speed?:number}} [opts]
   * @returns {Promise<{audioBuffer: Buffer, format: string}>}
   */
  async synthesize(text, opts = {}) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) throw new Error('Voice gateway TTS 文本为空');
    if (!this.configured()) throw new Error('Voice gateway TTS 未配置 baseUrl');
    const format = String(opts.responseFormat || this.responseFormat || 'wav');
    const body = {
      model: opts.model || this.model,
      voice: opts.voice || this.voice,
      input: clean,
      response_format: format,
      ...(Number.isFinite(Number(opts.speed)) ? { speed: Number(opts.speed) } : {}),
    };
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    let timer = null;
    if (this.timeoutMs > 0) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      init.signal = ctrl.signal;
    }
    try {
      const resp = await fetch(`${this.baseUrl}/audio/speech`, init);
      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        throw new Error(`Voice gateway TTS: ${err || resp.status}`);
      }
      const audioBuffer = Buffer.from(await resp.arrayBuffer());
      if (!audioBuffer.length) throw new Error('Voice gateway TTS 无音频返回');
      return { audioBuffer, format };
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('Voice gateway TTS 超时（本地网关未响应？）');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
