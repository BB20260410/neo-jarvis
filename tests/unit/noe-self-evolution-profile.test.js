import { describe, it, expect } from 'vitest';
import {
  SELF_EVOLUTION_SAFE_PROFILE,
  isSelfEvolutionRealApplyAllowed,
  resolveSelfEvolutionProfileName,
  resolveSelfEvolutionRealApplyEnabled,
  resolveSelfEvolutionCycleStoreCapability,
  applySelfEvolutionProfile,
  summarizeSelfEvolutionRings,
} from '../../src/room/NoeSelfEvolutionProfile.js';

describe('SELF_EVOLUTION_SAFE_PROFILE', () => {
  it('is frozen and contains expected keys', () => {
    expect(Object.isFrozen(SELF_EVOLUTION_SAFE_PROFILE)).toBe(true);
    expect(SELF_EVOLUTION_SAFE_PROFILE.NOE_SELF_EVOLUTION).toBe('1');
    expect(SELF_EVOLUTION_SAFE_PROFILE.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('0');
  });
});

describe('isSelfEvolutionRealApplyAllowed', () => {
  it('returns false when only REAL_APPLY is set', () => {
    const env = { NOE_SELF_EVOLUTION_REAL_APPLY: '1' };
    expect(isSelfEvolutionRealApplyAllowed(env)).toBe(false);
  });

  it('returns false when only ALLOW is set', () => {
    const env = { NOE_SELFEVO_ALLOW_REAL_APPLY: '1' };
    expect(isSelfEvolutionRealApplyAllowed(env)).toBe(false);
  });

  it('returns true when both ALLOW and REAL_APPLY are set', () => {
    const env = {
      NOE_SELFEVO_ALLOW_REAL_APPLY: '1',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    expect(isSelfEvolutionRealApplyAllowed(env)).toBe(true);
  });

  it('returns false when either is missing or not 1', () => {
    const env = {
      NOE_SELFEVO_ALLOW_REAL_APPLY: '0',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    expect(isSelfEvolutionRealApplyAllowed(env)).toBe(false);
  });
});

describe('resolveSelfEvolutionProfileName', () => {
  it('returns off for empty or falsy values', () => {
    expect(resolveSelfEvolutionProfileName({})).toBe('off');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: '' })).toBe('off');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: '0' })).toBe('off');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'false' })).toBe('off');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'off' })).toBe('off');
  });

  it('returns safe for safe-like values', () => {
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'safe' })).toBe('safe');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'true' })).toBe('safe');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: '1' })).toBe('safe');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'flywheel' })).toBe('safe');
  });

  it('returns custom for unknown values', () => {
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'custom' })).toBe('custom');
    expect(resolveSelfEvolutionProfileName({ NOE_SELFEVO_PROFILE: 'anything' })).toBe('custom');
  });

  it('falls back to NOE_SELF_EVOLUTION_PROFILE if NOE_SELFEVO_PROFILE is missing', () => {
    expect(resolveSelfEvolutionProfileName({ NOE_SELF_EVOLUTION_PROFILE: 'safe' })).toBe('safe');
  });
});

describe('resolveSelfEvolutionRealApplyEnabled', () => {
  it('uses double opt-in when profile is safe', () => {
    const env = {
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELFEVO_ALLOW_REAL_APPLY: '1',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    expect(resolveSelfEvolutionRealApplyEnabled(env)).toBe(true);

    const env2 = {
      NOE_SELFEVO_PROFILE: 'safe',
      NOE_SELFEVO_ALLOW_REAL_APPLY: '0',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    expect(resolveSelfEvolutionRealApplyEnabled(env2)).toBe(false);
  });

  it('uses legacy REAL_APPLY check when profile is not safe', () => {
    const env = {
      NOE_SELFEVO_PROFILE: 'custom',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    expect(resolveSelfEvolutionRealApplyEnabled(env)).toBe(true);

    const env2 = {
      NOE_SELFEVO_PROFILE: 'custom',
      NOE_SELF_EVOLUTION_REAL_APPLY: '0',
    };
    expect(resolveSelfEvolutionRealApplyEnabled(env2)).toBe(false);
  });
});

describe('resolveSelfEvolutionCycleStoreCapability', () => {
  it('returns correct capability flags', () => {
    const env = {
      NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE: '1',
      NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE: '0',
      NOE_SELFEVO_REWORK: '1',
    };
    const result = resolveSelfEvolutionCycleStoreCapability(env);
    expect(result.hasConsensusAutodrive).toBe(true);
    expect(result.hasCompletionAutodrive).toBe(false);
    expect(result.reworkEnabled).toBe(true);
  });

  it('returns false for missing keys', () => {
    const result = resolveSelfEvolutionCycleStoreCapability({});
    expect(result.hasConsensusAutodrive).toBe(false);
    expect(result.hasCompletionAutodrive).toBe(false);
    expect(result.reworkEnabled).toBe(false);
  });
});

describe('applySelfEvolutionProfile', () => {
  it('does not apply when profile is not safe', () => {
    const env = { NOE_SELFEVO_PROFILE: 'custom' };
    const result = applySelfEvolutionProfile(env, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.profile).toBe('custom');
  });

  it('applies safe profile and forces REAL_APPLY off', () => {
    const env = {};
    const result = applySelfEvolutionProfile(env, { apply: true, profile: 'safe' });
    expect(result.applied).toBe(true);
    expect(result.realApplyForcedOff).toBe(true);
    expect(env.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('0');
    expect(env.NOE_SELF_EVOLUTION).toBe('1');
  });

  it('respects double opt-in for REAL_APPLY', () => {
    const env = {
      NOE_SELFEVO_ALLOW_REAL_APPLY: '1',
      NOE_SELF_EVOLUTION_REAL_APPLY: '1',
    };
    const result = applySelfEvolutionProfile(env, { apply: true, profile: 'safe' });
    expect(result.realApplyOwnerOverride).toBe(true);
    expect(env.NOE_SELF_EVOLUTION_REAL_APPLY).toBe('1');
  });

  it('does not overwrite existing non-empty values', () => {
    const env = { NOE_SELF_EVOLUTION: '1' };
    const result = applySelfEvolutionProfile(env, { apply: true, profile: 'safe' });
    expect(result.keys).not.toContain('NOE_SELF_EVOLUTION');
  });
});

describe('summarizeSelfEvolutionRings', () => {
  it('returns correct ring statuses', () => {
    const env = {
      NOE_SELF_EVOLUTION: '1',
      NOE_SELF_EVOLUTION_TYPECHECK: '1',
      NOE_SELFEVO_REJECT_LEARNING: '1',
      NOE_SELFEVO_LESSON_AWARE_AUTOSEED: '1',
      NOE_SELF_EVOLUTION_EXECUTORS: '1',
      NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE: '1',
      NOE_SELF_EVOLUTION_REAL_APPLY: '0',
      NOE_HEARTBEAT: '1',
    };
    const result = summarizeSelfEvolutionRings(env);
    expect(result.perception).toBe(true);
    expect(result.memory).toBe(true);
    expect(result.falsification).toBe(true);
    expect(result.boundary).toBe(true);
    expect(result.continuousTick).toBe(true);
  });

  it('returns false for boundary when REAL_APPLY is 1', () => {
    const env = { NOE_SELF_EVOLUTION_REAL_APPLY: '1' };
    const result = summarizeSelfEvolutionRings(env);
    expect(result.boundary).toBe(false);
  });
});
