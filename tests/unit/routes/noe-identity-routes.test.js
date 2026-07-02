import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerNoeIdentityRoutes } from '../../../src/server/routes/noeIdentity.js';
import { OwnerIdentityStore } from '../../../src/identity/OwnerIdentityStore.js';
import { PersonKnowledgeStore } from '../../../src/identity/PersonKnowledgeStore.js';
import { IdentityModelSettingsStore } from '../../../src/identity/IdentityModelSettingsStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ body = {} } = {}) {
  return { body, get: () => 'owner-token' };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function sineWav(freq, seconds = 1.2, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 18000), 44 + i * 2);
  return buf;
}

const face = (seed = 0) => Array.from({ length: 512 }, (_, i) => Math.sin((i + seed) / 17));
const sendError = (res, e) => res.status(/not found|required/i.test(e?.message || '') ? 400 : 500).json({ ok: false, error: e?.message || String(e) });
function makeModelSettings(dir) {
  const store = new IdentityModelSettingsStore({ file: join(dir, 'model-settings.json') });
  store.update({ voiceEnabled: true, faceEnabled: true, voiceEngine: 'voice-lite' });
  return store;
}

describe('noe identity owner person routes', () => {
  it('binds voice and face owner gates to a person knowledge profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-routes-'));
    try {
      const ownerIdentityStore = new OwnerIdentityStore({ file: join(dir, 'owner.json'), voiceEngine: null });
      const modelSettings = makeModelSettings(dir);
      const personStore = new PersonKnowledgeStore({ file: join(dir, 'people.json'), modelSettings });
      const person = personStore.upsert({ displayName: '主人', relation: 'owner' });
      personStore.enrollFaceSample(person.id, { embedding: face(0), name: 'face-0' });
      for (let i = 0; i < 3; i += 1) {
        await personStore.enrollVoiceSample(person.id, { audioBuffer: sineWav(180 + i), name: `voice-${i}` });
      }
      const { app, routes } = makeApp();
      registerNoeIdentityRoutes(app, { ownerIdentityStore, personStore, modelSettings, sendError });

      const faceBind = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/face/owner-person');
      const faceRes = makeRes();
      await faceBind.handlers[1](makeReq({ body: { personId: person.id, enabled: true } }), faceRes);
      expect(faceRes.payload.face).toMatchObject({ enabled: true, ownerPersonId: person.id, samples: 1, ready: true, ownerPerson: { displayName: '主人' } });

      const voiceBind = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/voice/owner-person');
      const guest = personStore.upsert({ displayName: '样本不足的人' });
      const guestRes = makeRes();
      await voiceBind.handlers[1](makeReq({ body: { personId: guest.id, enabled: true } }), guestRes);
      expect(guestRes.payload.voice).toMatchObject({ enabled: false, ownerPersonId: guest.id, samples: 0, ready: false });
      const voiceRes = makeRes();
      await voiceBind.handlers[1](makeReq({ body: { personId: person.id, enabled: true } }), voiceRes);
      expect(voiceRes.payload.voice).toMatchObject({ enabled: true, ownerPersonId: person.id, samples: 3, ready: true, ownerPerson: { displayName: '主人' } });

      const status = routes.find((r) => r.method === 'get' && r.path === '/api/noe/identity/status');
      const statusRes = makeRes();
      await status.handlers[1](makeReq(), statusRes);
      expect(statusRes.payload.status.face.ownerPerson.displayName).toBe('主人');
      expect(statusRes.payload.status.voice.ownerPerson.displayName).toBe('主人');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes identity enrollments into the owner person profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-routes-'));
    try {
      const ownerIdentityStore = new OwnerIdentityStore({ file: join(dir, 'owner.json'), voiceEngine: null });
      const modelSettings = makeModelSettings(dir);
      const personStore = new PersonKnowledgeStore({ file: join(dir, 'people.json'), modelSettings });
      const { app, routes } = makeApp();
      registerNoeIdentityRoutes(app, { ownerIdentityStore, personStore, modelSettings, sendError });

      const voiceEnroll = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/voice/enroll');
      const voiceRes = makeRes();
      await voiceEnroll.handlers[1](makeReq({ body: { audio: sineWav(180).toString('base64'), name: '主人声纹' } }), voiceRes);
      expect(voiceRes.statusCode).toBe(201);
      expect(voiceRes.payload.person).toMatchObject({ displayName: '主人', voiceSamples: 1 });
      expect(ownerIdentityStore.status().voice.ownerPersonId).toBe(voiceRes.payload.person.id);

      const faceEnroll = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/face/enroll');
      const faceRes = makeRes();
      await faceEnroll.handlers[1](makeReq({ body: { embedding: face(1), name: '主人人脸' } }), faceRes);
      expect(faceRes.statusCode).toBe(201);
      expect(faceRes.payload.person).toMatchObject({ displayName: '主人', voiceSamples: 1, faceSamples: 1 });
      expect(personStore.list()[0]).toMatchObject({ displayName: '主人', voiceSamples: 1, faceSamples: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports existing hidden owner templates into the people library', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-routes-'));
    try {
      const ownerIdentityStore = new OwnerIdentityStore({ file: join(dir, 'owner.json'), voiceEngine: null });
      await ownerIdentityStore.enrollVoiceSample({ audioBuffer: sineWav(180), name: '旧声纹' });
      ownerIdentityStore.enrollFaceSample({ embedding: face(3), name: '旧人脸' });
      const modelSettings = makeModelSettings(dir);
      const personStore = new PersonKnowledgeStore({ file: join(dir, 'people.json'), modelSettings });
      const { app, routes } = makeApp();
      registerNoeIdentityRoutes(app, { ownerIdentityStore, personStore, modelSettings, sendError });

      const migrate = routes.find((r) => r.method === 'post' && r.path === '/api/noe/identity/import-owner-samples');
      const res = makeRes();
      await migrate.handlers[1](makeReq(), res);
      expect(res.payload.person).toMatchObject({ displayName: '主人', voiceSamples: 1, faceSamples: 1 });
      const again = makeRes();
      await migrate.handlers[1](makeReq(), again);
      expect(again.payload.person).toMatchObject({ voiceSamples: 1, faceSamples: 1 });
      expect(ownerIdentityStore.status().voice.ownerPersonId).toBe(res.payload.person.id);
      expect(ownerIdentityStore.status().face.ownerPersonId).toBe(res.payload.person.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
