// @ts-check
import { describe, expect, it } from 'vitest';
import { detectWallSignals, WALL_DEFAULTS } from '../../src/cognition/NoeWallSignal.js';

describe('detectWallSignals（P2-F1 防 Goodhart 撞墙检测）', () => {
  it('整合度连续 3 拍 ≥0.95 → over_integration（砍 novelty）', () => {
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.5 }, { integration: 0.96 }, { integration: 0.97 }, { integration: 0.98 }] });
    expect(r.hit).toBe(true);
    const s = r.signals.find((x) => x.kind === 'over_integration');
    expect(s).toBeTruthy();
    expect(s.action).toBe('cut_semantic_novelty');
    expect(s.value).toBe(0.98);
  });

  it('整合度单拍尖峰（非持续）→ 不触发', () => {
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.5 }, { integration: 0.5 }, { integration: 0.99 }] });
    expect(r.signals.some((s) => s.kind === 'over_integration')).toBe(false);
  });

  it('整合度历史不足 sustainedSamples → 不触发', () => {
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.99 }, { integration: 0.99 }] });
    expect(r.hit).toBe(false);
  });

  it('P2[2]（修三方审查 minor）：sustainedSamples≤1 被范围裁剪到下限 2，单拍尖峰不误触发撞墙', () => {
    // 注入 sustainedSamples=1 + 单拍高整合度，修复后下限裁剪到 2（需 ≥2 拍）不触发回滚
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.99 }], thresholds: { sustainedSamples: 1, integrationThreshold: 0.95 } });
    expect(r.signals.some((s) => s.kind === 'over_integration')).toBe(false);
  });

  it('独白≥30 且活跃目标 0 → idle_rumination（停 InnerMonologue）', () => {
    const r = detectWallSignals({ monologue7d: 42, activeGoals: 0 });
    expect(r.hit).toBe(true);
    const s = r.signals.find((x) => x.kind === 'idle_rumination');
    expect(s.action).toBe('pause_inner_monologue');
    expect(s.value).toBe(42);
  });

  it('独白≥30 但有活跃目标 → 不触发（有目标=没空转）', () => {
    const r = detectWallSignals({ monologue7d: 50, activeGoals: 3 });
    expect(r.signals.some((s) => s.kind === 'idle_rumination')).toBe(false);
  });

  it('独白 < 阈值 → 不触发', () => {
    const r = detectWallSignals({ monologue7d: 10, activeGoals: 0 });
    expect(r.hit).toBe(false);
  });

  it('R2/R4：activeGoals=null（目标系统不在场）→ idle_rumination 不检测（防假 0 幻象）', () => {
    const r = detectWallSignals({ monologue7d: 99, activeGoals: null });
    expect(r.signals.some((s) => s.kind === 'idle_rumination')).toBe(false);
    expect(r.hit).toBe(false);
  });

  it('R4：activeGoals=null 但 over_integration 仍无条件检测（不被目标系统绑窄）', () => {
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.96 }, { integration: 0.97 }, { integration: 0.98 }], activeGoals: null });
    expect(r.signals.some((s) => s.kind === 'over_integration')).toBe(true);
  });

  it('两个撞墙同时命中', () => {
    const r = detectWallSignals({
      integrationHistory: [{ integration: 0.96 }, { integration: 0.97 }, { integration: 0.98 }],
      monologue7d: 40, activeGoals: 0,
    });
    expect(r.signals).toHaveLength(2);
  });

  it('无撞墙 → hit:false 空 signals', () => {
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.4 }], monologue7d: 5, activeGoals: 2 });
    expect(r).toEqual({ hit: false, signals: [] });
  });

  it('阈值可注入覆盖默认', () => {
    expect(WALL_DEFAULTS.integrationThreshold).toBe(0.95);
    const r = detectWallSignals({ integrationHistory: [{ integration: 0.6 }, { integration: 0.6 }], monologue7d: 0, activeGoals: 0, thresholds: { integrationThreshold: 0.5, sustainedSamples: 2 } });
    expect(r.signals.some((s) => s.kind === 'over_integration')).toBe(true);
  });

  it('空输入 → 不抛、hit:false', () => {
    expect(detectWallSignals({}).hit).toBe(false);
    expect(detectWallSignals().hit).toBe(false);
  });
});
