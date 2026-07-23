import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContinuousAutonomySnapshot,
  EXPECTED_CADENCE_MS,
  writeContinuousAutonomySnapshot,
} from '../../scripts/noe-continuous-autonomy-snapshot.mjs';

const T0 = 1_780_000_000_000;

function packageScripts() {
  return {
    'verify:noe:continuous-autonomy': 'node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-continuous-autonomy-snapshot.mjs',
    'test:p0:unit': 'vitest run tests/unit/noe-continuous-autonomy-snapshot.test.js',
  };
}

function liveOk() {
  return {
    health: { ok: true, status: 200, json: { ok: true, port: 51835 } },
    readiness: { ok: true, status: 200, json: { status: 'passed', counts: { total: 9 } } },
  };
}

function dbEvidence(overrides = {}) {
  const cursors = Object.entries(EXPECTED_CADENCE_MS).map(([kind, cadenceMs]) => ({
    kind,
    cadence_ms: cadenceMs,
    next_due: T0 + cadenceMs,
    updated_at: T0 - 1000,
  }));
  const recentTicks = [
    { id: 101, kind: 'proactive', status: 'done', due_at: T0 - 3000, started_at: T0 - 3000, finished_at: T0 - 2900 },
    { id: 100, kind: 'meso', status: 'done', due_at: T0 - 5000, started_at: T0 - 5000, finished_at: T0 - 4900 },
    { id: 99, kind: 'micro', status: 'done', due_at: T0 - 6000, started_at: T0 - 6000, finished_at: T0 - 5900 },
  ];
  return {
    tickWindowMs: 600_000,
    cursors,
    tickCounts: [
      { kind: 'meso', status: 'done', n: 1 },
      { kind: 'micro', status: 'done', n: 1 },
      { kind: 'proactive', status: 'done', n: 1 },
    ],
    recentTicks,
    selfLearning: {
      total: 2,
      activeCount: 1,
      doneCount: 1,
      latest: {
        id: 'learn-2',
        created_at: T0 - 2000,
        source: 'self_learning',
        title: '自主学习：让 Noe 主动寻找证据',
        status: 'active',
        updated_at: T0 - 1000,
        plan: JSON.stringify([{ step: 'search', status: 'done' }, { step: 'act', status: 'open' }]),
      },
      latestDone: {
        id: 'learn-1',
        created_at: T0 - 10_000,
        source: 'self_learning',
        title: '自主学习：上一轮完成',
        status: 'done',
        updated_at: T0 - 8000,
        plan: JSON.stringify([{ step: 'search', status: 'done' }]),
      },
      recent: [],
    },
    ...overrides,
  };
}

function observationReport(overrides = {}) {
  return {
    generatedAt: new Date(T0).toISOString(),
    decision: {
      status: 'wait_for_expectation_due',
      nextAction: 'wait_until_next_expectation_due_then_rerun_observation_status',
      nextCheckAt: new Date(T0 + 60_000).toISOString(),
      readyForNextStageReview: false,
      blockers: ['expectation_calibration_pending'],
    },
    expectationCalibration: {
      naturalLiveResolved: 10,
      required: 20,
      remaining: 10,
      dueNowOpen: 0,
      dueWithin24h: 5,
    },
    soakSnapshot: {
      soak: { activeDays: 4, requiredDays: 7, daysRemaining: 3 },
    },
    hermesBackgroundAudit: {
      status: 'blocked',
      observedHours: 8.45,
      remainingHours: 15.55,
    },
    ...overrides,
  };
}

