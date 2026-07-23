import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionSession } from '../../src/vision/VisionSession.js';
import { PersonKnowledgeStore } from '../../src/identity/PersonKnowledgeStore.js';

const vec = (seed, n = 64) => { const a = Array.from({ length: n }, () => 0); a[seed % n] = 1; a[(seed * 7 + 3) % n] = 0.5; return a; };
const fakeFaceEngine = (map) => ({ embedImage: async (b64) => ({ ok: true, embedding: map[b64] || [] }) });

let dir; let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-vis-'));
  store = new PersonKnowledgeStore({ file: path.join(dir, 'people.json') });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('VisionSession.recognizeWho', () => {
  it('没有摄像头帧 → no_camera_frame + 提示开摄像头', async () => {
    const vs = new VisionSession({ mode: 'camera' });
    const r = await vs.recognizeWho({ faceEngine: fakeFaceEngine({}), personStore: store });
    expect(r).toMatchObject({ ok: false, reason: 'no_camera_frame' });
    expect(r.say).toMatch(/摄像头/);
  });

  it('推帧后认出已录入的人', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' });
    store.enrollFaceSample(p.id, { embedding: vec(1), name: 'f1' });
    const vs = new VisionSession({ mode: 'camera' });
    vs.pushFrame(Buffer.from('frame-wang'), 'jpeg');
    // 假引擎按"帧的 base64"返回向量；frame-wang 的 base64 映射到 vec(1)
    const b64 = Buffer.from('frame-wang').toString('base64');
    const r = await vs.recognizeWho({ faceEngine: fakeFaceEngine({ [b64]: vec(1) }), personStore: store });
    expect(r).toMatchObject({ ok: true, recognized: true });
    expect(r.person.displayName).toBe('老王');
    expect(r.say).toContain('老王');
  });

  it('陌生人 → 不认识并引导录入', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' });
    store.enrollFaceSample(p.id, { embedding: vec(1), name: 'f1' });
    const vs = new VisionSession({ mode: 'camera' });
    vs.pushFrame(Buffer.from('frame-x'), 'jpeg');
    const b64 = Buffer.from('frame-x').toString('base64');
    const r = await vs.recognizeWho({ faceEngine: fakeFaceEngine({ [b64]: vec(50) }), personStore: store });
    expect(r.recognized).toBe(false);
    expect(r.say).toMatch(/不认识|告诉我他是谁/);
  });

  it('setFaceRecog 只接受 off/ask/auto', () => {
    const vs = new VisionSession({ faceRecog: 'ask' });
    expect(vs.setFaceRecog('auto')).toBe('auto');
    expect(vs.setFaceRecog('off')).toBe('off');
    expect(vs.setFaceRecog('乱填')).toBe('off'); // 非法保持原值
  });

  it('关视觉(off)后清除陈旧帧，一律认不了人(隐私)', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' }); store.enrollFaceSample(p.id, { embedding: vec(1), name: 'a' });
    const vs = new VisionSession({ mode: 'camera' });
    vs.pushFrame(Buffer.from('frame-wang'), 'jpeg');
    vs.setMode('off'); // 关视觉应清掉缓存帧
    expect(vs.getCameraFrame()).toBeNull();
    const b64 = Buffer.from('frame-wang').toString('base64');
    const r = await vs.recognizeWho({ faceEngine: fakeFaceEngine({ [b64]: vec(1) }), personStore: store });
    expect(r).toMatchObject({ ok: false, reason: 'no_camera_frame' });
  });
});
