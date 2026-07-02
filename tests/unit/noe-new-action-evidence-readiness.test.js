import { describe, expect, it } from 'vitest';
import { buildNewActionEvidenceReadiness, renderMarkdown } from '../../scripts/noe-new-action-evidence-readiness.mjs';

describe('noe-new-action-evidence-readiness', () => {
  it('proves new action evidence can cross the semanticTrace gate without live side effects', () => {
    const report = buildNewActionEvidenceReadiness({
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.status).toBe('ready_for_new_action_evidence_after_restart_or_natural_action');
    expect(report.policy).toMatchObject({
      syntheticInputsOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noModelCalls: true,
    });
    expect(report.summary).toMatchObject({
      ready: true,
      newActionDirectReady: true,
      legacyActionDirectReady: false,
      observationOnlyDirectReady: false,
    });
    expect(report.summary.newActionSemanticTraceCoverage).toBeGreaterThanOrEqual(0.25);
    expect(report.summary.legacyActionSemanticTraceCoverage).toBeLessThan(0.25);
    expect(report.summary.observationOnlySemanticTraceCoverage).toBe(0);
    expect(report.cases.find((item) => item.id === 'new_action_evidence_with_act_payload_semantics')).toMatchObject({
      directReady: true,
      expectedVerdictHint: 'APPLIED',
      alignment: {
        resultActionEvents: 1,
        semanticTraceResultActionEvents: 1,
      },
    });
    expect(report.cases.find((item) => item.id === 'observation_only_control')).toMatchObject({
      directReady: false,
      expectedVerdictHint: 'UNKNOWN',
      alignment: {
        resultActionEvents: 0,
        semanticTraceResultActionEvents: 0,
      },
    });
    expect(JSON.stringify(report)).not.toContain('tp-unitsecret');
    expect(JSON.stringify(report)).not.toContain('unit-test-secret-token-value');
  });

  it('renders a safe markdown summary without claim or evidence body', () => {
    const report = buildNewActionEvidenceReadiness({
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const md = renderMarkdown(report, '/tmp/readiness.json');

    expect(md).toContain('ready_for_new_action_evidence_after_restart_or_natural_action');
    expect(md).toContain('new_action_evidence_with_act_payload_semantics');
    expect(md).toContain('observation_only_control');
    expect(md).not.toContain('owner expects visible delivery evidence from the readiness checkpoint');
    expect(md).not.toContain('Bearer ');
  });
});
