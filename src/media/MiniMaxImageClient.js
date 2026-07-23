// MiniMaxImageClient — MiniMax 图像生成（image-01）直调 HTTP API，绕开 minimax CLI commands。
//
// 波次5#1「多模态 SDK 剥壳，从图片起」。与 MiniMaxTtsClient 一脉相承：Bearer auth +
// resolveNoeProviderSecret('minimax') 拿 key（绝不硬编码/不 log）+ 错误体白名单过滤
// （只取 status_code/status_msg，绝不把第三方原始错误体——可能含计费/账户/请求回显——转发）。
//
// 遵循 feedback_no_model_timeout：默认不设硬超时（timeoutMs=null），生成多久不可预测，
// 硬超时会误判失败；需要时调用方可显式传 timeoutMs 开启。
// 纯请求/解析逻辑抽成函数可单测；fetch 注入 → 单测不真调、不烧额度。

import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';

// 默认国内站（对齐 MiniMaxChatAdapter；实测国内 sk-cp- key 走此站出图成功，国际站对此 key 不工作）。
// 国际账号用 MINIMAX_IMAGE_ENDPOINT 覆盖到 https://api.minimaxi.com/v1/image_generation。
const ENDPOINT = 'https://api.minimax.chat/v1/image_generation';

/** 构造图像生成请求体（纯函数）。 */
export function buildImageRequest(prompt, { model = 'image-01', aspectRatio = '1:1', n = 1, responseFormat = 'url', promptOptimizer = true } = {}) {
  const clean = String(prompt || '').trim().slice(0, 1500);
  if (!clean) throw new Error('图像 prompt 为空');
  return {
    model,
    prompt: clean,
    aspect_ratio: aspectRatio,
    response_format: responseFormat === 'base64' ? 'base64' : 'url',
    n: Math.max(1, Math.min(9, Number(n) || 1)),
    prompt_optimizer: !!promptOptimizer,
  };
}

/** 解析图像生成响应（纯函数）。错误只暴露白名单字段，不转发原始错误体。 */
export function parseImageResponse(data = {}) {
  const code = data?.base_resp?.status_code;
  if (code != null && code !== 0) {
    const err = new Error(`MiniMax 图像错误(${code}): ${data?.base_resp?.status_msg || 'unknown'}`);
    err.statusCode = code;
    throw err;
  }
  const urls = Array.isArray(data?.data?.image_urls) ? data.data.image_urls : [];
  const b64 = Array.isArray(data?.data?.image_base64) ? data.data.image_base64 : [];
  const images = [
    ...urls.filter(Boolean).map((url) => ({ url, base64: null })),
    ...b64.filter(Boolean).map((b) => ({ url: null, base64: b })),
  ];
  if (!images.length) throw new Error('MiniMax 图像无返回');
  return { images, id: data?.id || null };
}

export class MiniMaxImageClient {
  constructor({
    apiKey,
    secretResolver = resolveNoeProviderSecret,
    model = process.env.NOE_IMAGE_MODEL || 'image-01',
    baseUrl = process.env.MINIMAX_IMAGE_ENDPOINT || ENDPOINT,
    fetchImpl = fetch,
    timeoutMs = null,            // null = 不设硬超时（feedback_no_model_timeout）
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
        ? `MiniMax image key resolved from ${resolution.source}`
        : describeNoeProviderSecretFailure('minimax', resolution),
    };
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  configured() { return Boolean(this.apiKey); }

  /**
   * 生成图像。
   * @param {string} prompt
   * @param {object} [opts] {aspectRatio, n, responseFormat:'url'|'base64', promptOptimizer, model}
   * @returns {Promise<{images:Array<{url:string|null, base64:string|null}>, id:string|null}>}
   */
  async generate(prompt, opts = {}) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const body = buildImageRequest(prompt, { model: this.model, ...opts });
    let signal;
    let timer = null;
    if (this.timeoutMs && this.timeoutMs > 0) {
      const ctrl = new AbortController();
      signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    }
    try {
      const resp = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      const data = await resp.json().catch(() => ({}));
      return parseImageResponse(data);
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('MiniMax 图像生成超时');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
