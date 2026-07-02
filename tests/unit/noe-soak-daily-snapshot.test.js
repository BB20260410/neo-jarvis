import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSoakSnapshot, formatSoakDay, writeSoakSnapshot } from '../../scripts/noe-soak-daily-snapshot.mjs';

function readiness({ activeDays = 3, requiredDays = 7, passed = false } = {}) {
  return {
    score: passed ? 100 : 97,
    passed,
    readyFor100: passed,
    passedChecks: passed ? 37 : 36,
    failedChecks: passed ? 0 : 1,
    blockers: passed ? [] : ['not_enough_soak_evidence'],
    source: { generatedAt: '2026-06-12T02:38:01.315Z' },
    dimensions: {
      survival: {
        checks: [
          { id: 'not_enough_soak_evidence', ok: passed, details: { activeDays, requiredDays } },
        ],
      },
      reflection: {
        checks: [
          { id: 'expectation_ledger_has_fuel', ok: true, details: { total: 24, resolved: 24, naturalResolved: 4 } },
          {
            id: 'expectation_settlements_below_20',
            ok: false,
            details: {
              liveResolved: 24,
              naturalLiveResolved: 4,
              controlledLiveResolved: 20,
              controlledResolved: 20,
              controlledMechanismReady: true,
              source: 'natural_live_noe_expectations_below_threshold',
              reason: 'controlled drill proves mechanism only; long-term Noe100 readiness still requires natural live resolved rows',
              brier: { naturalLiveBrier: 0.038125 },
            },
          },
          { id: 'brier_available', ok: true, details: { brier: 0.038125 } },
        ],
      },
    },
  };
}

function calibration({ dueNowOpen = 0, secondsUntilNextOpenDue = 3600 } = {}) {
  return {
    generatedAt: '2026-06-12T03:00:00.000Z',
    live: {
      liveCalibrationReady: false,
      naturalLiveCalibrationReady: false,
      naturalResolvedScored: 10,
      liveResolvedRequired: 20,
      naturalLiveResolvedRemaining: 10,
      liveResolvedRemaining: 10,
      resolverActionableNow: dueNowOpen > 0,
      dueNowOpen,
      dueWithin24h: 5,
      nextOpenDueAt: 1781324968708,
      hoursUntilNextOpenDue: 1,
    },
    postHintJudgementGate: {
      status: 'waiting_for_post_hint_natural_judgement',
      decisiveEvidenceDecisionCount: 21,
      decisiveEvidenceHintCount: 0,
      dueNowOpen,
      nextOpenDueAt: 1781324968708,
      nextOpenDueAtIso: '2026-06-13T04:29:28.708Z',
      secondsUntilNextOpenDue,
      source: 'recent_expectation_ticks_safe_metadata',
      nextStep: 'wait for a natural expectation tick produced after evidenceDecisionHint deployment',
    },
    recentAutoJudgements: {
      actionFocus: {
        basis: 'global_recent_gap_counts',
        tickId: null,
        evidenceSummaryCount: 0,
        gapCounts: [
          { gap: 'judge_requires_claim_evidence_link', count: 9 },
          { gap: 'claim_action_semantic_alignment_weak', count: 3 },
        ],
        recommendedActions: [
          {
            action: 'wait_for_post_hint_judgement',
            priority: 1,
            gapCount: 9,
            gaps: ['judge_requires_claim_evidence_link'],
            nextStep: 'wait for a natural expectation tick before changing judge logic',
          },
        ],
      },
    },
  };
}

