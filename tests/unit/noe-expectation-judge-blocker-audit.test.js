import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExpectationJudgeBlockerAudit, renderMarkdown } from '../../scripts/noe-expectation-judge-blocker-audit.mjs';

describe('noe-expectation-judge-blocker-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(name, value) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  function writeText(name, value) {
    const path = join(dir, name);
    writeFileSync(path, `${value}\n`);
    return path;
  }

  function fixturePaths(overrides = {}) {
    dir = mkdtempSync(join(tmpdir(), 'noe-expectation-judge-blocker-audit-'));
    const calibration = {
      generatedAt: '2026-06-15T00:00:00.000Z',
      status: { blockers: ['live_expectation_resolved_below_20', 'live_expectation_overdue_open'] },
      live: {
        total: 299,
        resolvedScored: 17,
        naturalResolvedScored: 17,
        liveResolvedRequired: 20,
        liveResolvedRemaining: 3,
        open: 282,
        dueNowOpen: 27,
        overdueOpen: 27,
        resolverActionableNow: true,
        brier: { n: 17, brier: 0.054412 },
      },
      recentAutoJudgements: {
        ticksScanned: 20,
        ticksWithJudgements: 20,
        judged: 60,
        resolvedFromResults: 1,
        outcomeCounts: { applied: 1, failed: 0, unknown: 59 },
        reasonCounts: [{ reason: 'llm_unknown', count: 47 }, { reason: 'no_evidence', count: 12 }],
        verdictReasonCodeCounts: [{ reasonCode: 'insufficient_direct_evidence', count: 45 }],
        evidenceGapCounts: [
          { gap: 'claim_action_semantic_trace_coverage_low', count: 8 },
          { gap: 'no_evidence', count: 4 },
        ],
        evidenceSummary: {
          withSummary: 48,
          hasActionEvent: 18,
          hasObservationEvent: 44,
          hasResultSignal: 48,
          matched: { min: 1, max: 8, avg: 5.94 },
          kindCounts: [{ kind: 'noe_act_semantic_trace', count: 15 }],
          signalCounts: [{ signal: 'status=completed', count: 49 }],
        },
        evidenceDecision: {
          withDecision: 48,
          labelCounts: [
            { label: 'observation_only_result_signal', count: 30 },
            { label: 'action_success_signal', count: 18 },
          ],
          confidenceCounts: [{ confidence: 'high', count: 18 }],
        },
        evidenceDecisionHint: {
          withHint: 48,
          labelCounts: [{ label: 'action_success_signal', count: 22 }],
          suggestedVerdictCounts: [
            { suggestedVerdict: 'APPLIED', count: 22 },
            { suggestedVerdict: 'UNKNOWN', count: 26 },
          ],
        },
        evidenceClaimAlignment: {
          withAlignment: 48,
          actionEvents: 57,
          resultActionEvents: 57,
          linkedActionEvents: 57,
          unlinkedActionEvents: 0,
          actionMaxCoverage: 0.192,
          semanticActionEvents: 57,
          semanticResultActionEvents: 57,
          semanticLinkedActionEvents: 57,
          semanticActionMaxCoverage: 0.167,
          semanticTraceActionEvents: 23,
          semanticTraceResultActionEvents: 23,
          semanticTraceLinkedActionEvents: 23,
          semanticTraceUnlinkedActionEvents: 34,
          semanticTraceMaxCoverage: 0.167,
        },
        repeatedUnresolvedIds: [{ id: 272, count: 3 }],
      },
      postHintJudgementGate: {
        status: 'post_hint_sample_available',
        decisiveEvidenceDecisionCount: 18,
        decisiveEvidenceHintCount: 44,
        dueNowOpen: 27,
        nextOpenDueAtIso: '2026-06-15T01:00:00.000Z',
        secondsUntilNextOpenDue: 100,
        nextStep: 'inspect post-hint judgement output before changing settlement behavior',
      },
      rawClaim: 'PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR',
      ...overrides.calibration,
    };
    const runtime = {
      generatedAt: '2026-06-15T00:01:00.000Z',
      expectations: {
        status: 'positive_only_no_failed_samples',
        total: 299,
        settled: 17,
        applied: 17,
        failed: 0,
        open: 282,
        dueOpen: 27,
        brier: 0.054412,
      },
      expectationJudgeContract: {
        status: 'decisive_hints_partly_unknown',
        ticksScanned: 120,
        judged: 328,
        resolved: 3,
        unknown: 325,
        noEvidence: 59,
        decisiveHints: 106,
        decisiveHintUnknown: 103,
        decisiveHintOverride: 102,
        decisiveUnknownRate: 0.972,
        avgSemanticCoverage: 0.038,
        reasonCounts: [{ reason: 'llm_unknown', count: 264 }],
        verdictReasonCounts: [{ reasonCode: 'insufficient_direct_evidence', count: 262 }],
        hintLabelCounts: [{ label: 'action_success_signal', count: 106 }],
        suggestedVerdictCounts: [{ verdict: 'APPLIED', count: 106 }],
      },
      ...overrides.runtime,
    };
    const surprise = {
      status: 'code_ready_live_blocked_no_failed_samples',
      surpriseLearningLive: false,
      current: { expectationsFailed: 0, failedSurpriseEligible: 0, surpriseGoals: 0 },
      ...overrides.surprise,
    };
    const postHint = {
      status: 'code_mitigated_live_pending_new_evidence',
      summary: {
        uniqueJudgements: 19,
        actionSuccessUnknown: 7,
        observationOnlyUnknown: 9,
        directEvidenceUnknown: 1,
        staleActionHintOnObservationOnly: 1,
        semanticTraceCoverageMax: 0.167,
        categoryCounts: [
          { category: 'observation_only_correct_unknown', count: 9 },
          { category: 'historical_action_evidence_lacks_semantic_trace', count: 4 },
        ],
      },
      ...overrides.postHint,
    };
    const newActionReadiness = {
      status: 'ready_for_new_action_evidence_after_restart_or_natural_action',
      summary: {
        ready: true,
        newActionSemanticTraceCoverage: 1,
        legacyActionSemanticTraceCoverage: 0.178,
        observationOnlySemanticTraceCoverage: 0,
      },
      ...overrides.newActionReadiness,
    };
    const directReaskReadiness = {
      status: 'ready_for_direct_evidence_decisive_reask',
      summary: {
        ready: true,
        directSuccessResolved: 1,
        directSuccessOutcome: 1,
        directSuccessSemanticTraceCoverage: 1,
        claimMismatchResolved: 0,
        claimMismatchSecondReasonCode: 'claim_mismatch',
      },
      ...overrides.directReaskReadiness,
    };
    const actionEvidenceSource = writeText('NoeActionEvidence.js', `
      const safeActPayload = safeObject(safeAct.payload);
      semanticBucket(safeActPayload.goal, safeActPayload.goalTitle);
      semanticBucket(safeActPayload.expectation, safeActPayload.expectedClaim);
      semanticBucket(safeActPayload.checkpoint, safeActPayload.stepText);
    `);
    return {
      calibrationLatest: writeJson('calibration.json', calibration),
      runtimeEvidenceLatest: writeJson('runtime.json', runtime),
      surpriseLearningAudit: writeJson('surprise.json', surprise),
      postHintJudgementAudit: writeJson('post-hint.json', postHint),
      newActionEvidenceReadiness: writeJson('new-action-readiness.json', newActionReadiness),
      directEvidenceReaskReadiness: writeJson('direct-reask-readiness.json', directReaskReadiness),
      actionEvidenceSource,
    };
  }

  it('classifies the current high-unknown judge blocker without raw text', () => {
    const report = buildExpectationJudgeBlockerAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:02:00.000Z'),
    });

    expect(report.status).toBe('blocked_at_judge_and_evidence_linkage');
    expect(report.runtime).toMatchObject({
      failed: 0,
      decisiveHints: 106,
      decisiveHintUnknown: 103,
      decisiveUnknownRate: 0.972,
    });
    expect(report.calibration.recent.evidenceClaimAlignment).toMatchObject({
      semanticTraceResultActionEvents: 23,
      semanticTraceMaxCoverage: 0.167,
    });
    expect(report.blockers.map((item) => item.id)).toEqual(expect.arrayContaining([
      'no_failed_expectation_samples',
      'decisive_hints_mostly_unknown',
      'semantic_trace_claim_coverage_low',
      'action_success_signal_still_unknown',
      'observation_only_result_noise',
    ]));
    expect(report.codeMitigations.actionEvidenceActPayloadSemanticTrace).toMatchObject({
      status: 'code_ready_live_pending_restart_or_new_actions',
      liveStatus: 'pending_restart_or_new_action_evidence',
    });
    expect(report.postHintJudgement).toMatchObject({
      status: 'code_mitigated_live_pending_new_evidence',
      actionSuccessUnknown: 7,
      observationOnlyUnknown: 9,
      directEvidenceUnknown: 1,
      staleActionHintOnObservationOnly: 1,
    });
    expect(report.readiness.newActionEvidence).toMatchObject({
      status: 'ready_for_new_action_evidence_after_restart_or_natural_action',
      ready: true,
      newActionSemanticTraceCoverage: 1,
    });
    expect(report.readiness.directEvidenceReask).toMatchObject({
      status: 'ready_for_direct_evidence_decisive_reask',
      ready: true,
      directSuccessResolved: 1,
      claimMismatchSecondReasonCode: 'claim_mismatch',
    });
    expect(report.blockers.find((item) => item.id === 'semantic_trace_claim_coverage_low')).toMatchObject({
      severity: 'P1',
    });
    expect(report.blockers.find((item) => item.id === 'action_success_signal_still_unknown').nextAction)
      .toContain('direct-evidence reask readiness 已证明');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR');
  });

  it('renders actionable success criteria without Bearer or claim text', () => {
    const report = buildExpectationJudgeBlockerAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:02:00.000Z'),
    });
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(md).toContain('semantic_trace_claim_coverage_low');
    expect(md).toContain('actionEvidenceActPayloadSemanticTrace');
    expect(md).toContain('Post-Hint Judgement');
    expect(md).toContain('code_ready_live_pending_restart_or_new_actions');
    expect(md).toContain('code_mitigated_live_pending_new_evidence');
    expect(md).toContain('ready_for_new_action_evidence_after_restart_or_natural_action');
    expect(md).toContain('ready_for_direct_evidence_decisive_reask');
    expect(md).toContain('decisiveUnknownRate');
    expect(md).toContain('expectations.failed > 0');
    expect(md).not.toContain('PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR');
    expect(md).not.toContain('Bearer ');
  });

  it('drops P0 judge blockers once failed samples and sufficient trace coverage exist', () => {
    const report = buildExpectationJudgeBlockerAudit({
      root: dir || process.cwd(),
      paths: fixturePaths({
        calibration: {
          live: {
            resolvedScored: 24,
            naturalResolvedScored: 24,
            liveResolvedRequired: 20,
            liveResolvedRemaining: 0,
            open: 20,
            dueNowOpen: 0,
            overdueOpen: 0,
            resolverActionableNow: false,
            brier: { n: 24, brier: 0.1 },
          },
          recentAutoJudgements: {
            outcomeCounts: { applied: 8, failed: 2, unknown: 4 },
            evidenceDecision: {
              labelCounts: [{ label: 'action_success_signal', count: 6 }],
            },
            evidenceDecisionHint: {
              suggestedVerdictCounts: [{ suggestedVerdict: 'APPLIED', count: 6 }],
            },
            evidenceClaimAlignment: {
              semanticTraceResultActionEvents: 6,
              semanticTraceMaxCoverage: 0.32,
            },
          },
        },
        runtime: {
          expectations: { failed: 2, settled: 24, applied: 22 },
          expectationJudgeContract: {
            decisiveHints: 10,
            decisiveHintUnknown: 3,
            decisiveUnknownRate: 0.3,
          },
        },
        surprise: {
          current: { expectationsFailed: 2, failedSurpriseEligible: 1, surpriseGoals: 1 },
        },
      }),
      now: new Date('2026-06-15T00:02:00.000Z'),
    });

    expect(report.blockers.filter((item) => item.severity === 'P0')).toEqual([]);
    expect(report.status).toBe('needs_monitoring');
  });
});
