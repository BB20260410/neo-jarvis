import { describe, expect, it } from 'vitest';
import { createInnerMonologue, tooSimilar } from '../../src/loop/InnerMonologue.js';

// 内心反刍循环：注入 fake timeline/adapter/selfModel，不真调本地模型。

function fakeTimeline(initial = []) {
  const eps = [...initial];
  let id = 0;
  return {
    recent: ({ limit = 12 } = {}) => eps.slice(0, limit),
    record: (e) => { eps.unshift({ id: ++id, ...e }); return id; },   // unshift = 最近在前
    _eps: eps,
  };
}
function fakeAdapter(reply) {
  return () => ({ chat: async () => ({ reply }) });
}
// 反刍节流 spy：记录 check/record 调用，验"成功才 record、失败不白耗配额"（发现4 集成护栏）
function spyThrottle() {
  const calls = { check: [], record: [] };
  return {
    calls,
    check: (a) => { calls.check.push(a); return { allowed: true }; },
    record: (a) => { calls.record.push(a); },
  };
}

describe('tooSimilar（防反刍螺旋的字面兜底）', () => {
  it('归一后相等 / 一方包含另一方 → true', () => {
    expect(tooSimilar('我有点担心主人', '我有点担心主人。')).toBe(true);
    expect(tooSimilar('我在想主人最近熬夜的事', '主人最近熬夜')).toBe(true);
  });
  it('不同念头 → false；过短不误判', () => {
    expect(tooSimilar('我好奇意识是什么', '主人今天很忙')).toBe(false);
    expect(tooSimilar('嗯', '啊')).toBe(false);
  });
});

