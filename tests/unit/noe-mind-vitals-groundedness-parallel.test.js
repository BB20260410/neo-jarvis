// 批3 性能：NoeMindVitals.groundedness 把经历向量嵌入从逐条 await 串行改成 Promise.all 并行
// （与既有 diversity() 同款）。本测证明 ①结果（score/refKey）与串行逐字等价 ②确实并行：
// 所有经历嵌入请求在任一完成前都已发起。全确定性：注入受控 embedText，不触网/不依赖真实时钟。
import { describe, it, expect } from 'vitest';
import { createMindVitals } from '../../src/cognition/NoeMindVitals.js';

const V = {
  t: [1, 0, 0],        // 念头
  e_far: [0, 1, 0],    // 与念头正交
  e_mid: [0.6, 0.8, 0], // 中等
  e_near: [0.96, 0.28, 0], // 与念头 ≈0.96
};

describe('NoeMindVitals.groundedness 并行嵌入等价', () => {
  it('结果 score/refKey 与逐条串行实现逐字等价（最大值 + 先出现者优先并列）', async () => {
    const embed = async (text) => V[text] || null;
    const mv = createMindVitals({ embedText: embed });
    const g = await mv.groundedness('tk', 't', [
      { key: 'e1', text: 'e_far' },
      { key: 'e2', text: 'e_near' },
      { key: 'e3', text: 'e_mid' },
    ]);
    // 念头=t，最近的是 e_near（e2）≈0.96
    expect(g.refKey).toBe('e2');
    expect(g.score).toBeGreaterThan(0.95);
    expect(g.score).toBeLessThan(0.97);
  });

  it('并列最大值保留先出现者（与串行 `s > best` 严格大于一致）', async () => {
    const embed = async (text) => V[text] || null;
    const mv = createMindVitals({ embedText: embed });
    // 两条经历向量都等于念头 → 余弦都=1 → 取先出现的 e1
    const g = await mv.groundedness('tk', 't', [
      { key: 'e1', text: 't' },
      { key: 'e2', text: 't' },
    ]);
    expect(g.refKey).toBe('e1');
    expect(g.score).toBe(1);
  });

  it('null 经历向量被跳过，不影响最大值（与串行 `if (!ev) continue` 一致）', async () => {
    const embed = async (text) => V[text] || null; // 'missing' → null
    const mv = createMindVitals({ embedText: embed });
    const g = await mv.groundedness('tk', 't', [
      { key: 'e1', text: 'missing' },
      { key: 'e2', text: 'e_near' },
    ]);
    expect(g.refKey).toBe('e2');
    expect(g.score).toBeGreaterThan(0.95);
  });

  it('经历嵌入并行发起：任一完成前所有请求已 in-flight', async () => {
    const started = [];
    let releaseCount = 0;
    const resolvers = [];
    // embedText 立即记录发起，但延迟到我们手动放行后才 resolve
    const embed = (text) => {
      started.push(text);
      if (text === 'tk-thought') return Promise.resolve(V.t); // 念头先单独 await
      return new Promise((resolve) => { resolvers.push(() => resolve(V.e_near)); });
    };
    const mv = createMindVitals({ embedText: embed });
    const p = mv.groundedness('tk', 'tk-thought', [
      { key: 'e1', text: 'exp1' },
      { key: 'e2', text: 'exp2' },
      { key: 'e3', text: 'exp3' },
    ]);
    // 让微任务队列推进：念头 await 完成后，3 条经历应已全部发起（Promise.all 并行），
    // 此刻没有任何经历被 resolve（释放器还没调用）。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started.filter((t) => t.startsWith('exp')).sort()).toEqual(['exp1', 'exp2', 'exp3']);
    expect(releaseCount).toBe(0);
    // 放行全部经历嵌入 → groundedness 完成
    resolvers.forEach((fn) => { releaseCount += 1; fn(); });
    const g = await p;
    expect(g.score).toBeGreaterThan(0.95);
  });

  it('嵌入炸了仍 fail-open 返回 null（行为不变）', async () => {
    const mv = createMindVitals({ embedText: async () => { throw new Error('炸'); } });
    expect(await mv.groundedness('tk', 't', [{ key: 'e', text: 'e_near' }])).toBe(null);
  });

  it('LRU 缓存仍按 key 去重：同 key 经历不重复嵌入', async () => {
    const calls = [];
    const embed = async (text) => { calls.push(text); return V[text] || null; };
    const mv = createMindVitals({ embedText: embed });
    // 先把 e2 的 key 暖进缓存
    await mv.similarity('warm', 'e_near', 'e2', 'e_near');
    const before = calls.length;
    await mv.groundedness('tk', 't', [{ key: 'e2', text: 'e_near' }]);
    // e2 命中缓存（key 复用），只新增念头 tk 一次嵌入
    expect(calls.length).toBe(before + 1);
  });
});
