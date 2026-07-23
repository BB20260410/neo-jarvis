// @ts-check
import { describe, it, expect } from 'vitest';
import {
  resolveSelfEvolutionImplementerCandidates,
  isLocalCodeAdapterId,
  objectiveHasPriorRepairEvidence,
} from '../../src/loop/NoeSelfEvolutionCandidateOrder.js';
import {
  makeSignalWeightFn,
  resolveSignalWeight,
  assertTestGapDeprioritized,
  staticBiasForSignal,
} from '../../src/room/NoeSelfEvolutionSignalWeights.js';
import {
  planSkillBatchEnable,
  planSkillBatchPrune,
  applySkillBatchPlan,
} from '../../src/skills/NoeSkillBatchCurator.js';
import { orderSelfEvolutionGoalsByEffectivePriority } from '../../src/room/NoeSelfEvolutionTrigger.js';

describe('self-evolution implementer candidate order', () => {
  it('cloudFirst puts non-local before lmstudio-code', () => {
    const ids = resolveSelfEvolutionImplementerCandidates({
      routeAdapterId: 'lmstudio-code',
      localCodeAdapterId: 'lmstudio-code',
      localFirst: true,
      cloudFirst: true,
    });
    expect(isLocalCodeAdapterId(ids[0], 'lmstudio-code')).toBe(false);
    expect(ids[0]).toBe('minimax');
    expect(ids).toContain('lmstudio-code');
  });

  it('second repair with prior evidence forces cloud-first', () => {
    const ids = resolveSelfEvolutionImplementerCandidates({
      routeAdapterId: 'lmstudio-code',
      localCodeAdapterId: 'lmstudio-code',
      localFirst: true,
      cloudFirst: false,
      hasPriorRepairEvidence: true,
    });
    expect(isLocalCodeAdapterId(ids[0], 'lmstudio-code')).toBe(false);
  });

  it('localFirst keeps local first when not cloud', () => {
    const ids = resolveSelfEvolutionImplementerCandidates({
      routeAdapterId: 'minimax',
      localCodeAdapterId: 'lmstudio-code',
      localFirst: true,
      cloudFirst: false,
    });
    expect(ids[0]).toBe('lmstudio-code');
  });

  it('objectiveHasPriorRepairEvidence detects A2 hints', () => {
    expect(objectiveHasPriorRepairEvidence('修复 TS18046: error 未减少 1→1')).toBe(true);
    expect(objectiveHasPriorRepairEvidence('补 JSDoc for foo')).toBe(false);
  });
});

describe('signal weights deprioritize test_gap', () => {
  it('static bias: test_gap < type_error/high_complexity/self_directed', () => {
    expect(staticBiasForSignal('test_gap')).toBeLessThan(staticBiasForSignal('type_error'));
    expect(staticBiasForSignal('test_gap')).toBeLessThan(staticBiasForSignal('high_complexity'));
    expect(staticBiasForSignal('test_gap')).toBeLessThan(staticBiasForSignal('self_directed'));
  });

  it('weight fn with equal retention still ranks test_gap lower', () => {
    const fn = makeSignalWeightFn({
      retentionBySignal: {
        test_gap: 0.5,
        type_error: 0.5,
        high_complexity: 0.5,
        self_directed: 0.5,
      },
      applyStaticBias: true,
    });
    const check = assertTestGapDeprioritized(fn);
    expect(check.ok).toBe(true);
    expect(fn('test_gap')).toBeLessThan(fn('type_error'));
  });

  it('orders goals with lower effective priority for test_gap', () => {
    const weight = makeSignalWeightFn({ applyStaticBias: true, retentionBySignal: {} });
    const ordered = orderSelfEvolutionGoalsByEffectivePriority([
      { id: 'a', priority: 10, meta: { signal: 'test_gap' } },
      { id: 'b', priority: 10, meta: { signal: 'type_error' } },
      { id: 'c', priority: 10, meta: { signal: 'self_directed' } },
    ], weight);
    expect(ordered[0].id).not.toBe('a');
    expect(ordered.map((g) => g.id).slice(-1)[0]).toBe('a');
  });

  it('resolveSignalWeight clamps floor/ceil', () => {
    const w = resolveSignalWeight({ signal: 'test_gap', retention: 0, applyStaticBias: true });
    expect(w).toBeGreaterThanOrEqual(0.35);
    expect(w).toBeLessThanOrEqual(1.35);
  });
});

describe('skill batch enable/measure/prune', () => {
  const skills = [
    { name: 'distill-alpha', enabled: false, source: 'goal_distillation', updatedAt: '2026-07-01T00:00:00Z' },
    { name: 'distill-beta', enabled: false, source: 'auto', updatedAt: '2026-07-02T00:00:00Z' },
    { name: 'distill-gamma', enabled: false, source: 'extract', updatedAt: '2026-06-01T00:00:00Z' },
    { name: 'manual-keep', enabled: false, source: 'owner', updatedAt: '2026-07-03T00:00:00Z' },
    { name: 'trial-dead', enabled: true, hitCount: 0, extra: { trialBatch: true, trialStartedAt: '2026-01-01T00:00:00Z' } },
    { name: 'trial-live', enabled: true, hitCount: 3, extra: { trialBatch: true, trialStartedAt: '2026-01-01T00:00:00Z' } },
  ];

  it('plans small batch only of distilled disabled skills', () => {
    const plan = planSkillBatchEnable(skills, { batchSize: 2 });
    expect(plan.selected).toHaveLength(2);
    expect(plan.selected.every((s) => s.name.startsWith('distill'))).toBe(true);
    expect(plan.totalDisabledDistilled).toBe(3);
  });

  it('does not bulk-enable all', () => {
    const plan = planSkillBatchEnable(skills, { batchSize: 2 });
    expect(plan.selected.length).toBeLessThan(plan.totalDisabledDistilled);
  });

  it('prunes trial skills with zero hits after window', () => {
    const plan = planSkillBatchPrune(skills, { nowMs: Date.parse('2026-07-01T00:00:00Z'), minHits: 1 });
    expect(plan.prune.map((p) => p.name)).toContain('trial-dead');
    expect(plan.prune.map((p) => p.name)).not.toContain('trial-live');
  });

  it('apply dryRun does not call setEnabled', () => {
    const plan = planSkillBatchEnable(skills, { batchSize: 1 });
    let calls = 0;
    const applied = applySkillBatchPlan(plan, {
      dryRun: true,
      setEnabled: () => { calls += 1; },
    });
    expect(calls).toBe(0);
    expect(applied.actions[0].action).toBe('would_enable');
  });

  it('apply real enable invokes setEnabled once per selected', () => {
    const plan = planSkillBatchEnable(skills, { batchSize: 2 });
    const names = [];
    applySkillBatchPlan(plan, {
      dryRun: false,
      setEnabled: (name, enabled, meta) => {
        names.push({ name, enabled, trial: meta?.trialBatch });
      },
    });
    expect(names).toHaveLength(2);
    expect(names.every((n) => n.enabled === true && n.trial === true)).toBe(true);
  });
});
