import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runObservationStatus,
  summarizeObservationStatus,
} from '../../scripts/noe-observation-status.mjs';

const T0 = Date.parse('2026-06-13T02:24:00.000Z');

function expectation({
  ready = false,
  naturalLiveResolved = 10,
  required = 20,
  dueNowOpen = 0,
  nextOpenDueAtIso = '2026-06-13T04:29:28.708Z',
} = {}) {
  return {
    generatedAt: '2026-06-13T02:24:28.797Z',
    live: {
      liveCalibrationReady: ready,
      naturalLiveCalibrationReady: ready,
      naturalResolvedScored: ready ? required : naturalLiveResolved,
      liveResolvedRequired: required,
      naturalLiveResolvedRemaining: ready ? 0 : Math.max(0, required - naturalLiveResolved),
      resolverActionableNow: dueNowOpen > 0,
      dueNowOpen,
      dueWithin24h: 5,
    },
    postHintJudgementGate: {
      status: ready ? 'ready' : 'waiting_for_post_hint_natural_judgement',
      dueNowOpen,
      nextOpenDueAtIso,
      secondsUntilNextOpenDue: 7528,
      nextStep: ready ? 'calibration ready' : 'wait for a natural expectation tick',
    },
  };
}

function p8({ ready = false } = {}) {
  return {
    ok: true,
    source: { baselineId: 'p8-long-soak-real-20260613T012533' },
    gate: {
      readyForNextStage: ready,
      minObservationDays: 7,
      maxObservationDays: 10,
      observationDays: ready ? 7.1 : 0.07,
      observationStartedAt: '2026-06-13T00:45:39.145Z',
      earliestNextStageAt: '2026-06-20T00:45:39.145Z',
      blockers: ready ? [] : ['observation_window_not_elapsed'],
      warnings: [],
      recommendation: ready
        ? 'review_next_stage_without_skipping_owner_gate'
        : 'continue_observation_do_not_start_p9_or_research_bridge',
    },
    nextAllowedWork: ready
      ? ['P7-J0-lite mission-runtime integration review']
      : ['daily observation snapshot', 'do not start P9-A0/P9-D0/P9-G0/R line from this gate'],
  };
}

function soak({ ready = false } = {}) {
  return {
    generatedAt: '2026-06-13T02:24:39.395Z',
    reportPath: 'output/noe-soak-daily/2026-06-13/report.json',
    latestPath: 'output/noe-soak-daily/latest.json',
    noe100: {
      passed: ready,
      score: ready ? 100 : 92,
      blockers: ready ? [] : ['not_enough_soak_evidence', 'expectation_settlements_below_20'],
    },
    soak: {
      status: ready ? 'passed' : 'pending',
      activeDays: ready ? 7 : 1,
      requiredDays: 7,
      daysRemaining: ready ? 0 : 6,
      blocker: ready ? '' : 'not_enough_soak_evidence',
    },
    expectationCalibration: {
      naturalLiveResolved: ready ? 20 : 10,
      liveCalibrationReady: ready,
    },
    p8ObservationGate: {
      readyForNextStage: ready,
      blockers: ready ? [] : ['observation_window_not_elapsed'],
    },
  };
}

function hermes({ ready = false, observedHours = 7.05 } = {}) {
  return {
    ok: true,
    generatedAt: '2026-06-13T02:30:49.957Z',
    windowHours: 24,
    status: ready ? 'passed' : 'blocked',
    blockers: ready ? [] : [`insufficient_observation_window:${observedHours}/24`],
    observed: {
      recordCount: ready ? 25 : 15,
      firstAt: '2026-06-12T02:30:49.957Z',
      lastAt: '2026-06-13T02:30:49.957Z',
      observedHours: ready ? 24 : observedHours,
    },
    categories: {
      mission_finalization: { count: 10, okCount: 10, failedCount: 0 },
      background_review: { count: 1, okCount: 1, failedCount: 0 },
      skill_curator: { count: 1, okCount: 1, failedCount: 0 },
      memory_provider: { count: 1, okCount: 1, failedCount: 0 },
      candidate_holdout: { count: 2, okCount: 2, failedCount: 0 },
    },
    paths: {
      reportPath: 'output/noe-hermes-background-audit/audit.json',
      latestPath: 'output/noe-hermes-background-audit/latest.json',
    },
  };
}

function okSteps() {
  return [
    { id: 'expectation_calibration', ok: true, status: 0 },
    { id: 'p8_observation_gate', ok: true, status: 0 },
    { id: 'soak_snapshot', ok: true, status: 0 },
    { id: 'hermes_background_audit', ok: true, status: 0 },
  ];
}

