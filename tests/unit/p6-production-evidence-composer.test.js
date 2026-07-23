import { describe, expect, it } from 'vitest';
import { composeP6ProductionEvidence } from '../../src/cognition/P6ProductionEvidenceComposer.js';
import { validateP6ProductionEvidence } from '../../src/cognition/P6ProductionEvidence.js';

function runtime(overrides = {}) {
  return {
    mode: 'audit',
    port: 51835,
    healthOk: true,
    readinessOk: true,
    no51735Touched: true,
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    evidenceRefs: ['http://127.0.0.1:51835/health'],
    ...overrides,
  };
}

function db(overrides = {}) {
  return {
    verified: true,
    selfTalkOutcomes: 2,
    guardRecords: 2,
    confirmedDelivery: 1,
    synthesizedOnlyDelivery: 0,
    landingComplianceRate: 0.5,
    externalLandingRate: 0.5,
    silentClosures: 0,
    evidenceRefs: ['sqlite:panel.db/noe_self_talk_audit/1'],
    ...overrides,
  };
}

function audit(overrides = {}) {
  return {
    selfTalkOutcomes: 2,
    guardRecords: 2,
    confirmedDelivery: 1,
    synthesizedOnlyDelivery: 0,
    confirmedSelfTalkLandingRate: 0.5,
    landingComplianceRate: 0.5,
    externalLandingRate: 0.5,
    silentClosures: 0,
    ruminationGuardTripRate: 0.5,
    llmContextAllowed: false,
    evidenceRefs: ['jsonl:self-talk-audit.jsonl'],
    ...overrides,
  };
}

describe('P6ProductionEvidenceComposer', () => {
  it('composes valid evidence from runtime, DB, and audit summaries', () => {
    const evidence = composeP6ProductionEvidence({
      runtime: runtime(),
      db: db(),
      auditSummary: audit(),
    });
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      sampleKind: 'production',
      mode: 'audit',
      port: 51835,
      liveVerified: true,
      dbVerified: true,
      confirmedDelivery: 1,
    });
    expect(evidence.evidenceRefs).toHaveLength(3);
    expect(validateP6ProductionEvidence(evidence, { auditSummary: audit() }).ok).toBe(true);
  });

  it('derives confirmed landing rate from delivery count when summaries rounded it to zero', () => {
    const evidence = composeP6ProductionEvidence({
      runtime: runtime(),
      db: db({
        selfTalkOutcomes: 2006,
        confirmedDelivery: 1,
        confirmedSelfTalkLandingRate: 0,
      }),
      auditSummary: audit({
        selfTalkOutcomes: 2006,
        confirmedDelivery: 1,
        confirmedSelfTalkLandingRate: 0,
      }),
      frontendAck: { confirmedDelivery: 1, confirmedSelfTalkLandingRate: 0, evidenceRefs: ['sqlite:ack/1'] },
    });
    expect(evidence.confirmedSelfTalkLandingRate).toBeCloseTo(1 / 2006, 8);
    expect(validateP6ProductionEvidence(evidence, { auditSummary: evidence.auditReplay }).ok).toBe(true);
  });

  it('keeps unknown secret boundaries unproven instead of assuming false', () => {
    const evidence = composeP6ProductionEvidence({
      runtime: runtime({ secretValuesReturned: undefined, ownerTokenPrinted: undefined }),
      db: db(),
      auditSummary: audit(),
    });
    const report = validateP6ProductionEvidence(evidence, { auditSummary: audit() });
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('secret_redaction_not_proven');
    expect(report.blockers).toContain('owner_token_print_boundary_not_proven');
  });

  it('does not convert synthesized-only delivery into owner-perceived delivery', () => {
    const evidence = composeP6ProductionEvidence({
      runtime: runtime(),
      db: db({ confirmedDelivery: 0, synthesizedOnlyDelivery: 2 }),
      auditSummary: audit({ confirmedDelivery: 0, confirmedSelfTalkLandingRate: 0, synthesizedOnlyDelivery: 2 }),
    });
    const report = validateP6ProductionEvidence(evidence, { auditSummary: evidence.auditReplay });
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('owner_confirmed_delivery_missing');
    expect(report.blockers).toContain('tts_only_delivery_not_owner_perceived');
  });

  it('can validate no-playback production evidence through silent closure', () => {
    const evidence = composeP6ProductionEvidence({
      runtime: runtime(),
      db: db({
        confirmedDelivery: 0,
        synthesizedOnlyDelivery: 0,
        landingComplianceRate: 1,
        externalLandingRate: 0,
        silentClosures: 2,
      }),
      auditSummary: audit({
        confirmedDelivery: 0,
        confirmedSelfTalkLandingRate: 0,
        externalLandingRate: 0,
        landingComplianceRate: 1,
        silentClosures: 2,
      }),
    });
    const report = validateP6ProductionEvidence(evidence, { auditSummary: evidence.auditReplay });
    expect(report.ok).toBe(true);
    expect(report.summary.silentClosures).toBe(2);
    expect(report.warnings).toContain('owner_delivery_not_exercised_no_candidate');
  });
});
