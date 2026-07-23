// MiniMaxVideoClient — MiniMax 视频生成（异步任务制，波次5 P2）。
//
// API 形状核实自官方文档（platform.minimax.io/docs/guides/video-generation，2026-06-10）：
//   ① POST {base}/video_generation {model, prompt, ...} → { task_id }
//   ② GET  {base}/query/video_generation?task_id=… 轮询 → { status, file_id }（官方建议 10s 间隔）
// 与 MiniMaxImageClient 同款纪律：key 走 resolver 绝不打印；错误体白名单过滤；
// 轮询**不设硬超时**（feedback_no_model_timeout，生成时长不可预测），调用方可传 abortSignal 主动停。
// 音乐生成 API 本轮未核实到一手文档形状，按「禁假数据」不写猜测实现（见 docs 选型评估）。

import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';

// 默认国内站（与 chat/image 实测一致）；国际账号用 env 覆盖到 https://api.minimaxi.com/v1
const DEFAULT_BASE = 'https://api.minimax.chat/v1';

function pickError(data) {
  const code = data?.base_resp?.status_code;
  if (code != null && code !== 0) {
    const err = new Error(`MiniMax 视频错误(${code}): ${data?.base_resp?.status_msg || 'unknown'}`);
    err.statusCode = code;
    return err;
  }
  return null;
}

export class MiniMaxVideoClient {
  constructor({
    apiKey,
    secretResolver = resolveNoeProviderSecret,
    model = process.env.NOE_VIDEO_MODEL || 'video-01',
    baseUrl = process.env.MINIMAX_VIDEO_BASE || DEFAULT_BASE,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 10_000,            // 官方建议 10s，减轻服务端压力
  } = {}) {
    const resolution = apiKey
      ? { ok: true, value: apiKey, source: 'caller', sourceRef: 'apiKey' }
      : secretResolver('minimax');
    this.apiKey = resolution?.value || '';
    this.secretStatus = {
      ok: !!resolution?.ok,
      source: resolution?.source || 'unconfigured',
      message: resolution?.ok ? `MiniMax video key resolved from ${resolution.source}` : describeNoeProviderSecretFailure('minimax', resolution),
    };
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.pollIntervalMs = Math.max(1000, Number(pollIntervalMs) || 10_000);
  }

  configured() { return Boolean(this.apiKey); }

  #headers() { return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }; }

  /** ① 建任务：返回 { taskId }。 */
  async createTask(prompt, opts = {}) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const clean = String(prompt || '').trim().slice(0, 2000);
    if (!clean) throw new Error('视频 prompt 为空');
    const body = { model: opts.model || this.model, prompt: clean };
    if (opts.firstFrameImage) body.first_frame_image = opts.firstFrameImage;   // image-to-video 模式
    const resp = await this.fetchImpl(`${this.baseUrl}/video_generation`, {
      method: 'POST', headers: this.#headers(), body: JSON.stringify(body),
    });
    const data = typeof resp?.json === 'function' ? await resp.json().catch(() => ({})) : resp;
    const err = pickError(data);
    if (err) throw err;
    const taskId = data?.task_id;
    if (!taskId) throw new Error('MiniMax 视频未返回 task_id');
    return { taskId, raw: data };
  }

  /** ② 查任务：返回 { status:'pending'|'success'|'fail', fileId, raw }。 */
  async queryTask(taskId) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const id = String(taskId || '').trim();
    if (!id) throw new Error('task_id 为空');
    const resp = await this.fetchImpl(`${this.baseUrl}/query/video_generation?task_id=${encodeURIComponent(id)}`, {
      method: 'GET', headers: this.#headers(),
    });
    const data = typeof resp?.json === 'function' ? await resp.json().catch(() => ({})) : resp;
    const err = pickError(data);
    if (err) throw err;
    const s = String(data?.status || '').toLowerCase();
    const status = s === 'success' ? 'success' : (s === 'fail' || s === 'failed' ? 'fail' : 'pending');
    return { status, fileId: data?.file_id || null, raw: data };
  }

  /** ③ 取文件下载地址（同官方视频指南步骤③：success 后用 file_id 换 download_url，url 有时效需当场下载）。 */
  async retrieveFile(fileId) {
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY 未配置');
    const id = String(fileId || '').trim();
    if (!id) throw new Error('file_id 为空');
    const resp = await this.fetchImpl(`${this.baseUrl}/files/retrieve?file_id=${encodeURIComponent(id)}`, {
      method: 'GET', headers: this.#headers(),
    });
    const data = typeof resp?.json === 'function' ? await resp.json().catch(() => ({})) : resp;
    const err = pickError(data);
    if (err) throw err;
    const downloadUrl = data?.file?.download_url || null;
    if (!downloadUrl) throw new Error('MiniMax 文件无 download_url 返回');
    return { downloadUrl, raw: data };
  }

  /**
   * 建任务并轮询到终态。不设硬超时（时长不可预测）；可传 opts.abortSignal 主动停，
   * opts.onProgress(每轮查询结果) 观察进度。
   * @returns {Promise<{taskId, fileId}>}
   */
  async generateAndWait(prompt, opts = {}) {
    const { taskId } = await this.createTask(prompt, opts);
    for (;;) {
      if (opts.abortSignal?.aborted) { const e = new Error('视频生成被调用方中止'); e.name = 'AbortError'; throw e; }
      const q = await this.queryTask(taskId);
      opts.onProgress?.(q);
      if (q.status === 'success') return { taskId, fileId: q.fileId };
      if (q.status === 'fail') throw new Error(`MiniMax 视频任务失败(task ${taskId})`);
      await this.sleep(opts.pollIntervalMs || this.pollIntervalMs);
    }
  }
}
