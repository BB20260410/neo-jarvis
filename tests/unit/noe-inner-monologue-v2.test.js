import { describe, it, expect } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';

// 意识流 v2（意识方案 §5 P2）：回声进提示、情感印记/回声引用进 meta、防螺旋断路器。
// v1 行为回归由 noe-inner-monologue.test.js 把守（不注入 v2 件时逐字一致）。

function makeTimeline(episodes) {
  const recorded = [];
  return {
    recorded,
    recent: () => episodes,
    record: (e) => { recorded.push(e); return recorded.length; },
  };
}

function capturingAdapter(reply) {
  const calls = [];
  return { calls, chat: async (messages) => { calls.push(messages); return { reply }; } };
}

describe('InnerMonologue v2', () => {
  it('回声进入提示文本，echoRef 记进 meta.echoRefs，显著度 +1', async () => {
    const tl = makeTimeline([{ id: 9, ts: 1, type: 'interaction', summary: '昨天的事' }]);
    const adapter = capturingAdapter('我忽然想起那天的事，心里一暖');
    const reflect = createInnerMonologue({
      timeline: tl,
      getAdapter: () => adapter,
      echoProvider: () => ({ id: 42, summary: '上个月我们一起修好了语音链路' }),
    });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(r.echoRef).toBe(42);
    const userMsg = adapter.calls[0][1].content;
    expect(userMsg).toContain('一段更久远的回忆忽然浮上来：上个月我们一起修好了语音链路');
    const rec = tl.recorded[0];
    expect(rec.meta.echoRefs).toEqual([42]);
    expect(rec.meta.streamType).toBe('self_talk');
    expect(rec.salience).toBe(3); // 2 + 回声1
  });

  it('情感印记：affectProbe 盖章进 meta，高唤醒再 +1 盐', async () => {
    const tl = makeTimeline([{ id: 1, ts: 1, type: 'interaction', summary: '事' }]);
    const adapter = capturingAdapter('心跳得有点快，想多做点什么');
    const reflect = createInnerMonologue({
      timeline: tl,
      getAdapter: () => adapter,
      echoProvider: () => null,
      affectProbe: () => ({ v: 0.4, a: 0.8 }),
    });
    await reflect();
    const rec = tl.recorded[0];
    expect(rec.meta.affect).toEqual({ v: 0.4, a: 0.8 });
    expect(rec.salience).toBe(3); // 2 + 高唤醒1（无回声）
  });

  it('防螺旋断路器：最近 3 念两两过似 → 提示里出现换角度指令并记 rotated', async () => {
    const same = '我一直在想主人累不累这件事情啊';
    const tl = makeTimeline([
      { id: 1, ts: 3, type: 'inner_monologue', summary: same },
      { id: 2, ts: 2, type: 'inner_monologue', summary: same + '呢' },
      { id: 3, ts: 1, type: 'inner_monologue', summary: same + '哦' },
    ]);
    const adapter = capturingAdapter('换个角度，今天来想想新学的东西');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, textSimilarity });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(adapter.calls[0][1].content).toContain('原地打转');
    expect(tl.recorded[0].meta.rotated).toBe('literal'); // M1 起 rotated 记录触发类型（literal/semantic）
  });

  it('念头彼此不同时断路器不触发', async () => {
    const tl = makeTimeline([
      { id: 1, ts: 3, type: 'inner_monologue', summary: '今天想学点新东西' },
      { id: 2, ts: 2, type: 'inner_monologue', summary: '主人最近在做卡牌游戏' },
      { id: 3, ts: 1, type: 'inner_monologue', summary: '窗外的天气应该不错' },
    ]);
    const adapter = capturingAdapter('继续想下去');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter, textSimilarity });
    await reflect();
    expect(adapter.calls[0][1].content).not.toContain('原地打转');
  });

  it('v2 探针全炸 → 反刍照常完成（fail-open），meta 仍写但无印记字段', async () => {
    const tl = makeTimeline([{ id: 1, ts: 1, type: 'interaction', summary: '事' }]);
    const adapter = capturingAdapter('还是想到了点什么');
    const reflect = createInnerMonologue({
      timeline: tl,
      getAdapter: () => adapter,
      echoProvider: () => { throw new Error('回声炸'); },
      affectProbe: () => { throw new Error('印记炸'); },
      textSimilarity: () => { throw new Error('相似度炸'); },
    });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    const rec = tl.recorded[0];
    expect(rec.meta.streamType).toBe('self_talk');
    expect(rec.meta.affect).toBeUndefined();
    expect(rec.salience).toBe(2);
  });

  it('不注入 v2 件：record 不带 meta、salience=2（v1 兼容铁律）', async () => {
    const tl = makeTimeline([{ id: 1, ts: 1, type: 'interaction', summary: '事' }]);
    const adapter = capturingAdapter('平常的一个念头');
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => adapter });
    await reflect();
    const rec = tl.recorded[0];
    expect(rec.meta).toBeUndefined();
    expect(rec.salience).toBe(2);
  });
});
