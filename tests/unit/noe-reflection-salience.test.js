import { describe, it, expect } from 'vitest';
import { createNightlyReflection } from '../../src/memory/NoeNightlyReflection.js';

// 长期规划 M4：盐度累计触发——白天攒够大事提前反思，不死等夜相；0=关闭原行为。

const T0 = 1_780_000_000_000;
const HOUR = 3600_000;

function deps({ episodes = [], reply = '[]' } = {}) {
  return {
    timeline: { recent: ({ sinceTs = 0 } = {}) => episodes.filter((e) => e.ts >= sinceTs) },
    memory: { write: () => 'id', recall: () => [] },
    getAdapter: () => ({ chat: async () => ({ reply }) }),
    phaseOf: () => 'day', // 白天：夜相守卫会拒
  };
}
const bigEvents = (ts) => Array.from({ length: 6 }, (_, i) => ({ id: i, ts: ts + i, type: 'interaction', summary: `大事${i}`, salience: 5 }));

describe('NoeNightlyReflection 盐度旁路（M4）', () => {
  it('默认关闭（threshold=0）：白天即使大事再多也 not_night（原行为）', async () => {
    let t = T0;
    const r = createNightlyReflection({ ...deps({ episodes: bigEvents(T0 - HOUR) }), now: () => t });
    const out = await r.refresh();
    expect(out.reflected).toBe(false);
    expect(out.reason).toBe('not_night');
  });

  it('开启后：高盐(≥4)非念头盐度累计 ≥ 阈值 → 白天也真跑反思', async () => {
    let t = T0;
    const r = createNightlyReflection({
      ...deps({ episodes: bigEvents(T0 - HOUR), reply: '[]' }),
      now: () => t,
      salienceThreshold: 20, // 6×5=30 ≥ 20
    });
    const out = await r.refresh();
    // 走到了真反思流程（素材够、模型回空数组 → reflected true/written 0 或同等成功形态）
    expect(out.reason === 'not_night' || out.reason === 'fresh').toBe(false);
  });

  it('低盐/念头不计入累计：攒不够仍走原守卫', async () => {
    const eps = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: i, ts: T0 - HOUR + i, type: 'interaction', summary: `小事${i}`, salience: 2 })),
      { id: 99, ts: T0 - HOUR + 99, type: 'inner_monologue', summary: '高盐念头', salience: 5 },
    ];
    const r = createNightlyReflection({ ...deps({ episodes: eps }), now: () => T0, salienceThreshold: 20 });
    const out = await r.refresh();
    expect(out.reason).toBe('not_night');
  });

  it('旁路 4h 硬下限防刷：刚反思过即使大事滚滚也不旁路', async () => {
    let t = T0;
    const d = deps({ episodes: bigEvents(T0 + HOUR), reply: '{"new":[],"review":[]}' });
    const r = createNightlyReflection({ ...d, now: () => t, salienceThreshold: 20, phaseOf: () => 'night' });
    await r.refresh(); // 夜相真跑一次，lastRunAt=T0
    t = T0 + 2 * HOUR; // 才过 2h（<4h 下限）
    const r2 = await r.refresh();
    expect(r2.reflected).toBe(false); // fresh 守卫生效（旁路被硬下限挡住）
    expect(r2.reason).toBe('fresh');
  });
});
