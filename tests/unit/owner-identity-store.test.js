import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OwnerIdentityStore } from '../../src/identity/OwnerIdentityStore.js';
import { CampPlusVoiceClient } from '../../src/identity/CampPlusVoiceClient.js';
import { computeVoiceEmbedding, scoreVoiceEmbedding } from '../../src/identity/Voiceprint.js';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

function sineWav(freq, seconds = 1.2, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 18000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

describe('OwnerIdentityStore voiceprint', () => {
  it('scores a voiceprint against the closest enrolled sample', () => {
    const scored = scoreVoiceEmbedding([1, 0, 0, 0, 0, 0, 0, 0], [
      { embedding: [-1, 0, 0, 0, 0, 0, 0, 0] },
      { embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
      { embedding: [-0.9, 0.1, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(scored.bestScore).toBeGreaterThan(0.99);
    expect(scored.score).toBeGreaterThan(0.99);
    expect(scored.centroidScore).toBeLessThan(0);
  });

  it('computes stable local voice embeddings and verifies enrolled voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const store = new OwnerIdentityStore({ file, voiceEngine: null }); // 纯 lite 路径(本用例校准在 lite)
      const a = sineWav(180);
      const b = sineWav(185);
      expect(computeVoiceEmbedding(a).length).toBeGreaterThan(10);
      await store.enrollVoiceSample({ audioBuffer: a, name: 'sample-a' });
      await store.enrollVoiceSample({ audioBuffer: b, name: 'sample-b' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(175), name: 'sample-c' });
      expect(store.status().voice).toMatchObject({ samples: 3, ready: true });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.bak-latest`)).toBe(true);
      const verified = await store.verifyVoice(sineWav(182));
      expect(verified.enrolled).toBe(true);
      expect(verified.score).toBeGreaterThan(0.8);
      expect(store.status().voice.lastVerification).toMatchObject({ enrolled: true, score: verified.score });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores and verifies local face embeddings without raw images', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const store = new OwnerIdentityStore({ file });
      const faceA = Array.from({ length: 32 }, (_, i) => Math.sin(i / 3));
      const faceB = Array.from({ length: 32 }, (_, i) => Math.sin(i / 3 + 0.02));
      store.enrollFaceSample({ embedding: faceA, name: 'front' });
      expect(store.status().face).toMatchObject({ samples: 1, ready: true });
      store.enrollFaceSample({ embedding: faceB, name: 'left' });
      store.enrollFaceSample({ embedding: faceA.map((v) => v * 0.98), name: 'right' });
      store.updateFaceConfig({ enabled: true, threshold: 0.8 });
      expect(store.status().face).toMatchObject({ enabled: true, samples: 3, ready: true });
      expect(existsSync(`${file}.bak-latest`)).toBe(true);
      const verified = store.verifyFaceEmbedding(faceA);
      expect(verified.ok).toBe(true);
      expect(store.status().face.lastVerification).toMatchObject({ ok: true, score: verified.score });
      expect(store.shouldGateFace()).toBe(true);
      expect(JSON.parse(String(readFileSync(file))).face.samples[0].embedding).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can bind owner gates to a person profile instead of hidden owner samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const store = new OwnerIdentityStore({ file });
      store.bindFacePerson('person_owner', { enabled: true });
      store.bindVoicePerson('person_owner', { enabled: true });
      expect(store.status().face).toMatchObject({ enabled: true, samples: 0, ready: false, ownerPersonId: 'person_owner' });
      expect(store.status().voice).toMatchObject({ enabled: true, samples: 0, ready: false, ownerPersonId: 'person_owner' });
      expect(store.shouldGateFace()).toBe(true);
      expect(store.shouldGateVoice()).toBe(true);
      const reloaded = new OwnerIdentityStore({ file });
      expect(reloaded.status().face.ownerPersonId).toBe('person_owner');
      expect(reloaded.status().voice.ownerPersonId).toBe('person_owner');
      expect(reloaded.clearFace().ownerPersonId).toBe('');
      expect(reloaded.clearVoice().ownerPersonId).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates VoiceSession audio only after voiceprint is enabled and enrolled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    try {
      const store = new OwnerIdentityStore({ file: join(dir, 'owner-identity.json'), voiceEngine: null });
      await store.enrollVoiceSample({ audioBuffer: sineWav(180), name: 'a' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(185), name: 'b' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(175), name: 'c' });
      store.updateVoiceConfig({ enabled: true, threshold: 0.5 });
      const vs = new VoiceSession({
        sttClient: { transcribe: async () => '你好' },
        ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) },
        brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
        getAdapter: () => ({ chat: async () => ({ reply: '主人，我在。' }) }),
        identityStore: { shouldGateVoice: () => true, verifyVoice: () => ({ ok: false, score: 0.1, threshold: 0.9 }) },
      });
      const rejected = await vs.chat(sineWav(700));
      expect(rejected).toMatchObject({ ok: false, intent: 'voiceprint_gate', ignored: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires current face verification when face gate is ready', async () => {
    let sttCalled = false;
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => { sttCalled = true; return '你好'; } },
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: '不应回复' }) }),
      identityStore: {
        shouldGateVoice: () => true,
        verifyVoice: () => ({ ok: true, score: 0.99, threshold: 0.9 }),
        shouldGateFace: () => true,
        status: () => ({ face: { threshold: 0.9 } }),
        verifyFaceEmbedding: () => ({ ok: false, score: 0.2, threshold: 0.9 }),
      },
    });
    const rejected = await vs.chat(sineWav(180), { faceEmbedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    expect(rejected).toMatchObject({ ok: false, intent: 'owner_identity_gate', ignored: true });
    expect(sttCalled).toBe(false);
  });

  it('injects verified owner identity into the model context when voice and face pass', async () => {
    let seenSystem = '';
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '现在是不是我在说话' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) },
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => ({ chat: async (messages) => { seenSystem = messages[0].content; return { reply: '是的，这轮通过了主人验证。' }; } }),
      identityStore: {
        shouldGateVoice: () => true,
        verifyVoice: () => ({ ok: true, score: 0.98, threshold: 0.9 }),
        shouldGateFace: () => true,
        verifyFaceEmbedding: () => ({ ok: true, score: 0.97, threshold: 0.9 }),
      },
    });
    const r = await vs.chat(sineWav(180), { faceEmbedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    expect(r.ok).toBe(true);
    expect(seenSystem).toContain('声纹验证通过');
    expect(seenSystem).toContain('当前摄像头人脸验证通过');
    expect(seenSystem).toContain('主人本人正在说话');
  });

  it('uses person knowledge bindings for owner voice and face gates', async () => {
    let voiceChecked = false;
    let faceChecked = false;
    let hiddenVoiceCalled = false;
    let hiddenFaceCalled = false;
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '现在是不是我在说话' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) },
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: '是主人本人。' }) }),
      identityStore: {
        shouldGateVoice: () => true,
        shouldGateFace: () => true,
        status: () => ({ voice: { ownerPersonId: 'person_owner', threshold: 0.8 }, face: { ownerPersonId: 'person_owner', threshold: 0.82 } }),
        verifyVoice: () => { hiddenVoiceCalled = true; return { ok: false }; },
        verifyFaceEmbedding: () => { hiddenFaceCalled = true; return { ok: false }; },
      },
      personStore: {
        identifyVoiceForPerson: (id, _wav, opts) => { voiceChecked = id === 'person_owner' && opts.threshold === 0.8; return { ok: true, score: 0.96, threshold: opts.threshold, person: { displayName: '主人', faceSamples: 3, voiceSamples: 3 } }; },
        identifyFaceForPerson: (id, _emb, opts) => { faceChecked = id === 'person_owner' && opts.threshold === 0.58 && opts.minSamples === 1; return { ok: true, score: 0.97, threshold: opts.threshold, person: { displayName: '主人', faceSamples: 1, voiceSamples: 3 } }; },
      },
    });
    const r = await vs.chat(sineWav(180), { faceEmbedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    expect(r.ok).toBe(true);
    expect(voiceChecked).toBe(true);
    expect(faceChecked).toBe(true);
    expect(hiddenVoiceCalled).toBe(false);
    expect(hiddenFaceCalled).toBe(false);
  });

  it('relaxes face threshold after voice has already verified the owner', async () => {
    let faceThreshold = null;
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '你好' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) },
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: '通过。' }) }),
      identityStore: {
        shouldGateVoice: () => true,
        shouldGateFace: () => true,
        status: () => ({ voice: { ownerPersonId: 'person_owner', threshold: 0.92 }, face: { ownerPersonId: 'person_owner', threshold: 0.9 } }),
      },
      personStore: {
        identifyVoiceForPerson: () => ({ ok: true, score: 0.96, threshold: 0.92, person: { displayName: '主人' } }),
        identifyFaceForPerson: (_id, _emb, opts) => { faceThreshold = opts.threshold; return { ok: true, score: 0.73, threshold: opts.threshold, person: { displayName: '主人' } }; },
      },
    });
    const r = await vs.chat(sineWav(180), { faceEmbedding: Array.from({ length: 16 }, (_, i) => i / 16) });
    expect(r.ok).toBe(true);
    expect(faceThreshold).toBe(0.58);
  });

  // ── CAMPPlus 双引擎(用确定性假客户端,不依赖本机 python 模型)──
  // 假 CAMPPlus:用过零率(≈基频)生成可清晰区分的高斯凸包向量 → 同频近、异频远。
  function camppEmbed(buf) {
    let prev = 0; let crossings = 0; let n = 0;
    for (let off = 44; off + 1 < buf.length; off += 2) {
      const v = buf.readInt16LE(off);
      if (n > 0 && ((v >= 0) !== (prev >= 0))) crossings += 1;
      prev = v; n += 1;
    }
    const rate = n ? crossings / n : 0;
    const center = Math.min(63, Math.max(0, Math.round(rate * 600)));
    return Array.from({ length: 64 }, (_, i) => Math.exp(-((i - center) ** 2) / 8));
  }
  function makeFakeCampp() {
    const spy = { calls: 0 };
    return { spy, embedAudio: (buf) => { spy.calls += 1; return { ok: true, engine: 'campplus', model: 'fake-campp', embedding: camppEmbed(buf) }; } };
  }

  it('CAMPPlus 引擎:本人通过 / 他人(及杂音异频)被拒,且样本带 lite 兜底', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const store = new OwnerIdentityStore({ file, voiceEngine: makeFakeCampp() });
      const r = await store.enrollVoiceSample({ audioBuffer: sineWav(180), name: 'a' });
      expect(r.sample.engine).toBe('campplus');
      await store.enrollVoiceSample({ audioBuffer: sineWav(182), name: 'b' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(175), name: 'c' });
      // 落盘样本应带 campplus 标记 + lite 兜底向量
      const saved = JSON.parse(String(readFileSync(file))).voice.samples[0];
      expect(saved.engine).toBe('campplus');
      expect(Array.isArray(saved.liteEmbedding) && saved.liteEmbedding.length).toBeTruthy();

      const me = await store.verifyVoice(sineWav(181));
      expect(me).toMatchObject({ enrolled: true, engine: 'campplus', ok: true });
      expect(me.score).toBeGreaterThan(0.72);
      const other = await store.verifyVoice(sineWav(700)); // 别人/异频/杂音
      expect(other.engine).toBe('campplus');
      expect(other.ok).toBe(false);
      expect(other.score).toBeLessThan(0.72);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CAMPPlus 录入后引擎损坏:自动回退 lite 兜底向量,绝不把主人锁在门外', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const store = new OwnerIdentityStore({ file, voiceEngine: makeFakeCampp() });
      await store.enrollVoiceSample({ audioBuffer: sineWav(180), name: 'a' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(182), name: 'b' });
      await store.enrollVoiceSample({ audioBuffer: sineWav(175), name: 'c' });
      // 模拟 CAMPPlus 运行时崩溃
      store.voiceEngine = { embedAudio: () => { throw new Error('campp down'); } };
      const me = await store.verifyVoice(sineWav(181));
      expect(me).toMatchObject({ enrolled: true, engine: 'voice-lite', ok: true }); // 仍认得主人
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('向后兼容:老 lite 录入无需重录仍可验证,且不白跑深度模型', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const seed = new OwnerIdentityStore({ file, voiceEngine: null }); // 老数据=纯 lite
      await seed.enrollVoiceSample({ audioBuffer: sineWav(180), name: 'a' });
      await seed.enrollVoiceSample({ audioBuffer: sineWav(182), name: 'b' });
      await seed.enrollVoiceSample({ audioBuffer: sineWav(175), name: 'c' });

      const fake = makeFakeCampp();
      const store = new OwnerIdentityStore({ file, voiceEngine: fake }); // 重载老样本
      const me = await store.verifyVoice(sineWav(181));
      expect(me).toMatchObject({ enrolled: true, engine: 'voice-lite', ok: true });
      expect(fake.spy.calls).toBe(0); // 没有 campplus 样本 → 不触发深度模型,零延迟回归
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('尊重 modelSettings:切到 voice-lite 时主人门禁不走 CAMPPlus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    const file = join(dir, 'owner-identity.json');
    try {
      const fake = makeFakeCampp();
      const store = new OwnerIdentityStore({ file, voiceEngine: fake, modelSettings: { voiceEngine: () => 'voice-lite' } });
      const r = await store.enrollVoiceSample({ audioBuffer: sineWav(180), name: 'a' });
      expect(r.sample.engine).toBe('voice-lite');
      expect(fake.spy.calls).toBe(0); // 设置为 lite → 完全不调用 CAMPPlus
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs CAMPPlus with async spawn and a minimal child environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-campp-client-'));
    try {
      const python = join(dir, 'python');
      const script = join(dir, 'campp-speaker-embed.py');
      const modelDir = join(dir, 'model');
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(python, '# fake python\n');
      writeFileSync(script, '# fake script\n');
      writeFileSync(join(modelDir, 'campplus_cn_common.bin'), 'fake model\n');
      let capturedEnv = null;
      let capturedInput = '';
      const spawnImpl = (_cmd, _args, opts) => {
        capturedEnv = opts.env;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
          end(input) {
            capturedInput = String(input || '');
            queueMicrotask(() => {
              child.stdout.emit('data', `${JSON.stringify({ ok: true, engine: 'campplus', model: 'fake', embedding: Array.from({ length: 16 }, () => 0.1) })}\n`);
              child.emit('close', 0, null);
            });
          },
        };
        child.kill = () => {};
        return child;
      };
      const client = new CampPlusVoiceClient({
        python,
        script,
        modelDir,
        spawnImpl,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: dir,
          MINIMAX_API_KEY: 'must-not-leak',
          OPENAI_API_KEY: 'must-not-leak',
          OMP_NUM_THREADS: '2',
        },
      });

      const out = await client.embedAudio(sineWav(180), { timeoutMs: 1000 });
      expect(out).toMatchObject({ ok: true, engine: 'campplus', model: 'fake' });
      expect(capturedEnv).toMatchObject({ PATH: '/usr/bin:/bin', HOME: dir, NOE_CAMPP_MODEL_DIR: modelDir, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '2' });
      expect(capturedEnv.MINIMAX_API_KEY).toBeUndefined();
      expect(capturedEnv.OPENAI_API_KEY).toBeUndefined();
      expect(JSON.parse(capturedInput).modelDir).toBe(modelDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('阈值滑块作用于当前生效引擎并持久化(campplus 与 lite 各管各)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-identity-'));
    try {
      const file = join(dir, 'owner.json');
      const store = new OwnerIdentityStore({ file, voiceEngine: makeFakeCampp() }); // campplus 生效
      store.updateVoiceConfig({ enabled: true, threshold: 0.85 });
      expect(store.status().voice).toMatchObject({ engine: 'campplus', activeThreshold: 0.85, camppThreshold: 0.85 });
      expect(store.status().voice.threshold).toBe(0.78); // lite 阈值未被动
      const reloaded = new OwnerIdentityStore({ file, voiceEngine: makeFakeCampp() });
      expect(reloaded.status().voice.camppThreshold).toBe(0.85); // 持久化

      const lite = new OwnerIdentityStore({ file: join(dir, 'lite.json'), voiceEngine: null, modelSettings: { voiceEngine: () => 'voice-lite' } });
      lite.updateVoiceConfig({ enabled: true, threshold: 0.6 });
      expect(lite.status().voice).toMatchObject({ engine: 'voice-lite', activeThreshold: 0.6, threshold: 0.6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a face-backed owner pass when the rough voiceprint is close but below the strict threshold', async () => {
    let seenSystem = '';
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '现在是不是我在说话' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) },
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => ({ chat: async (messages) => { seenSystem = messages[0].content; return { reply: '是你。' }; } }),
      identityStore: {
        shouldGateVoice: () => true,
        shouldGateFace: () => true,
        status: () => ({ voice: { ownerPersonId: 'person_owner', threshold: 0.92 }, face: { ownerPersonId: 'person_owner', threshold: 0.55 } }),
      },
      personStore: {
        identifyVoiceForPerson: () => ({ ok: false, score: 0.72, threshold: 0.92, reason: 'below_threshold', person: { displayName: '主人' } }),
        identifyFaceForPerson: () => ({ ok: true, score: 0.86, threshold: 0.55, person: { displayName: '主人' } }),
      },
    });
    const r = await vs.chat(sineWav(180), { faceEmbedding: Array.from({ length: 16 }, (_, i) => i / 16) });
    expect(r.ok).toBe(true);
    expect(seenSystem).toContain('人脸辅助通过底线');
  });
});
