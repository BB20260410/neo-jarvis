// @ts-check
// QwenVoiceDesignTtsClient — 本地 Qwen3-TTS VoiceDesign 中文 TTS（志玲嗲软音色，seed 锁定）。
// 走本地常驻服务 scripts/noe-qwen-tts-server.py（默认 8126，1.7B-VoiceDesign + seed 52013 + 嗲软音色描述）。
// 音色由 server 端的固定 seed + 音色描述锁死；情感主要靠文本语义（大脑生成带情感的回复文本）。
// 接口与 CosyVoiceTtsClient/MiniMaxTtsClient/KokoroTtsClient 对齐（synthesize → {audioBuffer, format}），
// 可直接替换 VoiceSession 的本地中文 TTS 槽位。
const QWEN_TTS_URL = process.env.NOE_QWEN_TTS_URL || 'http://127.0.0.1:8126';

export class QwenVoiceDesignTtsClient {
  constructor({ baseUrl = QWEN_TTS_URL, instruct = process.env.NOE_QWEN_TTS_DESC || '', speed = 1.0, timeoutMs = 0 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.instruct = instruct; // 空 = 用 server 端默认嗲软音色描述（锁音色）；非空会覆盖(可能改音色)
    this.speed = speed;
    this.timeoutMs = timeoutMs; // 默认 0=不设超时（跑模型不许超时误杀）
  }

  configured() { return Boolean(this.baseUrl); }

  async available() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000); // 探活快速超时
      const resp = await fetch(this.baseUrl + '/', { signal: ctrl.signal });
      clearTimeout(t);
      return resp.ok;
    } catch { return false; }
  }

  /**
   * 合成语音（中文为主，志玲 VoiceDesign 固定音色）。
   * @param {string} text
   * @param {object} [opts] {instruct, speed}
   * @returns {Promise<{audioBuffer: Buffer, format: string}>}
   */
  async synthesize(text, opts = {}) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) throw new Error('Qwen TTS 文本为空');
    const payload = { text: clean, speed: opts.speed || this.speed };
    const instruct = opts.instruct || this.instruct;
    if (instruct) payload.instruct = instruct;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
    let timer = null;
    if (this.timeoutMs > 0) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      init.signal = ctrl.signal;
    }
    try {
      const resp = await fetch(`${this.baseUrl}/tts`, init);
      if (timer) clearTimeout(timer);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(`Qwen TTS: ${data.error || resp.status}`);
      if (!data.audio) throw new Error('Qwen TTS 无音频返回');
      return { audioBuffer: Buffer.from(data.audio, 'base64'), format: data.format || 'wav' };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e?.name === 'AbortError') throw new Error('Qwen TTS 超时（本地服务未启动？）');
      throw e;
    }
  }
}
