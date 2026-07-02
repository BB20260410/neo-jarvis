import { describe, it, expect } from 'vitest';
import { createIntegrationSampler, INTEGRATION_NODE_ORDER } from '../../src/cognition/NoeIntegrationSampler.js';

// 整合度代理采样器接线（注入式 · 滚动窗口 · fail-open · OFF 零开销由 server.js 门控保证）。
// 用注入假信号验 TC 读数能区分「整合」与「离散」+ 探针抛错不崩 + 首拍 ok:false。

function memKv() { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), _m: m }; }
const allOn = Object.fromEntries(INTEGRATION_NODE_ORDER.map((n) => [n, () => true]));

describe('createIntegrationSampler — 整合度采样器接线（注入式·确定性）', () => {
  it('8 宏节点顺序固定', () => {
    expect(INTEGRATION_NODE_ORDER).toHaveLength(8);
    expect(INTEGRATION_NODE_ORDER).toContain('gwt_focus');
    expect(INTEGRATION_NODE_ORDER).toContain('dream');
  });

  it('同步信号 → 高整合（联合熵≪边际熵和）', () => {
    const kv = memKv(); let flip = 0;
    const sync = Object.fromEntries(INTEGRATION_NODE_ORDER.map((n) => [n, () => flip % 2 === 0]));
    const s = createIntegrationSampler({ signals: sync, kv, now: () => 1000 + flip });
    let r; for (flip = 0; flip < 8; flip++) r = s.sample();
    expect(r.ok).toBe(true);
    expect(r.integration).toBeGreaterThan(0.9);
    expect(r.label).toBe('高度整合');
    expect(r.samples).toBe(8);
  });

  it('独立信号 → 近乎离散（TC≈0）', () => {
    const kv = memKv(); let tick = 0;
    const indep = Object.fromEntries(INTEGRATION_NODE_ORDER.map((n, i) => [n, () => ((tick >> i) & 1) === 1]));
    const s = createIntegrationSampler({ signals: indep, kv, now: () => 2000 + tick });
    let r; for (tick = 0; tick < 16; tick++) r = s.sample();
    expect(r.integration).toBeLessThan(0.3);
  });

  it('信号探针抛错/缺失 → fail-open 为 0，不崩', () => {
    const kv = memKv();
    const s = createIntegrationSampler({ signals: { gwt_focus: () => { throw new Error('boom'); } }, kv, now: () => 3000 });
    s.sample();
    const r = s.sample();
    expect(r.lastVector).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.ok).toBe(true); // 2 个全 0 样本仍可算（TC=0）
    expect(r.integration).toBe(0);
  });

  it('首拍样本不足 → ok:false 不硬崩', () => {
    const kv = memKv();
    const s = createIntegrationSampler({ signals: allOn, kv, now: () => 5000 });
    const r = s.sample();
    expect(r.ok).toBe(false);
    expect(r.samples).toBe(1);
  });

  it('滚动窗口受 windowSize 限制', () => {
    const kv = memKv();
    const s = createIntegrationSampler({ signals: allOn, kv, windowSize: 4, now: () => 6000 });
    for (let i = 0; i < 10; i++) s.sample();
    expect(kv.get('noe.integration.window')).toHaveLength(4);
  });

  it('latest() 读回最近读数；reading 写进 kv 供 mind 消费', () => {
    const kv = memKv();
    const s = createIntegrationSampler({ signals: allOn, kv, now: () => 7000 });
    s.sample(); s.sample();
    const latest = s.latest();
    expect(latest).toBeTruthy();
    expect(latest.nodeOrder).toEqual(INTEGRATION_NODE_ORDER);
    expect(kv.get('noe.integration.reading')).toBeTruthy();
  });

  it('脏窗口行（长度不符）被剔除，不污染计算', () => {
    const kv = memKv();
    kv.set('noe.integration.window', [[1, 1], 'garbage', [1, 1, 1, 1, 1, 1, 1, 1]]); // 仅最后一行合法
    const s = createIntegrationSampler({ signals: allOn, kv, now: () => 8000 });
    const r = s.sample(); // 剔除脏行后 = 1 合法旧行 + 本拍 = 2 行
    expect(r.samples).toBe(2);
  });

  it('缺 signals/kv → 构造即抛（注入契约）', () => {
    expect(() => createIntegrationSampler({ kv: memKv() })).toThrow();
    expect(() => createIntegrationSampler({ signals: allOn })).toThrow();
  });
});
