import { describe, expect, it } from 'vitest';
import {
  computeSelfTalkLandingWindow,
  decideSelfTalkLandingRequirement,
  isComplianceLanding,
  isExternalLanding,
} from '../../src/cognition/SelfTalkLandingPolicy.js';

function committed(id, landing = null) {
  return {
    channel: 'self_talk_outcome',
    proposalId: id,
    commit: { committed: true },
    landing,
  };
}

describe('SelfTalkLandingPolicy', () => {
  it('requires landing after the configured unlanded streak', () => {
    const records = [
      committed('p1'),
      committed('p2'),
      committed('p3'),
    ];

    const window = computeSelfTalkLandingWindow(records);
    expect(window.unlandedStreak).toBe(3);
    expect(window.mustLandNext).toBe(true);

    expect(decideSelfTalkLandingRequirement(records, { candidateType: null })).toMatchObject({
      required: true,
      satisfiedByCandidate: false,
      reason: 'unlanded_streak:3',
      fallbackType: 'silent',
    });
    expect(decideSelfTalkLandingRequirement(records, { candidateType: 'goal' }).satisfiedByCandidate).toBe(true);
  });

  it('treats silent as a compliance closure but not an external landing', () => {
    const records = [
      committed('p1'),
      committed('p2'),
      committed('p3', { type: 'silent' }),
    ];

    const window = computeSelfTalkLandingWindow(records);
    expect(window.unlandedStreak).toBe(0);
    expect(window.mustLandNext).toBe(false);
    expect(window.complianceLandings).toBe(1);
    expect(window.externalLandings).toBe(0);
    expect(window.silentClosures).toBe(1);
    expect(window.landingComplianceRate).toBe(0.333);
    expect(window.externalLandingRate).toBe(0);
  });

  it('counts goal/memory/awareness as both compliance and external landing', () => {
    const records = [
      committed('p1', { type: 'goal' }),
      committed('p2', { type: 'memory' }),
      committed('p3', { type: 'awareness' }),
    ];

    const window = computeSelfTalkLandingWindow(records);
    expect(window.complianceLandings).toBe(3);
    expect(window.externalLandings).toBe(3);
    expect(window.unlandedStreak).toBe(0);
    expect(window.landingComplianceRate).toBe(1);
    expect(window.externalLandingRate).toBe(1);
  });

  it('keeps compliance and external landing predicates separate', () => {
    expect(isComplianceLanding('silent')).toBe(true);
    expect(isExternalLanding('silent')).toBe(false);
    expect(isExternalLanding('expectation')).toBe(true);
  });
});
