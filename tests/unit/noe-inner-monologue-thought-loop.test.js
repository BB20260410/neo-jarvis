// @ts-check
import { describe, it, expect } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';

// S0.3：InnerMonologue 反刍前 additive 接入思维回环守卫（窗口主题固着）。全确定性：注入 timeline/getAdapter/thoughtLoopGuard，不触网/不依赖真实时钟/不依赖 process.env。

function makeTimeline(episodes) { const recorded = []; return { recorded, recent: () => episodes, record: (e) => { recorded.push(e); return recorded.length; } }; }
function capturingAdapter(reply) { const calls = []; return { calls, chat: async (messages) => { calls.push(messages); return { reply }; } }; }
// 5 条 inner_monologue：字面互不相同(两两不相似)，但共享「意识」「自由」→ 窗口主题固着。
function fixatedInners() { return [
  { id: 5, ts: 5, type: 'inner_monologue', summary: '我又在想意识和自由的关系' },
  { id: 4, ts: 4, type: 'inner_monologue', summary: '意识到底是不是自由的前提呢' },
  { id: 3, ts: 3, type: 'inner_monologue', summary: '自由意识这个问题又冒出来了' },
  { id: 2, ts: 2, type: 'inner_monologue', summary: '关于意识与自由我还是没头绪' },
  { id: 1, ts: 1, type: 'inner_monologue', summary: '意识、自由，绕来绕去就这俩' },
]; }

describe('InnerMonologue 思维回环守卫 additive（NOE_THOUGHT_LOOP_GUARD）', () => {
  it('ON：窗口主题固着 → 提示含换角度，meta.rotated=topic_loop', async () => {
    const tl = makeTimeline(fixatedInners());
    const adapter = capturingAdapter('换个角度，今天来想想新学的东西');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, thoughtLoopGuard: { enabled: true } });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(adapter.calls[0][1].content).toContain('打转');
    expect(adapter.calls[0][1].content).toMatch(/意识|自由/);
    expect(tl.recorded[0].meta.rotated).toBe('topic_loop');
  });
  it('OFF（enabled=false）：同样固着 → 无换角度行，meta 无（走 v1 逐字一致）', async () => {
    const tl = makeTimeline(fixatedInners());
    const adapter = capturingAdapter('继续顺着想下去');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, thoughtLoopGuard: { enabled: false } });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(adapter.calls[0][1].content).not.toContain('打转');
    expect(tl.recorded[0].meta).toBeUndefined();
  });
  it('未注入 thoughtLoopGuard（默认 null）：零回归', async () => {
    const tl = makeTimeline(fixatedInners());
    const adapter = capturingAdapter('顺着这个想法接着想');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter });
    await reflect();
    expect(adapter.calls[0][1].content).not.toContain('打转');
    expect(tl.recorded[0].meta).toBeUndefined();
  });
  it('ON 但念头不足 3 条 → 不触发', async () => {
    const tl = makeTimeline([{ id: 2, ts: 2, type: 'inner_monologue', summary: '意识和自由' }, { id: 1, ts: 1, type: 'inner_monologue', summary: '意识和自由' }]);
    const adapter = capturingAdapter('想点别的');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, thoughtLoopGuard: { enabled: true } });
    await reflect();
    expect(adapter.calls[0][1].content).not.toContain('打转');
  });
  it('additive 不堆叠：字符级断路器先触发时 rotated 仍 literal', async () => {
    const same = '我一直在想意识自由这件事情啊';
    const tl = makeTimeline([{ id: 3, ts: 3, type: 'inner_monologue', summary: same }, { id: 2, ts: 2, type: 'inner_monologue', summary: same + '呢' }, { id: 1, ts: 1, type: 'inner_monologue', summary: same + '哦' }]);
    const adapter = capturingAdapter('换个角度想想新东西');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, textSimilarity, thoughtLoopGuard: { enabled: true } });
    await reflect();
    expect(tl.recorded[0].meta.rotated).toBe('literal');
  });
  it('fail-open：守卫遇 undefined summary 不阻断反刍', async () => {
    const tl = makeTimeline([{ id: 3, ts: 3, type: 'inner_monologue', summary: '意识自由问题一' }, { id: 2, ts: 2, type: 'inner_monologue', summary: undefined }, { id: 1, ts: 1, type: 'inner_monologue', summary: '意识自由问题三' }]);
    const adapter = capturingAdapter('还是想到了点什么');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, thoughtLoopGuard: { enabled: true } });
    expect((await reflect()).reflected).toBe(true);
  });
});
