import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExpectationCalibrationSnapshot,
  summarizeRecentExpectationTickJudgements,
  summarizeExpectationRows,
  writeExpectationCalibrationSnapshot,
} from '../../scripts/noe-expectation-calibration-snapshot.mjs';
import {
  buildGoalCheckpointExpectationEvidenceRow,
  buildNoeActExpectationEvidenceRow,
} from '../../src/cognition/NoeExpectationActionEvidenceRows.js';

const T0 = Date.parse('2026-06-12T02:00:00Z');

describe('noe-expectation-calibration-snapshot', () => {
  it('builds safe legacy act evidence rows without exporting arbitrary command text', () => {
    const legacy = buildNoeActExpectationEvidenceRow({
      id: 'act-legacy',
      title: 'delivery evidence completed',
      action: 'shell.exec',
      status: 'completed',
      evidence_event_id: 42,
      log_ref: 'sqlite:events/42',
      updated_at: T0,
      payload: {
        executorResult: {
          command: 'echo tp-unitsecret000000000000000000000000000000',
          stdout: 'secret-ish output should stay out of expectation payload',
        },
      },
    });

    expect(legacy).toMatchObject({
      id: 'noe_act:act-legacy',
      kind: 'noe_act_evidence_summary',
      entityType: 'noe_act',
      payload: {
        status: 'completed',
        completed: true,
        ok: true,
        result: 'done',
        action: 'shell.exec',
        title: 'delivery evidence completed',
      },
    });
    expect(JSON.stringify(legacy)).not.toContain('tp-unitsecret');
    expect(JSON.stringify(legacy)).not.toContain('secret-ish output');

    const nullEvidence = buildNoeActExpectationEvidenceRow({
      id: 'act-null-evidence',
      title: 'legacy null evidence completed',
      action: 'shell.exec',
      status: 'completed',
      evidence_event_id: 43,
      updated_at: T0 + 1,
      payload: {
        actionEvidence: null,
        actionEvidenceSummary: null,
      },
    });
    expect(nullEvidence.kind).toBe('noe_act_evidence_summary');

    const blocked = buildNoeActExpectationEvidenceRow({
      id: 'act-open',
      title: 'delivery evidence pending',
      action: 'shell.exec',
      status: 'running',
      updated_at: T0,
      payload: {},
    });
    expect(blocked).toBeNull();
  });

  it('keeps semanticTrace rows on the stronger trace route for acts and checkpoints', () => {
    const act = buildNoeActExpectationEvidenceRow({
      id: 'act-trace',
      title: 'trace proof',
      action: 'noe.note.write',
      status: 'completed',
      updated_at: T0,
      payload: {
        actionEvidence: {
          action: 'noe.note.write',
          title: 'trace proof',
          semanticTrace: {
            expectation: ['owner expects visible delivery evidence'],
            token: 'tp-unitsecret000000000000000000000000000000',
          },
        },
      },
    });
    const checkpoint = buildGoalCheckpointExpectationEvidenceRow({
      id: 7,
      phase: 'evidence',
      status: 'done',
      kind: 'act',
      action: 'noe.note.write',
      evidence_ref: 'sqlite:noe_acts/act-trace',
      ts: T0 + 1,
      payload: {
        actionEvidenceSummary: {
          action: 'noe.note.write',
          title: 'trace checkpoint',
          semanticTrace: {
            checkpoint: ['write readiness audit'],
            apiKey: 'tp-unitsecret000000000000000000000000000000',
          },
        },
      },
    });

    expect(act.kind).toBe('noe_act_semantic_trace');
    expect(act.payload.actionEvidence.semanticTrace.expectation).toEqual(['owner expects visible delivery evidence']);
    expect(JSON.stringify(act)).not.toContain('tp-unitsecret');
    expect(checkpoint.kind).toBe('noe_goal_checkpoint_semantic_trace');
    expect(checkpoint.payload.phase).toBe('evidence');
    expect(checkpoint.payload.actionEvidence.semanticTrace.checkpoint).toEqual(['write readiness audit']);
    expect(JSON.stringify(checkpoint)).not.toContain('apiKey');

    const legacyCheckpoint = buildGoalCheckpointExpectationEvidenceRow({
      id: 8,
      phase: 'verify',
      status: 'completed',
      kind: 'act',
      action: 'noe.verify',
      evidence_ref: 'sqlite:noe_acts/act-legacy',
      ts: T0 + 2,
      payload: {
        actionEvidence: null,
        actionEvidenceSummary: null,
      },
    });
    expect(legacyCheckpoint.kind).toBe('noe_goal_checkpoint_evidence_summary');
    expect(legacyCheckpoint.payload.phase).toBe('verify');
  });

  it('summarizes live expectation counts without exposing claim text', () => {
    const rows = [
      { id: 1, source: 'thought', claim: 'secret text should not appear', p: 0.8, due_at: T0 - 1000, resolved_at: T0, outcome: 1 },
      { id: 2, source: 'thought', claim: 'another claim', p: 0.7, due_at: T0 - 1000, resolved_at: T0, outcome: 0 },
      { id: 3, source: 'conversation', claim: 'open due', p: 0.75, due_at: T0 - 1, resolved_at: null, outcome: null },
      { id: 4, source: 'conversation', claim: 'future due', p: 0.75, due_at: T0 + 3600_000, resolved_at: null, outcome: null },
      { id: 5, source: 'thought', claim: 'unknown', p: 0.6, due_at: T0 - 1000, resolved_at: T0, outcome: null },
    ];
    const live = summarizeExpectationRows(rows, { now: T0, requiredLiveResolved: 20 });
    expect(live.total).toBe(5);
    expect(live.resolvedScored).toBe(2);
    expect(live.naturalResolvedScored).toBe(2);
    expect(live.controlledLiveResolvedScored).toBe(0);
    expect(live.controlledLiveRows).toBe(0);
    expect(live.resolvedUnknown).toBe(1);
    expect(live.open).toBe(2);
    expect(live.openWithDueAt).toBe(2);
    expect(live.dueOpen).toBe(2);
    expect(live.dueNowOpen).toBe(1);
    expect(live.overdueOpen).toBe(1);
    expect(live.futureOpenWithDueAt).toBe(1);
    expect(live.dueWithin24h).toBe(1);
    expect(live.resolverActionableNow).toBe(true);
    expect(live.nextOpenDueAt).toBe(T0 + 3600_000);
    expect(live.hoursUntilNextOpenDue).toBe(1);
    expect(live.liveCalibrationReady).toBe(false);
    expect(live.naturalLiveCalibrationReady).toBe(false);
    expect(live.brierNatural.n).toBe(2);
    expect(JSON.stringify(live)).not.toContain('secret text');
  });

  it('keeps controlled drill separate from live calibration readiness', () => {
    const snapshot = buildExpectationCalibrationSnapshot({
      now: T0,
      dbExists: true,
      rows: Array.from({ length: 4 }, (_, i) => ({
        id: i + 1,
        source: 'thought',
        p: 0.8,
        due_at: T0 - 1000,
        resolved_at: T0,
        outcome: 1,
      })),
      controlledDrill: { ok: true, reportPath: 'output/noe-expectation-settlement-drill/x/report.json', sampleCount: 20, resolvedCount: 20 },
      requiredLiveResolved: 20,
    });
    expect(snapshot.status.controlledMechanismReady).toBe(true);
    expect(snapshot.status.liveCalibrationReady).toBe(false);
    expect(snapshot.status.readyForLongTermCalibration).toBe(false);
    expect(snapshot.status.blockers).toContain('live_expectation_resolved_below_20');
    expect(snapshot.status.warnings).toContain('controlled_drill_ready_but_live_calibration_not_ready');
  });

  it('exposes a structured post-hint wait gate without claim text', () => {
    const nextDue = T0 + 3600_000;
    const snapshot = buildExpectationCalibrationSnapshot({
      now: T0,
      dbExists: true,
      rows: [
        { id: 1, source: 'thought', claim: 'raw future claim should not appear', p: 0.7, due_at: nextDue, resolved_at: null, outcome: null },
      ],
      recentExpectationTicks: [
        {
          id: 22,
          finished_at: T0 - 1000,
          outcome: JSON.stringify({
            previousResult: {
              checked: 1,
              resolved: 0,
              judged: [
                {
                  id: 1,
                  outcome: null,
                  reason: 'llm_unknown',
                  verdictParser: 'json_unknown',
                  verdictReasonCode: 'insufficient_direct_evidence',
                  hintAgreement: 'override',
                  evidenceStats: { chars: 1000, lines: 5 },
                  evidenceSummary: {
                    scanned: 8,
                    matched: 4,
                    kinds: [{ kind: 'noe_act_semantic_trace', count: 4 }],
                    signals: [{ signal: 'status=completed', count: 4 }],
                    hasActionEvent: true,
                    hasObservationEvent: false,
                    hasResultSignal: true,
                  },
                },
              ],
            },
          }),
        },
      ],
      controlledDrill: { ok: true, reportPath: 'output/noe-expectation-settlement-drill/x/report.json', sampleCount: 20, resolvedCount: 20 },
      requiredLiveResolved: 20,
    });

    expect(snapshot.postHintJudgementGate).toMatchObject({
      status: 'waiting_for_post_hint_natural_judgement',
      decisiveEvidenceDecisionCount: 1,
      decisiveEvidenceHintCount: 0,
      dueNowOpen: 0,
      nextOpenDueAt: nextDue,
      nextOpenDueAtIso: new Date(nextDue).toISOString(),
      secondsUntilNextOpenDue: 3600,
      source: 'recent_expectation_ticks_safe_metadata',
    });
    expect(snapshot.postHintJudgementGate.nextStep).toContain('wait for the next natural expectation tick');
    expect(JSON.stringify(snapshot)).not.toContain('raw future claim');
  });

  it('excludes controlled live rows from long-term live calibration readiness', () => {
    const controlledRows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      source: i % 2 ? 'live_calibration_drill' : 'synthetic_expectation_test',
      claim: `controlled claim ${i}`,
      p: 0.8,
      due_at: T0 - 1000,
      resolved_at: T0,
      outcome: 1,
    }));
    const naturalRows = Array.from({ length: 4 }, (_, i) => ({
      id: 100 + i,
      source: 'reflection',
      claim: `natural claim ${i}`,
      p: 0.7,
      due_at: T0 - 1000,
      resolved_at: T0,
      outcome: i % 2,
    }));
    const snapshot = buildExpectationCalibrationSnapshot({
      now: T0,
      dbExists: true,
      rows: [...controlledRows, ...naturalRows],
      controlledDrill: { ok: true, reportPath: 'output/noe-expectation-settlement-drill/x/report.json', sampleCount: 20, resolvedCount: 20 },
      requiredLiveResolved: 20,
    });
    expect(snapshot.live.resolvedScored).toBe(24);
    expect(snapshot.live.naturalResolvedScored).toBe(4);
    expect(snapshot.live.controlledLiveResolvedScored).toBe(20);
    expect(snapshot.live.liveResolvedRemaining).toBe(16);
    expect(snapshot.live.liveCalibrationReady).toBe(false);
    expect(snapshot.status.readyForLongTermCalibration).toBe(false);
    expect(snapshot.status.blockers).toContain('live_expectation_resolved_below_20');
    expect(snapshot.status.warnings).toContain('controlled_live_expectations_excluded_from_live_calibration');
    expect(snapshot.live.brier.n).toBe(24);
    expect(snapshot.live.brierNatural.n).toBe(4);
    expect(JSON.stringify(snapshot)).not.toContain('controlled claim');
    expect(JSON.stringify(snapshot)).not.toContain('natural claim');
  });

  it('allows readiness when natural live rows meet the threshold even with controlled extras', () => {
    const naturalRows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      source: 'thought',
      p: 0.8,
      due_at: T0 - 1000,
      resolved_at: T0,
      outcome: 1,
    }));
    const controlledRows = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      source: 'controlled_live_drill',
      p: 0.8,
      due_at: T0 - 1000,
      resolved_at: T0,
      outcome: 1,
    }));
    const snapshot = buildExpectationCalibrationSnapshot({
      now: T0,
      dbExists: true,
      rows: [...naturalRows, ...controlledRows],
      controlledDrill: { ok: true, reportPath: 'output/noe-expectation-settlement-drill/x/report.json', sampleCount: 20, resolvedCount: 20 },
      requiredLiveResolved: 20,
    });
    expect(snapshot.live.resolvedScored).toBe(25);
    expect(snapshot.live.naturalResolvedScored).toBe(20);
    expect(snapshot.live.controlledLiveResolvedScored).toBe(5);
    expect(snapshot.live.liveResolvedRemaining).toBe(0);
    expect(snapshot.live.liveCalibrationReady).toBe(true);
    expect(snapshot.status.liveCalibrationReady).toBe(true);
    expect(snapshot.status.readyForLongTermCalibration).toBe(true);
    expect(snapshot.live.brierNatural.n).toBe(20);
    expect(snapshot.status.blockers).not.toContain('live_expectation_resolved_below_20');
    expect(snapshot.status.warnings).toContain('controlled_live_expectations_excluded_from_live_calibration');
  });

  it('summarizes recent automatic judgement reasons without claim text', () => {
    const ticks = [
      {
        id: 12,
        finished_at: T0 + 2000,
        outcome: JSON.stringify({
          reason: 'started_background',
          previousResult: {
            checked: 3,
            resolved: 0,
            judged: [
              {
                id: 145,
                outcome: null,
                reason: 'llm_unknown',
                verdictParser: 'en_unknown',
                evidenceStats: { chars: 180, lines: 2 },
                evidenceSummary: {
                  scanned: 4,
                  matched: 2,
                  kinds: [{ kind: 'noe_act_executed', count: 1 }, { kind: 'noe_thought', count: 1 }],
                  signals: [{ signal: 'status=completed', count: 1 }, { signal: 'ok=true', count: 1 }],
                  hasActionEvent: true,
                  hasObservationEvent: true,
                  hasResultSignal: true,
                },
                replyStats: { chars: 7, lines: 1 },
                claim: 'secret claim should not appear',
              },
              {
                id: 148,
                outcome: null,
                reason: 'no_evidence',
                verdictParser: 'en_unknown',
                evidenceStats: { chars: 0, lines: 0 },
                evidenceSummary: { scanned: 3, matched: 0, kinds: [], signals: [], hasActionEvent: false, hasObservationEvent: false, hasResultSignal: false },
                replyStats: { chars: 0, lines: 0 },
              },
              {
                id: 149,
                outcome: 1,
                reason: 'llm_applied',
                verdictParser: 'zh_applied',
                evidenceStats: { chars: 90, lines: 1 },
                evidenceSummary: {
                  scanned: 2,
                  matched: 1,
                  kinds: [{ kind: 'noe_thought', count: 1 }],
                  signals: [{ signal: 'completed=true', count: 1 }],
                  hasActionEvent: false,
                  hasObservationEvent: true,
                  hasResultSignal: true,
                },
                replyStats: { chars: 12, lines: 1 },
              },
            ],
          },
        }),
      },
      {
        id: 11,
        finished_at: T0 + 1000,
        outcome: JSON.stringify({
          checked: 2,
          resolved: 1,
          judged: [
            {
              id: 100,
              outcome: 0,
              reason: 'llm_failed',
              verdictParser: '<script>bad</script>',
              evidenceStats: { chars: 30, lines: 1 },
              evidenceSummary: {
                scanned: 1,
                matched: 1,
                kinds: [{ kind: 'noe_act_executed', count: 1 }],
                signals: [{ signal: 'failed=true', count: 1 }],
                hasActionEvent: true,
                hasObservationEvent: false,
                hasResultSignal: true,
              },
              replyStats: { chars: 21, lines: 2 },
            },
            {
              id: 145,
              outcome: null,
              reason: 'llm_unknown',
              verdictParser: 'en_unknown',
              evidenceStats: { chars: 181, lines: 2 },
              evidenceSummary: {
                scanned: 5,
                matched: 3,
                kinds: [{ kind: 'noe_reflection', count: 2 }, { kind: 'noe_act_executed', count: 1 }],
                signals: [{ signal: 'reason=OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz', count: 1 }, { signal: 'status=unknown', count: 2 }],
                hasActionEvent: true,
                hasObservationEvent: true,
                hasResultSignal: true,
              },
              replyStats: { chars: 7, lines: 1 },
              claim: 'repeated secret claim should not appear',
            },
          ],
        }),
      },
      {
        id: 10,
        finished_at: T0,
        outcome: JSON.stringify({ reason: 'started_background' }),
      },
    ];
    const summary = summarizeRecentExpectationTickJudgements(ticks);
    expect(summary.ticksScanned).toBe(3);
    expect(summary.ticksWithPreviousResult).toBe(1);
    expect(summary.ticksWithJudgements).toBe(2);
    expect(summary.judged).toBe(5);
    expect(summary.resolvedFromResults).toBe(1);
    expect(summary.outcomeCounts).toEqual({ applied: 1, failed: 1, unknown: 3 });
    expect(summary.reasonCounts).toEqual([
      { reason: 'llm_unknown', count: 2 },
      { reason: 'llm_applied', count: 1 },
      { reason: 'llm_failed', count: 1 },
      { reason: 'no_evidence', count: 1 },
    ]);
    expect(summary.verdictParserCounts).toEqual([
      { parser: 'en_unknown', count: 3 },
      { parser: 'script_bad_script', count: 1 },
      { parser: 'zh_applied', count: 1 },
    ]);
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'ambiguous_action_result_unknown', count: 1 },
      { gap: 'judge_unknown_despite_decisive_result', count: 1 },
      { gap: 'no_action_event', count: 1 },
      { gap: 'no_evidence', count: 1 },
      { gap: 'no_matched_evidence', count: 1 },
      { gap: 'no_result_signal', count: 1 },
    ]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'improve_evidence_retrieval',
        priority: 2,
        nextStep: 'expand or retune event matching so due expectations receive relevant post-creation evidence',
        gapCount: 2,
        gaps: ['no_evidence', 'no_matched_evidence'],
      },
      {
        action: 'record_action_event_evidence',
        priority: 3,
        nextStep: 'ensure relevant acts/checkpoints emit safe action events that expectation evidence can match',
        gapCount: 1,
        gaps: ['no_action_event'],
      },
      {
        action: 'record_result_signal_evidence',
        priority: 3,
        nextStep: 'ensure matched events include safe status/result/completed/failed signals',
        gapCount: 1,
        gaps: ['no_result_signal'],
      },
      {
        action: 'refine_evidence_decision_summary',
        priority: 3,
        nextStep: 'separate action outcome signals from observation metadata in the safe evidence summary',
        gapCount: 1,
        gaps: ['ambiguous_action_result_unknown'],
      },
      {
        action: 'review_judge_conservatism',
        priority: 4,
        nextStep: 'inspect prompt and safe metadata shape only after safe decisive result signals are present',
        gapCount: 1,
        gaps: ['judge_unknown_despite_decisive_result'],
      },
    ]);
    expect(summary.evidenceDecision.labelCounts).toEqual([
      { label: 'action_success_signal', count: 2 },
      { label: 'action_failure_signal', count: 1 },
      { label: 'ambiguous_action_result_signal', count: 1 },
      { label: 'no_matched_evidence', count: 1 },
    ]);
    expect(summary.evidenceStats).toEqual({
      withStats: 5,
      zeroEvidence: 1,
      chars: { min: 0, max: 181, avg: 96.2 },
      lines: { min: 0, max: 2, avg: 1.2 },
    });
    expect(summary.replyStats).toEqual({
      withStats: 5,
      zeroReply: 1,
      chars: { min: 0, max: 21, avg: 9.4 },
      lines: { min: 0, max: 2, avg: 1 },
    });
    expect(summary.evidenceSummary).toMatchObject({
      withSummary: 5,
      hasActionEvent: 3,
      hasObservationEvent: 3,
      hasResultSignal: 4,
      scanned: { min: 1, max: 5, avg: 3 },
      matched: { min: 0, max: 3, avg: 1.4 },
    });
    expect(summary.evidenceSummary.kindCounts).toEqual([
      { kind: 'noe_act_executed', count: 3 },
      { kind: 'noe_reflection', count: 2 },
      { kind: 'noe_thought', count: 2 },
    ]);
    expect(summary.evidenceSummary.signalCounts).toContainEqual({ signal: 'status=unknown', count: 2 });
    expect(summary.evidenceSummary.signalCounts).toContainEqual({ signal: 'reason=OPENAI_API_KEY=[redacted]', count: 1 });
    expect(summary.judgementIdCounts[0]).toEqual({
      id: 145,
      total: 2,
      unresolved: 2,
      resolved: 0,
      reasons: [{ reason: 'llm_unknown', count: 2 }],
      verdictParsers: [{ parser: 'en_unknown', count: 2 }],
      evidenceGaps: [
        { gap: 'ambiguous_action_result_unknown', count: 1 },
        { gap: 'judge_unknown_despite_decisive_result', count: 1 },
      ],
      latestEvidenceStats: { chars: 180, lines: 2 },
      latestEvidenceSummary: {
        scanned: 4,
        matched: 2,
        kinds: [{ kind: 'noe_act_executed', count: 1 }, { kind: 'noe_thought', count: 1 }],
        signals: [{ signal: 'ok=true', count: 1 }, { signal: 'status=completed', count: 1 }],
        hasActionEvent: true,
        hasObservationEvent: true,
        hasResultSignal: true,
      },
      latestEvidenceDecision: {
        label: 'action_success_signal',
        confidence: 'high',
        profile: {
          matched: 2,
          actionKinds: 1,
          observationKinds: 1,
          actionResultSignals: 2,
          observationSignals: 0,
          successSignals: 2,
          failureSignals: 0,
          runningSignals: 0,
        },
        nextStep: 'review judge prompt because safe success evidence exists',
      },
      latestEvidenceGaps: ['judge_unknown_despite_decisive_result'],
      latestReplyStats: { chars: 7, lines: 1 },
    });
    expect(summary.repeatedUnresolvedIds).toEqual([
      {
        id: 145,
        unresolved: 2,
        reasons: [{ reason: 'llm_unknown', count: 2 }],
        verdictParsers: [{ parser: 'en_unknown', count: 2 }],
        evidenceGaps: [
          { gap: 'ambiguous_action_result_unknown', count: 1 },
          { gap: 'judge_unknown_despite_decisive_result', count: 1 },
        ],
        latestEvidenceStats: { chars: 180, lines: 2 },
        latestEvidenceSummary: {
          scanned: 4,
          matched: 2,
          kinds: [{ kind: 'noe_act_executed', count: 1 }, { kind: 'noe_thought', count: 1 }],
          signals: [{ signal: 'ok=true', count: 1 }, { signal: 'status=completed', count: 1 }],
          hasActionEvent: true,
          hasObservationEvent: true,
          hasResultSignal: true,
        },
        latestEvidenceDecision: {
          label: 'action_success_signal',
          confidence: 'high',
          profile: {
            matched: 2,
            actionKinds: 1,
            observationKinds: 1,
            actionResultSignals: 2,
            observationSignals: 0,
            successSignals: 2,
            failureSignals: 0,
            runningSignals: 0,
          },
          nextStep: 'review judge prompt because safe success evidence exists',
        },
        latestEvidenceGaps: ['judge_unknown_despite_decisive_result'],
        latestReplyStats: { chars: 7, lines: 1 },
      },
    ]);
    expect(summary.latestTickWithJudgement).toMatchObject({
      id: 12,
      checked: 3,
      resolved: 0,
      judgedIds: [145, 148, 149],
      reasons: ['llm_unknown', 'no_evidence', 'llm_applied'],
      verdictParsers: ['en_unknown', 'zh_applied'],
      evidenceStats: [
        { id: 145, chars: 180, lines: 2 },
        { id: 148, chars: 0, lines: 0 },
        { id: 149, chars: 90, lines: 1 },
      ],
      evidenceSummaries: [
        {
          id: 145,
          scanned: 4,
          matched: 2,
          kinds: [{ kind: 'noe_act_executed', count: 1 }, { kind: 'noe_thought', count: 1 }],
          signals: [{ signal: 'ok=true', count: 1 }, { signal: 'status=completed', count: 1 }],
          hasActionEvent: true,
          hasObservationEvent: true,
          hasResultSignal: true,
        },
        {
          id: 148,
          scanned: 3,
          matched: 0,
          kinds: [],
          signals: [],
          hasActionEvent: false,
          hasObservationEvent: false,
          hasResultSignal: false,
        },
        {
          id: 149,
          scanned: 2,
          matched: 1,
          kinds: [{ kind: 'noe_thought', count: 1 }],
          signals: [{ signal: 'completed=true', count: 1 }],
          hasActionEvent: false,
          hasObservationEvent: true,
          hasResultSignal: true,
        },
      ],
      evidenceGaps: [
        { id: 145, gaps: ['judge_unknown_despite_decisive_result'] },
        { id: 148, gaps: ['no_evidence', 'no_matched_evidence', 'no_action_event', 'no_result_signal'] },
      ],
      evidenceGapCounts: [
        { gap: 'judge_unknown_despite_decisive_result', count: 1 },
        { gap: 'no_action_event', count: 1 },
        { gap: 'no_evidence', count: 1 },
        { gap: 'no_matched_evidence', count: 1 },
        { gap: 'no_result_signal', count: 1 },
      ],
      replyStats: [
        { id: 145, chars: 7, lines: 1 },
        { id: 148, chars: 0, lines: 0 },
        { id: 149, chars: 12, lines: 1 },
      ],
    });
    expect(summary.latestTickWithJudgement.recommendedActions).toEqual([
      {
        action: 'improve_evidence_retrieval',
        priority: 2,
        nextStep: 'expand or retune event matching so due expectations receive relevant post-creation evidence',
        gapCount: 2,
        gaps: ['no_evidence', 'no_matched_evidence'],
      },
      {
        action: 'record_action_event_evidence',
        priority: 3,
        nextStep: 'ensure relevant acts/checkpoints emit safe action events that expectation evidence can match',
        gapCount: 1,
        gaps: ['no_action_event'],
      },
      {
        action: 'record_result_signal_evidence',
        priority: 3,
        nextStep: 'ensure matched events include safe status/result/completed/failed signals',
        gapCount: 1,
        gaps: ['no_result_signal'],
      },
      {
        action: 'review_judge_conservatism',
        priority: 4,
        nextStep: 'inspect prompt and safe metadata shape only after safe decisive result signals are present',
        gapCount: 1,
        gaps: ['judge_unknown_despite_decisive_result'],
      },
    ]);
    expect(summary.actionFocus).toMatchObject({
      basis: 'latest_tick_actionable_gaps',
      tickId: 12,
      evidenceSummaryCount: 3,
    });
    expect(summary.actionFocus.recommendedActions[0].action).toBe('improve_evidence_retrieval');
    expect(JSON.stringify(summary)).not.toContain('secret claim');
    expect(JSON.stringify(summary)).not.toContain('repeated secret claim');
    expect(JSON.stringify(summary)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(summary)).not.toContain('<script>');
  });

  it('focuses on latest actionable gaps when stale missing summaries dominate global counts', () => {
    const ticks = [
      {
        id: 20,
        finished_at: T0 + 20_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 201,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1200, lines: 6 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'activity', count: 4 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                replyStats: { chars: 7, lines: 1 },
              },
            ],
          },
        }),
      },
      {
        id: 19,
        finished_at: T0 + 10_000,
        outcome: JSON.stringify({
          checked: 4,
          resolved: 0,
          judged: Array.from({ length: 4 }, (_, i) => ({
            id: 100 + i,
            outcome: null,
            reason: 'llm_unknown',
            evidenceStats: { chars: 500, lines: 4 },
          })),
        }),
      },
    ];
    const summary = summarizeRecentExpectationTickJudgements([...ticks].reverse());
    expect(summary.evidenceGapCounts[0]).toEqual({ gap: 'missing_evidence_summary', count: 4 });
    expect(summary.recommendedActions[0].action).toBe('wait_for_post_summary_judgement');
    expect(summary.actionFocus).toEqual({
      basis: 'latest_tick_actionable_gaps',
      tickId: 20,
      evidenceSummaryCount: 1,
      gapCounts: [{ gap: 'judge_unknown_despite_decisive_result', count: 1 }],
      recommendedActions: [
        {
          action: 'review_judge_conservatism',
          priority: 4,
          nextStep: 'inspect prompt and safe metadata shape only after safe decisive result signals are present',
          gapCount: 1,
          gaps: ['judge_unknown_despite_decisive_result'],
        },
      ],
    });
  });

  it('treats observation evidence with episode signals as actionable calibration evidence', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 30,
        finished_at: T0 + 30_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 301,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 900, lines: 5 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'noe_episode', count: 8 }],
                  signals: [
                    { signal: 'episodeType=inner_monologue', count: 8 },
                    { signal: 'guard.action=allow', count: 8 },
                    { signal: 'grounding.score_bucket=high', count: 4 },
                  ],
                  hasActionEvent: false,
                  hasObservationEvent: true,
                  hasResultSignal: true,
                },
                replyStats: { chars: 7, lines: 1 },
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'observation_only_unknown', count: 1 },
    ]);
    expect(summary.evidenceDecision.labelCounts).toEqual([
      { label: 'observation_only_result_signal', count: 1 },
    ]);
    expect(summary.actionFocus).toMatchObject({
      basis: 'latest_tick_actionable_gaps',
      tickId: 30,
      gapCounts: [{ gap: 'observation_only_unknown', count: 1 }],
    });
    expect(JSON.stringify(summary)).not.toContain('inner_monologue text');
  });

  it('normalizes legacy episode evidence summaries before classifying gaps', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 31,
        finished_at: T0 + 31_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 302,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 900, lines: 5 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'noe_episode', count: 8 }],
                  signals: [],
                  hasActionEvent: false,
                  hasObservationEvent: false,
                  hasResultSignal: false,
                },
                replyStats: { chars: 7, lines: 1 },
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'no_result_signal', count: 1 },
    ]);
    expect(summary.judgementIdCounts[0].latestEvidenceSummary).toMatchObject({
      hasActionEvent: false,
      hasObservationEvent: true,
      hasResultSignal: false,
    });
    expect(summary.judgementIdCounts[0].latestEvidenceGaps).toEqual(['no_result_signal']);
  });

  it('refreshes stale signal-less summaries from safe live event metadata', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 32,
        finished_at: T0 + 32_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 303,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 900, lines: 5 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'noe_episode', count: 8 }],
                  signals: [],
                  hasActionEvent: false,
                  hasObservationEvent: false,
                  hasResultSignal: false,
                },
                replyStats: { chars: 7, lines: 1 },
                claim: 'raw claim should not appear',
              },
            ],
          },
        }),
      },
    ], {
      evidenceSummaryRefresh: ({ id }) => id === 303 ? {
        source: 'read_only_live_events',
        changed: true,
        evidenceSummary: {
          scanned: 200,
          matched: 8,
          kinds: [{ kind: 'noe_episode', count: 8 }],
          signals: [
            { signal: 'episodeType=inner_monologue', count: 8 },
            { signal: 'guard.action=allow', count: 8 },
            { signal: 'grounding.score_bucket=medium', count: 8 },
          ],
          hasActionEvent: false,
          hasObservationEvent: true,
          hasResultSignal: true,
        },
      } : null,
    });
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'observation_only_unknown', count: 1 },
    ]);
    expect(summary.evidenceDecision.labelCounts).toEqual([
      { label: 'observation_only_result_signal', count: 1 },
    ]);
    expect(summary.evidenceRefresh).toEqual({ attempted: 1, refreshed: 1, changed: 1 });
    expect(summary.judgementIdCounts[0].latestEvidenceSummary).toMatchObject({
      signals: [
        { signal: 'episodeType=inner_monologue', count: 8 },
        { signal: 'grounding.score_bucket=medium', count: 8 },
        { signal: 'guard.action=allow', count: 8 },
      ],
      hasObservationEvent: true,
      hasResultSignal: true,
    });
    expect(summary.judgementIdCounts[0].latestEvidenceRefresh).toEqual({
      source: 'read_only_live_events',
      changed: true,
    });
    expect(JSON.stringify(summary)).not.toContain('raw claim');
  });

  it('classifies nearby action candidates as unlinked evidence instead of decisive settlement proof', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 33,
        finished_at: T0 + 33_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 304,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1100, lines: 6 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'noe_episode', count: 8 }],
                  signals: [
                    { signal: 'episodeType=inner_monologue', count: 8 },
                    { signal: 'guard.action=allow', count: 8 },
                    { signal: 'grounding.score_bucket=medium', count: 8 },
                  ],
                  hasActionEvent: false,
                  hasObservationEvent: true,
                  hasResultSignal: true,
                },
                evidenceCandidateSummary: {
                  scanned: 200,
                  candidates: 3,
                  windowMs: 900000,
                  kinds: [{ kind: 'activity', count: 3 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }, { signal: 'status=running', count: 1 }],
                  nearestDeltaMs: { min: 2000, max: 120000, avg: 41000 },
                },
                replyStats: { chars: 7, lines: 1 },
                claim: 'raw claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'candidate_result_unlinked_unknown', count: 1 },
    ]);
    expect(summary.recommendedActions[0]).toMatchObject({
      action: 'link_candidate_result_evidence',
      gaps: ['candidate_result_unlinked_unknown'],
    });
    expect(summary.evidenceCandidateSummary).toEqual({
      withCandidateSummary: 1,
      totalCandidates: 3,
      kindCounts: [{ kind: 'activity', count: 3 }],
      signalCounts: [{ signal: 'status=succeeded', count: 2 }, { signal: 'status=running', count: 1 }],
    });
    expect(summary.judgementIdCounts[0].latestEvidenceCandidateSummary).toMatchObject({
      candidates: 3,
      kinds: [{ kind: 'activity', count: 3 }],
    });
    expect(JSON.stringify(summary)).not.toContain('raw claim');
  });

  it('classifies semantically linked nearby candidates without counting them as settled', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 34,
        finished_at: T0 + 34_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 305,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1200, lines: 7 },
                evidenceSummary: {
                  scanned: 200,
                  matched: 8,
                  kinds: [{ kind: 'noe_episode', count: 8 }],
                  signals: [
                    { signal: 'episodeType=inner_monologue', count: 8 },
                    { signal: 'guard.action=allow', count: 8 },
                    { signal: 'grounding.score_bucket=medium', count: 8 },
                  ],
                  hasActionEvent: false,
                  hasObservationEvent: true,
                  hasResultSignal: true,
                },
                evidenceCandidateSummary: {
                  scanned: 200,
                  candidates: 4,
                  windowMs: 900000,
                  kinds: [{ kind: 'activity', count: 4 }],
                  signals: [{ signal: 'status=succeeded', count: 3 }, { signal: 'status=running', count: 1 }],
                  linkStats: {
                    method: 'claim_bigram_overlap_v1',
                    claimGrams: 9,
                    scoredCandidates: 4,
                    linkedCandidates: 1,
                    weakCandidates: 1,
                    unlinkedCandidates: 2,
                    maxHits: 4,
                    maxCoverage: 0.4444,
                  },
                  nearestDeltaMs: { min: 1000, max: 90000, avg: 24000 },
                },
                replyStats: { chars: 7, lines: 1 },
                claim: 'raw linked claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.resolvedFromResults).toBe(0);
    expect(summary.evidenceGapCounts).toEqual([
      { gap: 'candidate_result_linked_unknown', count: 1 },
    ]);
    expect(summary.recommendedActions[0]).toMatchObject({
      action: 'promote_linked_candidate_evidence',
      gaps: ['candidate_result_linked_unknown'],
    });
    expect(summary.evidenceCandidateSummary).toMatchObject({
      withCandidateSummary: 1,
      totalCandidates: 4,
      kindCounts: [{ kind: 'activity', count: 4 }],
      signalCounts: [{ signal: 'status=succeeded', count: 3 }, { signal: 'status=running', count: 1 }],
      linkStats: {
        withLinkStats: 1,
        linkedCandidates: 1,
        weakCandidates: 1,
        unlinkedCandidates: 2,
        maxHits: 4,
        maxCoverage: 0.444,
      },
    });
    expect(summary.judgementIdCounts[0].latestEvidenceCandidateSummary.linkStats).toMatchObject({
      linkedCandidates: 1,
      maxCoverage: 0.444,
    });
    expect(JSON.stringify(summary)).not.toContain('raw linked claim');
  });

  it('summarizes persisted safe decision hints without exposing raw text', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 35,
        finished_at: T0 + 35_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 306,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1000, lines: 6 },
                evidenceSummary: {
                  scanned: 10,
                  matched: 2,
                  kinds: [{ kind: 'activity', count: 2 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }, { signal: 'ok=true', count: 1 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  confidence: 'high',
                  suggestedVerdict: 'APPLIED',
                  caution: 'only_if_claim_matches_direct_action_evidence',
                  profile: {
                    matched: 2,
                    actionKinds: 2,
                    observationKinds: 0,
                    actionResultSignals: 3,
                    observationSignals: 0,
                    successSignals: 3,
                    failureSignals: 0,
                    runningSignals: 0,
                    linkedCandidates: 0,
                    weakCandidates: 0,
                    claimGrams: 20,
                    actionEvents: 2,
                    resultActionEvents: 2,
                    semanticLinkedActionEvents: 2,
                    semanticActionMaxCoverage: 0.15,
                  },
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'claim_mismatch<script>',
                hintAgreement: 'override',
                claim: 'raw decisive claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceDecisionHint).toEqual({
      withHint: 1,
      labelCounts: [{ label: 'action_success_signal', count: 1 }],
      confidenceCounts: [{ confidence: 'high', count: 1 }],
      suggestedVerdictCounts: [{ suggestedVerdict: 'APPLIED', count: 1 }],
    });
    expect(summary.verdictParserCounts).toEqual([{ parser: 'json_unknown', count: 1 }]);
    expect(summary.verdictReasonCodeCounts).toEqual([{ reasonCode: 'claim_mismatch_script', count: 1 }]);
    expect(summary.hintAgreementCounts).toEqual([{ hintAgreement: 'override', count: 1 }]);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'judge_reports_claim_mismatch', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'repair_claim_evidence_matching',
        priority: 3,
        nextStep: 'inspect safe matching metadata because the judge reported claim mismatch despite decisive action metadata',
        gapCount: 1,
        gaps: ['judge_reports_claim_mismatch'],
      },
    ]);
    expect(summary.latestTickWithJudgement.evidenceDecisionHints[0]).toMatchObject({
      id: 306,
      label: 'action_success_signal',
      suggestedVerdict: 'APPLIED',
      profile: {
        matched: 2,
        successSignals: 3,
        claimGrams: 20,
        actionEvents: 2,
        resultActionEvents: 2,
        semanticLinkedActionEvents: 2,
        semanticActionMaxCoverage: 0.15,
      },
    });
    expect(summary.latestTickWithJudgement.evidenceGapCounts).toEqual([
      { gap: 'judge_reports_claim_mismatch', count: 1 },
    ]);
    expect(summary.latestTickWithJudgement.verdictReasonCodes).toEqual(['claim_mismatch_script']);
    expect(summary.latestTickWithJudgement.hintAgreements).toEqual(['override']);
    expect(summary.latestTickWithJudgement.evidenceDecisionHintCounts).toEqual([
      { label: 'action_success_signal', count: 1 },
    ]);
    expect(summary.judgementIdCounts[0].latestEvidenceDecisionHint).toMatchObject({
      label: 'action_success_signal',
      caution: 'only_if_claim_matches_direct_action_evidence',
    });
    expect(summary.judgementIdCounts[0].verdictReasonCodes).toEqual([
      { reasonCode: 'claim_mismatch_script', count: 1 },
    ]);
    expect(summary.judgementIdCounts[0].hintAgreements).toEqual([
      { hintAgreement: 'override', count: 1 },
    ]);
    expect(summary.judgementIdCounts[0].evidenceGaps).toEqual([
      { gap: 'judge_reports_claim_mismatch', count: 1 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('raw decisive claim');
  });

  it('uses safe claim/action alignment to refine insufficient direct evidence gaps', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 36,
        finished_at: T0 + 36_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 307,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1000, lines: 6 },
                evidenceSummary: {
                  scanned: 10,
                  matched: 2,
                  kinds: [{ kind: 'activity', count: 2 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  confidence: 'high',
                  suggestedVerdict: 'APPLIED',
                  caution: 'only_if_claim_matches_direct_action_evidence',
                  profile: { matched: 2, actionKinds: 2, successSignals: 2, failureSignals: 0 },
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 20,
                  matchedEvents: 2,
                  actionEvents: 2,
                  resultActionEvents: 2,
                  linkedActionEvents: 2,
                  weakActionEvents: 0,
                  unlinkedActionEvents: 0,
                  maxHits: 3,
                  maxCoverage: 0.15,
                  actionMaxHits: 3,
                  actionMaxCoverage: 0.15,
                  semanticActionEvents: 2,
                  semanticResultActionEvents: 2,
                  semanticLinkedActionEvents: 2,
                  semanticWeakActionEvents: 0,
                  semanticUnlinkedActionEvents: 0,
                  semanticActionMaxHits: 3,
                  semanticActionMaxCoverage: 0.15,
                  semanticTraceEvents: 2,
                  semanticTraceActionEvents: 2,
                  semanticTraceResultActionEvents: 2,
                  semanticTraceLinkedActionEvents: 1,
                  semanticTraceWeakActionEvents: 1,
                  semanticTraceUnlinkedActionEvents: 0,
                  semanticTraceMaxHits: 2,
                  semanticTraceMaxCoverage: 0.1,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'insufficient_direct_evidence',
                hintAgreement: 'override',
                claim: 'raw weak-alignment claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'claim_action_semantic_trace_coverage_low', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'enrich_semantic_trace_claim_terms',
        priority: 3,
        nextStep: 'include safe expectation and goal terms in completed action semanticTrace so linked results reach the claim threshold',
        gapCount: 1,
        gaps: ['claim_action_semantic_trace_coverage_low'],
      },
    ]);
    expect(summary.evidenceClaimAlignment).toMatchObject({
      withAlignment: 1,
      actionEvents: 2,
      resultActionEvents: 2,
      actionMaxCoverage: 0.15,
      semanticActionEvents: 2,
      semanticResultActionEvents: 2,
      semanticActionMaxCoverage: 0.15,
      semanticTraceEvents: 2,
      semanticTraceActionEvents: 2,
      semanticTraceResultActionEvents: 2,
      semanticTraceLinkedActionEvents: 1,
      semanticTraceMaxCoverage: 0.1,
    });
    expect(summary.latestTickWithJudgement.evidenceClaimAlignment).toMatchObject({
      withAlignment: 1,
      actionMaxCoverage: 0.15,
      semanticActionMaxCoverage: 0.15,
      semanticTraceMaxCoverage: 0.1,
    });
    expect(summary.judgementIdCounts[0].latestEvidenceClaimAlignment).toMatchObject({
      actionEvents: 2,
      actionMaxCoverage: 0.15,
      semanticActionEvents: 2,
      semanticActionMaxCoverage: 0.15,
      semanticTraceActionEvents: 2,
      semanticTraceMaxCoverage: 0.1,
    });
    expect(JSON.stringify(summary)).not.toContain('raw weak-alignment claim');
  });

  it('does not request trace term enrichment when all result trace actions are linked at the tuned floor', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 361,
        finished_at: T0 + 36_100,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 3071,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1000, lines: 6 },
                evidenceSummary: {
                  scanned: 10,
                  matched: 2,
                  kinds: [{ kind: 'activity', count: 2 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  confidence: 'high',
                  suggestedVerdict: 'APPLIED',
                  caution: 'only_if_claim_matches_direct_action_evidence',
                  profile: { matched: 2, actionKinds: 2, successSignals: 2, failureSignals: 0 },
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 35,
                  matchedEvents: 2,
                  actionEvents: 2,
                  resultActionEvents: 2,
                  linkedActionEvents: 2,
                  weakActionEvents: 0,
                  unlinkedActionEvents: 0,
                  maxHits: 7,
                  maxCoverage: 0.2,
                  actionMaxHits: 7,
                  actionMaxCoverage: 0.2,
                  semanticActionEvents: 2,
                  semanticResultActionEvents: 2,
                  semanticLinkedActionEvents: 2,
                  semanticWeakActionEvents: 0,
                  semanticUnlinkedActionEvents: 0,
                  semanticActionMaxHits: 7,
                  semanticActionMaxCoverage: 0.2,
                  semanticTraceEvents: 2,
                  semanticTraceActionEvents: 2,
                  semanticTraceResultActionEvents: 2,
                  semanticTraceLinkedActionEvents: 2,
                  semanticTraceWeakActionEvents: 0,
                  semanticTraceUnlinkedActionEvents: 0,
                  semanticTraceMaxHits: 7,
                  semanticTraceMaxCoverage: 0.2,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'insufficient_direct_evidence',
                hintAgreement: 'override',
                claim: 'raw fully-linked claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'judge_requires_claim_evidence_link', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'audit_claim_action_alignment',
        priority: 3,
        nextStep: 'audit safe claim/action alignment before loosening the judge or counting the direct action hint as settlement',
        gapCount: 1,
        gaps: ['judge_requires_claim_evidence_link'],
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('raw fully-linked claim');
  });

  it('waits for post-hint natural judgement when decisive evidence predates persisted hints', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 362,
        finished_at: T0 + 36_200,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 3072,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1000, lines: 6 },
                evidenceSummary: {
                  scanned: 10,
                  matched: 2,
                  kinds: [{ kind: 'activity', count: 2 }],
                  signals: [{ signal: 'status=succeeded', count: 2 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 35,
                  matchedEvents: 2,
                  actionEvents: 2,
                  resultActionEvents: 2,
                  linkedActionEvents: 2,
                  weakActionEvents: 0,
                  unlinkedActionEvents: 0,
                  maxHits: 7,
                  maxCoverage: 0.2,
                  actionMaxHits: 7,
                  actionMaxCoverage: 0.2,
                  semanticActionEvents: 2,
                  semanticResultActionEvents: 2,
                  semanticLinkedActionEvents: 2,
                  semanticWeakActionEvents: 0,
                  semanticUnlinkedActionEvents: 0,
                  semanticActionMaxHits: 7,
                  semanticActionMaxCoverage: 0.2,
                  semanticTraceEvents: 2,
                  semanticTraceActionEvents: 2,
                  semanticTraceResultActionEvents: 2,
                  semanticTraceLinkedActionEvents: 2,
                  semanticTraceWeakActionEvents: 0,
                  semanticTraceUnlinkedActionEvents: 0,
                  semanticTraceMaxHits: 7,
                  semanticTraceMaxCoverage: 0.2,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'insufficient_direct_evidence',
                hintAgreement: 'override',
                claim: 'raw no-hint claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceDecisionHint.withHint).toBe(0);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'judge_requires_claim_evidence_link', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'wait_for_post_hint_judgement',
        priority: 1,
        nextStep: 'wait for a natural expectation tick produced after evidenceDecisionHint deployment; historical UNKNOWN rows without hints should not trigger claim/action rewrites',
        gapCount: 1,
        gaps: ['judge_requires_claim_evidence_link'],
      },
    ]);
    expect(summary.actionFocus.recommendedActions[0].action).toBe('wait_for_post_hint_judgement');
    expect(JSON.stringify(summary)).not.toContain('raw no-hint claim');
  });

  it('separates mixed semantic trace linkage from low coverage only gaps', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 37,
        finished_at: T0 + 37_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 308,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1200, lines: 7 },
                evidenceSummary: {
                  scanned: 12,
                  matched: 8,
                  kinds: [{ kind: 'noe_act_semantic_trace', count: 8 }],
                  signals: [{ signal: 'status=completed', count: 8 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecision: { label: 'action_success_signal' },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  confidence: 'high',
                  suggestedVerdict: 'APPLIED',
                  caution: 'only_if_claim_matches_direct_action_evidence',
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 35,
                  matchedEvents: 8,
                  actionEvents: 8,
                  resultActionEvents: 8,
                  linkedActionEvents: 2,
                  weakActionEvents: 0,
                  unlinkedActionEvents: 6,
                  maxHits: 6,
                  maxCoverage: 0.171,
                  actionMaxHits: 6,
                  actionMaxCoverage: 0.171,
                  semanticActionEvents: 8,
                  semanticResultActionEvents: 8,
                  semanticLinkedActionEvents: 2,
                  semanticWeakActionEvents: 0,
                  semanticUnlinkedActionEvents: 6,
                  semanticActionMaxHits: 6,
                  semanticActionMaxCoverage: 0.171,
                  semanticTraceEvents: 8,
                  semanticTraceActionEvents: 8,
                  semanticTraceResultActionEvents: 8,
                  semanticTraceLinkedActionEvents: 2,
                  semanticTraceWeakActionEvents: 0,
                  semanticTraceUnlinkedActionEvents: 6,
                  semanticTraceMaxHits: 6,
                  semanticTraceMaxCoverage: 0.171,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'insufficient_direct_evidence',
                hintAgreement: 'override',
                claim: 'raw mixed-linkage claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'claim_action_semantic_trace_mixed_linkage', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'separate_semantic_trace_claim_routes',
        priority: 3,
        nextStep: 'split unrelated semanticTrace action events from claim-linked evidence before promoting direct evidence',
        gapCount: 1,
        gaps: ['claim_action_semantic_trace_mixed_linkage'],
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('raw mixed-linkage claim');
  });

  it('uses refreshed route-separated trace alignment instead of stale mixed alignment', () => {
    const tick = {
      id: 37,
      finished_at: T0 + 37_000,
      outcome: JSON.stringify({
        previousResult: {
          checked: 1,
          resolved: 0,
          judged: [
            {
              id: 308,
              outcome: null,
              reason: 'llm_unknown',
              evidenceStats: { chars: 1200, lines: 7 },
              evidenceSummary: {
                scanned: 12,
                matched: 8,
                kinds: [{ kind: 'noe_act_semantic_trace', count: 8 }],
                signals: [{ signal: 'status=completed', count: 8 }],
                hasActionEvent: true,
                hasObservationEvent: false,
                hasResultSignal: true,
              },
              evidenceDecision: { label: 'action_success_signal' },
              evidenceClaimAlignment: {
                method: 'claim_bigram_overlap_v2_semantic_fields',
                claimGrams: 35,
                matchedEvents: 8,
                actionEvents: 8,
                resultActionEvents: 8,
                semanticActionEvents: 8,
                semanticResultActionEvents: 8,
                semanticLinkedActionEvents: 2,
                semanticUnlinkedActionEvents: 6,
                semanticTraceActionEvents: 8,
                semanticTraceResultActionEvents: 8,
                semanticTraceLinkedActionEvents: 2,
                semanticTraceUnlinkedActionEvents: 6,
                semanticTraceMaxCoverage: 0.171,
              },
              verdictParser: 'json_unknown',
              verdictReasonCode: 'insufficient_direct_evidence',
              hintAgreement: 'override',
              claim: 'raw refreshed mixed-linkage claim should not appear',
            },
          ],
        },
      }),
    };
    const summary = summarizeRecentExpectationTickJudgements([tick], {
      evidenceSummaryRefresh: ({ id }) => id === 308 ? {
        source: 'read_only_live_events',
        changed: true,
        evidenceSummary: {
          scanned: 12,
          matched: 2,
          kinds: [{ kind: 'noe_act_semantic_trace', count: 2 }],
          signals: [{ signal: 'status=completed', count: 2 }],
          hasActionEvent: true,
          hasObservationEvent: false,
          hasResultSignal: true,
        },
        evidenceClaimAlignment: {
          method: 'claim_bigram_overlap_v2_semantic_fields',
          claimGrams: 35,
          matchedEvents: 2,
          actionEvents: 2,
          resultActionEvents: 2,
          semanticActionEvents: 2,
          semanticResultActionEvents: 2,
          semanticLinkedActionEvents: 2,
          semanticUnlinkedActionEvents: 0,
          semanticActionMaxCoverage: 0.171,
          semanticTraceActionEvents: 2,
          semanticTraceResultActionEvents: 2,
          semanticTraceLinkedActionEvents: 2,
          semanticTraceUnlinkedActionEvents: 0,
          semanticTraceMaxCoverage: 0.171,
        },
      } : null,
    });
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'claim_action_semantic_trace_coverage_low', count: 1 }]);
    expect(summary.evidenceRefresh).toEqual({ attempted: 1, refreshed: 1, changed: 1 });
    expect(summary.judgementIdCounts[0].latestEvidenceSummary.matched).toBe(2);
    expect(summary.judgementIdCounts[0].latestEvidenceClaimAlignment).toMatchObject({
      semanticTraceLinkedActionEvents: 2,
      semanticTraceUnlinkedActionEvents: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('raw refreshed mixed-linkage claim');
  });

  it('reconstructs report-only hint profiles for compact persisted hints', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 39,
        finished_at: T0 + 39_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 310,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1200, lines: 6 },
                evidenceSummary: {
                  scanned: 12,
                  matched: 2,
                  kinds: [{ kind: 'noe_act_semantic_trace', count: 2 }],
                  signals: [
                    { signal: 'status=completed', count: 2 },
                    { signal: 'ok=true', count: 2 },
                  ],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  suggestedVerdict: 'APPLIED',
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 20,
                  matchedEvents: 2,
                  actionEvents: 2,
                  resultActionEvents: 2,
                  semanticActionEvents: 2,
                  semanticResultActionEvents: 2,
                  semanticLinkedActionEvents: 2,
                  semanticActionMaxCoverage: 0.25,
                  semanticTraceActionEvents: 2,
                  semanticTraceResultActionEvents: 2,
                  semanticTraceLinkedActionEvents: 2,
                  semanticTraceMaxCoverage: 0.25,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'insufficient_direct_evidence',
                hintAgreement: 'override',
                claim: 'raw compact hint claim should not appear',
              },
            ],
          },
        }),
      },
    ]);

    expect(summary.latestTickWithJudgement.evidenceDecisionHints[0]).toMatchObject({
      id: 310,
      label: 'action_success_signal',
      suggestedVerdict: 'APPLIED',
      confidence: 'high',
      profileSource: 'reconstructed_from_safe_metadata',
      profile: {
        matched: 2,
        actionKinds: 2,
        successSignals: 4,
        actionEvents: 2,
        resultActionEvents: 2,
        semanticLinkedActionEvents: 2,
        semanticTraceLinkedActionEvents: 2,
        semanticTraceMaxCoverage: 0.25,
      },
    });
    expect(summary.judgementIdCounts[0].latestEvidenceDecisionHint.profileSource).toBe('reconstructed_from_safe_metadata');
    expect(JSON.stringify(summary)).not.toContain('raw compact hint claim');
  });

  it('distinguishes judge claim mismatch when successful trace evidence is present', () => {
    const summary = summarizeRecentExpectationTickJudgements([
      {
        id: 38,
        finished_at: T0 + 38_000,
        outcome: JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [
              {
                id: 309,
                outcome: null,
                reason: 'llm_unknown',
                evidenceStats: { chars: 1100, lines: 6 },
                evidenceSummary: {
                  scanned: 10,
                  matched: 2,
                  kinds: [{ kind: 'noe_act_semantic_trace', count: 2 }],
                  signals: [{ signal: 'status=completed', count: 2 }],
                  hasActionEvent: true,
                  hasObservationEvent: false,
                  hasResultSignal: true,
                },
                evidenceDecision: { label: 'action_success_signal' },
                evidenceDecisionHint: {
                  label: 'action_success_signal',
                  confidence: 'high',
                  suggestedVerdict: 'APPLIED',
                  caution: 'only_if_claim_matches_direct_action_evidence',
                },
                evidenceClaimAlignment: {
                  method: 'claim_bigram_overlap_v2_semantic_fields',
                  claimGrams: 20,
                  matchedEvents: 2,
                  actionEvents: 2,
                  resultActionEvents: 2,
                  linkedActionEvents: 2,
                  weakActionEvents: 0,
                  unlinkedActionEvents: 0,
                  maxHits: 5,
                  maxCoverage: 0.25,
                  actionMaxHits: 5,
                  actionMaxCoverage: 0.25,
                  semanticActionEvents: 2,
                  semanticResultActionEvents: 2,
                  semanticLinkedActionEvents: 2,
                  semanticWeakActionEvents: 0,
                  semanticUnlinkedActionEvents: 0,
                  semanticActionMaxHits: 5,
                  semanticActionMaxCoverage: 0.25,
                  semanticTraceEvents: 2,
                  semanticTraceActionEvents: 2,
                  semanticTraceResultActionEvents: 2,
                  semanticTraceLinkedActionEvents: 2,
                  semanticTraceWeakActionEvents: 0,
                  semanticTraceUnlinkedActionEvents: 0,
                  semanticTraceMaxHits: 5,
                  semanticTraceMaxCoverage: 0.25,
                },
                verdictParser: 'json_unknown',
                verdictReasonCode: 'claim_mismatch',
                hintAgreement: 'override',
                claim: 'raw trace-success mismatch claim should not appear',
              },
            ],
          },
        }),
      },
    ]);
    expect(summary.evidenceGapCounts).toEqual([{ gap: 'judge_reports_claim_mismatch_with_trace_success', count: 1 }]);
    expect(summary.recommendedActions).toEqual([
      {
        action: 'repair_trace_claim_evidence_matching',
        priority: 3,
        nextStep: 'inspect safe semanticTrace matching metadata because the judge reported claim mismatch despite successful trace evidence',
        gapCount: 1,
        gaps: ['judge_reports_claim_mismatch_with_trace_success'],
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain('raw trace-success mismatch claim');
  });

  it('writes per-day and latest reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-expectation-calibration-'));
    try {
      const snapshot = buildExpectationCalibrationSnapshot({
        now: T0,
        day: '2026-06-12',
        dbPath: join(root, 'panel.db'),
        rows: [],
        controlledDrill: { ok: false },
      });
      const paths = writeExpectationCalibrationSnapshot(snapshot, { outDir: join(root, 'output', 'noe-expectation-calibration') });
      expect(paths.reportPath).toBe(join(root, 'output', 'noe-expectation-calibration', '2026-06-12', 'report.json'));
      expect(paths.latestPath).toBe(join(root, 'output', 'noe-expectation-calibration', 'latest.json'));
      const saved = JSON.parse(readFileSync(paths.reportPath, 'utf8'));
      expect(saved.policy.noClaimTextOutput).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
