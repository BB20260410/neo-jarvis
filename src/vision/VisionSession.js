// VisionSession — 视觉感知编排：截屏 → 变化检测（省算力）→ 本地 VLM 看懂 → 摘要沉淀进记忆
// 全本地零 token；截图只在本地处理、不外发。给"主动交互"提供"用户在干什么"的实时上下文。
import crypto from 'node:crypto';
import { ScreenCapturer } from './ScreenCapturer.js';
import { LocalVlmClient } from './LocalVlmClient.js';
import { OcrClient } from './OcrClient.js';
import { recognizeFaceFromImage, describeRecognizedPerson } from './FaceRecognition.js';
import { classifyNoeVisionSituation } from './NoeVisionSituation.js';

const DEFAULT_PROMPT = '用一两句话描述这张截图里用户大概在做什么类型的事（看视频/写代码/聊天/阅读等）和状态。简短自然，中文，不要点名具体应用或软件的名称，不要罗列细节。';
// 摄像头模式：描述镜头里的人（用于"看着你主动搭话"），关注表情/状态/动作而非屏幕内容
const CAMERA_PROMPT = '用一两句话描述这张摄像头画面里的人现在的状态：表情、情绪、在做什么、看起来累不累/专注不专注。简短自然，中文，只说看得到的，不要编造。';
// 双模式：第一张屏幕 + 第二张摄像头，综合理解"在屏幕上干嘛 + 人的状态"
const BOTH_PROMPT = '下面第一张是用户的电脑屏幕、第二张是摄像头里的用户本人。综合两张：用一两句话说用户在做什么类型的活动，以及此刻人的表情/状态（累不累、专注不专注）。简短自然，中文，只说看得到的，不要编造，不要点名具体应用或软件的名称。';
const ATTACHMENT_PROMPT = '这是用户添加到对话里的图片附件。用一两句话客观描述图片里可见内容和可能有用的信息。中文，只说看得到的，不要编造。';
const VISION_MODES = new Set(['screen', 'camera', 'both', 'off']);

