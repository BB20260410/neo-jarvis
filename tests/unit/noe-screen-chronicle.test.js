// @ts-check
import { describe, expect, it } from 'vitest';
import { createNoeScreenChronicle } from '../../src/vision/NoeScreenChronicle.js';

function make({ observe, enabled = true, setTimer, clearTimer } = {}) {
  const recorded = [];
  const c = createNoeScreenChronicle({
    observe,
    recordObservation: (summary, meta) => recorded.push({ summary, meta }),
    enabled,
    setTimer,
    clearTimer,
  });
  return { c, recorded };
}

describe('createNoeScreenChronicle（本地屏幕编年史调度器）', () => {
  it('env OFF（enabled=false）→ start 不启动', () => {
    const { c } = make({ enabled: false, observe: async () => ({ summary: 'x' }) });
    expect(c.start()).toBe(false);
    expect(c.status().running).toBe(false);
  });

  it('tickOnce：有新 summary → 沉淀 observation（带 screen_chronicle 来源）', async () => {
    const { c, recorded } = make({ observe: async () => ({ summary: '在写代码', at: 123, mode: 'screen' }) });
    await c.tickOnce();
    expect(recorded.length).toBe(1);
    expect(recorded[0].summary).toBe('在写代码');
    expect(recorded[0].meta.source).toBe('screen_chronicle');
    expect(recorded[0].meta.at).toBe(123);
  });

  it('屏幕没变(no_change) / 视觉关(vision_off) → 不沉淀', async () => {
    const nc = make({ observe: async () => ({ summary: 'x', skipped: 'no_change' }) });
    await nc.c.tickOnce();
    expect(nc.recorded.length).toBe(0);
    const vo = make({ observe: async () => ({ summary: 'x', skipped: 'vision_off' }) });
    await vo.c.tickOnce();
    expect(vo.recorded.length).toBe(0);
  });

  it('二次去重：连续相同 summary 只记一次', async () => {
    const { c, recorded } = make({ observe: async () => ({ summary: '同一屏' }) });
    await c.tickOnce();
    await c.tickOnce();
    expect(recorded.length).toBe(1);
  });

  it('fail-open：observe 抛错 tick 不崩、不沉淀', async () => {
    const { c, recorded } = make({ observe: async () => { throw new Error('VLM 挂了'); } });
    await expect(c.tickOnce()).resolves.toBeUndefined();
    expect(recorded.length).toBe(0);
  });

  it('observe 返回 null / 空 summary → 不沉淀', async () => {
    const a = make({ observe: async () => null });
    await a.c.tickOnce();
    const b = make({ observe: async () => ({ summary: '' }) });
    await b.c.tickOnce();
    expect(a.recorded.length + b.recorded.length).toBe(0);
  });

  it('start/stop 用注入的定时器；重复 start no-op', () => {
    let startedMs = null; let cleared = null;
    const c = createNoeScreenChronicle({
      observe: async () => ({ summary: 'x' }),
      recordObservation: () => {},
      enabled: true,
      setTimer: (_fn, ms) => { startedMs = ms; return 'TIMER'; },
      clearTimer: (t) => { cleared = t; },
    });
    expect(c.start()).toBe(true);
    expect(startedMs).toBe(10 * 60 * 1000);
    expect(c.status().running).toBe(true);
    expect(c.start()).toBe(false);
    expect(c.stop()).toBe(true);
    expect(cleared).toBe('TIMER');
  });
});
