import { describe, it, expect } from 'vitest';
import { createGwtMetrics } from '../../src/cognition/NoeGwtMetrics.js';

describe('createGwtMetrics', () => {
  it('空 → 零快照', () => {
    const m = createGwtMetrics();
    expect(m.snapshot()).toMatchObject({ broadcastCount: 0, switchCount: 0, switchRate: 0, coalitionEntropy: 0 });
  });

  it('注意力切换频率：相邻广播赢家变更占比', () => {
    let t = 0;
    const m = createGwtMetrics({ now: () => (t += 1) });
    m.record({ winner: 'A', candidateCount: 3 }); // 首次不算切换
    m.record({ winner: 'A', candidateCount: 2 }); // 不变
    m.record({ winner: 'B', candidateCount: 4 }); // 切换
    m.record({ winner: 'A', candidateCount: 1 }); // 切换
    const s = m.snapshot();
    expect(s.broadcastCount).toBe(4);
    expect(s.switchCount).toBe(2);
    expect(s.switchRate).toBeCloseTo(2 / 3, 4); // 3 个相邻对里 2 次切换
  });

  it('赢家分布 + coalition 熵（分散度）+ 竞争广度均值', () => {
    let t = 0;
    const m = createGwtMetrics({ now: () => (t += 1) });
    m.record({ winner: 'A', candidateCount: 2 });
    m.record({ winner: 'B', candidateCount: 4 });
    const s = m.snapshot();
    expect(s.winnerDistribution).toEqual({ A: 1, B: 1 });
    expect(s.coalitionEntropy).toBeCloseTo(1, 4); // 两个等概率赢家 = 1 bit
    expect(s.avgCandidatePool).toBe(3); // (2+4)/2
    expect(s.topWinners.length).toBe(2);
  });

  it('单一焦点垄断 → 熵≈0（注意力不分散，可观测）', () => {
    let t = 0;
    const m = createGwtMetrics({ now: () => (t += 1) });
    for (let i = 0; i < 10; i += 1) m.record({ winner: 'A', candidateCount: 1 });
    const s = m.snapshot();
    expect(s.coalitionEntropy).toBe(0);
    expect(s.switchCount).toBe(0); // 从不切换
  });

  it('滚动窗口上界（windowSize）', () => {
    let t = 0;
    const m = createGwtMetrics({ windowSize: 10, now: () => (t += 1) });
    for (let i = 0; i < 50; i += 1) m.record({ winner: `W${i}`, candidateCount: 1 });
    expect(m.snapshot().broadcastCount).toBe(10); // 只保留最近 10
  });

  it('reset 清空', () => {
    const m = createGwtMetrics();
    m.record({ winner: 'A' });
    m.reset();
    expect(m.snapshot().broadcastCount).toBe(0);
  });
});