describe('noe-soak-daily-snapshot', () => {
  it('keeps Noe100 pending while activeDays is below the soak threshold', () => {
    const snapshot = buildSoakSnapshot({
      now: Date.parse('2026-06-12T02:00:00Z'),
      timeZone: 'Asia/Shanghai',
      readinessReport: readiness({ activeDays: 3, requiredDays: 7 }),
      readinessReportPath: 'output/noe-100-readiness/noe-100-readiness-1.json',
      expectationCalibrationReport: calibration(),
      expectationCalibrationReportPath: 'output/noe-expectation-calibration/2026-06-12/report.json',
      liveHealth: { ok: true, status: 200, json: { ok: true, port: 51835 } },
      liveReadiness: { ok: true, status: 200, json: { status: 'passed', counts: { total: 9 } } },
      existingSnapshotDays: ['2026-06-11'],
    });
    expect(snapshot.noe100.passed).toBe(false);
    expect(snapshot.soak.status).toBe('pending');
    expect(snapshot.soak.blocker).toBe('not_enough_soak_evidence');
    expect(snapshot.soak.activeDays).toBe(3);
    expect(snapshot.soak.daysRemaining).toBe(4);
    expect(snapshot.soak.snapshotDays).toEqual(['2026-06-11', '2026-06-12']);
    expect(snapshot.policy.doesNotBypassSoak).toBe(true);
    expect(snapshot.p8ObservationGate.available).toBe(false);
    expect(snapshot.p8ObservationGate.readyForNextStage).toBe(false);
    expect(snapshot.p8ObservationGate.blockers).toEqual(['p8_observation_gate_unavailable']);
    expect(snapshot.expectations.liveResolved).toBe(24);
    expect(snapshot.expectations.naturalLiveResolved).toBe(4);
    expect(snapshot.expectations.controlledLiveResolved).toBe(20);
    expect(snapshot.expectations.controlledMechanismReady).toBe(true);
    expect(snapshot.expectations.longTermReady).toBe(false);
    expect(snapshot.expectations.settlementSource).toBe('natural_live_noe_expectations_below_threshold');
    expect(snapshot.expectationCalibration.available).toBe(true);
    expect(snapshot.expectationCalibration.naturalLiveResolved).toBe(10);
    expect(snapshot.expectationCalibration.goalModeNextStep).toEqual({
      action: 'waiting_for_post_hint_natural_judgement',
      reason: 'no_due_expectations_open',
      waitSeconds: 3600,
    });
    expect(snapshot.expectationCalibration.actionFocus.recommendedActions[0].action).toBe('wait_for_post_hint_judgement');
  });

  it('marks the soak gate passed only when the readiness report is passed and activeDays reaches the threshold', () => {
    const snapshot = buildSoakSnapshot({
      now: Date.parse('2026-06-18T02:00:00Z'),
      timeZone: 'Asia/Shanghai',
      readinessReport: readiness({ activeDays: 7, requiredDays: 7, passed: true }),
      liveHealth: { ok: true, status: 200, json: { ok: true } },
      liveReadiness: { ok: true, status: 200, json: { status: 'passed' } },
    });
    expect(snapshot.soak.status).toBe('passed');
    expect(snapshot.soak.blocker).toBe('');
    expect(snapshot.soak.daysRemaining).toBe(0);
    expect(snapshot.noe100.readyFor100).toBe(true);
  });

  it('keeps goal mode honest when the calibration report is unavailable', () => {
    const snapshot = buildSoakSnapshot({
      now: Date.parse('2026-06-12T02:00:00Z'),
      timeZone: 'Asia/Shanghai',
      readinessReport: readiness(),
    });
    expect(snapshot.expectationCalibration.available).toBe(false);
    expect(snapshot.expectationCalibration.goalModeNextStep).toEqual({
      action: 'refresh_expectation_calibration',
      reason: 'calibration_report_missing',
      waitSeconds: null,
    });
  });

  it('routes goal mode to observation when due expectations are open', () => {
    const snapshot = buildSoakSnapshot({
      now: Date.parse('2026-06-12T02:00:00Z'),
      timeZone: 'Asia/Shanghai',
      readinessReport: readiness(),
      expectationCalibrationReport: calibration({ dueNowOpen: 2 }),
    });
    expect(snapshot.expectationCalibration.resolverActionableNow).toBe(true);
    expect(snapshot.expectationCalibration.goalModeNextStep).toEqual({
      action: 'observe_next_natural_judgement',
      reason: 'due_expectations_open',
      waitSeconds: 0,
    });
  });

  it('carries the P8 observation gate into the daily soak snapshot', () => {
    const snapshot = buildSoakSnapshot({
      now: Date.parse('2026-06-13T02:00:00Z'),
      timeZone: 'Asia/Shanghai',
      readinessReport: readiness(),
      p8ObservationGateReport: {
        ok: true,
        source: { baselineId: 'p8-long-soak-real-20260613T012533' },
        gate: {
          readyForNextStage: false,
          observationDays: 0.02,
          observationStartedAt: '2026-06-13T00:45:39.145Z',
          earliestNextStageAt: '2026-06-20T00:45:39.145Z',
          blockers: ['observation_window_not_elapsed'],
          warnings: ['baseline_recovered_from_runner_interruptions'],
          recommendation: 'continue_observation_do_not_start_p9_or_research_bridge',
        },
        nextAllowedWork: ['daily observation snapshot', 'do not start P9-A0/P9-D0/P9-G0/R line from this gate'],
      },
    });

    expect(snapshot.p8ObservationGate).toMatchObject({
      available: true,
      ok: true,
      readyForNextStage: false,
      baselineId: 'p8-long-soak-real-20260613T012533',
      observationDays: 0.02,
      earliestNextStageAt: '2026-06-20T00:45:39.145Z',
      blockers: ['observation_window_not_elapsed'],
      recommendation: 'continue_observation_do_not_start_p9_or_research_bridge',
    });
    expect(snapshot.p8ObservationGate.nextAllowedWork).toContain('daily observation snapshot');
  });

  it('writes a per-day report and latest snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-soak-snapshot-'));
    try {
      const snapshot = buildSoakSnapshot({
        now: Date.parse('2026-06-12T02:00:00Z'),
        timeZone: 'Asia/Shanghai',
        readinessReport: readiness(),
      });
      const paths = writeSoakSnapshot(snapshot, { root, outDir: join(root, 'output', 'noe-soak-daily') });
      expect(paths.reportPath).toBe('output/noe-soak-daily/2026-06-12/report.json');
      expect(paths.latestPath).toBe('output/noe-soak-daily/latest.json');
      const saved = JSON.parse(readFileSync(join(root, paths.reportPath), 'utf8'));
      const latest = JSON.parse(readFileSync(join(root, paths.latestPath), 'utf8'));
      expect(saved.soak.status).toBe('pending');
      expect(latest.day).toBe(formatSoakDay(Date.parse('2026-06-12T02:00:00Z'), 'Asia/Shanghai'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
