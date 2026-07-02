// @ts-check
// 夜间反思（意识工程·阶段2）单测：JSON 解析鲁棒性、confidence 升降、全流程（写新洞察/复核回写/
// 各类守卫/fail-open）。全注入假依赖+假时钟。
import { describe, it, expect } from 'vitest';
import { createNightlyReflection, parseReflection, clampConfidence, adjustConfidence, applyVerdicts } from '../../src/memory/NoeNightlyReflection.js';

const T0 = 1_700_000_000_000;

describe('parseReflection（本地模型 JSON 输出鲁棒解析）', () => {
  it('裸 JSON / ```json 围栏 / 前后嘟囔 都能解析', () => {
    expect(parseReflection('{"new":[],"reviews":[]}')).toEqual({ new: [], reviews: [] });
    expect(parseReflection('```json\n{"new":[{"text":"x"}],"reviews":[]}\n```')).toEqual({ new: [{ text: 'x' }], reviews: [] });
    expect(parseReflection('好的，以下是我的反思：{"new":[],"reviews":[]} 希望有帮助')).toEqual({ new: [], reviews: [] });
  });
  it('think 标签剥离后解析', () => {
    expect(parseReflection('<think>嗯…</think>{"new":[],"reviews":[]}')).toEqual({ new: [], reviews: [] });
  });
  it('坏 JSON / 无 JSON → null（fail-open）', () => {
    expect(parseReflection('{"new":[')).toBeNull();
    expect(parseReflection('今天没什么好说的')).toBeNull();
    expect(parseReflection('')).toBeNull();
  });
  it('JSON 后跟含 {} 的废话 → 只取第一个平衡段（审查建议 B 场景）', () => {
    expect(parseReflection('{"new":[],"reviews":[]} 希望符合格式 {"key":"value"}')).toEqual({ new: [], reviews: [] });
  });
  it('前面有坏括号片段时继续寻找后面的有效 JSON', () => {
    expect(parseReflection('草稿 {不是 JSON；真正结果：```json\n{"new":[],"reviews":[{"id":"a","verdict":"neutral"}]}\n```'))
      .toEqual({ new: [], reviews: [{ id: 'a', verdict: 'neutral' }] });
  });
  it('字符串值内不成对的花括号不破坏提取（字符串感知计数）', () => {
    expect(parseReflection('{"new":[{"text":"代码块用 } 结尾这件事我记住了","kind":"lesson","confidence":0.5}],"reviews":[]}'))
      .toEqual({ new: [{ text: '代码块用 } 结尾这件事我记住了', kind: 'lesson', confidence: 0.5 }], reviews: [] });
    expect(parseReflection('{"new":[{"text":"转义引号\\"也安全","kind":"belief","confidence":0.4}],"reviews":[]}'))
      .toEqual({ new: [{ text: '转义引号"也安全', kind: 'belief', confidence: 0.4 }], reviews: [] });
  });
});

describe('confidence 升降', () => {
  it('clamp 进 [0.05, 0.95]，非法回退 0.5', () => {
    expect(clampConfidence(1.5)).toBe(0.95);
    expect(clampConfidence(-1)).toBe(0.05);
    expect(clampConfidence('x')).toBe(0.5);
  });
  it('confirmed/shaken 对称 ±0.1（终审 P0-1：非对称会交替漂移到底）/ neutral 不动，永不出界', () => {
    expect(adjustConfidence(0.5, 'confirmed')).toBeCloseTo(0.6);
    expect(adjustConfidence(0.5, 'shaken')).toBeCloseTo(0.4);
    expect(adjustConfidence(0.5, 'neutral')).toBe(0.5);
    expect(adjustConfidence(0.9, 'confirmed')).toBe(0.95);
    expect(adjustConfidence(0.1, 'shaken')).toBe(0.05);
    // 交替印证/动摇 10 轮后必须仍在中性带（漂移回归测试）
    let c = 0.5;
    for (let i = 0; i < 10; i += 1) c = adjustConfidence(c, i % 2 ? 'confirmed' : 'shaken');
    expect(c).toBeGreaterThan(0.35);
    expect(c).toBeLessThan(0.65);
  });
});

