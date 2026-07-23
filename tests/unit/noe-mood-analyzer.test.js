// NoeMoodAnalyzer（内在世界·支柱④）单测：全程注入 fake timeline/adapter，绝不连真库。
// 断言三件事：注入时行为正确形状 / 未注入（依赖缺失）时零调用零影响 / 依赖抛错时 fail-open 不破坏原返回。
import { describe, expect, it } from 'vitest';
import { cleanMood, createMoodAnalyzer, createCachedMoodInferrer } from '../../src/context/NoeMoodAnalyzer.js';

const T0 = 1_780_000_000_000;
const EPISODES = [
  { type: 'interaction', summary: '主人问我今天过得怎么样', salience: 3, ts: T0 - 60_000 },
  { type: 'milestone', summary: '修好了媒体生成 bug', salience: 7, ts: T0 - 3_600_000 },
];

function makeFakes({ reply = '踏实，有点开心', chatError = null, episodes = EPISODES } = {}) {
  const chatCalls = [];
  const adapter = {
    chat: async (messages, options) => {
      chatCalls.push({ messages, options });
      if (chatError) throw chatError;
      return { reply };
    },
  };
  const getAdapterCalls = [];
  const getAdapter = (id) => { getAdapterCalls.push(id); return adapter; };
  const timeline = { recent: ({ limit } = {}) => episodes.slice(0, limit) };
  return { adapter, getAdapter, getAdapterCalls, chatCalls, timeline };
}

describe('cleanMood（输出清洗）', () => {
  it('剥 <think> 块、包裹引号、尾部句号，只取第一行', () => {
    expect(cleanMood('<think>让我想想最近发生了什么</think>平稳，待命中。')).toBe('平稳，待命中');
    expect(cleanMood('「有点惦记」')).toBe('有点惦记');
    expect(cleanMood('"踏实"\n（因为刚修好了 bug，所以…）')).toBe('踏实');
  });

  it('SILENT / 空 / 超长跑题文本 → 判无效返回空串', () => {
    expect(cleanMood('SILENT')).toBe('');
    expect(cleanMood('  silent  ')).toBe('');
    expect(cleanMood('')).toBe('');
    expect(cleanMood(null)).toBe('');
    expect(cleanMood('我此刻的心境非常复杂，既有完成任务的喜悦，也有对未来的隐隐期待，总之一言难尽')).toBe('');
  });
});

describe('createMoodAnalyzer', () => {
  it('analyze 成功 → 缓存命中：current() 同步给 {mood, atMs}，chat 形状正确且不带超时', async () => {
    const { getAdapter, chatCalls, timeline } = makeFakes();
    let t = T0;
    const a = createMoodAnalyzer({ timeline, getAdapter, brainAdapterId: 'lmstudio', model: 'test-model', ttlMs: 10 * 60000, now: () => t });
    expect(a.current()).toBeNull();   // 没跑过 → null

    const r = await a.analyze();
    expect(r).toEqual({ analyzed: true, mood: '踏实，有点开心' });
    expect(a.current()).toEqual({ mood: '踏实，有点开心', atMs: T0 });

    expect(chatCalls).toHaveLength(1);
    const { messages, options } = chatCalls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('SILENT');
    expect(messages[1].content).toContain('主人问我今天过得怎么样');
    expect(options.think).toBe(false);
    expect(options.model).toBe('test-model');
    expect(options.budgetContext).toEqual({ projectId: 'noe', taskId: 'noe-mood-analyzer' });
    // 跑模型纪律：不设任何超时
    expect(options).not.toHaveProperty('signal');
    expect(options).not.toHaveProperty('timeoutMs');
    expect(options).not.toHaveProperty('timeout');
  });

  it('缓存过期 → current() 回 null（调用方据此回启发式）', async () => {
    const { getAdapter, timeline } = makeFakes();
    let t = T0;
    const a = createMoodAnalyzer({ timeline, getAdapter, ttlMs: 5 * 60000, now: () => t });
    await a.analyze();
    expect(a.current()).not.toBeNull();
    t = T0 + 5 * 60000 + 1;   // 刚过 ttl
    expect(a.current()).toBeNull();
  });

  it('adapter 缺失（getAdapter 返 null / 未注入）→ no_brain，零 chat 调用，缓存不动', async () => {
    const { timeline } = makeFakes();
    const a = createMoodAnalyzer({ timeline, getAdapter: () => null, now: () => T0 });
    expect(await a.analyze()).toEqual({ analyzed: false, reason: 'no_brain' });
    expect(a.current()).toBeNull();
    const b = createMoodAnalyzer({ timeline, now: () => T0 });   // getAdapter 根本没注入
    expect(await b.analyze()).toEqual({ analyzed: false, reason: 'no_brain' });
  });

  it('getAdapter 抛错 → fail-open 按 no_brain 处理，不向上抛', async () => {
    const { timeline } = makeFakes();
    const a = createMoodAnalyzer({ timeline, getAdapter: () => { throw new Error('pool 坏了'); }, now: () => T0 });
    expect(await a.analyze()).toEqual({ analyzed: false, reason: 'no_brain' });
  });

  it('时间线空 / 缺失 / recent 抛错 → no_episodes，零 chat 调用', async () => {
    const { getAdapter, chatCalls } = makeFakes({ episodes: [] });
    const a = createMoodAnalyzer({ timeline: { recent: () => [] }, getAdapter, now: () => T0 });
    expect(await a.analyze()).toEqual({ analyzed: false, reason: 'no_episodes' });
    const b = createMoodAnalyzer({ timeline: null, getAdapter, now: () => T0 });
    expect(await b.analyze()).toEqual({ analyzed: false, reason: 'no_episodes' });
    const c = createMoodAnalyzer({ timeline: { recent: () => { throw new Error('库挂了'); } }, getAdapter, now: () => T0 });
    expect(await c.analyze()).toEqual({ analyzed: false, reason: 'no_episodes' });
    expect(chatCalls).toHaveLength(0);
  });

  it('chat 抛错 → fail-open：brain_error，旧缓存不被破坏', async () => {
    const fakes = makeFakes();
    let t = T0;
    let boom = false;
    const adapter = { chat: async (...args) => { if (boom) throw new Error('模型挂了'); return fakes.adapter.chat(...args); } };
    const a = createMoodAnalyzer({ timeline: fakes.timeline, getAdapter: () => adapter, ttlMs: 60 * 60000, now: () => t });
    await a.analyze();
    expect(a.current()?.mood).toBe('踏实，有点开心');
    boom = true;
    t = T0 + 60_000;
    const r = await a.analyze();
    expect(r.analyzed).toBe(false);
    expect(r.reason).toBe('brain_error');
    expect(a.current()).toEqual({ mood: '踏实，有点开心', atMs: T0 });   // 旧缓存还在
  });

  it('模型回 SILENT / 无效输出 → silent，不更新缓存', async () => {
    const { getAdapter, timeline } = makeFakes({ reply: 'SILENT' });
    const a = createMoodAnalyzer({ timeline, getAdapter, now: () => T0 });
    expect(await a.analyze()).toEqual({ analyzed: false, reason: 'silent' });
    expect(a.current()).toBeNull();
  });

  it('并发守卫：进行中再 analyze 共享同一次，只打一次模型', async () => {
    const { getAdapter, chatCalls, timeline } = makeFakes();
    const a = createMoodAnalyzer({ timeline, getAdapter, now: () => T0 });
    const [r1, r2] = await Promise.all([a.analyze(), a.analyze()]);
    expect(chatCalls).toHaveLength(1);
    expect(r1).toBe(r2);
  });
});

