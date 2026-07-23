import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { computeVoiceEmbedding, cosine, normalizeVector, scoreVoiceEmbedding } from './Voiceprint.js';
import { defaultCampPlusVoiceClient } from './CampPlusVoiceClient.js';
import { defaultIdentityModelSettingsStore } from './IdentityModelSettingsStore.js';
import { preprocessVoiceWav, analyzeVoiceActivity } from './VoiceVad.js';

const DIR = join(homedir(), '.noe-panel');
const FILE = join(DIR, 'people-knowledge.json');
const FACE_READY_SAMPLES = 1;
const VOICE_READY_SAMPLES = 3;
const FACE_DEFAULT_THRESHOLD = 0.55;
const VOICE_DEFAULT_THRESHOLD = 0.78;
const VOICE_LITE_ENGINE = 'voice-lite';
const VOICE_LITE_MODEL = 'handcrafted-v1';

function cleanText(value, max = 500) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

function cleanId(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,63}$/.test(s) ? s : '';
}

function cleanEngine(value, fallback = '') {
  return cleanText(value, 80).toLowerCase() || fallback;
}

function splitList(value) {
  return Array.isArray(value)
    ? value.map((s) => cleanText(s, 80)).filter(Boolean)
    : cleanText(value, 800).split(/[,\n，、]/).map((s) => cleanText(s, 80)).filter(Boolean);
}

function newId(prefix = 'person') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function cleanVector(value, max = 512) {
  if (!Array.isArray(value)) throw new Error('embedding array required');
  const vec = value.map(Number).filter(Number.isFinite).slice(0, max);
  if (vec.length < 8) throw new Error('embedding too short');
  return normalizeVector(vec);
}

function cleanSamples(rows = [], max = 512, kind = 'sample') {
  return rows.filter((row) => Array.isArray(row.embedding) && row.embedding.length)
    .map((row) => ({
      id: String(row.id || newId('sample')),
      name: cleanText(row.name, 80),
      createdAt: row.createdAt || new Date().toISOString(),
      engine: cleanEngine(row.engine || row.embeddingEngine, kind === 'voice' ? VOICE_LITE_ENGINE : ''),
      model: cleanText(row.model || row.embeddingModel, 120),
      embedding: cleanVector(row.embedding, max),
    }))
    .filter((row) => row.embedding.length);
}

function cleanPerson(input = {}, previous = null) {
  const now = new Date().toISOString();
  const id = cleanId(input.id) || previous?.id || newId();
  const displayName = cleanText(input.displayName || input.name || previous?.displayName, 80);
  if (!displayName) throw new Error('displayName required');
  return {
    id,
    displayName,
    aliases: splitList(input.aliases ?? previous?.aliases),
    relation: cleanText(input.relation ?? previous?.relation, 120),
    notes: cleanText(input.notes ?? previous?.notes, 1600),
    tags: splitList(input.tags ?? previous?.tags),
    consentNote: cleanText(input.consentNote ?? previous?.consentNote, 300),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    faceSamples: previous?.faceSamples || [],
    voiceSamples: previous?.voiceSamples || [],
  };
}

function publicPerson(p) {
  return {
    id: p.id,
    displayName: p.displayName,
    aliases: [...(p.aliases || [])],
    relation: p.relation || '',
    notes: p.notes || '',
    tags: [...(p.tags || [])],
    consentNote: p.consentNote || '',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    faceSamples: p.faceSamples?.length || 0,
    voiceSamples: p.voiceSamples?.length || 0,
    faceSampleList: sampleList(p.faceSamples, 'face'),
    voiceSampleList: sampleList(p.voiceSamples, 'voice'),
    faceReady: (p.faceSamples?.length || 0) >= FACE_READY_SAMPLES,
    voiceReady: (p.voiceSamples?.length || 0) >= VOICE_READY_SAMPLES,
  };
}

