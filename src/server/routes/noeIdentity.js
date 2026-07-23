import { requireOwnerToken } from '../auth/owner-token.js';
import { defaultIdentityModelSettingsStore } from '../../identity/IdentityModelSettingsStore.js';

const MAX_AUDIO = 15_000_000;

function audioBufferFromBody(body = {}) {
  const raw = body.audio || body.wav || body.audioBase64;
  if (typeof raw !== 'string' || !raw) throw new Error('audio base64 required');
  if (raw.length > MAX_AUDIO) throw new Error('audio too large');
  return Buffer.from(raw, 'base64');
}

function ownerLite(p) {
  return p ? { id: p.id, displayName: p.displayName, relation: p.relation || '', faceSamples: p.faceSamples || 0, voiceSamples: p.voiceSamples || 0 } : null;
}

function enrichStatus(status, personStore) {
  const out = JSON.parse(JSON.stringify(status || {}));
  for (const key of ['voice', 'face']) {
    const id = out?.[key]?.ownerPersonId;
    if (!id || !personStore?.get) continue;
    const person = personStore.get(id);
    if (!person) { out[key].ownerMissing = true; continue; }
    out[key].ownerPerson = ownerLite(person);
    out[key].samples = key === 'voice' ? person.voiceSamples : person.faceSamples;
    out[key].ready = key === 'voice' ? person.voiceReady : person.faceReady;
  }
  return out;
}

function ensurePerson(personStore, personId) {
  const id = String(personId || '').trim();
  if (!id) return '';
  const person = personStore?.get?.(id);
  if (!person) throw new Error('person not found');
  return person;
}

function bindEnabled(requested, person, kind) {
  if (requested !== true) return requested;
  return kind === 'voice' ? person?.voiceReady === true : person?.faceReady === true;
}

function ensureOwnerPerson(ownerIdentityStore, personStore) {
  const current = ownerIdentityStore.status();
  const id = current.voice?.ownerPersonId || current.face?.ownerPersonId;
  const bound = id ? personStore?.get?.(id) : null;
  if (bound) return bound;
  const existing = personStore.list({ q: '主人' }).find((p) => p.displayName === '主人');
  return existing || personStore.upsert({ displayName: '主人', relation: '本人', tags: 'owner,主人', consentNote: '本机主人门禁录入自动创建。' });
}

function syncOwnerSamples(ownerIdentityStore, personStore) {
  const owner = ensureOwnerPerson(ownerIdentityStore, personStore);
  const snap = ownerIdentityStore.sampleSnapshot?.() || { voice: [], face: [] };
  for (const s of snap.voice || []) personStore.importVoiceEmbedding(owner.id, { embedding: s.embedding, name: s.name, createdAt: s.createdAt, sourceId: `owner-${s.id}` });
  for (const s of snap.face || []) personStore.importFaceEmbedding(owner.id, { embedding: s.embedding, name: s.name, createdAt: s.createdAt, sourceId: `owner-${s.id}` });
  const fresh = personStore.get(owner.id);
  ownerIdentityStore.bindVoicePerson(owner.id, { enabled: fresh.voiceReady === true });
  ownerIdentityStore.bindFacePerson(owner.id, { enabled: fresh.faceReady === true });
  return fresh;
}