/** 组一套可观测的假依赖。 */
function rig({ episodes = 8, reply, priors = [] } = {}) {
  const written = [];
  const timeline = {
    recent: ({ sinceTs }) => Array.from({ length: episodes }, (_, i) => ({
      type: 'interaction', summary: `事件${i}`, ts: (sinceTs || T0) + i, salience: 3,
    })),
  };
  const memory = {
    write: (m) => { written.push(m); return m; },
    recall: () => priors,
  };
  const adapter = { chat: async () => ({ reply }) };
  return { written, timeline, memory, getAdapter: () => adapter };
}

describe('reflectOnce 全流程', () => {
  it('写新 insight（字段校验+kind 白名单+confidence clamp）并推进水位线', async () => {
    const { written, timeline, memory, getAdapter } = rig({
      reply: JSON.stringify({
        new: [
          { text: '主人深夜工作时更需要安静的陪伴', kind: 'pattern', confidence: 0.7 },
          { text: '短', kind: 'lesson', confidence: 0.5 },               // <6 字被丢
          { text: '我对模型输出过度自信时容易出错', kind: '怪类型', confidence: 9 }, // kind 归 pattern、conf clamp
        ],
        reviews: [],
      }),
    });
    let t = T0;
    const nr = createNightlyReflection({ timeline, memory, getAdapter, now: () => t });
    const r = await nr.refresh();
    expect(r.reflected).toBe(true);
    expect(r.written).toBe(2);
    expect(written[0]).toMatchObject({ scope: 'insight', confidence: 0.7, sourceType: 'nightly_reflection' });
    expect(written[1].tags).toContain('pattern');
    expect(written[1].confidence).toBe(0.95);
    expect(nr.lastRunAt()).toBe(T0);
    // 水位线生效：20h 内再 refresh 是 fresh
    t += 3600000;
    expect((await nr.refresh()).reason).toBe('fresh');
  });

  it('复核回写：confirmed 升 / shaken 降 / neutral 与未提及不动（显式 id upsert 全字段）', async () => {
    const priors = [
      { id: 'in-1', body: '旧认知A', confidence: 0.5, tags: ['insight'], scope: 'insight', salience: 3, title: 'A' },
      { id: 'in-2', body: '旧认知B', confidence: 0.5, tags: ['insight'], scope: 'insight', salience: 3, title: 'B' },
      { id: 'in-3', body: '旧认知C', confidence: 0.5, tags: ['insight'], scope: 'insight', salience: 3, title: 'C' },
    ];
    const { written, timeline, memory, getAdapter } = rig({
      priors,
      reply: JSON.stringify({
        new: [],
        reviews: [
          { id: 'in-1', verdict: 'confirmed' },
          { id: 'in-2', verdict: 'shaken' },
          { id: 'in-3', verdict: 'neutral' },
        ],
      }),
    });
    const nr = createNightlyReflection({ timeline, memory, getAdapter, now: () => T0 });
    const r = await nr.refresh();
    expect(r.reviewed).toBe(2);
    const byId = Object.fromEntries(written.map((w) => [w.id, w]));
    expect(byId['in-1'].confidence).toBeCloseTo(0.6);
    expect(byId['in-1'].body).toBe('旧认知A'); // 全字段原样回写
    expect(byId['in-2'].confidence).toBeCloseTo(0.4); // 对称 -0.1（终审 P0-1）
    expect(byId['in-3']).toBeUndefined();
  });

  it('自动夜间反思接受 Qwen 模型配置', async () => {
    let seenModel = '';
    let seenOpts = null;
    const timeline = {
      recent: () => Array.from({ length: 8 }, (_, i) => ({ type: 'interaction', summary: `事件${i}`, ts: T0 + i, salience: 3 })),
    };
    const memory = { write: () => ({}), recall: () => [] };
    const getAdapter = () => ({
      chat: async (_messages, opts) => {
        seenOpts = opts;
        seenModel = opts.model;
        return { reply: '{"new":[],"reviews":[]}' };
      },
    });
    const nr = createNightlyReflection({
      timeline,
      memory,
      getAdapter,
      model: 'qwen/qwen3.6-35b-a3b',
      now: () => T0,
    });
    const r = await nr.refresh();
    expect(r.reflected).toBe(true);
    expect(seenModel).toBe('qwen/qwen3.6-35b-a3b');
    expect(seenOpts).toMatchObject({ temperature: 0, top_p: 1, maxTokens: 4096 });
  });

  it('模型 length 截断时不写 insight、不推进水位线', async () => {
    const written = [];
    const timeline = {
      recent: () => Array.from({ length: 8 }, (_, i) => ({ type: 'interaction', summary: `事件${i}`, ts: T0 + i, salience: 3 })),
    };
    const memory = { write: (m) => { written.push(m); return m; }, recall: () => [] };
    const nr = createNightlyReflection({
      timeline,
      memory,
      getAdapter: () => ({ chat: async () => ({ reply: '{"new":[{"text":"半截洞察"}]}', incomplete: true, finishReason: 'length' }) }),
      now: () => T0,
    });
    const r = await nr.refresh();
    expect(r).toMatchObject({ reflected: false, reason: 'brain_incomplete', finishReason: 'length' });
    expect(written).toHaveLength(0);
    expect(nr.lastRunAt()).toBe(0);
  });

  it('素材 <5 条不反思；夜相守卫：phaseOf 非 night 不跑、force 越过', async () => {
    const few = rig({ episodes: 3, reply: '{"new":[],"reviews":[]}' });
    expect((await createNightlyReflection({ ...few, now: () => T0 }).refresh()).reason).toBe('too_few_episodes');

    const day = rig({ reply: '{"new":[],"reviews":[]}' });
    const nr = createNightlyReflection({ ...day, phaseOf: () => 'day', now: () => T0 });
    expect((await nr.refresh()).reason).toBe('not_night');
    expect((await nr.refresh({ force: true })).reflected).toBe(true);
  });

  it('大脑抛错 / 输出不可解析 → fail-open 且不推水位线', async () => {
    const boom = rig({});
    boom.getAdapter = () => ({ chat: async () => { throw new Error('模型挂了'); } });
    const nr1 = createNightlyReflection({ ...boom, now: () => T0 });
    expect((await nr1.refresh()).reason).toBe('brain_error');
    expect(nr1.lastRunAt()).toBe(0);

    const garbage = rig({ reply: '我觉得今天挺好的' });
    const nr2 = createNightlyReflection({ ...garbage, now: () => T0 });
    expect((await nr2.refresh()).reason).toBe('unparseable');
    expect(nr2.lastRunAt()).toBe(0);
  });

  it('未接线（缺 timeline/memory）→ not_wired 不崩', async () => {
    const nr = createNightlyReflection({ getAdapter: () => null, now: () => T0 });
    expect((await nr.refresh()).reason).toBe('not_wired');
  });
});

