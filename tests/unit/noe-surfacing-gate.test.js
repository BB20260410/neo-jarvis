import { describe, it, expect } from 'vitest';
import { createSurfacingGate } from '../../src/cognition/NoeSurfacingGate.js';
import { textSimilarity } from '../../src/memory/NoeMemoryDedup.js';

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
}

const T0 = 1_780_000_000_000; // 固定起点

describe('NoeSurfacingGate 浮现门（四重闸）', () => {
  it('正常通过并记账；冷却期内第二条被拦', () => {
    let t = T0;
    const gate = createSurfacingGate({ kv: makeKv(), now: () => t, cooldownMs: 60_000 });
    expect(gate.tryPass({ text: '主人，新版本上线了' }).pass).toBe(true);
    expect(gate.tryPass({ text: '另一件完全不同的事' }).reason).toBe('cooldown');
    t += 61_000;
    expect(gate.tryPass({ text: '另一件完全不同的事' }).pass).toBe(true);
  });

  it('日预算耗尽拦截；跨天自动重置', () => {
    let t = T0;
    const gate = createSurfacingGate({ kv: makeKv(), now: () => t, budgetPerDay: 2, cooldownMs: 0 });
    expect(gate.tryPass({ text: '事一' }).pass).toBe(true);
    expect(gate.tryPass({ text: '事二' }).pass).toBe(true);
    expect(gate.tryPass({ text: '事三' }).reason).toBe('budget_exhausted');
    t += 25 * 3600_000; // 第二天
    expect(gate.tryPass({ text: '事三' }).pass).toBe(true);
    expect(gate.status().usedToday).toBe(1);
  });

  it('静默时段拦截（注入 quietCheck）', () => {
    const gate = createSurfacingGate({ kv: makeKv(), now: () => T0, quietCheck: () => true });
    expect(gate.tryPass({ text: '深夜想说话' }).reason).toBe('quiet_hours');
  });

  it('与近期已浮现内容过似 → duplicate 拦截', () => {
    let t = T0;
    const gate = createSurfacingGate({ kv: makeKv(), now: () => t, cooldownMs: 0, textSimilarity });
    expect(gate.tryPass({ text: '主人记得喝水休息一下哦' }).pass).toBe(true);
    t += 1000;
    expect(gate.tryPass({ text: '主人记得喝水休息一下哦！' }).reason).toBe('duplicate');
  });

  it('低显著度/空文本拦截；kv 全炸 fail-open 仍可判定', () => {
    const gate = createSurfacingGate({ kv: makeKv(), now: () => T0 });
    expect(gate.tryPass({ text: '小事', salience: 0.3 }).reason).toBe('low_salience');
    expect(gate.tryPass({ text: '' }).reason).toBe('empty');
    const broken = createSurfacingGate({ kv: { get: () => { throw new Error('x'); }, set: () => { throw new Error('x'); } }, now: () => T0 });
    expect(broken.tryPass({ text: '还是想说' }).pass).toBe(true);
  });
});
