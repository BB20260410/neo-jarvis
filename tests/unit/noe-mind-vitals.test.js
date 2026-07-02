import { describe, it, expect } from 'vitest';
import { createMindVitals } from '../../src/cognition/NoeMindVitals.js';

// 确定性假嵌入：按文本首字符给固定向量，便于精确断言相似度
function fakeEmbed(map) {
  const calls = [];
  const fn = async (text) => { calls.push(text); return map[text[0]] || null; };
  fn.calls = calls;
  return fn;
}
const V_A = [1, 0, 0];
const V_A2 = [0.96, 0.28, 0]; // 与 A 余弦 ≈0.96
const V_B = [0, 1, 0];

describe('NoeMindVitals 心智体征', () => {
  it('similarity：语义相近高分、正交低分；缓存命中不重复嵌入', async () => {
    const embed = fakeEmbed({ a: V_A, b: V_B, c: V_A2 });
    const mv = createMindVitals({ embedText: embed });
    expect(await mv.similarity('k1', 'aaa', 'k2', 'ccc')).toBeGreaterThan(0.9);
    expect(await mv.similarity('k1', 'aaa', 'k3', 'bbb')).toBeLessThan(0.1);
    const n = embed.calls.length;
    await mv.similarity('k1', 'aaa', 'k3', 'bbb'); // 全缓存
    expect(embed.calls.length).toBe(n);
  });

  it('diversity：同质组多样性低、异质组高；<2 条返回 null', async () => {
    const embed = fakeEmbed({ a: V_A, c: V_A2, b: V_B });
    const mv = createMindVitals({ embedText: embed });
    const same = await mv.diversity([{ key: '1', text: 'a一' }, { key: '2', text: 'c二' }]);
    expect(same.avgSim).toBeGreaterThan(0.9);
    expect(same.diversity).toBeLessThan(0.1);
    const diff = await mv.diversity([{ key: '1', text: 'a一' }, { key: '3', text: 'b三' }]);
    expect(diff.diversity).toBeGreaterThan(0.9);
    expect((await mv.diversity([{ key: '1', text: 'a' }])).diversity).toBe(null);
  });

  it('groundedness：返回与经历的最大相似度与引用键', async () => {
    const embed = fakeEmbed({ a: V_A, b: V_B, c: V_A2 });
    const mv = createMindVitals({ embedText: embed });
    const g = await mv.groundedness('t', 'c念头', [{ key: 'e1', text: 'b经历' }, { key: 'e2', text: 'a经历' }]);
    expect(g.score).toBeGreaterThan(0.9);
    expect(g.refKey).toBe('e2');
    expect(await mv.groundedness('t', 'c念头', [])).toBe(null);
  });

  it('嵌入炸了 fail-open：similarity/diversity/groundedness 全返回 null 形态', async () => {
    const mv = createMindVitals({ embedText: async () => { throw new Error('炸'); } });
    expect(await mv.similarity('1', 'x', '2', 'y')).toBe(null);
    expect((await mv.diversity([{ key: '1', text: 'x' }, { key: '2', text: 'y' }])).diversity).toBe(null);
    expect(await mv.groundedness('t', 'x', [{ key: 'e', text: 'y' }])).toBe(null);
  });
});
