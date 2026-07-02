import { describe, it, expect } from 'vitest';
import { affectBehaviorModulation, createNoeAffectModulator, NEUTRAL_MODULATION } from '../../src/cognition/NoeAffectModulation.js';

describe('affectBehaviorModulation', () => {
  it('flag 关（默认）→ 中性基线（行为回归未接情感前）', () => {
    const r = affectBehaviorModulation({ v: -1, a: 1, d: -1 }); // 极端 VAD
    expect(r).toEqual(NEUTRAL_MODULATION);
    expect(r.deliberationScale).toBe(1);
    expect(r.ownerPriorityBoost).toBe(0);
    expect(r.enabled).toBe(false);
  });
  it('arousal 高 → 缩短深思（scale<1）；低 → 放长（scale>1）', () => {
    const hi = affectBehaviorModulation({ a: 1 }, { enabled: true });
    const lo = affectBehaviorModulation({ a: 0 }, { enabled: true });
    expect(hi.deliberationScale).toBeLessThan(1);
    expect(lo.deliberationScale).toBeGreaterThan(1);
  });
  it('valence 低 → owner 关切加成 >0；valence≥0 → 0', () => {
    expect(affectBehaviorModulation({ v: -1 }, { enabled: true }).ownerPriorityBoost).toBeGreaterThan(0);
    expect(affectBehaviorModulation({ v: 0.5 }, { enabled: true }).ownerPriorityBoost).toBe(0);
  });
  it('dominance 低 → 谨慎偏置 >0', () => {
    expect(affectBehaviorModulation({ d: -1 }, { enabled: true }).cautionBias).toBeGreaterThan(0);
    expect(affectBehaviorModulation({ d: 0.5 }, { enabled: true }).cautionBias).toBe(0);
  });
  it('参数有界（deliberationScale∈[0.5,1.3]，其余∈[0,1]）+ 接受 valence/arousal 别名', () => {
    const ext = affectBehaviorModulation({ valence: -1, arousal: 1, dominance: -1 }, { enabled: true, arousalGain: 5, valenceGain: 5, dominanceGain: 5 });
    expect(ext.deliberationScale).toBeGreaterThanOrEqual(0.5);
    expect(ext.deliberationScale).toBeLessThanOrEqual(1.3);
    expect(ext.ownerPriorityBoost).toBeLessThanOrEqual(1);
    expect(ext.cautionBias).toBeLessThanOrEqual(1);
  });
  it('高/低 VAD 行为可观测差异（同一维度不同输入→不同参数）', () => {
    const calm = affectBehaviorModulation({ v: 0.5, a: 0.2, d: 0.5 }, { enabled: true });
    const distress = affectBehaviorModulation({ v: -0.8, a: 0.9, d: -0.6 }, { enabled: true });
    expect(distress.deliberationScale).not.toBe(calm.deliberationScale);
    expect(distress.ownerPriorityBoost).toBeGreaterThan(calm.ownerPriorityBoost);
    expect(distress.cautionBias).toBeGreaterThan(calm.cautionBias);
  });
});

describe('createNoeAffectModulator', () => {
  it('enabled=false → modulate 返回中性', () => {
    const m = createNoeAffectModulator({ enabled: false });
    expect(m.modulate({ v: -1, a: 1, d: -1 })).toEqual(NEUTRAL_MODULATION);
  });
  it('enabled=true → modulate 真调制', () => {
    const m = createNoeAffectModulator({ enabled: true });
    const r = m.modulate({ a: 1 });
    expect(r.enabled).toBe(true);
    expect(r.deliberationScale).toBeLessThan(1);
  });
});
