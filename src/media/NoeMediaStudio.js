// @ts-check
// NoeMediaStudio — MiniMax 三媒体 client（图像/音乐/视频）统一「生成→落盘」门面。
//
// P1 接线「MiniMaxImageClient 接出图能力」：三个 client 早已建成并验证，本文件负责把
// 生成产物当场下载落 ~/.noe-panel/media/<kind>/——MiniMax 返回的 url 有时效，存 url 等于丢件；
// 产物绝不放 ~/Desktop（feedback_no_desktop_output）。
// 注入式：client/fetch/baseDir/时钟全可注入 → 单测不真调 API、不烧额度。
// 生成与下载均不设硬超时（跑模型不设超时纪律）。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from 'undici';

const DEFAULT_BASE_DIR = join(homedir(), '.noe-panel', 'media');
const MAX_DOWNLOAD_BYTES = Object.freeze({
  image: 25 * 1024 * 1024,
  music: 50 * 1024 * 1024,
  video: 300 * 1024 * 1024,
});

// MiniMax 产物挂在阿里云国内 OSS（oss-cn-*.aliyuncs.com）。本机 Clash TUN/fake-ip 把
// aliyuncs.com 分流去海外节点 → 国内 OSS TLS 必断（2026-06-10 实测：API 层通、下载层
// "socket disconnected before secure TLS connection"，连 curl 直连都被 TUN 截获同样断）。
// 治本：图像走 response_format=base64 直返（见 image()，字节随 API 响应回来零下载）。
// 音乐/视频仍需下载：默认用无代理直连 dispatcher 至少绕开 env 代理（无 TUN 环境下即治本；
// TUN 环境若仍断，报错由调用方看到，需 owner 在 Clash 给 aliyuncs.com 加直连规则）。
// NOE_MEDIA_DOWNLOAD_VIA_PROXY=1 恢复走全局 dispatcher（海外部署场景）。
function defaultDownloadDispatcher() {
  return process.env.NOE_MEDIA_DOWNLOAD_VIA_PROXY === '1' ? null : new Agent();
}

/**
 * 落盘文件名 slug：<紧凑时间戳>-<prompt 头部清洗>。只留汉字/英数（其余折叠成 _），
 * 防路径注入与非法文件名；纯函数可单测。
 * @param {string} prompt
 * @param {number} [ts]
 */
export function mediaFileSlug(prompt, ts = Date.now()) {
  const head = String(prompt || '').trim().slice(0, 24)
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const stamp = new Date(ts).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return head ? `${stamp}-${head}` : stamp;
}

export class NoeMediaStudio {
  constructor({
    imageClient = null,
    videoClient = null,
    musicClient = null,
    baseDir = DEFAULT_BASE_DIR,
    fetchImpl = fetch,
    downloadDispatcher = defaultDownloadDispatcher(),
    now = Date.now,
  } = {}) {
    this.imageClient = imageClient;
    this.videoClient = videoClient;
    this.musicClient = musicClient;
    this.baseDir = baseDir;
    this.fetchImpl = fetchImpl;
    this.downloadDispatcher = downloadDispatcher;
    this.now = now;
  }

  /** 任一 client 有 key 即视为可用（三 client 共用 minimax key，正常要么全有要么全无）。 */
  configured() {
    return Boolean(
      this.imageClient?.configured?.()
      || this.videoClient?.configured?.()
      || this.musicClient?.configured?.(),
    );
  }

