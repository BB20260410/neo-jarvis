// @ts-check
// CosyVoiceTtsClient — 本地 CosyVoice 中文 TTS（卡②：断网/MiniMax 不可用时中文不哑的兜底档）。
// 走本地常驻服务 scripts/noe-cosyvoice-server.py（默认 8125，CosyVoice-300M-SFT）。
// CosyVoice3 MLX 仅作为显式实验服务保留，不再是默认本地中文语音。
// 接口与 MiniMaxTtsClient/KokoroTtsClient 对齐（synthesize → {audioBuffer, format}），
// 挂在 VoiceSession TTS 失败回退链尾：主选(MiniMax/Kokoro)全失败且文本含中文时才会走到这里。
const COSYVOICE_URL = process.env.NOE_COSYVOICE_URL || 'http://127.0.0.1:8125';

export class CosyVoiceTtsClient {
  constructor({ baseUrl = COSYVOICE_URL, voice = process.env.NOE_COSYVOICE_VOICE || '中文女', speed = 1.0, timeoutMs = 0 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.voice = voice;
    this.speed = speed;
    this.timeoutMs = timeoutMs; // 默认 0=不设超时（跑模型不许超时误杀；CPU 合成长句可能要数十秒）
  }

  configured() { return Boolean(this.baseUrl); }

  async available() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000); // 健康检查不是合成，快速探活可以设短超时
      const resp = await fetch(this.baseUrl + '/', { signal: ctrl.signal });
      clearTimeout(t);
      return resp.ok;
    } catch { return false; }
  }

  /**
   * 合成语音（中文为主，SFT 预置音色）。
   * @param {string} text
   * @param {object} [opts] {voice, speed}
   * @returns {Promise<{audioBuffer: Buffer, format: string}>}
   */
  async synthesize(text, opts = {}) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) throw new Error('CosyVoice TTS 文本为空');
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice: opts.voice || this.voice, speed: opts.speed || this.speed }),
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
      if (!resp.ok || data.error) throw new Error(`CosyVoice TTS: ${data.error || resp.status}`);
      if (!data.audio) throw new Error('CosyVoice TTS 无音频返回');
      return { audioBuffer: Buffer.from(data.audio, 'base64'), format: data.format || 'wav' };
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e?.name === 'AbortError') throw new Error('CosyVoice TTS 超时（本地服务未启动？）');
      throw e;
    }
  }
}
