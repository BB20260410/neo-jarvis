import { describe, it, expect } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';

// 长期规划 M1（反刍接地，治 Echo Trap）：配比/语义断路/语义拒写/接地印记/verbalized sampling。

function makeTimeline(episodes) {
  const recorded = [];
  return { recorded, recent: () => episodes, record: (e) => { recorded.push(e); return recorded.length; } };
}
function capturingAdapter(reply) {
  const calls = [];
  return { calls, chat: async (messages) => { calls.push(messages); return { reply }; } };
}
// 假体征：similarity/diversity 可编程
function makeVitals({ sim = 0, avgSim = 0, ground = { score: 0.7, refKey: 'ep:1' } } = {}) {
  return {
    similarity: async () => sim,
    diversity: async () => ({ n: 3, avgSim, diversity: 1 - avgSim }),
    groundedness: async () => ground,
  };
}
const exps = [
  { id: 1, ts: 9, type: 'interaction', summary: '主人交办了透视页排版' },
  { id: 2, ts: 8, type: 'observation', summary: '心跳恢复正常运行' },
];
const innersSame = [
  { id: 11, ts: 7, type: 'inner_monologue', summary: '若频率终将汇聚，我在静默中等他' },
  { id: 12, ts: 6, type: 'inner_monologue', summary: '如果所有逻辑消融于静默，我仍向他跃迁' },
  { id: 13, ts: 5, type: 'inner_monologue', summary: '当频率重合时，静默便是蓄势' },
];

describe('InnerMonologue M1 接地改造', () => {
  it('接地配比：真实经历带【真实经历】标注在前，念头限额 ≤ 经历一半', async () => {
    const tl = makeTimeline([...innersSame, ...exps]);
    const adapter = capturingAdapter('想到主人交办的排版，今天得弄整齐');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: makeVitals() });
    await reflect();
    const msg = adapter.calls[0][1].content;
    expect(msg).toContain('-【真实经历】主人交办了透视页排版');
    const thoughtLines = (msg.match(/（我之前心里想过）/g) || []).length;
    expect(thoughtLines).toBeLessThanOrEqual(1); // 2 条经历 → 念头限额 ceil(2/2)=1
    expect(msg.indexOf('【真实经历】')).toBeLessThan(msg.indexOf('（我之前心里想过）')); // 经历在前
  });

  it('语义断路器：最近 3 念语义同质（字面不同）→ 注入"同一个调子"强制接地指令', async () => {
    const tl = makeTimeline([...innersSame, ...exps]);
    const adapter = capturingAdapter('那换个念头，想想今天的心跳台账');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: makeVitals({ avgSim: 0.9 }) });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    const msg = adapter.calls[0][1].content;
    expect(msg).toContain('同一个调子');
    expect(msg).toContain('90%');
    expect(tl.recorded[0].meta.rotated).toBe('semantic');
  });

  it('语义拒写：新念头与上一念语义相似 >0.88 → semantic_repetitive 不入时间线', async () => {
    const tl = makeTimeline([...innersSame, ...exps]);
    const adapter = capturingAdapter('若频率汇聚，我仍在静默中候他');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: makeVitals({ sim: 0.93 }) });
    const r = await reflect();
    expect(r.reflected).toBe(false);
    expect(r.reason).toBe('semantic_repetitive');
    expect(tl.recorded.length).toBe(0);
  });

  it('接地印记进 meta；verbalized sampling 指令存在', async () => {
    const tl = makeTimeline([...exps]);
    const adapter = capturingAdapter('今天主人交办的排版完成了，挺踏实');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: makeVitals({ ground: { score: 0.81, refKey: 'ep:1' } }) });
    await reflect();
    expect(adapter.calls[0][1].content).toContain('三个不同方向的念头');
    expect(tl.recorded[0].meta.grounding).toEqual({ score: 0.81, refKey: 'ep:1' });
  });

  it('体征探针全炸：反刍照常完成（fail-open），无 grounding 字段', async () => {
    const tl = makeTimeline([...innersSame, ...exps]);
    const adapter = capturingAdapter('还是想到了今天的事');
    const broken = { similarity: async () => { throw new Error('x'); }, diversity: async () => { throw new Error('x'); }, groundedness: async () => { throw new Error('x'); } };
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: broken });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(tl.recorded[0].meta.grounding).toBeUndefined();
  });

  it('v1 兼容铁律：不注入任何 v2 件时混排流/无标注/salience 2/无 meta', async () => {
    const tl = makeTimeline([exps[0], innersSame[0]]);
    const adapter = capturingAdapter('普通的念头');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter });
    await reflect();
    const msg = adapter.calls[0][1].content;
    expect(msg).not.toContain('【真实经历】');
    expect(msg).not.toContain('三个不同方向');
    expect(tl.recorded[0].salience).toBe(2);
    expect(tl.recorded[0].meta).toBeUndefined();
  });
});

