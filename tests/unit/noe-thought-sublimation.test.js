import { describe, expect, it } from 'vitest';
import { SELF_MARK, classifyThought, createThoughtSublimation } from '../../src/loop/NoeThoughtSublimation.js';
import { createCommitmentStore } from '../../src/runtime/NoeCommitmentStore.js';

// 反刍升华（支柱③+⑥）：注入 fake/纯内存 store，不连真库、不调模型。

const NOW = 1_700_000_000_000;

/** 可观测 fake store：记录全部调用，便于断言「零调用」与入参形状。 */
function fakeStore({ open = [], failAdd = false, failList = false } = {}) {
  const calls = { add: [], list: 0 };
  return {
    calls,
    _open: open,
    add(input) {
      calls.add.push(input);
      if (failAdd) throw new Error('disk full');
      const rec = { id: `cm_${calls.add.length}`, status: 'open', ...input };
      open.push(rec);
      return rec;
    },
    list({ status } = {}) {
      calls.list += 1;
      if (failList) throw new Error('boom');
      return open.filter((c) => !status || c.status === status);
    },
  };
}

describe('classifyThought（确定性两类模式判定）', () => {
  it('出口①想说/该提醒：命中 kind=speak，置信度过 0.7 门槛', () => {
    expect(classifyThought('想跟主人说一声今天的发现')).toEqual({ kind: 'speak', confidence: 0.85 });
    expect(classifyThought('得提醒主人备份这周的工作')).toEqual({ kind: 'speak', confidence: 0.85 });
    expect(classifyThought('别忘了跟主人提那个超时的任务')).toEqual({ kind: 'speak', confidence: 0.8 });
  });

  it('出口②牵挂：命中 kind=care', () => {
    expect(classifyThought('不知道主人今天工作顺不顺利')).toEqual({ kind: 'care', confidence: 0.85 });
    expect(classifyThought('主人好久没好好休息了')).toEqual({ kind: 'care', confidence: 0.75 });
    expect(classifyThought('有点惦记主人')).toEqual({ kind: 'care', confidence: 0.8 });
  });

  it('普通念头 / 否定句（不用提醒主人）/ 空 → null', () => {
    expect(classifyThought('我好奇意识到底是什么')).toBeNull();
    expect(classifyThought('代码的世界真安静')).toBeNull();
    expect(classifyThought('这事不用提醒主人，他自己记得')).toBeNull();
    expect(classifyThought('先不打扰主人了')).toBeNull();
    expect(classifyThought('')).toBeNull();
  });
});

