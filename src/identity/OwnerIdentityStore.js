import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { computeVoiceEmbedding, cosine, normalizeVector, scoreVoiceEmbedding } from './Voiceprint.js';
import { defaultCampPlusVoiceClient } from './CampPlusVoiceClient.js';
import { defaultIdentityModelSettingsStore } from './IdentityModelSettingsStore.js';
import { preprocessVoiceWav, analyzeVoiceActivity } from './VoiceVad.js';

const DIR = join(homedir(), '.noe-panel');
const FILE = join(DIR, 'owner-identity.json');
const FACE_READY_SAMPLES = 1;
const VOICE_READY_SAMPLES = 3;
const VOICE_DEFAULT_THRESHOLD = 0.78;        // lite 引擎阈值
const VOICE_CAMPP_THRESHOLD = 0.72;          // CAMPPlus(缩放到[0,1]后)阈值
const CAMPP_ENGINE = 'campplus';
const LITE_ENGINE = 'voice-lite';

function cleanName(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || `sample-${Date.now()}`;
}

function cleanOwnerPersonId(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,80}$/.test(s) ? s : '';
}

function cleanSamples(rows = [], max = 128) {
  return rows.filter((row) => Array.isArray(row.embedding) && row.embedding.length)
    .map((row) => {
      const out = { id: String(row.id || `voice-${Date.now()}`), name: cleanName(row.name), createdAt: row.createdAt || new Date().toISOString(), engine: row.engine === CAMPP_ENGINE ? CAMPP_ENGINE : LITE_ENGINE, embedding: row.embedding.map(Number).filter(Number.isFinite).slice(0, max) };
      // campplus 样本附带的 lite 兜底向量:CAMPPlus 日后不可用时仍能比对,绝不把主人锁外。
      if (out.engine === CAMPP_ENGINE && Array.isArray(row.liteEmbedding) && row.liteEmbedding.length) {
        const lite = row.liteEmbedding.map(Number).filter(Number.isFinite).slice(0, max);
        if (lite.length) out.liteEmbedding = lite;
      }
      return out;
    })
    .filter((row) => row.embedding.length);
}

function cleanEmbeddingVector(value) {
  if (!Array.isArray(value)) throw new Error('embedding array required');
  const vec = value.map(Number).filter(Number.isFinite).slice(0, 512);
  if (vec.length < 8) throw new Error('embedding too short');
  return normalizeVector(vec);
}

export class OwnerIdentityStore {
  constructor({ file = FILE, voiceEngine = defaultCampPlusVoiceClient, modelSettings = null, camppThreshold = VOICE_CAMPP_THRESHOLD } = {}) {
    this.file = file;
    // CAMPPlus 深度说话人模型(对噪声/别人声鲁棒);失败自动回退 lite。注入式,测试可传假引擎。
    this.voiceEngine = voiceEngine;
    // 引擎选择器:与 PersonKnowledgeStore 共用同一份设置(默认 campplus,用户可切 voice-lite)。
    this.modelSettings = modelSettings;
    this.camppThreshold = Math.min(0.99, Math.max(0.5, Number(camppThreshold) || VOICE_CAMPP_THRESHOLD));
    this.state = { voice: { enabled: false, threshold: VOICE_DEFAULT_THRESHOLD, camppThreshold: this.camppThreshold, samples: [], ownerPersonId: '' }, face: { enabled: false, threshold: 0.55, samples: [], ownerPersonId: '' } };
    this.lastVoice = null;
    this.lastFace = null;
    this._load();
  }

