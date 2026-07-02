// @ts-check
import { describe, expect, it } from 'vitest';
import { createIntegrationHistory } from '../../src/cognition/NoeIntegrationHistory.js';

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), _m: m };
}

describe('createIntegrationHistory（P2 整合度趋势留存）', () => {
  it('record + read 往返', () => {
    const h = createIntegrationHistory({ kv: makeKv(), now: () => 1000 });
    h.record({ ts: 1000, integration: 0.42, totalCorrelation: 1.2, samples: 24 });
    h.record({ ts: 2000, integration: 0.55, totalCorrelation: 1.5, samples: 24 });
    const out = h.read();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ts: 1000, integration: 0.42 });
    expect(out[1].integration).toBe(0.55);
  });

  it('有限长度：超 maxPoints 裁剪最旧', () => {
    const h = createIntegrationHistory({ kv: makeKv(), maxPoints: 3 });
    for (let i = 1; i <= 5; i += 1) h.record({ ts: i * 100, integration: i / 10 });
    const out = h.read();
    expect(out).toHaveLength(3);
    expect(out[0].ts).toBe(300); // 最旧两条被裁
    expect(out[2].ts).toBe(500);
  });

  it('无效读数（缺 integration / 非对象）静默跳过不入历史', () => {
    const h = createIntegrationHistory({ kv: makeKv(), now: () => 9 });
    expect(h.record({ ts: 1, totalCorrelation: 1 })).toBeNull(); // 缺 integration
    expect(h.record(null)).toBeNull();
    expect(h.record({ integration: NaN })).toBeNull();
    expect(h.read()).toHaveLength(0);
  });

  it('ts 缺省用 now()', () => {
    const h = createIntegrationHistory({ kv: makeKv(), now: () => 7777 });
    h.record({ integration: 0.3 });
    expect(h.read()[0].ts).toBe(7777);
  });

  it('sinceTs 过滤 + limit 截取', () => {
    const h = createIntegrationHistory({ kv: makeKv() });
    for (let i = 1; i <= 10; i += 1) h.record({ ts: i * 1000, integration: i / 20 });
    expect(h.read({ sinceTs: 5000 })).toHaveLength(6); // ts>=5000
    expect(h.read({ limit: 2 })).toHaveLength(2); // 最近 2
    expect(h.read({ limit: 2 })[1].ts).toBe(10000);
  });

  it('读到脏 kv（非数组）→ 空数组不抛', () => {
    const kv = makeKv();
    kv.set('noe.integration.history.v1', 'corrupted');
    const h = createIntegrationHistory({ kv });
    expect(h.read()).toEqual([]);
  });

  it('只读 kv（无 set）：可 read 不可 record（安全降级，mind route 只读 deps 场景）', () => {
    const m = new Map();
    m.set('noe.integration.history.v1', [{ ts: 1, integration: 0.3 }]);
    const ro = createIntegrationHistory({ kv: { get: (k) => m.get(k) } }); // 无 set
    expect(ro.read()).toHaveLength(1);
    expect(ro.record({ ts: 2, integration: 0.5 })).toBeNull(); // record 静默降级，不抛
  });

  it('缺 kv.get → 构造即抛（DI 契约）', () => {
    expect(() => createIntegrationHistory({})).toThrow(/kv/);
  });
});
