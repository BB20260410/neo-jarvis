// @ts-check
import { describe, expect, it } from 'vitest';
import {
  buildEvolutionDashboard,
  evolutionDashboardIsHonestAboutRealApply,
} from '../../src/runtime/NoeEvolutionDashboard.js';

describe('NoeEvolutionDashboard', () => {
  it('under safe without dual opt-in does not claim live rewrite', () => {
    const dash = buildEvolutionDashboard({
      env: {
        NOE_SELF_EVOLUTION_PROFILE: 'safe',
        NOE_SELF_EVOLUTION: '1',
        NOE_SELF_EVOLUTION_EXECUTORS: '1',
        // raw REAL_APPLY alone must not arm under safe without ALLOW
        NOE_SELF_EVOLUTION_REAL_APPLY: '1',
        NOE_SELFEVO_ALLOW_REAL_APPLY: '0',
      },
      loop: {
        stage: 'consensus_blocked',
        nextAction: 'refresh_four_model_consensus',
        blocked: true,
      },
      openGoals: [{ id: 'g1' }],
      recentSignal: { id: 'sig1', kind: 'improve', summary: 'flake test' },
    });
    expect(dash.readOnly).toBe(true);
    expect(dash.profile).toBeTruthy();
    expect(dash.boundary.realApply).toBe(false);
    expect(dash.claimsLiveRewrite).toBe(false);
    expect(dash.boundary.label).toMatch(/dry-run|默认/);
    expect(dash.stage.name).toBe('consensus_blocked');
    expect(dash.cycleSummary.openGoalCount).toBe(1);
    expect(dash.recentSignal?.id).toBe('sig1');
    expect(evolutionDashboardIsHonestAboutRealApply(dash)).toBe(true);
  });

  it('exposes rings and stage fields for UI', () => {
    const dash = buildEvolutionDashboard({
      env: {
        NOE_SELF_EVOLUTION: '0',
      },
    });
    expect(dash.rings).toMatchObject({
      perception: expect.any(Boolean),
      memory: expect.any(Boolean),
      falsification: expect.any(Boolean),
      boundary: expect.any(Boolean),
    });
    expect(dash.schema).toMatch(/evolution/);
  });
});
