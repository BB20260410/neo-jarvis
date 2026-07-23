import { requireOwnerToken } from '../auth/owner-token.js';
import { defaultInsightFaceClient } from '../../identity/InsightFaceClient.js';
import { defaultIdentityModelSettingsStore } from '../../identity/IdentityModelSettingsStore.js';

const MAX_BODY = 20_000;
const MAX_AUDIO = 15_000_000;
const MAX_IMAGE = 12_000_000;

function audioBufferFromBody(body = {}) {
  const raw = body.audio || body.wav || body.audioBase64;
  if (typeof raw !== 'string' || !raw) throw new Error('audio base64 required');
  if (raw.length > MAX_AUDIO) throw new Error('audio too large');
  return Buffer.from(raw, 'base64');
}

function capBody(req, res) {
  if (JSON.stringify(req.body || {}).length > MAX_BODY) {
    res.status(413).json({ ok: false, error: 'people body too large' });
    return true;
  }
  return false;
}

function imageFromBody(body = {}) {
  const raw = body.image || body.imageBase64 || body.dataUrl;
  if (typeof raw !== 'string' || !raw) throw new Error('image base64 required');
  if (raw.length > MAX_IMAGE) throw new Error('image too large');
  return raw;
}

// detSize 由请求体可控，每维钳制到 [128, 1280]，防止巨尺寸触发 insightface/onnxruntime 巨额内存分配 DoS
function clampDetSize(detSize) {
  if (!Array.isArray(detSize)) return undefined;
  const clamp = (v) => Math.max(128, Math.min(1280, Math.trunc(Number(v))));
  const w = clamp(detSize[0]);
  const h = clamp(detSize[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined;
  return [w, h];
}

export function registerNoePeopleRoutes(app, { personStore, sendError, faceEngine = defaultInsightFaceClient, modelSettings = personStore?.modelSettings || defaultIdentityModelSettingsStore } = {}) {
  const registerPatch = typeof app.patch === 'function' ? app.patch.bind(app) : app.post.bind(app);
  app.get('/api/noe/people', requireOwnerToken, (req, res) => {
    try { return res.json({ ok: true, people: personStore.list({ q: req.query.q || '' }) }); } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/people/model-settings', requireOwnerToken, (_req, res) => {
    try { return res.json({ ok: true, settings: modelSettings.status?.() || {} }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/model-settings', requireOwnerToken, (req, res) => {
    try { return res.json({ ok: true, settings: modelSettings.update?.(req.body || {}) || {} }); } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/people/face-engine', requireOwnerToken, (req, res) => {
    try {
      const settings = modelSettings.status?.() || {};
      if (settings.face?.enabled === false) return res.json({ ok: true, status: { ok: false, engine: 'insightface', enabled: false, modelReady: false, reason: 'face_model_disabled' } });
      return res.json({ ok: true, status: { ...faceEngine.status(), enabled: true } });
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/people/voice-engine', requireOwnerToken, (req, res) => {
    try { return res.json({ ok: true, status: personStore.voiceEngineStatus?.() || { ok: false, engine: 'voice-lite' } }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/face-embedding', requireOwnerToken, async (req, res) => {
    try {
      const settings = modelSettings.status?.() || {};
      if (settings.face?.enabled === false) return res.status(409).json({ ok: false, error: 'face model disabled' });
      const out = await faceEngine.embedImage(imageFromBody(req.body), { model: req.body?.model, detSize: clampDetSize(req.body?.detSize) });
      return res.json({ ok: true, ...out, embedding: out.embedding });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people', requireOwnerToken, (req, res) => {
    try {
      if (capBody(req, res)) return res;
      return res.status(201).json({ ok: true, person: personStore.upsert(req.body || {}), people: personStore.list() });
    } catch (e) { return sendError(res, e); }
  });

  registerPatch('/api/noe/people/:id', requireOwnerToken, (req, res) => {
    try {
      if (capBody(req, res)) return res;
      return res.json({ ok: true, person: personStore.upsert({ ...(req.body || {}), id: req.params.id }), people: personStore.list() });
    } catch (e) { return sendError(res, e); }
  });

  app.delete('/api/noe/people/:id', requireOwnerToken, (req, res) => {
    try {
      if (!personStore.delete(req.params.id)) return res.status(404).json({ ok: false, error: 'person not found' });
      return res.json({ ok: true, people: personStore.list() });
    } catch (e) { return sendError(res, e); }
  });

  app.delete('/api/noe/people/:id/samples/:kind/:sampleId', requireOwnerToken, (req, res) => {
    try {
      const out = personStore.deleteSample(req.params.id, req.params.kind, req.params.sampleId);
      if (!out.ok) return res.status(404).json({ ok: false, error: 'sample not found', person: out.person });
      return res.json({ ok: true, person: out.person, people: personStore.list() });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/:id/face/enroll', requireOwnerToken, (req, res) => {
    try {
      if (capBody(req, res)) return res;
      return res.status(201).json({ ok: true, person: personStore.enrollFaceSample(req.params.id, { embedding: req.body?.embedding, name: req.body?.name }) });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/:id/voice/enroll', requireOwnerToken, async (req, res) => {
    try {
      return res.status(201).json({ ok: true, person: await personStore.enrollVoiceSample(req.params.id, { audioBuffer: audioBufferFromBody(req.body), name: req.body?.name }) });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/identify/face', requireOwnerToken, (req, res) => {
    try {
      if (capBody(req, res)) return res;
      return res.json({ ok: true, match: personStore.identifyFace(req.body?.embedding, { threshold: req.body?.threshold, minSamples: req.body?.minSamples }) });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/people/identify/voice', requireOwnerToken, async (req, res) => {
    try {
      return res.json({ ok: true, match: await personStore.identifyVoice(audioBufferFromBody(req.body), { threshold: req.body?.threshold, minSamples: req.body?.minSamples }) });
    } catch (e) { return sendError(res, e); }
  });
}
