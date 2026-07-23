import { describe, expect, it } from 'vitest';
import {
  buildNoeObservationStatusReportback,
  syncNoeObservationStatusReportback,
} from '../../src/runtime/NoeObservationStatusReportback.js';

function report(overrides = {}) {
  const ready = overrides.readyForNextStageReview === true || overrides.status === 'ready_for_next_stage_review';
  return {
    ok: true,
    generatedAt: '2026-06-13T03:00:00.000Z',
    decision: {
      status: 'wait_for_expectation_due',
      nextAction: 'wait_until_next_expectation_due_then_rerun_observation_status',
      nextCheckAt: '2026-06-13T04:29:28.708Z',
      readyForNextStageReview: false,
      blockers: ['expectation_calibration_pending', 'token=secret-value-that-must-not-leak'],
      ...overrides,
    },
    p8DailyObservation: {
      available: true,
      status: ready ? 'ready_for_next_stage_review' : 'collect_daily_observation_snapshot',
      observationDayIndex: ready ? 8 : 1,
      minObservationDays: 7,
      daysRemaining: ready ? 0 : 6.93,
      doNotStartNextStage: !ready,
    },
  };
}

function fakeQueue() {
  const items = [];
  return {
    items,
    add(item) {
      const next = { id: `item-${items.length + 1}`, ...item };
      items.push(next);
      return next;
    },
  };
}

function fakeState() {
  let value = null;
  return {
    get() { return value; },
    set(_key, next) { value = next; },
    value() { return value; },
  };
}

describe('NoeObservationStatusReportback', () => {
  it('builds a speakable blocked reportback without leaking secrets', () => {
    const built = buildNoeObservationStatusReportback(report());

    expect(built.item).toMatchObject({
      taskId: 'noe-observation-status',
      status: 'blocked',
      kind: 'observation_status',
      source: 'observation_status',
      speak: true,
      evidenceRefs: ['output/noe-observation-status/latest.json'],
    });
    expect(built.item.summary).toContain('长期观察门仍在等待');
    expect(built.item.summary).toContain('P8观察：第1天/7天');
    expect(built.item.summary).toContain('禁止启动P9/R');
    expect(built.item.summary).toContain('token=[redacted]');
    expect(built.item.summary).not.toContain('secret-value-that-must-not-leak');
    expect(built.signature).toContain('wait_for_expectation_due');
    expect(built.signature).toContain('p8day:1');
    expect(built.state.p8DailyObservation).toMatchObject({
      observationDayIndex: 1,
      minObservationDays: 7,
      daysRemaining: 6.93,
      doNotStartNextStage: true,
    });
  });

  it('adds one queue item per status signature', () => {
    const queue = fakeQueue();
    const state = fakeState();

    const first = syncNoeObservationStatusReportback({
      report: report(),
      taskReportbacks: queue,
      state,
      now: () => 1781319600000,
    });
    const second = syncNoeObservationStatusReportback({
      report: report(),
      taskReportbacks: queue,
      state,
      now: () => 1781319700000,
    });
    const third = syncNoeObservationStatusReportback({
      report: report({ readyForNextStageReview: true, status: 'ready_for_next_stage_review', blockers: [] }),
      taskReportbacks: queue,
      state,
      now: () => 1781319800000,
    });

    expect(first).toMatchObject({ ok: true, changed: true });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(third).toMatchObject({ ok: true, changed: true });
    expect(queue.items).toHaveLength(2);
    expect(queue.items[1]).toMatchObject({ status: 'done', title: '观察门：已满足' });
    expect(state.value()).toMatchObject({ readyForNextStageReview: true, itemId: 'item-2' });
  });

  it('does not write without a reportback queue', () => {
    expect(syncNoeObservationStatusReportback({ report: report() })).toMatchObject({
      ok: false,
      changed: false,
      reason: 'task_reportbacks_unavailable',
    });
  });
});
