import { describe, expect, it } from 'vitest';
import { permissionPreflight } from '../../src/loop/ActPipelinePreflight.js';

describe('permissionPreflight self_evolution defer (codex post-review)', () => {
  it('does not gate-defer non-mapped self_evolution-named actions', () => {
    const pipeline = {
      permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    };

    const real = permissionPreflight(pipeline, {
      action: 'noe.self_evolution.implementation',
      payload: { selfEvolution: { action: 'implementation' } },
    }, {});
    const fake = permissionPreflight(pipeline, { action: 'custom.self_evolution_proxy' }, {});

    expect(real.decision).toBe('allow');
    expect(real.target?.deferredToSelfEvolutionGate).toBe(true);
    expect(fake.target?.deferredToSelfEvolutionGate).not.toBe(true);
  });
});
