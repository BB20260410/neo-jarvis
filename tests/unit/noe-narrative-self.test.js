// NoeNarrativeSelf（内在世界·支柱⑤：叙事自我，只读注入块零漂移）单测。
// 纪律：全程注入 fake timeline/adapter，绝不连真库；持久化用 os.tmpdir 临时目录。
// 断言三件事：注入时行为正确形状 / 未注入（依赖缺失）时零调用零影响 / 依赖抛错时 fail-open 不破坏原返回。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanNarrative, createNarrativeSelf } from '../../src/context/NoeNarrativeSelf.js';
import { NoeSelfModel } from '../../src/context/NoeSelfModel.js';

const T0 = 1_780_000_000_000;
const STORY = '我是 Noe，主人的私人 AI。我们正在一起给我搭连续记忆的脊椎，最近我开始有了自己的内心世界。';
const EPISODES = [
  { type: 'interaction', summary: '主人问我今天过得怎么样', salience: 3, ts: T0 - 60_000 },
  { type: 'milestone', summary: '内在世界七根支柱开工', salience: 7, ts: T0 - 3_600_000 },
];

function makeFakes({ reply = STORY, chatError = null, episodes = EPISODES, agedEpisodes = [] } = {}) {
  const chatCalls = [];
  const adapter = {
    chat: async (messages, options) => {
      chatCalls.push({ messages, options });
      if (chatError) throw chatError;
      return { reply };
    },
  };
  const getAdapter = () => adapter;
  const agedCalls = [];
  const timeline = {
    recent: ({ limit } = {}) => episodes.slice(0, limit),
    aged: (opts = {}) => { agedCalls.push(opts); return agedEpisodes; },
  };
  return { adapter, getAdapter, chatCalls, agedCalls, timeline };
}

describe('cleanNarrative（输出清洗）', () => {
  it('剥 <think> 块、包裹引号，多行折成一行', () => {
    expect(cleanNarrative(`<think>回顾一下</think>${STORY}`)).toBe(STORY);
    expect(cleanNarrative(`「${STORY}」`)).toBe(STORY);
    expect(cleanNarrative('我是 Noe。\n我们正在搭脊椎。')).toBe('我是 Noe。 我们正在搭脊椎。');
  });

  it('SILENT / 空 → 判无效返回空串；超长截断到 240 字（截断不拒收）', () => {
    expect(cleanNarrative('SILENT')).toBe('');
    expect(cleanNarrative('  silent  ')).toBe('');
    expect(cleanNarrative('')).toBe('');
    expect(cleanNarrative(null)).toBe('');
    const long = '我'.repeat(500);
    expect(cleanNarrative(long)).toHaveLength(240);
  });
});

