import { describe, expect, it } from 'vitest';
import {
  buildDirectEvidenceReaskReadiness,
  renderMarkdown,
} from '../../scripts/noe-direct-evidence-reask-readiness.mjs';

describe('noe-direct-evidence-reask-readiness', () => {
  it('proves decisive reask can settle direct action-result evidence without live side effects', async () => {
    const report = await buildDirectEvidenceReaskReadiness({
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.status).toBe('ready_for_direct_evidence_decisive_reask');
    expect(report.policy).toMatchObject({
      syntheticInputsOnly: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noLiveHttpCalls: true,
      noRealModelCalls: true,
    });
    expect(report.summary).toMatchObject({
      ready: true,
      directSuccessResolved: 1,
      directSuccessOutcome: 1,
      directSuccessReaskAttempted: true,
      claimMismatchResolved: 0,
      claimMismatchOutcome: null,
      claimMismatchReaskAttempted: true,
      claimMismatchSecondReasonCode: 'claim_mismatch',
    });
    expect(report.summary.directSuccessSemanticTraceCoverage).toBeGreaterThanOrEqual(0.25);
    expect(report.cases.find((item) => item.id === 'direct_success_reask_applies')).toMatchObject({
      resolved: 1,
      outcome: 1,
      calls: ['initial_judge', 'decisive_reask'],
      decisiveReask: {
        attempted: true,
        outcome: 1,
        secondReasonCode: 'direct_success',
      },
    });
    expect(report.cases.find((item) => item.id === 'claim_mismatch_reask_stays_unknown')).toMatchObject({
      resolved: 0,
      outcome: null,
      calls: ['initial_judge', 'decisive_reask'],
      decisiveReask: {
        attempted: true,
        outcome: null,
        secondReasonCode: 'claim_mismatch',
      },
    });
    expect(JSON.stringify(report)).not.toContain('tp-unitsecret');
    expect(JSON.stringify(report)).not.toContain('unit-test-secret-token-value');
    expect(JSON.stringify(report)).not.toContain('owner expects visible delivery evidence from the decisive reask checkpoint');
  });

  it('renders a safe markdown summary without claim or evidence body', async () => {
    const report = await buildDirectEvidenceReaskReadiness({
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const md = renderMarkdown(report, '/tmp/direct-reask.json');

    expect(md).toContain('ready_for_direct_evidence_decisive_reask');
    expect(md).toContain('direct_success_reask_applies');
    expect(md).toContain('claim_mismatch_reask_stays_unknown');
    expect(md).not.toContain('owner expects visible delivery evidence from the decisive reask checkpoint');
    expect(md).not.toContain('Bearer ');
  });
});