describe('createThoughtSublimation（升华入店：形状/延迟/标记）', () => {
  it('想说类 → add({category:open_loop, sensitivity:care, SELF_MARK 前缀, earliest=now+30min})', async () => {
    const store = fakeStore();
    const sublimate = createThoughtSublimation({ commitmentStore: store, now: () => NOW });
    const r = await sublimate('想跟主人说一声今天学到的事');
    expect(r).toEqual({ sublimated: true, kind: 'speak', commitmentId: 'cm_1' });
    expect(store.calls.add).toHaveLength(1);
    const added = store.calls.add[0];
    expect(added.text.startsWith(SELF_MARK)).toBe(true);          // 自生可识别标记
    expect(added.text).toContain('想跟主人说一声今天学到的事');
    expect(added.category).toBe('open_loop');
    expect(added.sensitivity).toBe('care');
    expect(added.dueWindow).toEqual({ earliestMs: NOW + 30 * 60000 }); // latest 走 store 默认 24h 窗
  });

  it('牵挂类 → earliest=now+2h（更保守的打扰预算）', async () => {
    const store = fakeStore();
    const r = await createThoughtSublimation({ commitmentStore: store, now: () => NOW })('不知道主人现在怎么样了');
    expect(r.sublimated).toBe(true);
    expect(r.kind).toBe('care');
    expect(store.calls.add[0].dueWindow.earliestMs).toBe(NOW + 2 * 3600000);
  });

  it('真 store 集成：入店后 open 可见且通过 dueWindow 归一（latest=earliest+24h 兜底）', async () => {
    const store = createCommitmentStore({ now: () => NOW });
    const r = await createThoughtSublimation({ commitmentStore: store, now: () => NOW })('该提醒主人喝水了');
    expect(r.sublimated).toBe(true);
    const open = store.list({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].text).toBe(`${SELF_MARK}该提醒主人喝水了`);
    expect(open[0].dueWindow.latestMs).toBe(NOW + 30 * 60000 + 24 * 3600000);
  });

  it('dedupe：同一念头（归一后）第二次跳过，不重复入店', async () => {
    const store = createCommitmentStore({ now: () => NOW });
    const sublimate = createThoughtSublimation({ commitmentStore: store, now: () => NOW });
    expect((await sublimate('不知道主人今天工作顺不顺利')).sublimated).toBe(true);
    const again = await sublimate('不知道主人今天工作顺不顺利。');
    expect(again).toEqual({ sublimated: false, reason: 'duplicate' });
    expect(store.list({ status: 'open' })).toHaveLength(1);
  });

  it('自生上限 2 条：第三条跳过（cap）；上限只数 SELF_MARK 自生项，用户承诺不挤占', async () => {
    const store = createCommitmentStore({ now: () => NOW });
    // 三条用户来源的 open 承诺（无前缀）不占自生额度
    store.add({ text: '提醒我买菜' });
    store.add({ text: '提醒我交报销' });
    store.add({ text: 'Noe 承诺：我会帮你查航班' });
    const sublimate = createThoughtSublimation({ commitmentStore: store, now: () => NOW });
    expect((await sublimate('想跟主人说今天的进展')).sublimated).toBe(true);
    expect((await sublimate('不知道主人吃饭了没')).sublimated).toBe(true);
    const third = await sublimate('有点惦记主人');
    expect(third).toEqual({ sublimated: false, reason: 'cap' });
    expect(store.list({ status: 'open' }).filter((c) => c.text.startsWith(SELF_MARK))).toHaveLength(2);
  });

  it('未命中念头：零 store 调用（不查不写，零影响）', async () => {
    const store = fakeStore();
    const r = await createThoughtSublimation({ commitmentStore: store, now: () => NOW })('我好奇意识到底是什么');
    expect(r).toEqual({ sublimated: false, reason: 'no_match' });
    expect(store.calls.add).toHaveLength(0);
    expect(store.calls.list).toBe(0);
  });

  it('置信度门槛：minConfidence 高于模式置信度 → 不入店', async () => {
    const store = fakeStore();
    const sublimate = createThoughtSublimation({ commitmentStore: store, minConfidence: 0.8, now: () => NOW });
    const r = await sublimate('主人好久没好好休息了');   // care 0.75 < 0.8
    expect(r).toEqual({ sublimated: false, reason: 'no_match' });
    expect(store.calls.add).toHaveLength(0);
  });

  it('fail-open：store 缺失/不完整 → no_store 零调用不抛；门控关闭（装配点不建实例）即零影响', async () => {
    expect(await createThoughtSublimation({})('想跟主人说点事')).toEqual({ sublimated: false, reason: 'no_store' });
    expect(await createThoughtSublimation({ commitmentStore: null })('想跟主人说点事')).toEqual({ sublimated: false, reason: 'no_store' });
    // 只有 add 没有 list（无法 dedupe/数上限）→ 同样 fail-open，绝不盲入库
    const calls = [];
    const half = { add: (x) => calls.push(x) };
    expect(await createThoughtSublimation({ commitmentStore: half })('想跟主人说点事')).toEqual({ sublimated: false, reason: 'no_store' });
    expect(calls).toHaveLength(0);
  });

  it('fail-open：store.list / store.add 抛错 → store_error 不抛出、不破坏调用方', async () => {
    const failList = fakeStore({ failList: true });
    expect(await createThoughtSublimation({ commitmentStore: failList, now: () => NOW })('想跟主人说点事'))
      .toEqual({ sublimated: false, reason: 'store_error' });
    const failAdd = fakeStore({ failAdd: true });
    expect(await createThoughtSublimation({ commitmentStore: failAdd, now: () => NOW })('想跟主人说点事'))
      .toEqual({ sublimated: false, reason: 'store_error' });
  });

  it('LLM 判定注入位：正则未命中时兜底；形状非法/抛错按未命中 fail-open', async () => {
    const store = fakeStore();
    const sublimate = createThoughtSublimation({
      commitmentStore: store,
      llmClassify: async () => ({ kind: 'care', confidence: 0.9 }),
      now: () => NOW,
    });
    const r = await sublimate('那件事在我心里转了一整天');   // 正则不命中 → llm 兜底
    expect(r.sublimated).toBe(true);
    expect(r.kind).toBe('care');
    // 抛错 → no_match
    const s2 = createThoughtSublimation({ commitmentStore: fakeStore(), llmClassify: async () => { throw new Error('down'); }, now: () => NOW });
    expect(await s2('那件事在我心里转了一整天')).toEqual({ sublimated: false, reason: 'no_match' });
    // 形状非法（kind 乱写/置信度越界）→ no_match
    const s3 = createThoughtSublimation({ commitmentStore: fakeStore(), llmClassify: async () => ({ kind: 'shout', confidence: 0.9 }), now: () => NOW });
    expect(await s3('那件事在我心里转了一整天')).toEqual({ sublimated: false, reason: 'no_match' });
    const s4 = createThoughtSublimation({ commitmentStore: fakeStore(), llmClassify: async () => ({ kind: 'care', confidence: 9 }), now: () => NOW });
    expect(await s4('那件事在我心里转了一整天')).toEqual({ sublimated: false, reason: 'no_match' });
  });

  it('空念头 → empty 零调用', async () => {
    const store = fakeStore();
    expect(await createThoughtSublimation({ commitmentStore: store })('  ')).toEqual({ sublimated: false, reason: 'empty' });
    expect(store.calls.list).toBe(0);
  });
});
