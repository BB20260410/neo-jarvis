import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonKnowledgeStore } from '../../src/identity/PersonKnowledgeStore.js';
import { recognizeFaceFromImage, describeRecognizedPerson } from '../../src/vision/FaceRecognition.js';

// 假 InsightFace:把"图"直接当 embedding 用(测试里 imageBase64 传一个标记，引擎按标记吐对应向量)
function fakeFaceEngine(map) {
  return { embedImage: async (b64) => { const v = map[b64]; if (v === 'throw') throw new Error('no face detected'); if (!v) return { ok: true, embedding: [] }; return { ok: true, embedding: v }; } };
}
// 近正交向量:同 seed→cosine=1(同人),不同 seed→cosine≈0(陌生人),稳定可判
const vec = (seed, n = 64) => { const a = Array.from({ length: n }, () => 0); a[seed % n] = 1; a[(seed * 7 + 3) % n] = 0.5; return a; };

let dir; let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-face-'));
  store = new PersonKnowledgeStore({ file: path.join(dir, 'people.json') });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('FaceRecognition 看摄像头认人闭环', () => {
  it('认出已录入的人 → recognized + person', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' });
    store.enrollFaceSample(p.id, { embedding: vec(1), name: 'f1' });
    const r = await recognizeFaceFromImage({ imageBase64: 'wang', faceEngine: fakeFaceEngine({ wang: vec(1) }), personStore: store });
    expect(r).toMatchObject({ ok: true, recognized: true });
    expect(r.person.displayName).toBe('老王');
    expect(describeRecognizedPerson(r)).toContain('老王');
    expect(describeRecognizedPerson(r)).toContain('同事');
  });

  it('陌生人(库里没有相近的)→ 不认识 + 引导录入话术', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' });
    store.enrollFaceSample(p.id, { embedding: vec(1), name: 'f1' });
    const r = await recognizeFaceFromImage({ imageBase64: 'stranger', faceEngine: fakeFaceEngine({ stranger: vec(99) }), personStore: store });
    expect(r).toMatchObject({ ok: true, recognized: false });
    expect(describeRecognizedPerson(r)).toMatch(/不认识|告诉我他是谁/);
  });

  it('画面没人脸 → no_face,话术提示正对摄像头', async () => {
    const r = await recognizeFaceFromImage({ imageBase64: 'empty', faceEngine: fakeFaceEngine({ empty: null }), personStore: store });
    expect(r).toMatchObject({ ok: false, reason: 'no_face' });
    expect(describeRecognizedPerson(r)).toMatch(/没看清|人脸/);
  });

  it('引擎报错(没装好)→ face_engine_error', async () => {
    const r = await recognizeFaceFromImage({ imageBase64: 'x', faceEngine: { embedImage: async () => { throw new Error('InsightFace runtime not installed'); } }, personStore: store });
    expect(r).toMatchObject({ ok: false, reason: 'face_engine_error' });
    expect(describeRecognizedPerson(r)).toMatch(/引擎|没装/);
  });

  it('没图 → no_image', async () => {
    const r = await recognizeFaceFromImage({ faceEngine: fakeFaceEngine({}), personStore: store });
    expect(r).toMatchObject({ ok: false, reason: 'no_image' });
  });

  it('多人画面：认出所有已录入的人 + 数清未录入的', async () => {
    const a = store.upsert({ displayName: '老王', relation: '同事' }); store.enrollFaceSample(a.id, { embedding: vec(1), name: 'a' });
    const b = store.upsert({ displayName: '小美', relation: '朋友' }); store.enrollFaceSample(b.id, { embedding: vec(7), name: 'b' });
    // 引擎返回 3 张脸:老王 + 小美 + 一个陌生人
    const eng = { embedImage: async () => ({ ok: true, faces: [{ embedding: vec(1) }, { embedding: vec(7) }, { embedding: vec(50) }] }) };
    const r = await recognizeFaceFromImage({ imageBase64: 'group', faceEngine: eng, personStore: store });
    expect(r.faceCount).toBe(3);
    expect(r.faces.filter((f) => f.recognized).length).toBe(2);
    const say = describeRecognizedPerson(r);
    expect(say).toContain('老王');
    expect(say).toContain('小美');
    expect(say).toMatch(/1 个我没见过/);
  });

  it('单脸结构向后兼容：只返回 embedding 的旧引擎仍走单脸路径', async () => {
    const p = store.upsert({ displayName: '老王', relation: '同事' }); store.enrollFaceSample(p.id, { embedding: vec(1), name: 'a' });
    const r = await recognizeFaceFromImage({ imageBase64: 'wang', faceEngine: fakeFaceEngine({ wang: vec(1) }), personStore: store });
    expect(r.faceCount).toBe(1);
    expect(r.recognized).toBe(true); // 顶层主脸字段仍在
    expect(describeRecognizedPerson(r)).toContain('老王');
  });

  it('话术能融合人物卡的偏好/事件', async () => {
    const p = store.upsert({ displayName: '小美', relation: '朋友' });
    store.enrollFaceSample(p.id, { embedding: vec(7), name: 'f1' });
    const r = await recognizeFaceFromImage({ imageBase64: 'mei', faceEngine: fakeFaceEngine({ mei: vec(7) }), personStore: store });
    const personCards = { getByAlias: (a) => (a === '小美' ? { preferences: { 忌口: '香菜' }, events: [{ text: '一起爬了山' }] } : null) };
    const line = describeRecognizedPerson(r, { personCards });
    expect(line).toContain('小美');
    expect(line).toMatch(/香菜|爬了山/);
  });
});