  #dirFor(kind) {
    const dir = join(this.baseDir, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async #download(url, kind = 'media') {
    // 不设硬超时；dispatcher 见文件头注释（绕全局代理直连国内 OSS）
    const resp = await this.fetchImpl(url, this.downloadDispatcher ? { dispatcher: this.downloadDispatcher } : {});
    if (!resp?.ok) throw new Error(`媒体下载失败(HTTP ${resp?.status || '??'})`);
    const maxBytes = MAX_DOWNLOAD_BYTES[kind] || MAX_DOWNLOAD_BYTES.video;
    const len = Number(resp.headers?.get?.('content-length') || 0);
    if (Number.isFinite(len) && len > maxBytes) throw new Error(`媒体下载过大(${len} > ${maxBytes})`);
    let bytes;
    if (resp.body?.getReader) {
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error(`媒体下载过大(${total} > ${maxBytes})`);
        }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, total);
    } else {
      bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`媒体下载过大(${bytes.length} > ${maxBytes})`);
    }
    // 国内 OSS TLS 可能在 200 后中途断流 → arrayBuffer 拿到 0 字节/截断；音视频图不可能 0 字节，
    // 落盘坏件比明确报错更难排查，故宁可 throw 让调用方重试。
    if (bytes.length === 0) throw new Error('媒体下载为空（0 字节，疑似传输中断）');
    return bytes;
  }

  // 防覆盖落盘：同名已存在则在扩展名前自增 -2/-3…，保住每件产物（slug 精度到秒，同秒同 prompt 会撞名）。
  #write(kind, name, bytes) {
    const dir = this.#dirFor(kind);
    let file = join(dir, name);
    if (existsSync(file)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      do { file = join(dir, `${stem}-${n}${ext}`); n += 1; } while (existsSync(file));
    }
    writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  }

  /**
   * 文生图：生成 → 逐张落盘。
   * @param {string} prompt
   * @param {object} [opts] 透传 MiniMaxImageClient.generate：{aspectRatio, n, promptOptimizer}
   * @returns {Promise<{ok:true, kind:'image', files:string[], id:string|null}>}
   */
  async image(prompt, opts = {}) {
    if (!this.imageClient) throw new Error('图像 client 未注入');
    // 默认 base64 直返：字节随 API 响应回来，绕开国内 OSS 下载（见文件头注释）；传 responseFormat:'url' 可覆盖。
    const { images, id } = await this.imageClient.generate(prompt, { responseFormat: 'base64', ...opts });
    const slug = mediaFileSlug(prompt, this.now());
    const files = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const bytes = img.base64 ? Buffer.from(img.base64, 'base64') : await this.#download(img.url, 'image');
      files.push(this.#write('images', `${slug}-${i + 1}.png`, bytes));
    }
    return { ok: true, kind: 'image', files, id: id || null };
  }

  /**
   * 文生音乐（同步接口，分钟级）。
   * @param {string} prompt
   * @param {object} [opts] 透传 MiniMaxMusicClient.generate：{lyrics, instrumental, lyricsOptimizer, outputFormat}
   * @returns {Promise<{ok:true, kind:'music', files:string[]}>}
   */
  async music(prompt, opts = {}) {
    if (!this.musicClient) throw new Error('音乐 client 未注入');
    const { audioUrl, audioBase64 } = await this.musicClient.generate(prompt, opts);
    const bytes = audioBase64 ? Buffer.from(audioBase64, 'base64') : await this.#download(audioUrl, 'music');
    const ext = opts.outputFormat === 'wav' ? 'wav' : 'mp3';
    const file = this.#write('music', `${mediaFileSlug(prompt, this.now())}.${ext}`, bytes);
    return { ok: true, kind: 'music', files: [file] };
  }

  /**
   * 文生视频①：提交异步任务（之后用 videoPoll 轮询取片）。
   * @param {string} prompt
   * @param {object} [opts] 透传 MiniMaxVideoClient.createTask：{firstFrameImage, model}
   * @returns {Promise<{ok:true, taskId:string}>}
   */
  async videoCreate(prompt, opts = {}) {
    if (!this.videoClient) throw new Error('视频 client 未注入');
    const { taskId } = await this.videoClient.createTask(prompt, opts);
    return { ok: true, taskId };
  }

  /**
   * 文生视频②：查任务状态；success 时自动 file_id→download_url 并落盘。
   * @param {string} taskId
   * @returns {Promise<{ok:boolean, status:'pending'|'success'|'fail', taskId:string, files?:string[]}>}
   */
  async videoPoll(taskId) {
    if (!this.videoClient) throw new Error('视频 client 未注入');
    const q = await this.videoClient.queryTask(taskId);
    if (q.status !== 'success') return { ok: q.status !== 'fail', status: q.status, taskId };
    // success 但缺 file_id：语义异常，明确返回失败而非把 null 喂进 retrieveFile 抛"file_id 为空"误导调用方
    if (!q.fileId) return { ok: false, status: 'fail', taskId, reason: 'success 但无 file_id' };
    const { downloadUrl } = await this.videoClient.retrieveFile(q.fileId);
    // 文件名用完整 taskId（已天然唯一、仅做文件名安全清洗，不走 prompt slug 通道——那会截断削弱唯一性）
    const safeTask = String(taskId).replace(/[^\w-]/g, '_').slice(0, 80);
    const file = this.#write('videos', `${mediaFileSlug('', this.now())}-${safeTask}.mp4`, await this.#download(downloadUrl, 'video'));
    return { ok: true, status: 'success', taskId, files: [file] };
  }
}