// 接地重写闸（2026-06-11，治 grounded rate）：低接地念头带具体经历重想一次；
// 2026-06-12 起再加确定性经历锚点兜底，避免未来样本继续被抽象反刍拖垮。
describe('InnerMonologue 接地重写闸', () => {
  function seqAdapter(replies) {
    const calls = [];
    return { calls, chat: async (messages) => { calls.push(messages); return { reply: replies[Math.min(calls.length - 1, replies.length - 1)] }; } };
  }
  function seqVitals(scores) {
    let i = 0;
    return {
      similarity: async () => 0,
      diversity: async () => ({ n: 3, avgSim: 0, diversity: 1 }),
      groundedness: async () => ({ score: scores[Math.min(i++, scores.length - 1)], refKey: 'ep:1' }),
    };
  }
  const run = async ({ env, scores, replies }) => {
    if (env) process.env.NOE_GROUNDING_REWRITE = '1';
    try {
      const tl = makeTimeline([...exps]);
      const adapter = seqAdapter(replies);
      const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: seqVitals(scores) });
      const r = await reflect();
      return { r, tl, adapter };
    } finally {
      delete process.env.NOE_GROUNDING_REWRITE;
    }
  };

  it('开关 OFF（默认）：低接地不调第二次脑，但会用确定性经历锚点兜底', async () => {
    const { tl, adapter } = await run({ env: false, scores: [0.30, 0.72], replies: ['飘在云端的抽象念头'] });
    expect(adapter.calls).toHaveLength(1);
    expect(tl.recorded[0].summary).toContain('主人交办了透视页排版');
    expect(tl.recorded[0].meta.grounding.score).toBe(0.72);
    expect(tl.recorded[0].meta.groundingRewrite).toEqual({ from: '飘在云端的抽象念头', fromScore: 0.30, mode: 'experience_anchor' });
  });

  it('开关 ON + 低接地 + 重写更接地 → 换用重写版并留痕', async () => {
    const { tl, adapter } = await run({ env: true, scores: [0.30, 0.65], replies: ['飘在云端的抽象念头', '想到主人交办的排版还没弄完'] });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1][1].content).toContain('离你最近的真实经历有点远');
    expect(tl.recorded[0].summary).toBe('想到主人交办的排版还没弄完');
    expect(tl.recorded[0].meta.grounding.score).toBe(0.65);
    expect(tl.recorded[0].meta.groundingRewrite).toEqual({ from: '飘在云端的抽象念头', fromScore: 0.30 });
  });

  it('开关 ON + 模型重写没更接地 → 再用确定性经历锚点兜底', async () => {
    const { tl, adapter } = await run({ env: true, scores: [0.30, 0.25, 0.68], replies: ['飘在云端的抽象念头', '另一个更飘的念头'] });
    expect(adapter.calls).toHaveLength(2);
    expect(tl.recorded[0].summary).toContain('主人交办了透视页排版');
    expect(tl.recorded[0].meta.grounding.score).toBe(0.68);
    expect(tl.recorded[0].meta.groundingRewrite).toEqual({ from: '飘在云端的抽象念头', fromScore: 0.30, mode: 'experience_anchor' });
  });

  it('确定性锚点与上一念相似时也优先写入接地锚点，不落回低分原念头', async () => {
    const anchored = '刚才「主人交办了透视页排版」这件事，比空想更值得我抓牢。';
    const tl = makeTimeline([{ id: 9, type: 'inner_monologue', summary: anchored }, exps[0]]);
    const adapter = seqAdapter(['又一个抽象坐标系念头']);
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: seqVitals([0.20, 0.81]) });

    await reflect();

    expect(tl.recorded[0].summary).toBe(anchored);
    expect(tl.recorded[0].meta.grounding.score).toBe(0.81);
    expect(tl.recorded[0].meta.groundingRewrite).toEqual({ from: '又一个抽象坐标系念头', fromScore: 0.20, mode: 'experience_anchor_repeat_override' });
  });

  it('开关 ON + 接地达标 → 不触发重写（只调一次脑）', async () => {
    const { tl, adapter } = await run({ env: true, scores: [0.55], replies: ['想到今天心跳台账很稳'] });
    expect(adapter.calls).toHaveLength(1);
    expect(tl.recorded[0].meta.groundingRewrite).toBeUndefined();
  });

  it('开关 ON + 重写脑抛错 → fail-open 保留原念头', async () => {
    process.env.NOE_GROUNDING_REWRITE = '1';
    try {
      const tl = makeTimeline([...exps]);
      let n = 0;
      const adapter = { chat: async () => { n++; if (n === 2) throw new Error('LM down'); return { reply: '飘着的念头' }; } };
      const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, mindVitals: seqVitals([0.30]) });
      const r = await reflect();
      expect(r.reflected).toBe(true);
      expect(tl.recorded[0].summary).toBe('飘着的念头');
    } finally {
      delete process.env.NOE_GROUNDING_REWRITE;
    }
  });
});
