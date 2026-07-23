// @ts-check
import { describe, expect, it } from 'vitest';
import { createTopicCurator } from '../../src/cognition/NoeTopicCurator.js';

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}
const SEEDS = [
  { title: 'A', url: 'https://x/a' },
  { title: 'B', url: 'https://x/b' },
  { title: 'C', url: 'https://x/c' },
];

describe('createTopicCurator（阶段3 动态选题，治 cursor%6 循环）', () => {
  it('round-robin：依次选不同 topic（最久没学优先），不固定打转', () => {
    let t = 1000;
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => t });
    const picks = [];
    for (let i = 0; i < 3; i += 1) {
      const { topic } = c.getNextTopic();
      picks.push(topic.title);
      c.recordVisit(topic);
      t += 100;
    }
    expect(new Set(picks).size).toBe(3); // 3 次选了 3 个不同的，非死循环同一个
  });

  it('dynamicPriority=true：动态发现主题优先于静态 seed（价值对齐 D）', () => {
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => 1000 });
    const dyn = [{ title: 'DYN1', url: 'https://x/dyn1' }];
    const { topic, reason } = c.getNextTopic({ dynamicConcepts: dyn, dynamicPriority: true });
    expect(topic.title).toBe('DYN1'); // 静态/动态都没学过时，动态优先
    expect(reason).toBe('dynamic_novel');
  });

  it('dynamicPriority=false：原行为(静态在前,最久没学优先)——零回归', () => {
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => 1000 });
    const dyn = [{ title: 'DYN1', url: 'https://x/dyn1' }];
    const { topic } = c.getNextTopic({ dynamicConcepts: dyn }); // 默认 OFF
    expect(topic.title).toBe('A'); // pool=[A,B,C,DYN1] 都未学,稳定排序→第一个静态 seed
  });

  it('饱和冷却：一个 topic 学满 satN 次后进冷却，不再被选', () => {
    let t = 1000;
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => t, saturationVisits: 2, cooldownMs: 100000 });
    // 把 A 学满 2 次
    c.recordVisit(SEEDS[0]); c.recordVisit(SEEDS[0]);
    expect(c.isSaturated(SEEDS[0])).toBe(true);
    // 接下来几次选题都不该是 A（A 饱和+冷却中）
    for (let i = 0; i < 4; i += 1) {
      const { topic } = c.getNextTopic();
      expect(topic.title).not.toBe('A');
      c.recordVisit(topic);
      t += 100;
    }
  });

  it('冷却过期→解冻可重学', () => {
    let t = 1000;
    const c = createTopicCurator({ kv: makeKv(), seeds: [SEEDS[0]], now: () => t, saturationVisits: 1, cooldownMs: 100000 });
    c.recordVisit(SEEDS[0]);
    expect(c.isSaturated(SEEDS[0])).toBe(true); // 学 1 次即满，冷却中
    t += 110000; // 冷却过期（> cooldownMs 100s，避开 60s 下限 clamp）
    expect(c.isSaturated(SEEDS[0])).toBe(false); // 解冻
  });

  it('全饱和 → 解冻最旧的（不完全停学）', () => {
    let t = 1000;
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => t, saturationVisits: 1, cooldownMs: 1e9 });
    // 全学满
    SEEDS.forEach((s, i) => { t = 1000 + i * 100; c.recordVisit(s); });
    const { topic, reason } = c.getNextTopic();
    expect(reason).toBe('all_saturated_thaw_oldest');
    expect(topic.title).toBe('A'); // A 最久没学（lastVisit 最小）
  });

  it('动态扩池：读到的新概念过 novelty 门进候选', () => {
    let t = 1000;
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => t, saturationVisits: 1, cooldownMs: 1e9 });
    SEEDS.forEach((s) => c.recordVisit(s)); // 6 种子全饱和
    const dyn = [{ title: 'NewConcept', url: 'https://x/new', query: 'q' }];
    const { topic, reason } = c.getNextTopic({ dynamicConcepts: dyn });
    expect(topic.title).toBe('NewConcept'); // 新概念未饱和，优先于全饱和种子
    expect(reason).toBe('dynamic_novel');
  });

  it('novelty 门：已学过的动态概念被过滤（不重复）', () => {
    const c = createTopicCurator({ kv: makeKv(), seeds: [], now: () => 1000 });
    c.recordVisit({ title: 'Seen', url: 'https://x/seen' });
    const { topic } = c.getNextTopic({ dynamicConcepts: [{ title: 'Seen', url: 'https://x/seen' }] });
    // Seen 已学过 → 被过滤 → 空池回退
    expect(topic).toBeNull();
  });

  it('report：饱和度报表', () => {
    const c = createTopicCurator({ kv: makeKv(), seeds: SEEDS, now: () => 1000, saturationVisits: 1, cooldownMs: 1e9 });
    c.recordVisit(SEEDS[0]);
    const r = c.report();
    expect(r.total).toBe(1);
    expect(r.saturated).toBe(1);
  });

  it('缺 kv → 构造即抛', () => {
    expect(() => createTopicCurator({})).toThrow(/kv/);
  });
});
