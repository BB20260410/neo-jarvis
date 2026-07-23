// LocalVlmClient — 调本地 LM Studio VLM 看图理解（零 token、零外发、隐私好）。
// 默认跟随 Noe 主脑 Qwen 35B A3B 6bit；其它模型可由调用方显式 opts.model / fallbackModel 覆盖。
import { ensureLmStudioModel } from '../room/LmStudioLoader.js';
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

export class LocalVlmClient {
  constructor({
    baseUrl = process.env.NOE_VLM_URL || 'http://127.0.0.1:1234/v1',
    model = process.env.NOE_VLM_MODEL || NOE_MAIN_BRAIN_MODEL,
    fallbackModel = process.env.NOE_VLM_FALLBACK_MODEL || '',
    timeoutMs = Number(process.env.NOE_VLM_TIMEOUT_MS) || 90000,
    ensureModel = ensureLmStudioModel,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = normalizeNoeAutoModel(model);
    this.fallbackModel = String(fallbackModel || '').trim();
    this.timeoutMs = timeoutMs;
    this.ensureModel = ensureModel;
    this.lastUsedModel = null;
    this.lastFallback = null;
  }

  async available() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(this.baseUrl + '/models', { signal: ctrl.signal, headers: { Authorization: 'Bearer lm-studio' } });
      clearTimeout(t);
      return resp.ok;
    } catch { return false; }
  }

  /**
   * 让本地 VLM 描述一张图（截屏/摄像头帧），推断用户在干什么。
   * @param {Buffer|Uint8Array} imageBuffer
   * @param {string} [prompt]
   * @param {object} [opts] {format:'png'|'jpeg', model, maxTokens}
   * @returns {Promise<string>}
   */
  async describe(imageBuffer, prompt = '用一两句话描述这张截图里有什么、用户可能正在做什么。简短自然，中文。', opts = {}) {
    return this.describeImages([{ buffer: imageBuffer, format: opts.format || 'png' }], prompt, opts);
  }

  /**
   * 多图综合理解：一次喂多张图（如 屏幕+摄像头），让 VLM 综合描述。
   * @param {Array<{buffer:Buffer|Uint8Array, format?:string}>} images
   * @param {string} [prompt]
   * @param {object} [opts] {model, maxTokens}
   * @returns {Promise<string>}
   */
  async describeImages(images, prompt = '描述这些画面里的内容。简短自然，中文。', opts = {}) {
    const model = opts.model || this.model;
    const fallbackModel = opts.model
      ? ''
      : (opts.fallbackModel !== undefined ? opts.fallbackModel : this.fallbackModel);
    // 自助确保 LM Studio 已加载该视觉模型(对称于大脑)，没加载就 lms load；失败则下面 fetch 自然报错
    const content = [{ type: 'text', text: prompt }];
    for (const im of (images || [])) {
      if (!im || !im.buffer) continue;
      const b64 = Buffer.from(im.buffer).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:image/${im.format || 'png'};base64,${b64}` } });
    }
    try {
      const text = await this._requestModel(model, content, opts);
      this.lastUsedModel = model;
      this.lastFallback = null;
      return text;
    } catch (e) {
      const fallback = String(fallbackModel || '').trim();
      if (/^(0|off|false|none)$/i.test(fallback)) throw e;
      if (!fallback || fallback === model) throw e;
      try {
        const text = await this._requestModel(fallback, content, opts);
        this.lastUsedModel = fallback;
        this.lastFallback = { from: model, to: fallback, reason: e?.message || String(e) };
        return text;
      } catch (fallbackError) {
        fallbackError.cause = e;
        throw fallbackError;
      }
    }
  }

  async _requestModel(model, content, opts = {}) {
    try { await this.ensureModel(model, { baseUrl: this.baseUrl }); } catch { /* noop */ }
    const budget = resolveNoeOutputBudget('vision', { requestedMaxTokens: opts.maxTokens });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          max_tokens: budget.max_tokens,
          temperature: 0.1,
          top_p: 0.9,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const d = await resp.json().catch(() => ({}));
      const text = d?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(`VLM 无回复: ${JSON.stringify(d).slice(0, 200)}`);
      return text;
    } catch (e) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('VLM 超时（LM Studio 视觉模型未加载？）');
      throw e;
    }
  }

  /** 从 LM Studio 卸载视觉模型释放内存（关闭视觉时调）：spawn lms unload <model>，PATH 找不到则退 ~/.lmstudio/bin/lms */
  async unload() {
    const { spawn } = await import('node:child_process');
    const tryBin = (bin) => new Promise((resolve) => {
      try {
        const p = spawn(bin, ['unload', this.model], { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
      } catch { resolve(false); }
    });
    try { if (await tryBin('lms')) return true; } catch {}
    try { return await tryBin(`${process.env.HOME || ''}/.lmstudio/bin/lms`); } catch { return false; }
  }
}
