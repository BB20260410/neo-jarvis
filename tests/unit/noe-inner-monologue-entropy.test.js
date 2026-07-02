// @ts-check
import { describe, expect, it } from 'vitest';
import { createInnerMonologue } from '../../src/loop/InnerMonologue.js';
import { createEntropyTemperature } from '../../src/cognition/NoeEntropyTemperature.js';

// 熵驱动生成温度接入 InnerMonologue：注入 fake timeline/adapter + 真 createEntropyTemperature
// （真熵数学，非桩）。不碰 process.env（用 factory 的显式 enabled），不真调本地模型。
//
// 基准温度 = NOE_MAIN_BRAIN.generation.temperature = 0.2（InnerMonologue baseTemperature 默认值）。
// factory 默认 alpha=0.4 beta=4：
//   念头扎堆（熵≈0）⇒ boost=0.4 ⇒ T=clamp(0.2+0.4)=0.6（升温换角度）；
//   念头正交（熵≈1）⇒ boost=0.4·e^-4≈0.007 ⇒ T≈0.207（基本不升温）。

const BASE = 0.2;

function fakeTimeline(initial = []) {
  const eps = [...initial];
  let id = 0;
  return {
    recent: ({ limit = 12 } = {}) => eps.slice(0, limit),
    record: (e) => { eps.unshift({ id: ++id, ...e }); return id; },
    _eps: eps,
  };
}

// 捕获 adapter.chat 收到的 opts（逐次记录，便于校验主调用 + 重写调用）
function capturingAdapter(reply) {
  const calls = [];
  const getAdapter = () => ({
    chat: async (_msgs, opts) => { calls.push(opts); return { reply }; },
  });
  return { getAdapter, calls };
}

