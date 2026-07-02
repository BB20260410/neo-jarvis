import { describe, it, expect } from 'vitest';
import { createMemoryEcho } from '../../src/cognition/NoeMemoryEcho.js';

const T0 = 1_780_000_000_000;
const DAY = 86_400_000;

function makeTimeline(episodes) {
  return { recent: ({ types }) => episodes.filter((e) => !types || types.includes(e.type)) };
}

describe('NoeMemoryEcho 记忆回声采样', () => {
  it('排除 24h 内的近事与念头类型（回声=久远的非念头经历）', () => {
    const tl = makeTimeline([
      { id: 1, ts: T0 - 2 * 3600_000, type: 'interaction', summary: '太近' },
      { id: 2, ts: T0 - 3 * DAY, type: 'inner_monologue', summary: '念头' }, // 类型被 recent 过滤
      { id: 3, ts: T0 - 3 * DAY, type: 'interaction', summary: '三天前聊过种誓' },
    ]);
    const echo = createMemoryEcho({ timeline: tl, now: () => T0, rng: () => 0.5 });
    for (let i = 0; i < 10; i++) {
      const e = echo.sample();
      expect(e.id).toBe(3);
    }
  });

  it('高显著度记忆被采中的概率显著更高（softmax 温度 0.25）', () => {
    const tl = makeTimeline([
      { id: 1, ts: T0 - 3 * DAY, type: 'interaction', summary: '平淡小事', salience: 1 },
      { id: 2, ts: T0 - 3 * DAY, type: 'milestone', summary: '上线大事', salience: 5 },
    ]);
    let seed = 0;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const echo = createMemoryEcho({ timeline: tl, now: () => T0, rng });
    const hits = { 1: 0, 2: 0 };
    for (let i = 0; i < 200; i++) hits[echo.sample().id]++;
    expect(hits[2]).toBeGreaterThan(hits[1] * 2);
  });

  it('情感相称：带印记且与当下心情相近的记忆得分更高', () => {
    const tl = makeTimeline([
      { id: 1, ts: T0 - 3 * DAY, type: 'interaction', summary: '难过的事', salience: 3, meta: { affect: { v: -0.8 } } },
      { id: 2, ts: T0 - 3 * DAY, type: 'interaction', summary: '开心的事', salience: 3, meta: { affect: { v: 0.8 } } },
    ]);
    let seed = 7;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const echo = createMemoryEcho({ timeline: tl, now: () => T0, rng, affectProbe: () => ({ v: 0.7, a: 0.4 }) });
    const hits = { 1: 0, 2: 0 };
    for (let i = 0; i < 200; i++) hits[echo.sample().id]++;
    expect(hits[2]).toBeGreaterThan(hits[1]); // 心情好时更容易想起开心的事（情感一致性记忆效应）
  });

  it('池空 / timeline 抛错 → null（fail-open）', () => {
    expect(createMemoryEcho({ timeline: makeTimeline([]), now: () => T0 }).sample()).toBe(null);
    const broken = { recent: () => { throw new Error('炸'); } };
    expect(createMemoryEcho({ timeline: broken, now: () => T0 }).sample()).toBe(null);
    const onlyFresh = makeTimeline([{ id: 1, ts: T0 - 1000, type: 'interaction', summary: '刚刚' }]);
    expect(createMemoryEcho({ timeline: onlyFresh, now: () => T0 }).sample()).toBe(null);
  });
});
