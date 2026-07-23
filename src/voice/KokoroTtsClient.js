// KokoroTtsClient — 本地 Kokoro TTS（英文/次要播报降级档，省 MiniMax 付费配额）。
// 走本地 kokoro HTTP 服务（scripts/noe-kokoro-server.py，kokoro-onnx，按需启动，不污染 Noe node_modules）。
// 重要：Kokoro 中文弱（实测确认），仅用于英文/系统提示；中文陪伴仍走 MiniMax 甜心小玲。
// 接口与 MiniMaxTtsClient 对齐（synthesize → {audioBuffer, format}），可在 VoiceSession 里按语言分档替换。
const KOKORO_URL = process.env.NOE_KOKORO_URL || 'http://127.0.0.1:8124';

export class KokoroTtsClient {
  constructor({ baseUrl = KOKORO_URL, voice = process.env.NOE_KOKORO_VOICE || 'af_heart', speed = 1.0, timeoutMs = 30000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.voice = voice;
    this.speed = speed;
    this.timeoutMs = timeoutMs;
  }

  configured() { return Boolean(this.baseUrl); }

  async available() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(this.baseUrl + '/', { signal: ctrl.signal });
      clearTimeout(t);
      return resp.ok;
    } catch { return false; }
  }

  /**
   * 合成语音（英文为主）。
   * @param {string} text
   * @param {object} [opts] {voice, speed}
   * @returns {Promise<{audioBuffer: Buffer, format: string}>}
   */
  async synthesize(text, opts = {}) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) throw new Error('Kokoro TTS 文本为空');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, voice: opts.voice || this.voice, speed: opts.speed || this.speed }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(`Kokoro TTS: ${data.error || resp.status}`);
      if (!data.audio) throw new Error('Kokoro TTS 无音频返回');
      return { audioBuffer: Buffer.from(data.audio, 'base64'), format: data.format || 'wav' };
    } catch (e) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('Kokoro TTS 超时（本地服务未启动？）');
      throw e;
    }
  }
}