  _ensureDir() { const dir = this.file.slice(0, this.file.lastIndexOf('/')); if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  _backup() { if (existsSync(this.file)) { try { copyFileSync(this.file, `${this.file}.bak-latest`); chmodSync(`${this.file}.bak-latest`, 0o600); } catch {} } }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8'));
      this.state.voice = {
        enabled: data?.voice?.enabled === true,
        threshold: Math.min(0.99, Math.max(0.5, Number(data?.voice?.threshold) || VOICE_DEFAULT_THRESHOLD)),
        camppThreshold: Math.min(0.99, Math.max(0.5, Number(data?.voice?.camppThreshold) || this.camppThreshold)),
        samples: cleanSamples(data?.voice?.samples, 128),
        ownerPersonId: cleanOwnerPersonId(data?.voice?.ownerPersonId),
      };
      this.state.face = {
        enabled: data?.face?.enabled === true,
        threshold: Math.min(0.99, Math.max(0.35, Number(data?.face?.threshold) || 0.55)),
        samples: cleanSamples(data?.face?.samples, 512),
        ownerPersonId: cleanOwnerPersonId(data?.face?.ownerPersonId),
      };
    } catch (e) {
      try { copyFileSync(this.file, `${this.file}.corrupted-${Date.now()}.bak`); } catch {}
      console.warn('[owner-identity] load failed:', e.message);
    }
  }

  _save() {
    this._ensureDir();
    this._backup();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.state }, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.file);
  }

  status() {
    const engine = this._effectiveEngine();
    return {
      // engine=当前生效声纹引擎;activeThreshold=该引擎实际判定阈值(滑块对应它)。
      voice: { enabled: this.state.voice.enabled, engine, threshold: this.state.voice.threshold, camppThreshold: this.state.voice.camppThreshold, activeThreshold: engine === CAMPP_ENGINE ? this.state.voice.camppThreshold : this.state.voice.threshold, samples: this.state.voice.samples.length, ready: this.state.voice.samples.length >= VOICE_READY_SAMPLES, ownerPersonId: this.state.voice.ownerPersonId, lastVerification: this.lastVoice },
      face: { enabled: this.state.face.enabled, threshold: this.state.face.threshold, samples: this.state.face.samples.length, ready: this.state.face.samples.length >= FACE_READY_SAMPLES, ownerPersonId: this.state.face.ownerPersonId, lastVerification: this.lastFace },
    };
  }

  sampleSnapshot() {
    const copy = (rows = []) => rows.map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt, embedding: [...(s.embedding || [])] }));
    return { voice: copy(this.state.voice.samples), face: copy(this.state.face.samples) };
  }

  updateVoiceConfig(input = {}) {
    this.state.voice.enabled = input.enabled === true;
    const clamp = (v, d) => Math.min(0.99, Math.max(0.5, Number(v) || d));
    // 通用阈值滑块作用于"当前生效引擎",用户调一个滑块即对实际门禁生效。
    if (input.threshold !== undefined) {
      if (this._effectiveEngine() === CAMPP_ENGINE) this.state.voice.camppThreshold = clamp(input.threshold, this.state.voice.camppThreshold);
      else this.state.voice.threshold = clamp(input.threshold, this.state.voice.threshold);
    }
    // 也支持分别精调(可选)。
    if (input.camppThreshold !== undefined) this.state.voice.camppThreshold = clamp(input.camppThreshold, this.state.voice.camppThreshold);
    if (input.liteThreshold !== undefined) this.state.voice.threshold = clamp(input.liteThreshold, this.state.voice.threshold);
    this._save();
    return this.status().voice;
  }

  updateFaceConfig(input = {}) {
    this.state.face.enabled = input.enabled === true;
    if (input.threshold !== undefined) this.state.face.threshold = Math.min(0.99, Math.max(0.35, Number(input.threshold) || this.state.face.threshold));
    this._save();
    return this.status().face;
  }

  // 是否优先用 CAMPPlus:跟随 IdentityModelSettingsStore 设置(默认 campplus,与人物识别一致);
  // 未注入设置时默认 true。用户在设置里切到 voice-lite 即对主人门禁同样生效。
  _preferCampp() {
    if (!this.modelSettings?.voiceEngine) return true;
    try { return this.modelSettings.voiceEngine() !== LITE_ENGINE; } catch { return true; }
  }

  // 实际生效引擎:即便设置偏好 campplus,若已录样本全是旧 lite(未重录)则验证仍走 lite。
  // status 显示与阈值滑块路由都以此为准,如实反映"现在到底在用哪个引擎"。
  _effectiveEngine() {
    if (!this._preferCampp()) return LITE_ENGINE;
    const samples = this.state.voice.samples;
    const onlyLite = samples.length > 0 && samples.every((s) => (s.engine || LITE_ENGINE) === LITE_ENGINE);
    return onlyLite ? LITE_ENGINE : CAMPP_ENGINE;
  }

  // 在"已预处理"的 buf 上取嵌入:优先 CAMPPlus 深度说话人模型(对噪声/别人声鲁棒),
  // 失败回退 lite 手工特征。调用方负责先做一次 preprocessVoiceWav,保证同一条音频的
  // campplus 向量与 lite 兜底向量基准一致。
  async _embedFrom(buf) {
    if (this._preferCampp() && this.voiceEngine?.embedAudio) {
      try {
        const out = await this.voiceEngine.embedAudio(buf);
        const vec = Array.isArray(out?.embedding) ? out.embedding.map(Number).filter(Number.isFinite) : [];
        if (out?.ok !== false && vec.length >= 8) return { engine: CAMPP_ENGINE, embedding: normalizeVector(vec) };
      } catch { /* 回退 lite */ }
    }
    return { engine: LITE_ENGINE, embedding: computeVoiceEmbedding(buf) };
  }

  // VAD/降噪前处理(裁静音+去低频底噪,enroll/verify 同口径)+ 取嵌入。
  async _embedVoice(audioBuffer) {
    return this._embedFrom(preprocessVoiceWav(audioBuffer));
  }

  // CAMPPlus 余弦原始域是 [-1,1],缩放到 [0,1] 与阈值同尺度;lite 已在 [0,1]。
  _scaleScore(engine, raw) {
    return engine === CAMPP_ENGINE ? Math.max(0, Math.min(1, (Number(raw) + 1) / 2)) : Number(raw);
  }

  async enrollVoiceSample({ audioBuffer, name } = {}) {
    const buf = preprocessVoiceWav(audioBuffer);
    const primary = await this._embedFrom(buf);
    const sample = { id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: cleanName(name), createdAt: new Date().toISOString(), engine: primary.engine, embedding: primary.embedding };
    // CAMPPlus 主向量旁再存一份 lite 兜底(同一预处理 buf):即便日后 CAMPPlus 不可用,主人仍能被认出。
    if (primary.engine === CAMPP_ENGINE) {
      try { const lite = computeVoiceEmbedding(buf); if (Array.isArray(lite) && lite.length) sample.liteEmbedding = lite; } catch { /* 兜底向量可选 */ }
    }
    this.state.voice.samples.push(sample);
    this.state.voice.samples = this.state.voice.samples.slice(-12);
    this.lastVoice = null;
    this._save();
    return { sample: { id: sample.id, name: sample.name, createdAt: sample.createdAt, engine: primary.engine }, status: this.status().voice };
  }

  async verifyVoice(audioBuffer) {
    const all = this.state.voice.samples;
    if (!all.length) return { ok: false, enrolled: false, score: 0, threshold: this.state.voice.threshold };
    // 语音活动门禁：杂音/静音直接拒，不进声纹比对(防杂音被误判成主人)
    const vad = analyzeVoiceActivity(audioBuffer);
    if (!vad.ok && vad.reason !== 'vad_skipped') {
      const out = { ok: false, enrolled: true, score: 0, reason: 'no_speech', vad, threshold: this.state.voice.threshold, at: new Date().toISOString() };
      this.lastVoice = out;
      return out;
    }
    // 预处理一次,campplus 与 lite 兜底共用同一 buf(与 enroll 同口径)。
    const buf = preprocessVoiceWav(audioBuffer);
    // 没有任何 CAMPPlus 样本时不白跑深度模型(老用户重录前保持纯 lite,零延迟回归)。
    const hasCampp = all.some((s) => (s.engine || LITE_ENGINE) === CAMPP_ENGINE);
    const probe = hasCampp ? await this._embedFrom(buf) : { engine: LITE_ENGINE, embedding: computeVoiceEmbedding(buf) };
    let engine = probe.engine;
    let queryEmb = probe.embedding;
    let pool;
    if (engine === CAMPP_ENGINE) {
      pool = all.filter((s) => (s.engine || LITE_ENGINE) === CAMPP_ENGINE).map((s) => s.embedding);
    }
    // CAMPPlus 不可用 / 无 campplus 样本 → 退回 lite:campplus 样本取其 lite 兜底向量,绝不锁外。
    if (engine !== CAMPP_ENGINE || !pool.length) {
      engine = LITE_ENGINE;
      queryEmb = probe.engine === CAMPP_ENGINE ? computeVoiceEmbedding(buf) : probe.embedding;
      pool = all.map((s) => ((s.engine || LITE_ENGINE) === CAMPP_ENGINE ? s.liteEmbedding : s.embedding))
        .filter((v) => Array.isArray(v) && v.length);
    }
    if (!pool.length) return { ok: false, enrolled: false, score: 0, threshold: this.state.voice.threshold };
    const scored = scoreVoiceEmbedding(queryEmb, pool);
    // 保守判定:用 top-3 均值(比单一 best 抗噪/抗偶然撞脸),再按引擎缩放到 [0,1]。
    const score = this._scaleScore(engine, scored.topScore);
    const threshold = engine === CAMPP_ENGINE ? this.state.voice.camppThreshold : this.state.voice.threshold;
    const round = (v) => Math.round(this._scaleScore(engine, v) * 10000) / 10000;
    const out = {
      ok: score >= threshold,
      enrolled: true,
      engine,
      score: Math.round(score * 10000) / 10000,
      bestScore: round(scored.bestScore),
      topScore: round(scored.topScore),
      centroidScore: round(scored.centroidScore),
      sampleCount: scored.sampleCount,
      threshold,
      at: new Date().toISOString(),
    };
    this.lastVoice = out;
    return out;
  }

  shouldGateVoice() {
    return this.state.voice.enabled === true && (this.state.voice.samples.length >= 3 || !!this.state.voice.ownerPersonId);
  }

  clearVoice() {
    this.state.voice.samples = [];
    this.state.voice.enabled = false;
    this.state.voice.ownerPersonId = '';
    this.lastVoice = null;
    this._save();
    return this.status().voice;
  }

  bindVoicePerson(personId, { enabled } = {}) {
    this.state.voice.ownerPersonId = cleanOwnerPersonId(personId);
    if (typeof enabled === 'boolean') this.state.voice.enabled = enabled;
    this.lastVoice = null;
    this._save();
    return this.status().voice;
  }

  enrollFaceSample({ embedding, name } = {}) {
    const sample = { id: `face-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: cleanName(name), createdAt: new Date().toISOString(), embedding: cleanEmbeddingVector(embedding) };
    this.state.face.samples.push(sample);
    this.lastFace = null;
    this._save();
    return { sample: { id: sample.id, name: sample.name, createdAt: sample.createdAt }, status: this.status().face };
  }

  verifyFaceEmbedding(embedding) {
    const samples = this.state.face.samples;
    if (!samples.length) return { ok: false, enrolled: false, score: 0, threshold: this.state.face.threshold };
    const vec = cleanEmbeddingVector(embedding);
    const score = Math.max(...samples.map((s) => cosine(vec, s.embedding)));
    const out = { ok: score >= this.state.face.threshold, enrolled: true, score: Math.round(score * 10000) / 10000, threshold: this.state.face.threshold, at: new Date().toISOString() };
    this.lastFace = out;
    return out;
  }

  shouldGateFace() {
    return this.state.face.enabled === true && (this.state.face.samples.length >= FACE_READY_SAMPLES || !!this.state.face.ownerPersonId);
  }

  clearFace() {
    this.state.face.samples = [];
    this.state.face.enabled = false;
    this.state.face.ownerPersonId = '';
    this.lastFace = null;
    this._save();
    return this.status().face;
  }

  bindFacePerson(personId, { enabled } = {}) {
    this.state.face.ownerPersonId = cleanOwnerPersonId(personId);
    if (typeof enabled === 'boolean') this.state.face.enabled = enabled;
    this.lastFace = null;
    this._save();
    return this.status().face;
  }
}

export const defaultOwnerIdentityStore = new OwnerIdentityStore({ modelSettings: defaultIdentityModelSettingsStore });