describe('InnerMonologue × NoeEntropyTemperature 接入', () => {
  it('ON 端到端：念头扎堆（熵低/想腻了）⇒ adapter.chat 真升温（temperature≈base+α），meta/返回带 entropyTemperature', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: '主人在改代码', salience: 4, ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('换个角度想：也许该歇会儿');
    // 四个几乎相同的念头向量 ⇒ 在线聚类成 1 簇 ⇒ 熵 0 ⇒ 升温
    const same = [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]];
    const reflect = createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      thoughtVectors: async () => same,
    });
    const r = await reflect();
    expect(r.reflected).toBe(true);
    // 真升温：主 chat 调用收到 temperature ≈ 0.2 + 0.4 = 0.6
    expect(calls).toHaveLength(1);
    expect(calls[0].temperature).toBeCloseTo(BASE + 0.4, 6);
    // 升温信息进 meta（可观测）+ 进返回值
    expect(tl._eps[0].meta?.entropyTemperature).toBeTruthy();
    expect(tl._eps[0].meta.entropyTemperature.entropy).toBe(0);
    expect(tl._eps[0].meta.entropyTemperature.clusters).toBe(1);
    expect(tl._eps[0].meta.entropyTemperature.temperature).toBeCloseTo(0.6, 6);
    expect(r.entropyTemperature?.temperature).toBeCloseTo(0.6, 6);
  });

  it('ON 但念头发散（熵高）⇒ 基本不升温（temperature≈base），不记升温 meta', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('一个新念头');
    // 正交向量 ⇒ 多簇 ⇒ 熵≈1 ⇒ boost≈0.007，温度仍贴近 base
    const orthogonal = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const r = await createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      thoughtVectors: async () => orthogonal,
    })();
    expect(r.reflected).toBe(true);
    expect(calls[0].temperature).toBeGreaterThanOrEqual(BASE);
    expect(calls[0].temperature).toBeLessThan(BASE + 0.05); // 没有有意义的升温
    // 没有有意义升温（boosted 阈值边界外的微小提升仍标 boosted，但温度贴 base）——至少不应记成"想腻了升温"的大值
    expect(tl._eps[0].meta?.entropyTemperature?.temperature || BASE).toBeLessThan(BASE + 0.05);
  });

  it('OFF 零回归：entropyTemperature.enabled=false ⇒ adapter.chat opts 完全不含 temperature 键（与接线前逐字一致）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('普通念头');
    const r = await createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: false }),
      thoughtVectors: async () => [[1, 0, 0], [1, 0, 0]],
    })();
    expect(r.reflected).toBe(true);
    expect('temperature' in calls[0]).toBe(false); // OFF ⇒ 不传温度，用 adapter 固定默认
    expect(r.entropyTemperature).toBeUndefined();
    expect(tl._eps[0].meta?.entropyTemperature).toBeUndefined();
  });

  it('零回归（默认）：完全不注入 entropy 件 ⇒ 不含 temperature 键（旧调用方逐字不变）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('普通念头');
    const r = await createInnerMonologue({ timeline: tl, getAdapter })();
    expect(r.reflected).toBe(true);
    expect('temperature' in calls[0]).toBe(false);
  });

  it('fail-open：thoughtVectors 抛错 ⇒ 退回固定温度（不传 temperature），不崩、照常反刍', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('普通念头');
    const r = await createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      thoughtVectors: async () => { throw new Error('embed down'); },
    })();
    expect(r.reflected).toBe(true);
    expect('temperature' in calls[0]).toBe(false);
  });

  it('fail-open：ON 但未注入 thoughtVectors provider ⇒ 退回固定温度（不传 temperature）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('普通念头');
    const r = await createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      // 不注入 thoughtVectors
    })();
    expect(r.reflected).toBe(true);
    expect('temperature' in calls[0]).toBe(false);
  });

  it('fail-open：向量不足（<2 个念头）⇒ 熵无信号 ⇒ 退回基准温度（不升温）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('普通念头');
    const r = await createInnerMonologue({
      timeline: tl,
      getAdapter,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      thoughtVectors: async () => [[1, 0, 0]], // 只 1 个 ⇒ clusterEntropy 返回 null ⇒ temperature=base
    })();
    expect(r.reflected).toBe(true);
    // 拿到了温度（=base），但不是升温
    expect(calls[0].temperature).toBeCloseTo(BASE, 6);
    expect(tl._eps[0].meta?.entropyTemperature).toBeUndefined();
  });

  it('自定义 baseTemperature 被熵模块采纳为锚点（升温=base+α）', async () => {
    const tl = fakeTimeline([{ type: 'interaction', summary: 'x', ts: 1 }]);
    const { getAdapter, calls } = capturingAdapter('念头');
    const same = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];
    await createInnerMonologue({
      timeline: tl,
      getAdapter,
      baseTemperature: 0.5,
      entropyTemperature: createEntropyTemperature({ enabled: true }),
      thoughtVectors: async () => same,
    })();
    expect(calls[0].temperature).toBeCloseTo(0.5 + 0.4, 6); // 0.9
  });

  it('ON 升温会贯穿到接地重写调用（NOE_GROUNDING_REWRITE 路径同享动态温度）', async () => {
    // 构造：低接地念头触发重写 → 验证两次 chat 调用都带升温后的 temperature。
    const prevFlag = process.env.NOE_GROUNDING_REWRITE;
    process.env.NOE_GROUNDING_REWRITE = '1';
    try {
      const tl = fakeTimeline([{ type: 'interaction', summary: '主人在写文档', salience: 4, ts: 1 }]);
      let n = 0;
      const calls = [];
      const getAdapter = () => ({
        chat: async (_m, opts) => { calls.push(opts); n++; return { reply: n === 1 ? '抽象的空想念头' : '更贴近文档这件事的念头' }; },
      });
      // mindVitals 桩：首个念头接地低（0.1）→ 触发重写；重写后更高（0.9）→ 采纳
      const mindVitals = {
        similarity: async () => null,
        diversity: async () => ({ avgSim: null }),
        groundedness: async (key) => (String(key).startsWith('new2:') ? { score: 0.9, refKey: 'ep:1' } : { score: 0.1, refKey: 'ep:1' }),
      };
      const same = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];
      const r = await createInnerMonologue({
        timeline: tl,
        getAdapter,
        mindVitals,
        entropyTemperature: createEntropyTemperature({ enabled: true }),
        thoughtVectors: async () => same,
      })();
      expect(r.reflected).toBe(true);
      expect(calls.length).toBeGreaterThanOrEqual(2); // 主调用 + 重写调用
      for (const c of calls) expect(c.temperature).toBeCloseTo(BASE + 0.4, 6);
    } finally {
      if (prevFlag === undefined) delete process.env.NOE_GROUNDING_REWRITE;
      else process.env.NOE_GROUNDING_REWRITE = prevFlag;
    }
  });
});