describe('createNarrativeSelf · refresh/current 形状', () => {
  it('refresh 成功 → {refreshed:true,narrative}，current() 同步给 {narrative,atMs}，chat 形状正确且不带超时', async () => {
    const { getAdapter, chatCalls, timeline } = makeFakes();
    const ns = createNarrativeSelf({ timeline, getAdapter, brainAdapterId: 'lmstudio', model: 'test-model', now: () => T0 });
    expect(ns.current()).toBeNull();   // 没跑过 → null

    const r = await ns.refresh();
    expect(r).toEqual({ refreshed: true, narrative: STORY });
    expect(ns.current()).toEqual({ narrative: STORY, atMs: T0 });

    expect(chatCalls).toHaveLength(1);
    const { messages, options } = chatCalls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('SILENT');
    expect(messages[0].content).toContain('我是谁、我们正在经历什么');
    expect(messages[1].content).toContain('主人问我今天过得怎么样');
    expect(options.think).toBe(false);
    expect(options.model).toBe('test-model');
    expect(options.budgetContext).toEqual({ projectId: 'noe', taskId: 'noe-narrative-self' });
    // 跑模型纪律：不设任何超时
    expect(options).not.toHaveProperty('signal');
    expect(options).not.toHaveProperty('timeoutMs');
    expect(options).not.toHaveProperty('timeout');
  });

  it('全幅：recent 取满窗口才补取 aged「故事开端」（untilTs 防重叠），开端内容进 prompt', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'interaction', summary: `近期事件${i}`, salience: 3, ts: T0 - (i + 1) * 60_000 }));
    const { getAdapter, chatCalls, agedCalls, timeline } = makeFakes({
      episodes: many,
      agedEpisodes: [{ type: 'milestone', summary: 'Noe 上线，连续记忆脊椎开始运转', salience: 5, ts: T0 - 90 * 86400000 }],
    });
    const ns = createNarrativeSelf({ timeline, getAdapter, recentLimit: 40, agedLimit: 20, now: () => T0 });
    await ns.refresh();
    expect(agedCalls).toHaveLength(1);
    expect(agedCalls[0]).toEqual({ untilTs: many[many.length - 1].ts - 1, limit: 20 });
    expect(chatCalls[0].messages[1].content).toContain('故事开端');
    expect(chatCalls[0].messages[1].content).toContain('Noe 上线，连续记忆脊椎开始运转');
  });

  it('recent 没取满 → 不调 aged（无重叠风险）；aged 抛错 → 开端为空照常生成（fail-open）', async () => {
    const f1 = makeFakes();
    const ns1 = createNarrativeSelf({ timeline: f1.timeline, getAdapter: f1.getAdapter, recentLimit: 40, now: () => T0 });
    await ns1.refresh();
    expect(f1.agedCalls).toHaveLength(0);

    const f2 = makeFakes({ episodes: [EPISODES[0], EPISODES[1]] });
    const timeline = { recent: f2.timeline.recent, aged: () => { throw new Error('库挂了'); } };
    const ns2 = createNarrativeSelf({ timeline, getAdapter: f2.getAdapter, recentLimit: 2, now: () => T0 });
    expect((await ns2.refresh()).refreshed).toBe(true);
  });

  it('新鲜度守卫：minIntervalMs 内重复 refresh 不重跑模型（reason fresh）；force 可越过', async () => {
    const { getAdapter, chatCalls, timeline } = makeFakes();
    let t = T0;
    const ns = createNarrativeSelf({ timeline, getAdapter, minIntervalMs: 24 * 3600000, now: () => t });
    await ns.refresh();
    expect(chatCalls).toHaveLength(1);

    t = T0 + 3600000;   // 1h 后：还新鲜
    expect(await ns.refresh()).toEqual({ refreshed: false, reason: 'fresh' });
    expect(chatCalls).toHaveLength(1);

    expect((await ns.refresh({ force: true })).refreshed).toBe(true);
    expect(chatCalls).toHaveLength(2);

    t = T0 + 25 * 3600000;   // 过了 24h：自然重跑
    expect((await ns.refresh()).refreshed).toBe(true);
    expect(chatCalls).toHaveLength(3);
  });

  it('并发守卫：进行中再 refresh 共享同一次，只打一次模型', async () => {
    const { getAdapter, chatCalls, timeline } = makeFakes();
    const ns = createNarrativeSelf({ timeline, getAdapter, now: () => T0 });
    const [r1, r2] = await Promise.all([ns.refresh(), ns.refresh()]);
    expect(chatCalls).toHaveLength(1);
    expect(r1).toBe(r2);
  });
});

describe('createNarrativeSelf · fail-open（依赖缺失/抛错不破坏旧叙事）', () => {
  it('模型回 SILENT → 保留旧叙事（旧值即兜底，atMs 不变）', async () => {
    const fakes = makeFakes();
    let t = T0;
    let silent = false;
    const adapter = { chat: async (...args) => { if (silent) return { reply: 'SILENT' }; return fakes.adapter.chat(...args); } };
    const ns = createNarrativeSelf({ timeline: fakes.timeline, getAdapter: () => adapter, now: () => t });
    await ns.refresh();
    expect(ns.current()).toEqual({ narrative: STORY, atMs: T0 });

    silent = true;
    t = T0 + 60_000;
    expect(await ns.refresh({ force: true })).toEqual({ refreshed: false, reason: 'silent' });
    expect(ns.current()).toEqual({ narrative: STORY, atMs: T0 });   // 旧叙事原封不动
  });

  it('adapter 缺失（getAdapter 返 null / 未注入 / 抛错）→ no_brain，零 chat 调用，缓存不动', async () => {
    const { timeline } = makeFakes();
    const a = createNarrativeSelf({ timeline, getAdapter: () => null, now: () => T0 });
    expect(await a.refresh()).toEqual({ refreshed: false, reason: 'no_brain' });
    expect(a.current()).toBeNull();
    const b = createNarrativeSelf({ timeline, now: () => T0 });   // getAdapter 根本没注入
    expect(await b.refresh()).toEqual({ refreshed: false, reason: 'no_brain' });
    const c = createNarrativeSelf({ timeline, getAdapter: () => { throw new Error('pool 坏了'); }, now: () => T0 });
    expect(await c.refresh()).toEqual({ refreshed: false, reason: 'no_brain' });
  });

  it('chat 抛错 → brain_error，旧叙事不被破坏，不向上抛', async () => {
    const fakes = makeFakes();
    let boom = false;
    const adapter = { chat: async (...args) => { if (boom) throw new Error('模型挂了'); return fakes.adapter.chat(...args); } };
    const ns = createNarrativeSelf({ timeline: fakes.timeline, getAdapter: () => adapter, now: () => T0 });
    await ns.refresh();
    boom = true;
    const r = await ns.refresh({ force: true });
    expect(r.refreshed).toBe(false);
    expect(r.reason).toBe('brain_error');
    expect(ns.current()).toEqual({ narrative: STORY, atMs: T0 });
  });

  it('时间线空 / 缺失 / recent 抛错 → no_episodes，零 chat 调用', async () => {
    const { getAdapter, chatCalls } = makeFakes();
    const a = createNarrativeSelf({ timeline: { recent: () => [] }, getAdapter, now: () => T0 });
    expect(await a.refresh()).toEqual({ refreshed: false, reason: 'no_episodes' });
    const b = createNarrativeSelf({ timeline: null, getAdapter, now: () => T0 });
    expect(await b.refresh()).toEqual({ refreshed: false, reason: 'no_episodes' });
    const c = createNarrativeSelf({ timeline: { recent: () => { throw new Error('库挂了'); } }, getAdapter, now: () => T0 });
    expect(await c.refresh()).toEqual({ refreshed: false, reason: 'no_episodes' });
    expect(chatCalls).toHaveLength(0);
  });
});