function clampMs(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export class VisionSession {
  constructor({ capturer, vlmClient, ocrClient = null, memory = null, projectId = 'noe', mode = 'off', faceEngine = null, personStore = null, personCards = null, faceRecog = 'ask' } = {}) {
    this.capturer = capturer || new ScreenCapturer();
    this.vlm = vlmClient || new LocalVlmClient();
    this.ocrClient = ocrClient || new OcrClient(); // 卡③：屏幕读字（RapidOCR），runtime 未装时 ocr() 明确报错不影响其他能力
    this.memory = memory;
    this.projectId = projectId;
    this.mode = ['screen', 'camera', 'both', 'off'].includes(mode) ? mode : 'off'; // off=默认不看(不加载VLM省内存) / screen=截屏 / camera=摄像头帧 / both=屏幕+摄像头
    // 人脸认人("这是谁")：off=不认 / ask=问"这是谁"才认 / auto=预留(当前等同 ask；空闲自动认人主动报待接主动陪伴 tick)。复用 InsightFace + identifyFace(1:N)。
    this.faceEngine = faceEngine;     // 注入便于测试;为空走 recognizeFaceFromImage 默认(InsightFace)
    this.personStore = personStore;   // 为空走默认 PersonKnowledgeStore
    this.personCards = personCards;   // 可选:话术补充偏好/事件
    this.faceRecog = ['off', 'ask', 'auto'].includes(faceRecog) ? faceRecog : 'ask';
    this._cameraFrame = null;     // 摄像头模式：前端最近推来的帧 Buffer
    this._cameraFormat = 'jpeg';
    this._cameraAt = null;
    this.lastFrameHash = null;
    this.lastSummary = null;
    this.lastAt = null;
    this.lastMode = null;
    this.lastSituation = null;
    this.lastAmbientSampleAt = null;
    this.lastAmbientResult = null;
    this.lastAmbientError = null;
    this._inflight = null;
    this.ambient = {
      enabled: this.mode !== 'off',
      mode: this.mode,
      screenSampleMs: 10_000,
      cameraFrameMs: 4_000,
      source: 'initial',
      updatedAt: Date.now(),
    };
  }

  /** 切换视觉源：'screen' 看屏幕 / 'camera' 看摄像头 / 'both' 屏幕+摄像头同时（摄像头帧由前端 pushFrame 推送）。 */
  setMode(m, { source = 'mode' } = {}) {
    this.mode = VISION_MODES.has(m) ? m : 'off';
    this.lastFrameHash = null;
    this.lastAmbientSampleAt = null;
    this.lastAmbientResult = null;
    this.lastAmbientError = null;
    this.ambient = { ...this.ambient, enabled: this.mode !== 'off', mode: this.mode, source, updatedAt: Date.now() };
    if (this.mode === 'off') {
      this.lastSummary = null;
      this.lastAt = null;
      this.lastMode = null;
      this.lastSituation = null;
      this._cameraFrame = null;
      this._cameraFormat = 'jpeg';
      this._cameraAt = null;
      this.vlm?.unload?.().catch(() => {});
    }
    return this.mode;
  }

  /**
   * 配置持续视觉感知。它只改变开关/节奏状态，不绕过浏览器摄像头授权，也不会主动保存原始帧。
   * 摄像头仍必须由前端 getUserMedia 成功后通过 pushFrame 推送最近一帧。
   */
  configureAmbient({ enabled = true, mode = '', screenSampleMs, cameraFrameMs, source = 'ambient' } = {}) {
    const nextMode = enabled === false ? 'off' : (VISION_MODES.has(mode) && mode !== 'off' ? mode : (this.mode === 'off' ? 'screen' : this.mode));
    this.ambient = {
      ...this.ambient,
      screenSampleMs: clampMs(screenSampleMs, this.ambient.screenSampleMs, 5_000, 120_000),
      cameraFrameMs: clampMs(cameraFrameMs, this.ambient.cameraFrameMs, 1_000, 60_000),
      source,
      updatedAt: Date.now(),
    };
    this.setMode(nextMode, { source });
    return this.ambientStatus();
  }

  /** 摄像头模式：接收前端推来的一帧（已解码的 Buffer）。仅缓存最近帧，VLM 在 glance 时才跑。 */
  pushFrame(buf, format = 'jpeg') { if (buf && buf.length) { this._cameraFrame = buf; this._cameraFormat = format || 'jpeg'; this._cameraAt = Date.now(); } }

  /** 最近一帧摄像头画面（给认人用）；视觉关闭(off)或无帧时返回 null —— 关了就一律认不了人。 */
  getCameraFrame() { return (this.mode !== 'off' && this._cameraFrame) ? { buffer: this._cameraFrame, format: this._cameraFormat } : null; }

  /** 切换认人模式：'off' 不认 / 'ask' 问"这是谁"才认 / 'auto' 预留(当前等同 ask；空闲自动认人主动报待接主动陪伴 tick)。 */
  setFaceRecog(m) { this.faceRecog = ['off', 'ask', 'auto'].includes(m) ? m : this.faceRecog; return this.faceRecog; }

  /**
   * "这是谁"：用最近摄像头帧 → InsightFace 提脸 → identifyFace 1:N 搜 → 命中取人物卡组织话术 / 没命中引导录入。
   * @returns {Promise<{ok, recognized?, person?, score?, reason?, say }>}  say=可直接 TTS 的中文
   */
  async recognizeWho({ faceEngine, personStore, personCards, threshold } = {}) {
    const frame = this.getCameraFrame();
    if (!frame) return { ok: false, reason: 'no_camera_frame', say: '我现在没拿到摄像头画面，先帮我打开摄像头看一下。' };
    const r = await recognizeFaceFromImage({
      imageBuffer: frame.buffer,
      faceEngine: faceEngine || this.faceEngine || undefined,
      personStore: personStore || this.personStore || undefined,
      threshold,
    });
    return { ...r, say: describeRecognizedPerson(r, { personCards: personCards || this.personCards }) };
  }

  async describeAttachment(buf, opts = {}) {
    if (!buf || !buf.length) return { summary: '', at: null, skipped: 'empty_attachment' };
    const format = opts.format === 'png' ? 'png' : 'jpeg';
    const prompt = opts.prompt || ATTACHMENT_PROMPT;
    let summary = this.vlm.describeImages
      ? await this.vlm.describeImages([{ buffer: buf, format }], prompt)
      : await this.vlm.describe(buf, prompt, { format });
    summary = String(summary || '').replace(/\bN[eo]{2}\w*\s*(应用|程序|软件|app|界面)?/gi, '电脑');
    this.lastSummary = `${opts.name ? `用户添加图片「${opts.name}」：` : '用户添加图片附件：'}${summary}`;
    this.lastAt = Date.now();
    this.lastMode = 'attachment';
    const situation = this._updateSituation({ summary: this.lastSummary, at: this.lastAt, mode: this.lastMode });
    try {
      this.memory?.write?.({ id: `vision-latest:${this.projectId}`, projectId: this.projectId, scope: 'vision', sourceType: 'attachment', body: this.lastSummary, tags: ['vision', 'attachment'], confidence: 0.6 });
    } catch { /* 记忆失败不阻断 */ }
    return { summary: this.lastSummary, at: this.lastAt, mode: 'attachment', situation };
  }

  /**
   * 看一眼屏幕：截图 → 变化检测 → VLM 描述 → 沉淀记忆。
   * @param {object} [opts] {prompt, force} force=true 时即使画面没变也重新分析
   * @returns {Promise<{summary, at, skipped?}>}
   */
  async glance(opts = {}) {
    // 并发重入保护：已有进行中的 glance 直接复用它，避免并发截屏/VLM 风暴 + lastFrameHash 状态错乱
    if (this._inflight) {
      try { return await this._inflight; } catch { /* 上一次失败则往下自己重跑一次 */ }
    }
    this._inflight = this._doGlance(opts);
    try { return await this._inflight; }
    finally { this._inflight = null; }
  }

  async _doGlance(opts = {}) {
    if (this.mode === 'off') return { summary: '', at: null, mode: 'off', skipped: 'vision_off' }; // 视觉关闭：不截屏不看摄像头
    // 按模式取帧：camera=摄像头帧 / both=屏幕+摄像头一起喂 VLM 综合理解 / screen=截屏
    const images = [];
    let prompt = opts.prompt;
    let modeUsed = this.mode;
    if (this.mode === 'camera' && this._cameraFrame) {
      images.push({ buffer: this._cameraFrame, format: this._cameraFormat });
      prompt = prompt || CAMERA_PROMPT;
    } else if (this.mode === 'camera') {
      const summary = this.lastMode === 'camera' ? this.lastSummary : '';
      return { summary: summary || '', at: summary ? this.lastAt : null, mode: 'camera', skipped: 'no_camera_frame', situation: summary ? this.situation() : null };
    } else if (this.mode === 'both') {
      images.push({ buffer: await this.capturer.capture(), format: 'png' });
      if (this._cameraFrame) images.push({ buffer: this._cameraFrame, format: this._cameraFormat });
      modeUsed = images.length > 1 ? 'both' : 'screen';
      prompt = prompt || (images.length > 1 ? BOTH_PROMPT : DEFAULT_PROMPT); // 摄像头帧还没到则降级只看屏幕
    } else {
      images.push({ buffer: await this.capturer.capture(), format: 'png' });
      prompt = prompt || DEFAULT_PROMPT;
      modeUsed = 'screen';
    }
    // 变化检测：所有帧拼一起 hash，任一变化就重新分析（静止画面省算力）
    const hash = crypto.createHash('md5').update(Buffer.concat(images.map((i) => Buffer.from(i.buffer)))).digest('hex');
    if (!opts.force && hash === this.lastFrameHash && this.lastSummary) {
      return { summary: this.lastSummary, at: this.lastAt, mode: this.lastMode || modeUsed, skipped: 'no_change', situation: this.situation() };
    }
    this.lastFrameHash = hash;
    // 优先多图 describeImages(支持 both 双图)；兼容只实现 describe 的注入(退化为单图)
    let summary = this.vlm.describeImages
      ? await this.vlm.describeImages(images, prompt)
      : await this.vlm.describe(images[0].buffer, prompt, { format: images[0].format });
    // 摘要消毒：抹掉 VLM 误报的程序名（Noe/Noo/Neo 等变体），避免污染对话让大脑误以为自己叫 Noe
    summary = String(summary || '').replace(/\bN[eo]{2}\w*\s*(应用|程序|软件|app|界面)?/gi, '电脑');
    this.lastSummary = summary;
    this.lastAt = Date.now();
    this.lastMode = modeUsed;
    const situation = this._updateSituation({ summary, at: this.lastAt, mode: modeUsed });
    try {
      // 用稳定 id 去重更新最近一条视觉摘要；sourceType 按模式区分(screen/camera/both)
      this.memory?.write?.({ id: `vision-latest:${this.projectId}`, projectId: this.projectId, scope: 'vision', sourceType: modeUsed, body: summary, tags: ['vision', modeUsed], confidence: 0.5 });
    } catch { /* 记忆失败不阻断 */ }
    return { summary, at: this.lastAt, mode: modeUsed, situation };
  }

  /** 最近一次看到的内容（给 NoeLoop 主动交互用，不重新截屏） */
  latest(now = Date.now()) {
    return this.lastSummary ? { summary: this.lastSummary, at: this.lastAt, mode: this.lastMode, situation: this.situation(now) } : null;
  }

  ambientSampleIntervalMs() {
    return this.mode === 'camera' ? this.ambient.cameraFrameMs : this.ambient.screenSampleMs;
  }

  nextAmbientSampleAt(now = Date.now()) {
    if (this.mode === 'off') return null;
    return this.lastAmbientSampleAt ? this.lastAmbientSampleAt + this.ambientSampleIntervalMs() : now;
  }

  ambientDue(now = Date.now()) {
    if (this.mode === 'off') return false;
    const next = this.nextAmbientSampleAt(now);
    return next === null ? false : now >= next;
  }

  /**
   * 后台视觉节流采样：只在配置节奏到点时触发 glance，避免心跳/主动 tick 每次都跑截屏+VLM。
   * 不保存原始帧，只保存上次采样结果、跳过原因和下次采样时间，供 runtime/status 审计。
   */
  async ambientTick({ force = false, now = Date.now(), prompt } = {}) {
    if (this.mode === 'off') {
      return { sampled: false, skipped: 'vision_off', lastSampleAt: this.lastAmbientSampleAt, nextSampleAt: null, latest: null };
    }
    const nextSampleAt = this.nextAmbientSampleAt(now);
    if (!force && nextSampleAt !== null && now < nextSampleAt) {
      return {
        sampled: false,
        skipped: 'ambient_not_due',
        lastSampleAt: this.lastAmbientSampleAt,
        nextSampleAt,
        latest: this.latest(now),
      };
    }

    try {
      const result = await this.glance({ force, prompt });
      this.lastAmbientSampleAt = now;
      this.lastAmbientResult = { at: now, sampled: true, result };
      this.lastAmbientError = null;
      return {
        sampled: true,
        result,
        lastSampleAt: this.lastAmbientSampleAt,
        nextSampleAt: this.nextAmbientSampleAt(now),
        latest: this.latest(now),
      };
    } catch (e) {
      this.lastAmbientSampleAt = now;
      this.lastAmbientError = { at: now, message: String(e?.message || e).slice(0, 300) };
      this.lastAmbientResult = { at: now, sampled: false, skipped: 'ambient_error' };
      return {
        sampled: false,
        skipped: 'ambient_error',
        error: this.lastAmbientError.message,
        lastSampleAt: this.lastAmbientSampleAt,
        nextSampleAt: this.nextAmbientSampleAt(now),
        latest: this.latest(now),
      };
    }
  }

  situation(now = Date.now()) {
    if (!this.lastSummary) return null;
    return this._updateSituation({ summary: this.lastSummary, at: this.lastAt, mode: this.lastMode, now });
  }

  _updateSituation({ summary, at, mode, now = Date.now() } = {}) {
    this.lastSituation = classifyNoeVisionSituation({ summary, at, mode, now });
    return this.lastSituation;
  }

  ambientStatus(now = Date.now()) {
    const latest = this.latest(now);
    const nextAmbientSampleAt = this.nextAmbientSampleAt(now);
    return {
      enabled: this.mode !== 'off',
      mode: this.mode,
      localOnly: true,
      screenCaptureAvailable: true,
      requiresCameraFramePush: this.mode === 'camera' || this.mode === 'both',
      cameraFrameReady: Boolean(this._cameraFrame && this.mode !== 'off'),
      cameraFrameAgeMs: this._cameraAt ? Math.max(0, now - this._cameraAt) : null,
      screenSampleMs: this.ambient.screenSampleMs,
      cameraFrameMs: this.ambient.cameraFrameMs,
      sampleIntervalMs: this.mode === 'off' ? null : this.ambientSampleIntervalMs(),
      ambientDue: this.ambientDue(now),
      lastAmbientSampleAt: this.lastAmbientSampleAt,
      nextAmbientSampleAt,
      lastAmbientSkipped: this.lastAmbientResult?.result?.skipped || this.lastAmbientResult?.skipped || null,
      lastAmbientError: this.lastAmbientError,
      source: this.ambient.source,
      updatedAt: this.ambient.updatedAt,
      latest,
      situation: latest?.situation || null,
    };
  }

  /**
   * 屏幕读字（卡③）：截当前屏（或用传入图）→ RapidOCR 逐行精确识别。
   * 与 glance 的 VLM 语义理解互补：问"屏幕上具体写了什么字/哪个路径/什么报错"用这个。
   * @param {object} [opts] {image?: Buffer|string 不传则现截屏}
   * @returns {Promise<{ok: true, text, lines, count, source}>}
   */
  async ocr(opts = {}) {
    if (!this.ocrClient?.recognize) throw new Error('OCR 未配置');
    const image = opts.image || await this.capturer.capture();
    const r = await this.ocrClient.recognize(image);
    return { ...r, source: opts.image ? 'attachment' : 'screen' };
  }
}