describe('applyVerdicts（独立单测，终审 P2 提取）', () => {
  it('ttlMs/expiresAt/sourceId/mergeTrace 原样透传（upsert 不清零）；写炸单条不阻断', () => {
    const written = [];
    const memory = {
      write: (m) => {
        if (m.id === 'boom') throw new Error('写炸');
        written.push(m);
      },
    };
    const priors = [
      { id: 'a', body: 'A', confidence: 0.5, tags: ['insight'], scope: 'insight', salience: 3, title: 'A', ttlMs: 86400000, expiresAt: T0 + 86400000, sourceId: 'ep-9', mergeTrace: [{ at: 1 }] },
      { id: 'boom', body: 'B', confidence: 0.5, tags: [], scope: 'insight', salience: 3, title: 'B' },
      { id: 'c', body: 'C', confidence: 0.5, tags: [], scope: 'insight', salience: 3, title: 'C' },
    ];
    const reviews = [
      { id: 'a', verdict: 'confirmed' },
      { id: 'boom', verdict: 'shaken' },
      { id: 'c', verdict: 'shaken' },
    ];
    const n = applyVerdicts({ priors, reviews, memory, projectId: 'noe' });
    expect(n).toBe(2); // boom 写炸不计入但也不阻断 c
    const a = written.find((w) => w.id === 'a');
    expect(a).toMatchObject({ ttlMs: 86400000, expiresAt: T0 + 86400000, sourceId: 'ep-9', confidence: 0.6 });
    expect(a.mergeTrace).toEqual([{ at: 1 }]);
    expect(written.find((w) => w.id === 'c').confidence).toBeCloseTo(0.4);
  });
});