describe('createNarrativeSelf · 持久化（atomicJsonFile，重启不丢）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-narrative-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('refresh 成功落盘；新实例同文件冷启动恢复叙事，零模型调用', async () => {
    const file = join(dir, 'narrative-self.json');
    const { getAdapter, timeline } = makeFakes();
    const ns = createNarrativeSelf({ timeline, getAdapter, stateFile: file, now: () => T0 });
    await ns.refresh();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, narrative: STORY, atMs: T0 });

    // 重启模拟：新实例 + 永不该被调用的 adapter
    let chatCount = 0;
    const ns2 = createNarrativeSelf({
      timeline, stateFile: file, now: () => T0 + 60_000,
      getAdapter: () => ({ chat: async () => { chatCount += 1; return { reply: '不该被调用' }; } }),
    });
    expect(ns2.current()).toEqual({ narrative: STORY, atMs: T0 });
    expect(await ns2.refresh()).toEqual({ refreshed: false, reason: 'fresh' });   // 持久化缓存仍新鲜 → 不烧模型
    expect(chatCount).toBe(0);
  });

  it('状态文件损坏/字段无效 → fail-open 当没存过（current null），不炸', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{half json', 'utf-8');
    const ns = createNarrativeSelf({ timeline: null, stateFile: bad, now: () => T0 });
    expect(ns.current()).toBeNull();

    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ version: 1, narrative: '', atMs: 'NaN' }), 'utf-8');
    const ns2 = createNarrativeSelf({ timeline: null, stateFile: invalid, now: () => T0 });
    expect(ns2.current()).toBeNull();
  });
});

describe('NoeSelfModel 注入「我的故事」（未注入与现状逐字一致）', () => {
  const fakeTimeline = { recent: () => [] };
  const base = () => new NoeSelfModel({ timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0 });

  it('注入 narrativeSelf 且有叙事 → 出现「我的故事」一行（紧跟身份行）', () => {
    const m = new NoeSelfModel({
      timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0,
      narrativeSelf: { current: () => ({ narrative: STORY, atMs: T0 }) },
    });
    const block = m.buildSelfStateBlock();
    expect(block).toContain(`- 我的故事：${STORY}`);
    const lines = block.split('\n');
    expect(lines.findIndex((l) => l.startsWith('- 我的故事'))).toBe(lines.findIndex((l) => l.startsWith('- 我是谁')) + 1);
  });

  it('未注入（默认 null）→ 零调用零影响，块与现状逐字一致；叙事为空/null 也不出现该行', () => {
    const baseline = base().buildSelfStateBlock();
    expect(baseline).not.toContain('我的故事');

    let calls = 0;
    const withNull = new NoeSelfModel({
      timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0,
      narrativeSelf: { current: () => { calls += 1; return null; } },
    });
    expect(withNull.buildSelfStateBlock()).toBe(baseline);
    expect(calls).toBe(1);   // 注入了才会被调用——未注入时连 current 都不存在，自然零调用

    const withEmpty = new NoeSelfModel({
      timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0,
      narrativeSelf: { current: () => ({ narrative: '   ', atMs: T0 }) },
    });
    expect(withEmpty.buildSelfStateBlock()).toBe(baseline);
  });

  it('narrativeSelf.current 抛错 / 形状不合法 → fail-open，块与现状逐字一致', () => {
    const baseline = base().buildSelfStateBlock();
    const withThrow = new NoeSelfModel({
      timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0,
      narrativeSelf: { current: () => { throw new Error('坏了'); } },
    });
    expect(withThrow.buildSelfStateBlock()).toBe(baseline);

    const withBadShape = new NoeSelfModel({
      timeline: fakeTimeline, hostContextBlock: () => '', now: () => T0,
      narrativeSelf: /** @type {any} */ ({ current: 'not-a-function' }),
    });
    expect(withBadShape.buildSelfStateBlock()).toBe(baseline);
  });
});
