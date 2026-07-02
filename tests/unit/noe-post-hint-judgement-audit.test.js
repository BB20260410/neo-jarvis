import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPostHintJudgementAudit, classifyEntry, renderMarkdown } from '../../scripts/noe-post-hint-judgement-audit.mjs';

describe('noe-post-hint-judgement-audit', () => {
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

  function actionSuccessEntry(id, overrides = {}) {
    return {
      id,
      total: 4,
      unresolved: 4,
      resolved: 0,
      reasons: [{ reason: 'llm_unknown', count: 4 }],
      verdictReasonCodes: [{ reasonCode: 'insufficient_direct_evidence', count: 4 }],
      hintAgreements: [{ hintAgreement: 'override', count: 4 }],
      evidenceGaps: [{ gap: 'claim_action_semantic_alignment_weak', count: 4 }],
      latestEvidenceDecision: {
        label: 'action_success_signal',
        confidence: 'high',
        profile: {
          matched: 8,
          actionKinds: 1,
          observationKinds: 7,
          actionResultSignals: 4,
          observationSignals: 14,
          successSignals: 4,
        },
      },
      latestEvidenceDecisionHint: {
        label: 'action_success_signal',
        confidence: 'high',
        suggestedVerdict: 'APPLIED',
        profileSource: 'reconstructed_from_safe_metadata',
      },
      latestEvidenceClaimAlignment: {
        claimGrams: 31,
        actionEvents: 1,
        resultActionEvents: 1,
        semanticActionEvents: 1,
        semanticResultActionEvents: 1,
        semanticLinkedActionEvents: 1,
        semanticTraceActionEvents: 0,
        semanticTraceResultActionEvents: 0,
        semanticTraceLinkedActionEvents: 0,
        actionMaxCoverage: 0.129,
        semanticActionMaxCoverage: 0.129,
        semanticTraceMaxCoverage: 0,
      },
      latestEvidenceSummary: {
        scanned: 315,
        matched: 8,
        hasActionEvent: true,
        hasObservationEvent: true,
        hasResultSignal: true,
      },
      latestReplyStats: { chars: 105, lines: 5 },
      claim: 'PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR',
      modelReply: 'PRIVATE_MODEL_REPLY_SHOULD_NOT_APPEAR',
      ...overrides,
    };
  }

  function fixturePaths(overrides = {}) {
    dir = mkdtempSync(join(tmpdir(), 'noe-post-hint-judgement-audit-'));
    const calibration = {
      generatedAt: '2026-06-15T00:00:00.000Z',
      postHintJudgementGate: {
        status: 'post_hint_sample_available',
        nextStep: 'inspect post-hint judgement output before changing settlement behavior',
      },
      recentAutoJudgements: {
        actionFocus: {
          basis: 'latest_tick_actionable_gaps',
          tickId: 42,
          gapCounts: [
            { gap: 'claim_action_semantic_alignment_weak', count: 1 },
            { gap: 'observation_only_unknown', count: 1 },
          ],
        },
        latestTickWithJudgement: {
          id: 42,
          checked: 3,
          resolved: 0,
          evidenceGapCounts: [
            { gap: 'claim_action_semantic_alignment_weak', count: 1 },
            { gap: 'observation_only_unknown', count: 1 },
          ],
        },
        judgementIdCounts: [
          actionSuccessEntry(1),
          {
            id: 2,
            total: 4,
            unresolved: 4,
            resolved: 0,
            reasons: [{ reason: 'llm_unknown', count: 4 }],
            verdictReasonCodes: [{ reasonCode: 'insufficient_direct_evidence', count: 4 }],
            hintAgreements: [{ hintAgreement: 'agree', count: 4 }],
            evidenceGaps: [{ gap: 'observation_only_unknown', count: 4 }],
            latestEvidenceDecision: {
              label: 'observation_only_result_signal',
              confidence: 'low',
              profile: { matched: 8, actionKinds: 0, observationKinds: 8, observationSignals: 17 },
            },
            latestEvidenceDecisionHint: {
              label: 'observation_only_result_signal',
              confidence: 'medium',
              suggestedVerdict: 'UNKNOWN',
            },
            latestEvidenceClaimAlignment: {
              claimGrams: 22,
              actionEvents: 0,
              resultActionEvents: 0,
              semanticTraceMaxCoverage: 0,
            },
            latestEvidenceSummary: { scanned: 315, matched: 8, hasActionEvent: false, hasObservationEvent: true, hasResultSignal: true },
            latestReplyStats: { chars: 96, lines: 5 },
          },
          {
            id: 5,
            total: 2,
            unresolved: 2,
            resolved: 0,
            reasons: [{ reason: 'llm_unknown', count: 2 }],
            verdictReasonCodes: [{ reasonCode: 'insufficient_direct_evidence', count: 2 }],
            hintAgreements: [{ hintAgreement: 'override', count: 2 }],
            evidenceGaps: [{ gap: 'observation_only_unknown', count: 2 }],
            latestEvidenceDecision: {
              label: 'observation_only_result_signal',
              confidence: 'low',
              profile: { matched: 8, actionKinds: 0, observationKinds: 8, observationSignals: 18 },
            },
            latestEvidenceDecisionHint: {
              label: 'action_success_signal',
              confidence: 'medium',
              suggestedVerdict: 'APPLIED',
              profileSource: 'reconstructed_from_safe_metadata',
            },
            latestEvidenceClaimAlignment: {
              claimGrams: 27,
              actionEvents: 0,
              resultActionEvents: 0,
              semanticTraceMaxCoverage: 0,
            },
            latestEvidenceSummary: { scanned: 315, matched: 8, hasActionEvent: false, hasObservationEvent: true, hasResultSignal: true },
            latestReplyStats: { chars: 105, lines: 5 },
          },
          {
            id: 3,
            total: 1,
            unresolved: 1,
            resolved: 0,
            reasons: [{ reason: 'llm_unknown', count: 1 }],
            verdictReasonCodes: [{ reasonCode: 'claim_mismatch', count: 1 }],
            evidenceGaps: [{ gap: 'judge_reports_claim_mismatch_with_trace_success', count: 1 }],
            latestEvidenceDecision: { label: 'action_success_signal', confidence: 'high' },
            latestEvidenceDecisionHint: { label: 'action_success_signal', suggestedVerdict: 'APPLIED' },
            latestEvidenceClaimAlignment: {
              claimGrams: 20,
              resultActionEvents: 2,
              semanticResultActionEvents: 2,
              semanticTraceResultActionEvents: 2,
              semanticTraceMaxCoverage: 0.25,
            },
            latestEvidenceSummary: { scanned: 20, matched: 2, hasActionEvent: true, hasObservationEvent: false, hasResultSignal: true },
          },
          {
            id: 4,
            total: 3,
            unresolved: 3,
            resolved: 0,
            reasons: [{ reason: 'no_evidence', count: 3 }],
            evidenceGaps: [
              { gap: 'missing_evidence_summary', count: 3 },
              { gap: 'no_evidence', count: 3 },
            ],
          },
        ],
      },
      rawClaim: 'PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR',
      ...overrides.calibration,
    };
    const blocker = {
      codeMitigations: {
        actionEvidenceActPayloadSemanticTrace: {
          status: 'code_ready_live_pending_restart_or_new_actions',
          liveStatus: 'pending_restart_or_new_action_evidence',
        },
      },
      ...overrides.blocker,
    };
    return {
      calibrationLatest: writeJson('calibration.json', calibration),
      expectationJudgeBlockerAudit: writeJson('blocker.json', blocker),
    };
  }

  it('classifies post-hint UNKNOWNs without raw claim or model reply text', () => {
    const report = buildPostHintJudgementAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:01:00.000Z'),
    });

    expect(report.status).toBe('code_mitigated_live_pending_new_evidence');
    expect(report.summary).toMatchObject({
      uniqueJudgements: 5,
      unresolvedUniqueJudgements: 5,
      actionSuccessUnknown: 2,
      observationOnlyUnknown: 2,
      directEvidenceUnknown: 1,
      staleActionHintOnObservationOnly: 1,
      semanticTraceCoverageMax: 0.25,
    });
    expect(report.summary.categoryCounts).toEqual(expect.arrayContaining([
      { category: 'historical_action_evidence_lacks_semantic_trace', count: 1 },
      { category: 'observation_only_correct_unknown', count: 2 },
      { category: 'judge_claim_mismatch_after_trace_success', count: 1 },
      { category: 'missing_evidence', count: 1 },
    ]));
    expect(report.nextActions.map((item) => item.action)).toEqual(expect.arrayContaining([
      'restart_or_wait_for_new_action_evidence_then_rerun_calibration',
      'keep_observation_only_unknown_and_collect_action_or_external_result',
      'ignore_stale_compact_action_hints_on_observation_only_rows',
      'review_judge_prompt_contract_for_direct_evidence_unknowns',
    ]));
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_MODEL_REPLY_SHOULD_NOT_APPEAR');
  });

  it('renders safe markdown with categories and no bearer-like secret', () => {
    const report = buildPostHintJudgementAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:01:00.000Z'),
    });
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(md).toContain('historical_action_evidence_lacks_semantic_trace');
    expect(md).toContain('observation_only_correct_unknown');
    expect(md).toContain('stale action hint on observation-only: 1');
    expect(md).toContain('ignore_stale_compact_action_hints_on_observation_only_rows');
    expect(md).toContain('restart_or_wait_for_new_action_evidence_then_rerun_calibration');
    expect(md).not.toContain('PRIVATE_CLAIM_TEXT_SHOULD_NOT_APPEAR');
    expect(md).not.toContain('Bearer ');
  });

  it('recognizes direct-evidence unknowns as judge contract review instead of trace enrichment', () => {
    const entry = actionSuccessEntry(9, {
      evidenceGaps: [{ gap: 'judge_requires_claim_evidence_link', count: 1 }],
      latestEvidenceClaimAlignment: {
        claimGrams: 12,
        resultActionEvents: 2,
        semanticResultActionEvents: 2,
        semanticTraceResultActionEvents: 2,
        actionMaxCoverage: 0.25,
        semanticActionMaxCoverage: 0.25,
        semanticTraceMaxCoverage: 0.25,
      },
    });

    expect(classifyEntry(entry)).toBe('judge_contract_too_conservative');
  });
});
