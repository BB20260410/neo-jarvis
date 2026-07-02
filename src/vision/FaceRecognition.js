// FaceRecognition — "这是谁"闭环:摄像头帧 → InsightFace 提脸(支持多张) → identifyFace 1:N 搜
//   → 命中取人物卡组织话术 / 没命中说不认识并引导录入。
// 复用既有件:InsightFaceClient(已装 buffalo_l)、PersonKnowledgeStore.identifyFace(1:N)、
//   NoePersonCards(关系/偏好/事件)。纯逻辑、依赖注入,可独立单测(假 faceEngine)。
// 多人画面:认出所有已录入的人,未录入的计数;主脸(最大)展开为顶层兼容字段。

import { defaultInsightFaceClient } from '../identity/InsightFaceClient.js';
import { defaultPersonKnowledgeStore } from '../identity/PersonKnowledgeStore.js';

// 从一张图认出所有脸分别是谁。返回归一化结果,不抛(失败用 reason 表达)。
export async function recognizeFaceFromImage({
  imageBuffer,
  imageBase64,
  faceEngine = defaultInsightFaceClient,
  personStore = defaultPersonKnowledgeStore,
  threshold,
} = {}) {
  const b64 = imageBase64 || (imageBuffer && imageBuffer.length ? Buffer.from(imageBuffer).toString('base64') : '');
  if (!b64) return { ok: false, reason: 'no_image' };

  let out = null;
  try {
    out = await faceEngine.embedImage(b64);
  } catch (e) {
    const msg = e?.message || String(e);
    if (/no face|face not found|未检测到|no_face/i.test(msg)) return { ok: false, reason: 'no_face' };
    return { ok: false, reason: 'face_engine_error', error: msg };
  }
  // 多脸优先 out.faces[](已按大小排序);否则退回单脸 out.embedding
  const faceVecs = Array.isArray(out?.faces) && out.faces.length
    ? out.faces.map((f) => f?.embedding).filter((v) => Array.isArray(v) && v.length)
    : (Array.isArray(out?.embedding) && out.embedding.length ? [out.embedding] : []);
  if (!faceVecs.length) return { ok: false, reason: 'no_face' };

  const faces = faceVecs.map((vec) => {
    const r = personStore.identifyFace(vec, threshold ? { threshold } : {});
    return r?.ok === true
      ? { recognized: true, person: r.person, score: r.score }
      : { recognized: false, reason: r?.reason || 'unknown', bestGuess: r?.person || null, score: r?.score || 0 };
  });
  const primary = faces[0];
  // 顶层展开主脸,兼容只关心单人的调用方
  return { ok: true, faceCount: faces.length, faces, recognized: primary.recognized, person: primary.person, score: primary.score, reason: primary.reason, bestGuess: primary.bestGuess };
}

// 单个人的自然话术(命中):这是X，你的同事。+ 可选人物卡偏好/事件
function sayOnePerson(f, personCards) {
  const p = f.person || {};
  const name = p.displayName || '某个人';
  const bits = [`这是${name}`];
  if (p.relation) bits.push(`，你的${p.relation}`);
  let card = null;
  if (personCards?.getByAlias) {
    try { card = personCards.getByAlias(name) || (p.aliases || []).map((a) => personCards.getByAlias(a)).find(Boolean) || null; } catch { card = null; }
  }
  const extras = [];
  if (p.notes) extras.push(p.notes);
  if (card?.preferences && typeof card.preferences === 'object') {
    const prefs = Object.entries(card.preferences).slice(0, 2).map(([k, v]) => `${k}：${v}`);
    if (prefs.length) extras.push(prefs.join('、'));
  }
  if (Array.isArray(card?.events) && card.events.length) {
    const last = card.events[card.events.length - 1];
    if (last?.text || last?.summary) extras.push(`上次${last.text || last.summary}`);
  }
  let line = bits.join('');
  if (extras.length) line += `。${extras.slice(0, 2).join('；')}`;
  return `${line}。`;
}

// 把识别结果组织成一句自然中文(给 TTS 读 / 喂大脑)。单脸=具体介绍;多脸=综合点名 + 未知计数。
export function describeRecognizedPerson(result, { personCards = null } = {}) {
  if (!result || result.ok === false) {
    const reason = result?.reason || 'unknown';
    if (reason === 'no_image') return '我现在没拿到摄像头画面，先帮我打开摄像头看一下。';
    if (reason === 'no_face') return '镜头里我没看清人脸，让他正对摄像头、光线亮一点再试。';
    if (reason === 'face_engine_error') return '人脸识别引擎没跑起来（InsightFace 没装好或没启动），我先认不了人。';
    return '我这边出了点问题，没认出来。';
  }
  const faces = Array.isArray(result.faces) && result.faces.length ? result.faces : [result];

  if (faces.length <= 1) {
    const f = faces[0] || result;
    if (!f.recognized) return '摄像头里这个人我不认识，没在你的人物库里。要的话告诉我他是谁、跟你什么关系，我记下来下次就认得了。';
    return sayOnePerson(f, personCards);
  }

  // 多脸
  const known = faces.filter((f) => f.recognized);
  const names = known.map((f) => (f.person?.relation ? `${f.person.displayName}（${f.person.relation}）` : f.person?.displayName)).filter(Boolean);
  const unknown = faces.length - known.length;
  let line = `画面里有 ${faces.length} 个人`;
  if (names.length) line += `：${names.join('、')}`;
  if (unknown) line += `${names.length ? '；还有' : '，其中'} ${unknown} 个我没见过`;
  line += '。';
  if (unknown && !names.length) line += '要把他们记进人物库吗？告诉我各是谁。';
  return line;
}
