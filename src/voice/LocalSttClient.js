// LocalSttClient — 调本地常驻 whisper 服务做语音转写（零成本、零外发、隐私好）
// 依赖 scripts/noe-whisper-server.py 起在 NOE_WHISPER_URL（默认 127.0.0.1:8123）。

export class LocalSttClient {
  constructor({ baseUrl = process.env.NOE_WHISPER_URL || 'http://127.0.0.1:8123', timeoutMs = 30000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

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
   * 转写一段 16kHz mono PCM 的 wav。
   * @param {Buffer|Uint8Array} wavBuffer
   * @returns {Promise<string>} 识别文本
   */
  async transcribe(wavBuffer) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: wavBuffer,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(`whisper STT: ${data.error || resp.status}`);
      return data.text || '';
    } catch (e) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('whisper STT 超时（本地服务未启动？）');
      throw e;
    }
  }
}