describe('noe-continuous-autonomy-snapshot', () => {
  it('passes when live readiness, fast heartbeat cursors, recent ticks, and self_learning evidence are present', () => {
    const live = liveOk();
    const snapshot = buildContinuousAutonomySnapshot({
      now: T0,
      packageScripts: packageScripts(),
      liveHealth: live.health,
      liveReadiness: live.readiness,
      dbEvidence: dbEvidence(),
      observationReport: observationReport(),
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.policy.noModelCalls).toBe(true);
    expect(snapshot.policy.noDbWrites).toBe(true);
    expect(snapshot.heartbeat.checks.every((check) => check.ok)).toBe(true);
    expect(snapshot.ticks.requiredWindowDoneKindsSatisfied).toBe(true);
    expect(snapshot.selfLearning.continuousReady).toBe(true);
    expect(snapshot.observationStatus).toMatchObject({
      available: true,
      status: 'wait_for_expectation_due',
      nextCheckDue: false,
      blockerCount: 1,
      naturalExpectation: { resolved: 10, required: 20, remaining: 10 },
    });
  });

  it('surfaces due observation status without treating the autonomy loop itself as failed', () => {
    const live = liveOk();
    const snapshot = buildContinuousAutonomySnapshot({
      now: T0 + 120_000,
      packageScripts: packageScripts(),
      liveHealth: live.health,
      liveReadiness: live.readiness,
      dbEvidence: dbEvidence(),
      observationReport: observationReport(),
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.observationStatus).toMatchObject({
      available: true,
      nextCheckDue: true,
      staleForNextCheck: true,
      action: 'rerun npm run verify:noe:observation-status',
    });
  });

  it('blocks when a required cursor is slower than the continuous autonomy threshold', () => {
    const live = liveOk();
    const evidence = dbEvidence({
      cursors: Object.entries(EXPECTED_CADENCE_MS).map(([kind, cadenceMs]) => ({
        kind,
        cadence_ms: kind === 'proactive' ? cadenceMs + 45_000 : cadenceMs,
        next_due: T0 + cadenceMs,
        updated_at: T0 - 1000,
      })),
    });
    const snapshot = buildContinuousAutonomySnapshot({
      now: T0,
      packageScripts: packageScripts(),
      liveHealth: live.health,
      liveReadiness: live.readiness,
      dbEvidence: evidence,
      observationReport: observationReport(),
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.blockers).toContain('cadence_proactive_too_slow_or_missing');
    expect(snapshot.heartbeat.checks.find((check) => check.kind === 'proactive').ok).toBe(false);
  });

  it('does not count missing p0 registration as verified', () => {
    const live = liveOk();
    const snapshot = buildContinuousAutonomySnapshot({
      now: T0,
      packageScripts: {},
      liveHealth: live.health,
      liveReadiness: live.readiness,
      dbEvidence: dbEvidence(),
      observationReport: observationReport(),
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.blockers).toContain('continuous_autonomy_validation_not_registered');
    expect(snapshot.registration.packageScript).toBe('missing');
  });

  it('does not count stale tick rows as continuous when the ten minute window has a missing required done kind', () => {
    const live = liveOk();
    const evidence = dbEvidence({
      tickCounts: [
        { kind: 'meso', status: 'done', n: 1 },
        { kind: 'proactive', status: 'done', n: 1 },
      ],
    });
    const snapshot = buildContinuousAutonomySnapshot({
      now: T0,
      packageScripts: packageScripts(),
      liveHealth: live.health,
      liveReadiness: live.readiness,
      dbEvidence: evidence,
      observationReport: observationReport(),
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.blockers).toContain('no_recent_done_tick_micro');
    expect(snapshot.ticks.requiredWindowDoneKindsSatisfied).toBe(false);
  });

  it('writes a timestamped report and latest snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-continuous-autonomy-'));
    try {
      const live = liveOk();
      const snapshot = buildContinuousAutonomySnapshot({
        now: T0,
        packageScripts: packageScripts(),
        liveHealth: live.health,
        liveReadiness: live.readiness,
        dbEvidence: dbEvidence(),
        observationReport: observationReport(),
      });
      const paths = writeContinuousAutonomySnapshot(snapshot, {
        root,
        outDir: join(root, 'output', 'noe-continuous-autonomy'),
      });
      expect(paths.reportPath).toMatch(/^output\/noe-continuous-autonomy\/continuous-autonomy-/);
      expect(paths.latestPath).toBe('output/noe-continuous-autonomy/latest.json');
      const latest = JSON.parse(readFileSync(join(root, paths.latestPath), 'utf8'));
      expect(latest.ok).toBe(true);
      expect(latest.policy.readOnly).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