export function registerNoeIdentityRoutes(app, { ownerIdentityStore, personStore, sendError, modelSettings = personStore?.modelSettings || defaultIdentityModelSettingsStore } = {}) {
  const status = () => enrichStatus(ownerIdentityStore.status(), personStore);
  app.get('/api/noe/identity/status', requireOwnerToken, (_req, res) => {
    try { return res.json({ ok: true, status: status() }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/voice/config', requireOwnerToken, (req, res) => {
    try { ownerIdentityStore.updateVoiceConfig(req.body || {}); return res.json({ ok: true, voice: status().voice }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/voice/enroll', requireOwnerToken, async (req, res) => {
    try {
      if (modelSettings.status?.().voice?.enabled === false) return res.status(409).json({ ok: false, error: 'voice model disabled' });
      if (!personStore?.enrollVoiceSample || !ownerIdentityStore?.bindVoicePerson) {
        const result = await ownerIdentityStore.enrollVoiceSample({ audioBuffer: audioBufferFromBody(req.body), name: req.body?.name });
        return res.status(201).json({ ok: true, ...result, voice: status().voice });
      }
      const p = ensureOwnerPerson(ownerIdentityStore, personStore);
      const person = await personStore.enrollVoiceSample(p.id, { audioBuffer: audioBufferFromBody(req.body), name: req.body?.name });
      ownerIdentityStore.bindVoicePerson(person.id, { enabled: person.voiceReady === true });
      return res.status(201).json({ ok: true, person, voice: status().voice });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/voice/verify', requireOwnerToken, async (req, res) => {
    try {
      if (modelSettings.status?.().voice?.enabled === false) return res.json({ ok: true, voice: { ok: false, reason: 'voice_model_disabled', score: 0 } });
      const current = status();
      const voice = current.voice?.ownerPersonId && personStore?.identifyVoiceForPerson
        ? await personStore.identifyVoiceForPerson(current.voice.ownerPersonId, audioBufferFromBody(req.body), { threshold: current.voice.threshold, minSamples: 3 })
        : await ownerIdentityStore.verifyVoice(audioBufferFromBody(req.body));
      return res.json({ ok: true, voice });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/voice/clear', requireOwnerToken, (_req, res) => {
    try { ownerIdentityStore.clearVoice(); return res.json({ ok: true, voice: status().voice }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/voice/owner-person', requireOwnerToken, (req, res) => {
    try { const p = ensurePerson(personStore, req.body?.personId); ownerIdentityStore.bindVoicePerson(p?.id || '', { enabled: bindEnabled(req.body?.enabled, p, 'voice') }); return res.json({ ok: true, voice: status().voice, status: status() }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/import-owner-samples', requireOwnerToken, (_req, res) => {
    try { const person = syncOwnerSamples(ownerIdentityStore, personStore); return res.json({ ok: true, person, status: status() }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/face/config', requireOwnerToken, (req, res) => {
    try { ownerIdentityStore.updateFaceConfig(req.body || {}); return res.json({ ok: true, face: status().face }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/face/enroll', requireOwnerToken, (req, res) => {
    try {
      if (modelSettings.status?.().face?.enabled === false) return res.status(409).json({ ok: false, error: 'face model disabled' });
      if (!personStore?.enrollFaceSample || !ownerIdentityStore?.bindFacePerson) {
        const result = ownerIdentityStore.enrollFaceSample({ embedding: req.body?.embedding, name: req.body?.name });
        return res.status(201).json({ ok: true, ...result, face: status().face });
      }
      const p = ensureOwnerPerson(ownerIdentityStore, personStore);
      const person = personStore.enrollFaceSample(p.id, { embedding: req.body?.embedding, name: req.body?.name });
      ownerIdentityStore.bindFacePerson(person.id, { enabled: person.faceReady === true });
      return res.status(201).json({ ok: true, person, face: status().face });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/face/verify', requireOwnerToken, (req, res) => {
    try {
      if (modelSettings.status?.().face?.enabled === false) return res.json({ ok: true, face: { ok: false, reason: 'face_model_disabled', score: 0 } });
      return res.json({ ok: true, face: ownerIdentityStore.verifyFaceEmbedding(req.body?.embedding) });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/face/clear', requireOwnerToken, (_req, res) => {
    try { ownerIdentityStore.clearFace(); return res.json({ ok: true, face: status().face }); } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/identity/face/owner-person', requireOwnerToken, (req, res) => {
    try { const p = ensurePerson(personStore, req.body?.personId); ownerIdentityStore.bindFacePerson(p?.id || '', { enabled: bindEnabled(req.body?.enabled, p, 'face') }); return res.json({ ok: true, face: status().face, status: status() }); } catch (e) { return sendError(res, e); }
  });
}