function sampleList(rows = [], kind = 'sample') {
  return rows.map((row, index) => ({
    id: row.id,
    name: row.name || `${kind}-${index + 1}`,
    createdAt: row.createdAt || '',
    dimension: Array.isArray(row.embedding) ? row.embedding.length : 0,
    engine: row.engine || '',
    model: row.model || '',
  }));
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function matchPayload(person, score, source, ok, reason = '', extra = {}) {
  return { ok, source, score: roundScore(score), reason, ...extra, person: publicPerson(person) };
}

function scoreAgainstSamples(vec, samples = [], source = '') {
  if (!samples.length) return 0;
  if (source === 'face') return Math.max(...samples.map((s) => cosine(vec, s.embedding)));
  return scoreVoiceEmbedding(vec, samples).score;
}

function voiceScoreExtra(vec, samples = []) {
  const scored = scoreVoiceEmbedding(vec, samples);
  return {
    bestScore: roundScore(scored.bestScore),
    topScore: roundScore(scored.topScore),
    centroidScore: roundScore(scored.centroidScore),
    sampleCount: scored.sampleCount,
  };
}

function voiceEngineOf(sample = {}) {
  return cleanEngine(sample.engine, VOICE_LITE_ENGINE);
}

function voiceScoreScale(engine, value) {
  const raw = Number(value) || 0;
  return engine === 'campplus' ? Math.max(0, Math.min(1, (raw + 1) / 2)) : raw;
}

function scoreVoiceGroup(vec, samples = [], engine = VOICE_LITE_ENGINE) {
  const scored = scoreVoiceEmbedding(vec, samples);
  return {
    score: voiceScoreScale(engine, scored.score),
    rawScore: scored.score,
    bestScore: voiceScoreScale(engine, scored.bestScore),
    topScore: voiceScoreScale(engine, scored.topScore),
    centroidScore: voiceScoreScale(engine, scored.centroidScore),
    rawBestScore: scored.bestScore,
    rawTopScore: scored.topScore,
    rawCentroidScore: scored.centroidScore,
    sampleCount: scored.sampleCount,
  };
}

export class PersonKnowledgeStore {
  constructor({ file = FILE, voiceEngine = null, modelSettings = null } = {}) {
    this.file = file;
    this.voiceEngine = voiceEngine;
    this.modelSettings = modelSettings;
    this.lastVoiceEngineError = '';
    this.people = new Map();
    this._load();
  }

  _ensureDir() { const dir = this.file.slice(0, this.file.lastIndexOf('/')); if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  _backup() { if (existsSync(this.file)) { try { copyFileSync(this.file, `${this.file}.bak-latest`); chmodSync(`${this.file}.bak-latest`, 0o600); } catch {} } }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8'));
      for (const row of Array.isArray(data?.people) ? data.people : []) {
        const person = cleanPerson(row);
        person.faceSamples = cleanSamples(row.faceSamples, 512);
        person.voiceSamples = cleanSamples(row.voiceSamples, 256, 'voice').slice(-32);
        this.people.set(person.id, person);
      }
    } catch (e) {
      try { copyFileSync(this.file, `${this.file}.corrupted-${Date.now()}-${process.pid}.bak`); } catch {}
      console.warn('[people-knowledge] load failed:', e.message);
    }
  }

  _save() {
    this._ensureDir();
    this._backup();
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, people: Array.from(this.people.values()) }, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.file);
  }

  list({ q = '' } = {}) {
    const needle = cleanText(q, 120).toLowerCase();
    return Array.from(this.people.values()).filter((p) => {
      if (!needle) return true;
      return [p.displayName, p.relation, p.notes, ...(p.aliases || []), ...(p.tags || [])].join(' ').toLowerCase().includes(needle);
    }).map(publicPerson);
  }

  get(id) {
    const person = this.people.get(cleanId(id));
    return person ? publicPerson(person) : null;
  }

  upsert(input = {}) {
    const id = cleanId(input.id);
    const prev = id ? this.people.get(id) : null;
    const person = cleanPerson(input, prev);
    this.people.set(person.id, person);
    this._save();
    return publicPerson(person);
  }

  delete(id) {
    const ok = this.people.delete(cleanId(id));
    if (ok) this._save();
    return ok;
  }

  enrollFaceSample(id, { embedding, name } = {}) {
    const person = this.people.get(cleanId(id));
    if (!person) throw new Error('person not found');
    person.faceSamples.push({ id: newId('face'), name: cleanText(name, 80), createdAt: new Date().toISOString(), embedding: cleanVector(embedding, 512) });
    person.faceSamples = person.faceSamples.slice(-64); // 与声纹 slice(-32) 对齐:杜绝无界增长撑盘/拖慢 1:N
    person.updatedAt = new Date().toISOString();
    this._save();
    return publicPerson(person);
  }

  importFaceEmbedding(id, { embedding, name, createdAt, sourceId } = {}) {
    const person = this.people.get(cleanId(id));
    if (!person) throw new Error('person not found');
    const sampleId = cleanText(sourceId, 90) || newId('face');
    if (person.faceSamples.some((s) => s.id === sampleId)) return publicPerson(person);
    person.faceSamples.push({ id: sampleId, name: cleanText(name, 80) || '主人门禁人脸', createdAt: createdAt || new Date().toISOString(), embedding: cleanVector(embedding, 512) });
    person.faceSamples = person.faceSamples.slice(-64);
    person.updatedAt = new Date().toISOString();
    this._save();
    return publicPerson(person);
  }

  async enrollVoiceSample(id, { audioBuffer, name } = {}) {
    const person = this.people.get(cleanId(id));
    if (!person) throw new Error('person not found');
    const primary = (await this._voiceEmbeddings(audioBuffer, { includeLite: false }))[0];
    if (!primary) throw new Error(this.lastVoiceEngineError || 'voice model unavailable');
    person.voiceSamples.push({
      id: newId('voice'),
      name: cleanText(name, 80),
      createdAt: new Date().toISOString(),
      engine: primary.engine,
      model: primary.model,
      embedding: primary.embedding,
    });
    person.voiceSamples = person.voiceSamples.slice(-32);
    person.updatedAt = new Date().toISOString();
    this._save();
    return publicPerson(person);
  }

  importVoiceEmbedding(id, { embedding, name, createdAt, sourceId, engine, model } = {}) {
    const person = this.people.get(cleanId(id));
    if (!person) throw new Error('person not found');
    const sampleId = cleanText(sourceId, 90) || newId('voice');
    if (person.voiceSamples.some((s) => s.id === sampleId)) return publicPerson(person);
    person.voiceSamples.push({ id: sampleId, name: cleanText(name, 80) || '主人门禁声纹', createdAt: createdAt || new Date().toISOString(), engine: cleanEngine(engine, VOICE_LITE_ENGINE), model: cleanText(model, 120) || VOICE_LITE_MODEL, embedding: cleanVector(embedding, 256) });
    person.voiceSamples = person.voiceSamples.slice(-32);
    person.updatedAt = new Date().toISOString();
    this._save();
    return publicPerson(person);
  }

  deleteSample(id, kind, sampleId) {
    const person = this.people.get(cleanId(id));
    if (!person) throw new Error('person not found');
    const key = kind === 'face' ? 'faceSamples' : (kind === 'voice' ? 'voiceSamples' : '');
    if (!key) throw new Error('sample kind must be face or voice');
    const before = person[key].length;
    person[key] = person[key].filter((s) => String(s.id) !== String(sampleId));
    if (person[key].length === before) return { ok: false, person: publicPerson(person) };
    person.updatedAt = new Date().toISOString();
    this._save();
    return { ok: true, person: publicPerson(person) };
  }

  _identify(embedding, { source, threshold, minSamples, sampleKey, maxVector }) {
    const vec = cleanVector(embedding, maxVector);
    const candidates = Array.from(this.people.values()).map((person) => {
      const samples = person[sampleKey] || [];
      const score = scoreAgainstSamples(vec, samples, source);
      const enough = samples.length >= minSamples;
      const extra = source === 'voice' ? voiceScoreExtra(vec, samples) : {};
      return { person, score, enough, extra };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    const best = candidates[0];
    if (!best) return { ok: false, source, score: 0, reason: 'no_people' };
    if (!best.enough) return matchPayload(best.person, best.score, source, false, 'not_enough_samples', best.extra);
    if (best.score < threshold) return matchPayload(best.person, best.score, source, false, 'below_threshold', best.extra);
    return { ...matchPayload(best.person, best.score, source, true, '', best.extra), candidates: candidates.map((c) => matchPayload(c.person, c.score, source, c.enough && c.score >= threshold, c.enough ? '' : 'not_enough_samples', c.extra)) };
  }

  voiceEngineStatus() {
    const settings = this.modelSettings?.status?.() || { voice: { enabled: true, engine: this.voiceEngine ? 'campplus' : VOICE_LITE_ENGINE } };
    const st = this.voiceEngine?.status?.() || { ok: false, engine: VOICE_LITE_ENGINE, modelReady: false };
    return {
      ...st,
      enabled: settings.voice?.enabled !== false,
      selectedEngine: cleanEngine(settings.voice?.engine, st.engine || VOICE_LITE_ENGINE),
      availableEngines: ['campplus', VOICE_LITE_ENGINE],
      lastError: this.lastVoiceEngineError || '',
    };
  }

  async _voiceEmbeddings(audioBuffer, { includeLite = true } = {}) {
    audioBuffer = preprocessVoiceWav(audioBuffer); // 裁静音/去低频底噪，让声纹特征聚焦真语音段（录入/验证同口径）
    const rows = [];
    const settings = this.modelSettings?.status?.() || { voice: { enabled: true, engine: this.voiceEngine ? 'campplus' : VOICE_LITE_ENGINE } };
    if (settings.voice?.enabled === false) {
      this.lastVoiceEngineError = 'voice model disabled';
      return rows;
    }
    const selected = cleanEngine(settings.voice?.engine, this.voiceEngine ? 'campplus' : VOICE_LITE_ENGINE);
    if (selected === VOICE_LITE_ENGINE) {
      rows.push({ engine: VOICE_LITE_ENGINE, model: VOICE_LITE_MODEL, embedding: computeVoiceEmbedding(audioBuffer) });
      this.lastVoiceEngineError = '';
      return rows;
    }
    if (this.voiceEngine?.embedAudio) {
      try {
        const out = await this.voiceEngine.embedAudio(audioBuffer);
        rows.push({
          engine: cleanEngine(out.engine, 'campplus'),
          model: cleanText(out.model, 120),
          embedding: cleanVector(out.embedding, 256),
          seconds: out.seconds,
          maxrssBytes: out.maxrssBytes,
        });
        this.lastVoiceEngineError = '';
      } catch (e) {
        this.lastVoiceEngineError = e?.message || String(e);
      }
    }
    if (includeLite) {
      try { rows.push({ engine: VOICE_LITE_ENGINE, model: VOICE_LITE_MODEL, embedding: computeVoiceEmbedding(audioBuffer) }); }
      catch (e) { if (!rows.length) this.lastVoiceEngineError = this.lastVoiceEngineError || e?.message || String(e); }
    }
    return rows;
  }

  _voiceCandidates(embeddings, { threshold, minSamples, onlyPerson = null } = {}) {
    const people = onlyPerson ? [onlyPerson] : Array.from(this.people.values());
    const candidates = [];
    for (const person of people.filter(Boolean)) {
      const allSamples = person.voiceSamples || [];
      // 审计 §3.4 P0-7：不再硬编码 campplus 维度 192（模型升维会让所有样本被静默过滤、莫名退 lite）；length > 0 即视为有效样本
      const hasReadyCampPlus = allSamples.filter((s) => voiceEngineOf(s) === 'campplus' && Array.isArray(s.embedding) && s.embedding.length > 0).length >= minSamples;
      for (const emb of embeddings) {
        const engine = cleanEngine(emb.engine, VOICE_LITE_ENGINE);
        if (hasReadyCampPlus && engine !== 'campplus') continue;
        const samples = allSamples.filter((s) => voiceEngineOf(s) === engine && Array.isArray(s.embedding) && s.embedding.length === emb.embedding.length);
        if (!samples.length) continue;
        const scored = scoreVoiceGroup(emb.embedding, samples, engine);
        const enough = samples.length >= minSamples;
        candidates.push({
          person,
          score: scored.score,
          enough,
          pass: enough && scored.score >= threshold,
          extra: {
            engine,
            model: emb.model || samples[0]?.model || '',
            rawScore: roundScore(scored.rawScore),
            bestScore: roundScore(scored.bestScore),
            topScore: roundScore(scored.topScore),
            centroidScore: roundScore(scored.centroidScore),
            rawBestScore: roundScore(scored.rawBestScore),
            rawTopScore: roundScore(scored.rawTopScore),
            rawCentroidScore: roundScore(scored.rawCentroidScore),
            sampleCount: scored.sampleCount,
            engineSeconds: emb.seconds ?? null,
            engineMaxrssBytes: emb.maxrssBytes ?? null,
          },
        });
      }
    }
    return candidates
      .sort((a, b) => Number(b.pass) - Number(a.pass) || Number(b.enough) - Number(a.enough) || b.score - a.score)
      .slice(0, 5);
  }

  _identifyPerson(person, embedding, { source, threshold, minSamples, sampleKey, maxVector }) {
    if (!person) return { ok: false, source, score: 0, reason: 'person_not_found' };
    const vec = cleanVector(embedding, maxVector);
    const samples = person[sampleKey] || [];
    if (!samples.length) return matchPayload(person, 0, source, false, 'no_samples');
    const score = scoreAgainstSamples(vec, samples, source);
    const extra = source === 'voice' ? voiceScoreExtra(vec, samples) : {};
    if (samples.length < minSamples) return matchPayload(person, score, source, false, 'not_enough_samples', extra);
    if (score < threshold) return matchPayload(person, score, source, false, 'below_threshold', extra);
    return matchPayload(person, score, source, true, '', extra);
  }

  identifyFace(embedding, opts = {}) {
    return this._identify(embedding, { source: 'face', threshold: Number(opts.threshold) || FACE_DEFAULT_THRESHOLD, minSamples: Number(opts.minSamples) || FACE_READY_SAMPLES, sampleKey: 'faceSamples', maxVector: 512 });
  }

  identifyFaceForPerson(id, embedding, opts = {}) {
    return this._identifyPerson(this.people.get(cleanId(id)), embedding, { source: 'face', threshold: Number(opts.threshold) || FACE_DEFAULT_THRESHOLD, minSamples: Number(opts.minSamples) || FACE_READY_SAMPLES, sampleKey: 'faceSamples', maxVector: 512 });
  }

  async identifyVoice(audioBuffer, opts = {}) {
    // 语音活动门禁：没有足够清晰人声(杂音/静音/底噪)直接拒，不进声纹比对(防杂音被误判成某人)
    const vad = analyzeVoiceActivity(audioBuffer);
    if (!vad.ok && vad.reason !== 'vad_skipped') return { ok: false, source: 'voice', score: 0, reason: 'no_speech', vad };
    const threshold = Number(opts.threshold) || VOICE_DEFAULT_THRESHOLD;
    const minSamples = Number(opts.minSamples) || 3;
    const candidates = this._voiceCandidates(await this._voiceEmbeddings(audioBuffer), { threshold, minSamples });
    const best = candidates[0];
    if (!best) return { ok: false, source: 'voice', score: 0, reason: this.lastVoiceEngineError === 'voice model disabled' ? 'voice_model_disabled' : 'no_people', engineError: this.lastVoiceEngineError || '' };
    if (!best.enough) return matchPayload(best.person, best.score, 'voice', false, 'not_enough_samples', { ...best.extra, threshold });
    if (best.score < threshold) return matchPayload(best.person, best.score, 'voice', false, 'below_threshold', { ...best.extra, threshold });
    return { ...matchPayload(best.person, best.score, 'voice', true, '', { ...best.extra, threshold }), candidates: candidates.map((c) => matchPayload(c.person, c.score, 'voice', c.pass, c.enough ? '' : 'not_enough_samples', { ...c.extra, threshold })) };
  }

  async identifyVoiceForPerson(id, audioBuffer, opts = {}) {
    const person = this.people.get(cleanId(id));
    if (!person) return { ok: false, source: 'voice', score: 0, reason: 'person_not_found' };
    // 语音活动门禁：杂音/静音直接拒，不让它进比对被误判成主人（即便主人门禁绑定了这个 person 也拦得住）
    const vad = analyzeVoiceActivity(audioBuffer);
    if (!vad.ok && vad.reason !== 'vad_skipped') return matchPayload(person, 0, 'voice', false, 'no_speech', { vad });
    const threshold = Number(opts.threshold) || VOICE_DEFAULT_THRESHOLD;
    const minSamples = Number(opts.minSamples) || 3;
    const candidates = this._voiceCandidates(await this._voiceEmbeddings(audioBuffer), { threshold, minSamples, onlyPerson: person });
    const best = candidates[0];
    if (!best) return matchPayload(person, 0, 'voice', false, this.lastVoiceEngineError === 'voice model disabled' ? 'voice_model_disabled' : 'no_samples', { threshold, engineError: this.lastVoiceEngineError || '' });
    if (!best.enough) return matchPayload(person, best.score, 'voice', false, 'not_enough_samples', { ...best.extra, threshold });
    if (best.score < threshold) return matchPayload(person, best.score, 'voice', false, 'below_threshold', { ...best.extra, threshold });
    return matchPayload(person, best.score, 'voice', true, '', { ...best.extra, threshold });
  }
}

export const defaultPersonKnowledgeStore = new PersonKnowledgeStore({ voiceEngine: defaultCampPlusVoiceClient, modelSettings: defaultIdentityModelSettingsStore });
