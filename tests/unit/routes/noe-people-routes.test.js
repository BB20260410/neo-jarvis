import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerNoePeopleRoutes } from '../../../src/server/routes/noePeople.js';
import { PersonKnowledgeStore } from '../../../src/identity/PersonKnowledgeStore.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ query = {}, body = {}, params = {} } = {}) {
  return { query, body, params, get: () => 'owner-token' };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

const sendError = (res, e) => res.status(/not found|required|embedding/i.test(e?.message || '') ? 400 : 500).json({ ok: false, error: e?.message || String(e) });

describe('noe people routes', () => {
  it('creates a person, enrolls face samples, identifies, and deletes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-routes-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const { app, routes } = makeApp();
      const faceEngine = {
        status: () => ({ ok: true, engine: 'insightface', modelReady: true }),
        embedImage: async () => ({ ok: true, engine: 'insightface', faceCount: 1, embedding: Array.from({ length: 512 }, (_, n) => Math.sin(n / 17)) }),
      };
      let settings = { voice: { enabled: true, engine: 'campplus' }, face: { enabled: true } };
      const modelSettings = { status: () => settings, update: (patch) => { settings = { voice: { ...settings.voice, enabled: patch.voiceEnabled ?? settings.voice.enabled, engine: patch.voiceEngine || settings.voice.engine }, face: { ...settings.face, enabled: patch.faceEnabled ?? settings.face.enabled } }; return settings; } };
      registerNoePeopleRoutes(app, { personStore: store, sendError, faceEngine, modelSettings });

      const engine = routes.find((r) => r.method === 'get' && r.path === '/api/noe/people/face-engine');
      const engineRes = makeRes();
      await engine.handlers[1](makeReq(), engineRes);
      expect(engineRes.payload.status).toMatchObject({ ok: true, engine: 'insightface', modelReady: true });

      const voiceEngine = routes.find((r) => r.method === 'get' && r.path === '/api/noe/people/voice-engine');
      const voiceEngineRes = makeRes();
      await voiceEngine.handlers[1](makeReq(), voiceEngineRes);
      expect(voiceEngineRes.payload.status).toMatchObject({ ok: false, engine: 'voice-lite' });

      const modelGet = routes.find((r) => r.method === 'get' && r.path === '/api/noe/people/model-settings');
      const modelGetRes = makeRes();
      await modelGet.handlers[1](makeReq(), modelGetRes);
      expect(modelGetRes.payload.settings).toMatchObject({ voice: { enabled: true, engine: 'campplus' }, face: { enabled: true } });

      const modelPost = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people/model-settings');
      const modelPostRes = makeRes();
      await modelPost.handlers[1](makeReq({ body: { voiceEnabled: false, voiceEngine: 'voice-lite', faceEnabled: false } }), modelPostRes);
      expect(modelPostRes.payload.settings).toMatchObject({ voice: { enabled: false, engine: 'voice-lite' }, face: { enabled: false } });
      settings.face.enabled = true;

      const embed = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people/face-embedding');
      const embedRes = makeRes();
      await embed.handlers[1](makeReq({ body: { image: 'data:image/png;base64,abc' } }), embedRes);
      expect(embedRes.payload).toMatchObject({ ok: true, engine: 'insightface', faceCount: 1 });
      expect(embedRes.payload.embedding).toHaveLength(512);

      const create = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people');
      const createRes = makeRes();
      await create.handlers[1](makeReq({ body: { displayName: '王五', relation: '同事', notes: '负责设计。' } }), createRes);
      expect(createRes.statusCode).toBe(201);
      const id = createRes.payload.person.id;

      const enroll = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people/:id/face/enroll');
      for (let i = 0; i < 3; i += 1) {
        const res = makeRes();
        await enroll.handlers[1](makeReq({ params: { id }, body: { embedding: Array.from({ length: 32 }, (_, n) => Math.sin((n + i) / 7)) } }), res);
        expect(res.statusCode).toBe(201);
      }

      const identify = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people/identify/face');
      const identifyRes = makeRes();
      await identify.handlers[1](makeReq({ body: { embedding: Array.from({ length: 32 }, (_, n) => Math.sin((n + 1) / 7)), threshold: 0.5 } }), identifyRes);
      expect(identifyRes.payload.match).toMatchObject({ ok: true, person: { displayName: '王五', relation: '同事' } });

      const del = routes.find((r) => r.method === 'delete' && r.path === '/api/noe/people/:id');
      const sampleDel = routes.find((r) => r.method === 'delete' && r.path === '/api/noe/people/:id/samples/:kind/:sampleId');
      const beforeSampleDelete = store.get(id);
      const sampleRes = makeRes();
      await sampleDel.handlers[1](makeReq({ params: { id, kind: 'face', sampleId: beforeSampleDelete.faceSampleList[0].id } }), sampleRes);
      expect(sampleRes.payload).toMatchObject({ ok: true, person: { displayName: '王五', faceSamples: 2 } });

      const delRes = makeRes();
      await del.handlers[1](makeReq({ params: { id } }), delRes);
      expect(delRes.payload).toMatchObject({ ok: true, people: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not call the face model when face recognition is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-routes-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const { app, routes } = makeApp();
      let called = false;
      const faceEngine = {
        status: () => ({ ok: true, engine: 'insightface', modelReady: true }),
        embedImage: async () => { called = true; return { ok: true, embedding: Array.from({ length: 512 }, () => 0) }; },
      };
      const modelSettings = { status: () => ({ voice: { enabled: true, engine: 'campplus' }, face: { enabled: false } }), update: () => ({}) };
      registerNoePeopleRoutes(app, { personStore: store, sendError, faceEngine, modelSettings });
      const engine = routes.find((r) => r.method === 'get' && r.path === '/api/noe/people/face-engine');
      const engineRes = makeRes();
      await engine.handlers[1](makeReq(), engineRes);
      expect(engineRes.payload.status).toMatchObject({ enabled: false, reason: 'face_model_disabled' });
      const embed = routes.find((r) => r.method === 'post' && r.path === '/api/noe/people/face-embedding');
      const embedRes = makeRes();
      await embed.handlers[1](makeReq({ body: { image: 'data:image/png;base64,abc' } }), embedRes);
      expect(embedRes.statusCode).toBe(409);
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