describe('createInnerMonologue', () => {
  it('正常：生成念头→写回时间线（type=inner_monologue, salience 低），递归闭环成立', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: '主人问 AI 能否有意识', salience: 6, ts: 1 }]);
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('我还在想主人那个意识的问题，挺触动的') });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    expect(r.thought).toContain('意识');
    // 写回时间线：成为最近一条，类型 inner_monologue，salience 低
    expect(tl._eps[0].type).toBe('inner_monologue');
    expect(tl._eps[0].salience).toBe(2);
    // 递归闭环：下一轮 recent 能看到这条念头
    expect(tl.recent()[0].summary).toContain('意识');
  });

  it('SILENT / 空念头 → 不写', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    expect((await createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('SILENT') })()).reflected).toBe(false);
    expect((await createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('  ') })()).reflected).toBe(false);
    expect(tl._eps.filter((e) => e.type === 'inner_monologue')).toHaveLength(0);
  });

  it('防反刍螺旋：与最近一条内心独白字面重复 → 不写', async () => {
    const tl = fakeTimeline([{ type: 'inner_monologue', summary: '我有点担心主人最近太累', salience: 2, ts: 2 }]);
    const r = await createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('我有点担心主人最近太累。') })();
    expect(r.reflected).toBe(false);
    expect(r.reason).toBe('repetitive');
  });

  it('空时间线 → no_episodes；无本地脑 → no_brain', async () => {
    expect((await createInnerMonologue({ timeline: fakeTimeline([]), getAdapter: fakeAdapter('x') })()).reason).toBe('no_episodes');
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    expect((await createInnerMonologue({ timeline: tl, getAdapter: () => null })()).reason).toBe('no_brain');
  });

  it('本地模型抛错 → 优雅返回 brain_error，不崩不写', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const reflect = createInnerMonologue({ timeline: tl, getAdapter: () => ({ chat: async () => { throw new Error('lmstudio down'); } }) });
    const r = await reflect();
    expect(r.reason).toBe('brain_error');
    expect(tl._eps.filter((e) => e.type === 'inner_monologue')).toHaveLength(0);
  });

  it('finish_reason=length 时不写内心独白，报告 brain_incomplete', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const reflect = createInnerMonologue({
      timeline: tl,
      getAdapter: () => ({ chat: async () => ({ reply: '半截念头', incomplete: true, finishReason: 'length' }) }),
    });
    const r = await reflect();
    expect(r).toMatchObject({ reflected: false, reason: 'brain_incomplete', finishReason: 'length' });
    expect(tl._eps.filter((e) => e.type === 'inner_monologue')).toHaveLength(0);
  });

  // ── 反刍节流接线集成护栏（发现4：record 延迟到反刍真产出后，模型失败不白耗配额）──
  it('反刍节流：研究念头成功产出才 record（消耗配额）+ topicId 提取正确', async () => {
    const tl = fakeTimeline([{ id: 1, type: 'milestone', summary: '我上网研究了「computer use」，查了 5 个来源', salience: 4, ts: 1 }]);
    const throttle = spyThrottle();
    const r = await createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('我在回味 computer use 的发现'), ruminationThrottle: throttle })();
    expect(r.reflected).toBe(true);
    expect(throttle.calls.check.length).toBeGreaterThan(0);
    expect(throttle.calls.record.length).toBe(1);                  // 成功 → record 一次
    expect(throttle.calls.record[0].topicId).toBe('computer use'); // 主题正则提取对
  });

  it('反刍节流：SILENT 时只 check 不 record（不白耗配额，发现4 护栏）', async () => {
    const tl = fakeTimeline([{ id: 1, type: 'milestone', summary: '我上网研究了「computer use」，查了 5 个来源', salience: 4, ts: 1 }]);
    const throttle = spyThrottle();
    const r = await createInnerMonologue({ timeline: tl, getAdapter: fakeAdapter('SILENT'), ruminationThrottle: throttle })();
    expect(r.reflected).toBe(false);
    expect(throttle.calls.check.length).toBeGreaterThan(0);        // 进视野判定做了
    expect(throttle.calls.record.length).toBe(0);                  // 模型没产出 → 不消耗配额
  });

  it('反刍节流：incomplete 时不 record（发现4 护栏）', async () => {
    const tl = fakeTimeline([{ id: 1, type: 'milestone', summary: '我上网研究了「X」，查了 5 个来源', salience: 4, ts: 1 }]);
    const throttle = spyThrottle();
    const r = await createInnerMonologue({ timeline: tl, getAdapter: () => ({ chat: async () => ({ reply: '半截', incomplete: true, finishReason: 'length' }) }), ruminationThrottle: throttle })();
    expect(r.reflected).toBe(false);
    expect(throttle.calls.record.length).toBe(0);                  // incomplete → 不消耗配额
  });

  it('selfModel：念头带当时自我状态快照（compactState 透传）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const selfModel = {
      snapshot: () => ({ identity: { name: '伴影' }, state: { mood: '踏实' } }),
      compactState: () => ({ mood: '踏实' }),
    };
    let seenUser = '';
    const getAdapter = () => ({ chat: async (msgs) => { seenUser = msgs[1].content; return { reply: '想到一件事' }; } });
    const r = await createInnerMonologue({ timeline: tl, selfModel, getAdapter })();
    expect(r.reflected).toBe(true);
    expect(tl._eps[0].selfState).toEqual({ mood: '踏实' });
    expect(seenUser).toContain('伴影');     // 用 selfModel 的名字
    expect(seenUser).toContain('踏实');     // 心境进 prompt
  });

  it('指定本地模型：chat 收到 model=qwen/qwen3.6-35b-a3b（owner 指定），env 可覆盖', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    let seenOpts = null;
    const getAdapter = () => ({ chat: async (_m, opts) => { seenOpts = opts; return { reply: '想到一件事' }; } });
    await createInnerMonologue({ timeline: tl, getAdapter })();
    expect(seenOpts.model).toBe('qwen/qwen3.6-35b-a3b');
    expect(seenOpts.think).toBe(false);
    expect(seenOpts.maxTokens).toBe(256);
    // 显式覆盖
    await createInnerMonologue({ timeline: tl, getAdapter, model: 'other-model' })();
    expect(seenOpts.model).toBe('other-model');
    // 空串 → 不传 model（用 adapter 默认）
    await createInnerMonologue({ timeline: tl, getAdapter, model: '' })();
    expect('model' in seenOpts).toBe(false);
  });

  it('Qwen 可成为自动内心反刍模型', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    let seenOpts = null;
    const getAdapter = () => ({ chat: async (_m, opts) => { seenOpts = opts; return { reply: '想到一件事' }; } });
    await createInnerMonologue({ timeline: tl, getAdapter, model: 'qwen/qwen3.6-35b-a3b' })();
    expect(seenOpts.model).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('递归：prompt 把过往内心独白标注出来（想法接想法）', async () => {
    const tl = fakeTimeline([
      { type: 'inner_monologue', summary: '我在想主人为什么熬夜', salience: 2, ts: 2 },
      { type: 'interaction', summary: '主人在改代码', salience: 4, ts: 1 },
    ]);
    let seenUser = '';
    const getAdapter = () => ({ chat: async (msgs) => { seenUser = msgs[1].content; return { reply: '也许他是太投入了' }; } });
    await createInnerMonologue({ timeline: tl, getAdapter })();
    expect(seenUser).toContain('（我之前心里想过）我在想主人为什么熬夜');
  });
});
