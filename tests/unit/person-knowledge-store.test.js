import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PersonKnowledgeStore } from '../../src/identity/PersonKnowledgeStore.js';

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

function face(seed = 0) {
  return Array.from({ length: 512 }, (_, i) => Math.sin((i + seed) / 17) + Math.cos((i * 3 + seed) / 29));
}

describe('PersonKnowledgeStore', () => {
  it('faceSamples 有上限(slice -64)，防无界增长撑盘/拖慢 1:N', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-cap-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '多角度' });
      for (let i = 0; i < 70; i += 1) store.enrollFaceSample(p.id, { embedding: face(i), name: `f${i}` });
      expect(store.list().find((x) => x.id === p.id).faceSamples).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('声纹验证 VAD 门禁：静音/杂音被拒(no_speech)，不进比对被误判成主人', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-vad-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '主人', relation: 'owner' });
      for (const f of [180, 184, 176]) await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(f), name: `v${f}` });
      const silent = sineWav(0); // 全 0 = 静音(模拟没人说话/纯杂音底噪)
      const r = await store.identifyVoiceForPerson(p.id, silent, { minSamples: 3 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('no_speech'); // 被语音活动门禁拦下，而不是进比对
      const r2 = await store.identifyVoice(silent);
      expect(r2.reason).toBe('no_speech');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores people profiles and identifies by local face and voice templates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    const file = join(dir, 'people.json');
    try {
      const store = new PersonKnowledgeStore({ file });
      const p = store.upsert({ displayName: '张三', relation: '朋友', aliases: '老张,三哥', notes: '喜欢咖啡，来过工作室。', consentNote: '本人同意本地识别。' });
      expect(p.displayName).toBe('张三');
      store.enrollFaceSample(p.id, { embedding: face(1), name: 'front' });
      store.enrollFaceSample(p.id, { embedding: face(2), name: 'left' });
      store.enrollFaceSample(p.id, { embedding: face(3), name: 'right' });
      await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(180), name: 'voice-a' });
      await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(184), name: 'voice-b' });
      await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(176), name: 'voice-c' });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.bak-latest`)).toBe(true);

      const faceMatch = store.identifyFace(face(2), { threshold: 0.7 });
      expect(faceMatch.ok).toBe(true);
      expect(faceMatch.person).toMatchObject({ displayName: '张三', relation: '朋友', faceSamples: 3 });
      expect(store.identifyFaceForPerson(p.id, face(2), { threshold: 0.7 }).ok).toBe(true);
      const voiceMatch = await store.identifyVoice(sineWav(182), { threshold: 0.7 });
      expect(voiceMatch.ok).toBe(true);
      expect(voiceMatch.person.displayName).toBe('张三');
      expect((await store.identifyVoiceForPerson(p.id, sineWav(182), { threshold: 0.7 })).ok).toBe(true);
      const raw = JSON.parse(String(readFileSync(file)));
      expect(raw.people[0].notes).toContain('咖啡');
      expect(raw.people[0].faceSamples[0].embedding).toBeTruthy();
      expect(raw.people[0].faceSamples[0].frame).toBeUndefined();

      const reloaded = new PersonKnowledgeStore({ file });
      const listed = reloaded.list({ q: '三哥' })[0];
      expect(listed).toMatchObject({ displayName: '张三', voiceReady: true, faceReady: true });
      expect(listed.faceSampleList).toHaveLength(3);
      expect(listed.voiceSampleList).toHaveLength(3);
      expect(listed.faceSampleList[0]).toMatchObject({ name: 'front', dimension: 512 });
      expect(listed.faceSampleList[0].embedding).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not confirm a face match before enough samples are enrolled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '李四' });
      store.enrollFaceSample(p.id, { embedding: face(9), name: 'only' });
      const match = store.identifyFace(face(9), { threshold: 0.7, minSamples: 2 });
      expect(match.ok).toBe(false);
      expect(match.reason).toBe('not_enough_samples');
      expect(match.person.displayName).toBe('李四');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('identifies a person from one enrolled face sample by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '王五' });
      store.enrollFaceSample(p.id, { embedding: face(11), name: 'front' });
      expect(store.get(p.id)).toMatchObject({ faceSamples: 1, faceReady: true });
      const match = store.identifyFace(face(11));
      expect(match).toMatchObject({ ok: true, person: { displayName: '王五', faceSamples: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps all enrolled face samples instead of capping the people library at sixteen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '多角度样本' });
      for (let i = 0; i < 20; i += 1) store.enrollFaceSample(p.id, { embedding: face(i), name: `face-${i}` });
      expect(store.get(p.id).faceSamples).toBe(20);
      expect(new PersonKnowledgeStore({ file: join(dir, 'people.json') }).get(p.id).faceSamples).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches face against the best sample instead of a fragile centroid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '主人' });
      const good = face(4);
      store.enrollFaceSample(p.id, { embedding: good, name: 'good' });
      store.enrollFaceSample(p.id, { embedding: face(90), name: 'side-light' });
      store.enrollFaceSample(p.id, { embedding: face(140), name: 'blurred' });
      const match = store.identifyFaceForPerson(p.id, good, { threshold: 0.9 });
      expect(match.ok).toBe(true);
      expect(match.score).toBeGreaterThan(0.99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes individual face and voice samples without deleting the person profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
      const p = store.upsert({ displayName: '样本管理', relation: '测试' });
      store.enrollFaceSample(p.id, { embedding: face(1), name: 'front' });
      store.enrollFaceSample(p.id, { embedding: face(2), name: 'side' });
      await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(180), name: 'voice-a' });
      const before = store.get(p.id);
      expect(before).toMatchObject({ faceSamples: 2, voiceSamples: 1, displayName: '样本管理' });
      const faceId = before.faceSampleList[0].id;
      const voiceId = before.voiceSampleList[0].id;

      expect(store.deleteSample(p.id, 'face', faceId)).toMatchObject({ ok: true, person: { faceSamples: 1, voiceSamples: 1 } });
      expect(store.deleteSample(p.id, 'voice', voiceId)).toMatchObject({ ok: true, person: { faceSamples: 1, voiceSamples: 0 } });
      const after = store.get(p.id);
      expect(after).toMatchObject({ displayName: '样本管理', relation: '测试', faceSamples: 1, voiceSamples: 0 });
      expect(store.deleteSample(p.id, 'face', 'missing')).toMatchObject({ ok: false, person: { faceSamples: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a configured CAM++ voice engine for new voice samples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      const voiceEngine = {
        status: () => ({ ok: true, engine: 'campplus', modelReady: true }),
        embedAudio: () => ({ ok: true, engine: 'campplus', model: 'mock-campp', embedding: Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0)), seconds: 0.01, maxrssBytes: 1234 }),
      };
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json'), voiceEngine });
      const p = store.upsert({ displayName: '声纹模型测试' });
      for (let i = 0; i < 3; i += 1) await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(180 + i), name: `campp-${i}` });
      const listed = store.get(p.id);
      expect(listed.voiceSampleList[0]).toMatchObject({ dimension: 192, engine: 'campplus', model: 'mock-campp' });
      const match = await store.identifyVoiceForPerson(p.id, sineWav(181), { threshold: 0.78 });
      expect(match).toMatchObject({ ok: true, engine: 'campplus', model: 'mock-campp', sampleCount: 3 });
      expect(match.engineMaxrssBytes).toBe(1234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let legacy voice-lite samples override ready CAM++ samples for the same person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    let camppPass = false;
    try {
      const voiceEngine = {
        status: () => ({ ok: true, engine: 'campplus', modelReady: true }),
        embedAudio: () => ({ ok: true, engine: 'campplus', model: 'mock-campp', embedding: Array.from({ length: 192 }, (_, i) => (i === 0 ? (camppPass ? 1 : -1) : 0)) }),
      };
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json'), voiceEngine });
      const p = store.upsert({ displayName: '主人' });
      store.importVoiceEmbedding(p.id, { embedding: [1, 0, 0, 0, 0, 0, 0, 0], name: 'legacy-a' });
      store.importVoiceEmbedding(p.id, { embedding: [1, 0, 0, 0, 0, 0, 0, 0], name: 'legacy-b' });
      store.importVoiceEmbedding(p.id, { embedding: [1, 0, 0, 0, 0, 0, 0, 0], name: 'legacy-c' });
      camppPass = true;
      for (let i = 0; i < 3; i += 1) await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(190 + i), name: `campp-${i}` });
      camppPass = false;
      const rejected = await store.identifyVoiceForPerson(p.id, sineWav(181), { threshold: 0.78 });
      expect(rejected).toMatchObject({ ok: false, engine: 'campplus', reason: 'below_threshold' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to existing voice-lite samples until CAM++ samples are enrolled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    let selectedEngine = 'voice-lite';
    try {
      let campCalled = false;
      const voiceEngine = {
        status: () => ({ ok: true, engine: 'campplus', modelReady: true }),
        embedAudio: () => {
          campCalled = true;
          return { ok: true, engine: 'campplus', model: 'mock-campp', embedding: Array.from({ length: 192 }, (_, i) => (i === 0 ? -1 : 0)) };
        },
      };
      const modelSettings = { status: () => ({ voice: { enabled: true, engine: selectedEngine } }) };
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json'), voiceEngine, modelSettings });
      const p = store.upsert({ displayName: '主人' });
      for (const f of [180, 184, 176]) await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(f), name: `lite-${f}` });
      expect(store.get(p.id).voiceSampleList.every((s) => s.engine === 'voice-lite')).toBe(true);

      selectedEngine = 'campplus';
      const match = await store.identifyVoiceForPerson(p.id, sineWav(182), { threshold: 0.7 });
      expect(campCalled).toBe(true);
      expect(match).toMatchObject({ ok: true, engine: 'voice-lite', person: { displayName: '主人' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the lightweight voice algorithm when that engine is selected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      let called = false;
      const voiceEngine = {
        status: () => ({ ok: true, engine: 'campplus', modelReady: true }),
        embedAudio: () => { called = true; throw new Error('should not call campplus'); },
      };
      const modelSettings = { status: () => ({ voice: { enabled: true, engine: 'voice-lite' } }) };
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json'), voiceEngine, modelSettings });
      const p = store.upsert({ displayName: '轻量声纹' });
      await store.enrollVoiceSample(p.id, { audioBuffer: sineWav(180), name: 'lite' });
      expect(called).toBe(false);
      expect(store.get(p.id).voiceSampleList[0]).toMatchObject({ dimension: 26, engine: 'voice-lite' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not extract voice embeddings when the voice model is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-people-'));
    try {
      let called = false;
      const voiceEngine = {
        status: () => ({ ok: true, engine: 'campplus', modelReady: true }),
        embedAudio: () => { called = true; return { ok: true, engine: 'campplus', embedding: Array.from({ length: 192 }, () => 0) }; },
      };
      const modelSettings = { status: () => ({ voice: { enabled: false, engine: 'campplus' } }) };
      const store = new PersonKnowledgeStore({ file: join(dir, 'people.json'), voiceEngine, modelSettings });
      const p = store.upsert({ displayName: '关闭声纹' });
      await expect(store.enrollVoiceSample(p.id, { audioBuffer: sineWav(180), name: 'off' })).rejects.toThrow(/disabled/);
      expect(called).toBe(false);
      expect(await store.identifyVoiceForPerson(p.id, sineWav(180))).toMatchObject({ ok: false, reason: 'voice_model_disabled' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
