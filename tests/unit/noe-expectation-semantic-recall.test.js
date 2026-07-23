import { describe, it, expect } from 'vitest';
import { createClaimEventEmbedRecall, DEGRADED_KEY } from '../../src/cognition/NoeExpectationSemanticRecall.js';

// mock：embed 按文本返回固定向量；cosineSim 真算（与 EmbeddingProvider.cosineSim 同口径=Math.min 截断）
const mkEmbed = (map) => async (text) => map[text] || { vector: [0, 0, 0, 0], fallback: false };
function cos(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('NoeExpectationSemanticRecall', () => {
  it('召回 sim>=threshold 的事件，对象引用作键，低相似不纳入', async () => {
    const evA = { id: 'a' }, evB = { id: 'b' };
    const embed = mkEmbed({
      claim: { vector: [1, 0, 0, 0] },
      tA: { vector: [0.95, 0.05, 0, 0] }, // 高相似
      tB: { vector: [0, 1, 0, 0] },        // 正交 ≈0
    });
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos, threshold: 0.5 });
    const r = await recall('claim', [{ ev: evA, text: 'tA' }, { ev: evB, text: 'tB' }]);
    expect(r.has(evA)).toBe(true);
    expect(r.get(evA).similarity).toBeGreaterThan(0.9);
    expect(r.has(evB)).toBe(false);
  });

  it('R2 守卫：fallback 事件跳过且不污染，整体标 degraded', async () => {
    const evA = { id: 'a' }, evB = { id: 'b' };
    const embed = mkEmbed({
      claim: { vector: [1, 0, 0, 0] },
      tA: { vector: [1, 0, 0, 0] },
      tB: { vector: [0.5, 0.5], fallback: true }, // ollama 抖动退 128 维（这里 2 维模拟）
    });
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos });
    const r = await recall('claim', [{ ev: evA, text: 'tA' }, { ev: evB, text: 'tB' }]);
    expect(r.has(evA)).toBe(true);
    expect(r.has(evB)).toBe(false); // fallback 跳过，绝不靠 cosineSim 截断算假相似度
    expect(r.get(DEGRADED_KEY)?.degraded).toBe(true);
  });

  it('R2 守卫：维度不等跳过（防 cosineSim Math.min 假相似度）', async () => {
    const evA = { id: 'a' };
    const embed = mkEmbed({ claim: { vector: [1, 0, 0, 0] }, tA: { vector: [1, 0] } }); // 维度不等、无 fallback 标
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos });
    const r = await recall('claim', [{ ev: evA, text: 'tA' }]);
    expect(r.has(evA)).toBe(false);
  });

  it('claim 退 fallback → 整体降级（仅 DEGRADED，绝不用低维 claim 比）', async () => {
    const evA = { id: 'a' };
    const embed = mkEmbed({ claim: { vector: [1, 0], fallback: true }, tA: { vector: [1, 0, 0, 0] } });
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos });
    const r = await recall('claim', [{ ev: evA, text: 'tA' }]);
    expect(r.has(evA)).toBe(false);
    expect(r.get(DEGRADED_KEY)?.degraded).toBe(true);
  });

  it('embed/cosineSim 缺失 → null（OFF 走旧词面路径）', () => {
    expect(createClaimEventEmbedRecall({})).toBe(null);
    expect(createClaimEventEmbedRecall({ embed: async () => ({}) })).toBe(null);
  });

  it('空输入安全', async () => {
    const recall = createClaimEventEmbedRecall({ embed: async () => ({ vector: [1] }), cosineSim: cos });
    expect((await recall('', [{ ev: {}, text: 'x' }])).size).toBe(0);
    expect((await recall('claim', [])).size).toBe(0);
  });

  it('真实路径：embed 返回 Float32Array（非普通数组）也能召回（防 Array.isArray 漏判回归，端到端揪出的真 bug）', async () => {
    const evA = { id: 'a' };
    const f32 = (arr) => ({ vector: Float32Array.from(arr), fallback: false });
    const embed = async (text) => (text === 'claim' ? f32([1, 0, 0, 0]) : f32([0.95, 0.05, 0, 0]));
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos, threshold: 0.5 });
    const r = await recall('claim', [{ ev: evA, text: 'tA' }]);
    // EmbeddingProvider 返回 Float32Array，Array.isArray 对它恒 false——修复前这里会 degraded、漏召回
    expect(r.has(evA)).toBe(true);
    expect(r.get(DEGRADED_KEY)).toBeUndefined();
  });

  it('R5：候选超 maxEmbedEvents cap → 标 degraded（超 cap 候选被 slice 漏召回，可观测）', async () => {
    const embed = async (text) => ({ vector: text === 'claim' ? [1, 0, 0, 0] : [0.9, 0.1, 0, 0], fallback: false });
    const recall = createClaimEventEmbedRecall({ embed, cosineSim: cos, threshold: 0.5, maxEmbedEvents: 2 });
    const events = [{ ev: { id: 'a' }, text: 'a' }, { ev: { id: 'b' }, text: 'b' }, { ev: { id: 'c' }, text: 'c' }]; // 3 > cap 2
    const r = await recall('claim', events);
    expect(r.get(DEGRADED_KEY)?.degraded).toBe(true); // 超 cap → degraded 可观测
  });
});
