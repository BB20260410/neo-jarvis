import { describe, it, expect } from 'vitest';
import { integrationMetric, integrationLabel } from '../../src/cognition/NoeIntegrationMetric.js';

// aura/IIT 整合度代理（多信息 Total Correlation）。验证它真能区分「整合」与「离散」。

describe('integrationMetric — 意识整合度（多信息代理，非完整 IIT φ）', () => {
  it('全同步子系统 → 整合度高（联合熵 ≪ 边际熵和）', () => {
    const r = integrationMetric([[1, 1, 1, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]]);
    expect(r.ok).toBe(true);
    expect(r.integration).toBeGreaterThan(0.9);
    expect(r.totalCorrelation).toBeCloseTo(3, 5);
  });

  it('完全独立子系统 → 整合度 ≈ 0（TC=0）', () => {
    const r = integrationMetric([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(r.ok).toBe(true);
    expect(r.totalCorrelation).toBeCloseTo(0, 5);
    expect(r.integration).toBeCloseTo(0, 5);
  });

  it('部分耦合 → 整合度居中（>0 且 <0.9）', () => {
    const r = integrationMetric([[1, 1], [1, 1], [0, 0], [0, 1]]);
    expect(r.integration).toBeGreaterThan(0);
    expect(r.integration).toBeLessThan(0.9);
  });

  it('样本/节点不足 → ok:false（不硬崩）', () => {
    expect(integrationMetric([]).ok).toBe(false);
    expect(integrationMetric([[1, 1]]).ok).toBe(false); // 样本 < 2
    expect(integrationMetric([[1], [0]]).ok).toBe(false); // 节点 < 2
    expect(integrationMetric('garbage').ok).toBe(false);
  });

  it('integrationLabel 中文分档', () => {
    expect(integrationLabel(0.7)).toBe('高度整合');
    expect(integrationLabel(0.4)).toBe('部分整合');
    expect(integrationLabel(0.1)).toBe('弱整合');
    expect(integrationLabel(0.01)).toBe('近乎离散');
    expect(integrationLabel(-1)).toBe('无数据');
  });
});