describe('createCachedMoodInferrer（装配点包装：缓存新鲜用模型，否则回启发式）', () => {
  const fallback = (recent, now, circadian) => `启发式(${recent.length},${now},${circadian ? '夜' : '无节律'})`;

  it('缓存新鲜 → 返回模型 mood，不调 fallback、不触发刷新', () => {
    let analyzeCalls = 0;
    const analyzer = { current: () => ({ mood: '踏实', atMs: T0 }), analyze: () => { analyzeCalls += 1; return Promise.resolve({}); } };
    const infer = createCachedMoodInferrer({ analyzer, fallback });
    expect(infer(EPISODES, T0, null)).toBe('踏实');
    expect(analyzeCalls).toBe(0);
  });

  it('缓存过期/为空 → 同步立即回 fallback（含 circadian 第三参透传），并后台触发一次刷新', () => {
    let analyzeCalls = 0;
    const analyzer = { current: () => null, analyze: () => { analyzeCalls += 1; return Promise.resolve({}); } };
    const infer = createCachedMoodInferrer({ analyzer, fallback });
    expect(infer(EPISODES, T0, { isQuiet: () => true })).toBe(`启发式(2,${T0},夜)`);
    expect(analyzeCalls).toBe(1);   // 这是 NOE_INNER_MONOLOGUE 未开时的独立刷新机制
  });

  it('analyzer 缺失 / current 抛错 / analyze 拒绝 → fail-open 全部回 fallback，不炸', async () => {
    const inferNoAnalyzer = createCachedMoodInferrer({ analyzer: /** @type {any} */ (null), fallback });
    expect(inferNoAnalyzer(EPISODES, T0, null)).toBe(`启发式(2,${T0},无节律)`);

    const inferThrow = createCachedMoodInferrer({
      analyzer: { current: () => { throw new Error('坏了'); }, analyze: () => Promise.resolve({}) },
      fallback,
    });
    expect(inferThrow(EPISODES, T0, null)).toBe(`启发式(2,${T0},无节律)`);

    const rejected = Promise.reject(new Error('模型挂了'));
    const inferReject = createCachedMoodInferrer({ analyzer: { current: () => null, analyze: () => rejected }, fallback });
    expect(inferReject(EPISODES, T0, null)).toBe(`启发式(2,${T0},无节律)`);
    await new Promise((r) => setTimeout(r, 0));   // 后台 rejection 已被吞，无 unhandled
  });

  it('fallback 缺失 → 构造时报错（fail-fast，装配错误别带病上线）', () => {
    expect(() => createCachedMoodInferrer({ analyzer: { current: () => null, analyze: () => Promise.resolve({}) }, fallback: /** @type {any} */ (null) }))
      .toThrow(/fallback/);
  });
});