describe('noe-observation-status', () => {
  it('waits for the next natural expectation due time before changing logic', () => {
    const report = summarizeObservationStatus({
      expectationReport: expectation(),
      p8Report: p8(),
      soakReport: soak(),
      hermesReport: hermes(),
      steps: okSteps(),
      nowMs: T0,
    });

    expect(report.ok).toBe(true);
    expect(report.policy.doesNotBypassSoak).toBe(true);
    expect(report.policy.doesNotStartP9OrResearch).toBe(true);
    expect(report.decision.status).toBe('wait_for_expectation_due');
    expect(report.decision.nextCheckAt).toBe('2026-06-13T04:29:28.708Z');
    expect(report.decision.blockers).toContain('expectation_calibration_pending');
    expect(report.decision.blockers).toContain('observation_window_not_elapsed');
    expect(report.p8ObservationGate).toMatchObject({
      minObservationDays: 7,
      observationDayIndex: 1,
      daysRemaining: 6.93,
      doNotStartNextStage: true,
    });
    expect(report.p8DailyObservation).toMatchObject({
      status: 'collect_daily_observation_snapshot',
      observationDayIndex: 1,
      minObservationDays: 7,
      daysRemaining: 6.93,
      doNotStartNextStage: true,
      forbiddenWork: ['P9-A0', 'P9-D0', 'P9-G0', 'research/R line'],
      nextAction: 'capture_daily_observation_snapshot_and_rerun_observation_status',
    });
    expect(report.p8DailyObservation.evidenceRefs).toEqual([
      'output/noe-p8-observation-gate/latest.json',
      'output/noe-soak-daily/latest.json',
    ]);
  });

  it('continues P8 observation when expectation calibration is ready but the window has not elapsed', () => {
    const report = summarizeObservationStatus({
      expectationReport: expectation({ ready: true }),
      p8Report: p8(),
      soakReport: soak(),
      hermesReport: hermes(),
      steps: okSteps(),
      nowMs: T0,
    });

    expect(report.decision.status).toBe('continue_p8_observation');
    expect(report.decision.nextAction).toBe('continue_daily_observation_do_not_start_p9_or_research_bridge');
    expect(report.decision.nextCheckAt).toBe('2026-06-20T00:45:39.145Z');
    expect(report.p8DailyObservation.allowedWork).toContain('daily observation snapshot');
    expect(report.p8DailyObservation.completionAllowed).toBe(false);
  });

  it('marks next-stage review ready only when calibration and P8 gate are both ready', () => {
    const report = summarizeObservationStatus({
      expectationReport: expectation({ ready: true }),
      p8Report: p8({ ready: true }),
      soakReport: soak({ ready: true }),
      hermesReport: hermes({ ready: true }),
      steps: okSteps(),
      nowMs: T0,
    });

    expect(report.decision.status).toBe('ready_for_next_stage_review');
    expect(report.decision.readyForNextStageReview).toBe(true);
    expect(report.decision.nextAction).toBe('review_p7j0_lite_next_stage_without_skipping_owner_gate');
    expect(report.p8DailyObservation).toMatchObject({
      status: 'ready_for_next_stage_review',
      completionAllowed: true,
      doNotStartNextStage: false,
      forbiddenWork: [],
    });
  });

  it('does not report ok when the Hermes background audit is unavailable', () => {
    const report = summarizeObservationStatus({
      expectationReport: expectation({ ready: true }),
      p8Report: p8({ ready: true }),
      soakReport: soak({ ready: true }),
      hermesReport: null,
      steps: okSteps(),
      nowMs: T0,
    });

    expect(report.hermesBackgroundAudit.available).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.decision.status).toBe('blocked_by_observation_command');
    expect(report.decision.blockers).toContain('hermes_background_audit_unavailable');
  });

  it('does not exit ok via main when the Hermes audit step failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-observation-status-hermes-'));
    const outputs = {
      expectation_calibration: expectation({ ready: true }),
      p8_observation_gate: p8({ ready: true }),
      soak_snapshot: soak({ ready: true }),
      hermes_background_audit: hermes({ ready: true }),
    };
    try {
      const { report } = runObservationStatus({
        root,
        outDir: join(root, 'output', 'noe-observation-status'),
        nowMs: T0,
        runner: (step) => {
          if (step.id === 'hermes_background_audit') {
            return { status: 1, stdout: '', stderr: 'hermes audit crashed' };
          }
          return { status: 0, stdout: JSON.stringify(outputs[step.id]), stderr: '' };
        },
      });
      expect(report.hermesBackgroundAudit.available).toBe(false);
      expect(report.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps next-stage review blocked when Hermes 24h background audit window is not complete', () => {
    const report = summarizeObservationStatus({
      expectationReport: expectation({ ready: true }),
      p8Report: p8({ ready: true }),
      soakReport: soak({ ready: true }),
      hermesReport: hermes({ ready: false, observedHours: 7.05 }),
      steps: okSteps(),
      nowMs: T0,
    });

    expect(report.decision.status).toBe('continue_hermes_background_observation');
    expect(report.decision.readyForNextStageReview).toBe(false);
    expect(report.decision.blockers).toContain('hermes_background_audit_pending');
    expect(report.hermesBackgroundAudit.remainingHours).toBe(16.95);
    expect(report.decision.nextAction).toBe('continue_background_observation_until_hermes_audit_window_passes');
  });

  it('runs the four source checks in order and writes compact latest output', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-observation-status-'));
    const calls = [];
    const outputs = {
      expectation_calibration: expectation(),
      p8_observation_gate: p8(),
      soak_snapshot: soak(),
      hermes_background_audit: hermes(),
    };
    try {
      const { report, written } = runObservationStatus({
        root,
        outDir: join(root, 'output', 'noe-observation-status'),
        nowMs: T0,
        runner: (step) => {
          calls.push({ id: step.id, args: step.args });
          return { status: 0, stdout: JSON.stringify(outputs[step.id]), stderr: '' };
        },
      });

      expect(calls.map((call) => call.id)).toEqual([
        'expectation_calibration',
        'p8_observation_gate',
        'soak_snapshot',
        'hermes_background_audit',
      ]);
      expect(calls[1].args).toContain('--no-write');
      expect(calls[2].args).toContain('--no-refresh-readiness');
      expect(calls[2].args).toContain('--no-refresh-calibration');
      expect(report.steps[0]).not.toHaveProperty('stdoutJson');
      expect(written?.latestPath).toBe('output/noe-observation-status/latest.json');
      const latest = JSON.parse(readFileSync(join(root, written.latestPath), 'utf8'));
      expect(latest.decision.status).toBe('wait_for_expectation_due');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
