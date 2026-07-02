import { describe, expect, it } from 'vitest';
import { validateP6ProductionEvidence } from '../../src/cognition/P6ProductionEvidence.js';

function validEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    sampleKind: 'production',
    mode: 'audit',
    port: 51835,
    liveVerified: true,
    dbVerified: true,
    no51735Touched: true,
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    selfTalkOutcomes: 2,
    guardRecords: 2,
    confirmedDelivery: 1,
    synthesizedOnlyDelivery: 0,
    confirmedSelfTalkLandingRate: 0.5,
    landingComplianceRate: 0.5,
    externalLandingRate: 0.5,
    silentClosures: 0,
    ruminationGuardTripRate: 0.5,
    evidenceRefs: [
      'http://127.0.0.1:51835/health',
      'sqlite:panel.db/noe_self_talk_audit/1',
      'jsonl:self-talk-audit.jsonl',
    ],
    ...overrides,
  };
}

describe('P6ProductionEvidence', () => {
  it('accepts production evidence with live, DB, confirmed playback, and redaction proof', () => {
    const report = validateP6ProductionEvidence(validEvidence());
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.summary).toMatchObject({
      port: 51835,
      liveVerified: true,
      dbVerified: true,
      confirmedDelivery: 1,
      evidenceRefs: 3,
    });
  });

  it('derives a non-zero confirmed landing rate from delivery count when stored rate was rounded to zero', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      selfTalkOutcomes: 2006,
      confirmedDelivery: 1,
      confirmedSelfTalkLandingRate: 0,
    }));
    expect(report.ok).toBe(true);
    expect(report.blockers).not.toContain('confirmed_landing_rate_missing');
    expect(report.summary.confirmedSelfTalkLandingRate).toBeCloseTo(1 / 2006, 8);
  });

  it('rejects controlled or fixture samples as production proof', () => {
    const report = validateP6ProductionEvidence(validEvidence({ sampleKind: 'controlled' }));
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('sample_kind_not_production:controlled');
  });

  it('rejects synthesized-only playback evidence', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      confirmedDelivery: 0,
      confirmedSelfTalkLandingRate: 0,
      synthesizedOnlyDelivery: 2,
    }));
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('owner_confirmed_delivery_missing');
    expect(report.blockers).toContain('tts_only_delivery_not_owner_perceived');
  });

  it('accepts guard-blocked self-talk when it is explicitly closed as silent and no playback candidate exists', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      confirmedDelivery: 0,
      synthesizedOnlyDelivery: 0,
      confirmedSelfTalkLandingRate: 0,
      landingComplianceRate: 1,
      externalLandingRate: 0,
      silentClosures: 2,
    }));
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toContain('owner_delivery_not_exercised_no_candidate');
  });

  it('does not treat external landing as owner-perceived delivery by itself', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      confirmedDelivery: 0,
      synthesizedOnlyDelivery: 0,
      confirmedSelfTalkLandingRate: 0,
      landingComplianceRate: 0.95,
      externalLandingRate: 0.1,
      silentClosures: 2,
    }));
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toContain('owner_delivery_not_exercised_no_candidate');
  });

  it('rejects evidence with neither owner delivery nor closed self-talk', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      confirmedDelivery: 0,
      synthesizedOnlyDelivery: 0,
      confirmedSelfTalkLandingRate: 0,
      landingComplianceRate: 0,
      externalLandingRate: 0,
      silentClosures: 0,
    }));
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('self_talk_closure_missing');
  });

  it('rejects boundary and redaction gaps', () => {
    const report = validateP6ProductionEvidence(validEvidence({
      port: 51735,
      no51735Touched: false,
      secretValuesReturned: true,
      ownerTokenPrinted: true,
    }));
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('live_port_not_51835');
    expect(report.blockers).toContain('port_51735_boundary_missing');
    expect(report.blockers).toContain('secret_redaction_not_proven');
    expect(report.blockers).toContain('owner_token_print_boundary_not_proven');
  });

  it('rejects thin hand-written evidence without source refs', () => {
    const report = validateP6ProductionEvidence(validEvidence({ evidenceRefs: ['sqlite:only-one-ref'] }));
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('evidence_refs_insufficient');
  });
});
