// @ts-check
import { describe, expect, it } from 'vitest';
import {
  buildUpdateDrainSnapshot,
  buildUpdateDrainSnapshotFromReaders,
  parseUpdateDrainHealthPayload,
} from '../../src/runtime/NoeUpdateDrainState.js';

describe('NoeUpdateDrainState', () => {
  it('counts all known active work sources conservatively', () => {
    const snapshot = buildUpdateDrainSnapshot({
      rooms: [
        { status: 'running', taskList: [{ status: 'running' }, { status: 'done' }] },
      ],
      sessions: [{ busy: true, runState: 'idle' }],
      agentRuns: [{ status: 'running' }],
      autopilotJobs: [{ status: 'running' }],
      observedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.runningTaskCount).toBe(5);
    expect(snapshot.drainComplete).toBe(false);
    expect(parseUpdateDrainHealthPayload({ ok: true, taskDrain: snapshot })).toBeNull();
  });

  it('accepts only an explicit all-zero, source-complete health payload', () => {
    const snapshot = buildUpdateDrainSnapshot({
      rooms: [],
      sessions: [],
      agentRuns: [],
      autopilotJobs: [],
      observedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(parseUpdateDrainHealthPayload({ ok: true, taskDrain: snapshot })).toEqual({
      available: true,
      drainComplete: true,
      runningTaskCount: 0,
      counts: {
        roomRuns: 0,
        roomTasks: 0,
        busySessions: 0,
        agentRuns: 0,
        autopilotJobs: 0,
      },
      observedAt: '2026-07-22T00:00:00.000Z',
    });
  });

  it('fails closed for missing, contradictory, or degraded sources', () => {
    expect(parseUpdateDrainHealthPayload({ ok: true })).toBeNull();
    const degraded = buildUpdateDrainSnapshot({ sourceErrors: ['rooms:db_locked'] });
    expect(degraded.available).toBe(false);
    expect(degraded.drainComplete).toBe(false);
    expect(parseUpdateDrainHealthPayload({ ok: true, taskDrain: degraded })).toBeNull();

    const contradictory = {
      ...buildUpdateDrainSnapshot({}),
      runningTaskCount: 0,
      drainComplete: true,
      counts: { rooms: 1 },
    };
    expect(parseUpdateDrainHealthPayload({ ok: true, taskDrain: contradictory })).toBeNull();
  });

  it('fails closed when a live source throws, is missing, or is not an array', () => {
    const snapshot = buildUpdateDrainSnapshotFromReaders({
      rooms: () => [],
      sessions: () => { throw new Error('db_locked'); },
      agentRuns: () => ({ status: 'running' }),
    });
    expect(snapshot.available).toBe(false);
    expect(snapshot.drainComplete).toBe(false);
    expect(snapshot.sourceErrors).toEqual([
      'sessions:db_locked',
      'agent_runs:non_array_result',
      'autopilot_jobs:reader_missing',
    ]);
  });

  it('prefers exact agentRunsCount over list length (avoids false cap at 500)', () => {
    const fake500 = Array.from({ length: 500 }, () => ({ status: 'running' }));
    const snapshot = buildUpdateDrainSnapshot({
      rooms: [],
      sessions: [],
      agentRuns: fake500,
      agentRunsCount: 330498,
      autopilotJobs: [],
    });
    expect(snapshot.counts.agentRuns).toBe(330498);
    expect(snapshot.runningTaskCount).toBe(330498);

    const fromReaders = buildUpdateDrainSnapshotFromReaders({
      rooms: () => [],
      sessions: () => [],
      agentRunsCount: () => 42,
      // agentRuns reader intentionally omitted — count path must not require it
      autopilotJobs: () => [],
    });
    expect(fromReaders.available).toBe(true);
    expect(fromReaders.counts.agentRuns).toBe(42);
    expect(fromReaders.runningTaskCount).toBe(42);
    expect(fromReaders.sourceErrors).toEqual([]);
  });
});
