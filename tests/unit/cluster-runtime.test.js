import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prevent the module from trying to read a real history file
delete process.env.PANEL_HEALTH_HISTORY_PATH;
process.env.NODE_ENV = 'test';

vi.mock('../../src/server/services/cluster-health-trend.js', () => ({
  buildClusterHealthTrendReport: vi.fn(() => ({ mocked: 'health-trend' })),
}));
vi.mock('../../src/server/services/cluster-resource-guard.js', () => ({
  buildClusterResourceGuardReport: vi.fn(() => ({ mocked: 'resource-guard' })),
}));
vi.mock('../../src/server/services/cluster-ops-guard.js', () => ({
  buildClusterOpsGuardReport: vi.fn(() => ({ mocked: 'ops-guard' })),
}));
vi.mock('../../src/server/services/cluster-capability-guard.js', () => ({
  buildClusterCapabilityGuardReport: vi.fn(() => ({ mocked: 'capability-guard' })),
}));

import {
  parseGoalModeCommandTopic,
  buildClusterHealthTrend,
  buildClusterResourceGuard,
  buildClusterOpsGuard,
  buildClusterCapabilityGuard,
  listRoomsForConcurrency,
  clusterRoomId,
} from '../../src/server/services/cluster-runtime.js';
import { buildClusterHealthTrendReport } from '../../src/server/services/cluster-health-trend.js';
import { buildClusterResourceGuardReport } from '../../src/server/services/cluster-resource-guard.js';
import { buildClusterOpsGuardReport } from '../../src/server/services/cluster-ops-guard.js';
import { buildClusterCapabilityGuardReport } from '../../src/server/services/cluster-capability-guard.js';

describe('parseGoalModeCommandTopic', () => {
  it('returns topic unchanged when no goal command prefix is present', () => {
    expect(parseGoalModeCommandTopic('hello world')).toEqual({
      topic: 'hello world',
      goalModeCommand: false,
    });
  });

  it('handles empty and nullish input', () => {
    expect(parseGoalModeCommandTopic('')).toEqual({ topic: '', goalModeCommand: false });
    expect(parseGoalModeCommandTopic(null)).toEqual({ topic: '', goalModeCommand: false });
    expect(parseGoalModeCommandTopic(undefined)).toEqual({ topic: '', goalModeCommand: false });
  });

  it('strips /goal: prefix', () => {
    expect(parseGoalModeCommandTopic('/goal: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('strips /goal- prefix (dash separator)', () => {
    expect(parseGoalModeCommandTopic('/goal- do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('strips /goal prefix without separator', () => {
    expect(parseGoalModeCommandTopic('/goal do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('is case-insensitive on the goal keyword', () => {
    expect(parseGoalModeCommandTopic('/GOAL: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
    expect(parseGoalModeCommandTopic('/Goal: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('strips /目标: prefix (Chinese characters with regular slash)', () => {
    expect(parseGoalModeCommandTopic('/目标: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('strips ／目标: prefix (full-width slash)', () => {
    expect(parseGoalModeCommandTopic('／目标: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });

  it('does not match 目标 without a leading slash', () => {
    expect(parseGoalModeCommandTopic('目标: do something')).toEqual({
      topic: '目标: do something',
      goalModeCommand: false,
    });
  });

  it('trims leading whitespace before the prefix', () => {
    expect(parseGoalModeCommandTopic('   /goal: do something')).toEqual({
      topic: 'do something',
      goalModeCommand: true,
    });
  });
});

describe('buildClusterHealthTrend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls buildClusterHealthTrendReport and returns its result', () => {
    const result = buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
    });
    expect(buildClusterHealthTrendReport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mocked: 'health-trend' });
  });

  it('marks currentReport.ok=true when all statuses are good and no repair', () => {
    buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(true);
    expect(callArg.currentReport).not.toHaveProperty('repair');
  });

  it('marks currentReport.ok=false when health status is not passed', () => {
    buildClusterHealthTrend({
      health: { status: 'failed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('marks currentReport.ok=false when readiness is blocked', () => {
    buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'blocked' },
      diagnostics: { status: 'ok' },
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('marks currentReport.ok=false when diagnostics is blocked', () => {
    buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'blocked' },
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('marks currentReport.ok=false when repair.ok is false', () => {
    buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      repair: { ok: false, action: 'restart' },
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('includes repair in currentReport when provided and ok', () => {
    const repair = { ok: true, action: 'restart' };
    buildClusterHealthTrend({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      repair,
    });
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.repair).toBe(repair);
  });

  it('works with empty arguments (all undefined)', () => {
    buildClusterHealthTrend();
    const callArg = buildClusterHealthTrendReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });
});

describe('buildClusterResourceGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls buildClusterResourceGuardReport and returns its result', () => {
    const result = buildClusterResourceGuard();
    expect(buildClusterResourceGuardReport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mocked: 'resource-guard' });
  });
});

describe('buildClusterOpsGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls buildClusterOpsGuardReport and returns its result', () => {
    const rooms = [{ roomId: 'r1' }];
    const result = buildClusterOpsGuard({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      healthTrend: { status: 'ok' },
      resourceGuard: { status: 'ok' },
      rooms,
    });
    expect(buildClusterOpsGuardReport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mocked: 'ops-guard' });
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.rooms).toBe(rooms);
  });

  it('marks currentReport.ok=true when all statuses are good', () => {
    buildClusterOpsGuard({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      healthTrend: { status: 'ok' },
      resourceGuard: { status: 'ok' },
    });
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(true);
  });

  it('marks currentReport.ok=false when readiness is blocked', () => {
    buildClusterOpsGuard({
      health: { status: 'passed' },
      readiness: { status: 'blocked' },
      diagnostics: { status: 'ok' },
      healthTrend: { status: 'ok' },
      resourceGuard: { status: 'ok' },
    });
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('marks currentReport.ok=false when healthTrend is blocked', () => {
    buildClusterOpsGuard({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      healthTrend: { status: 'blocked' },
      resourceGuard: { status: 'ok' },
    });
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('marks currentReport.ok=false when resourceGuard is blocked', () => {
    buildClusterOpsGuard({
      health: { status: 'passed' },
      readiness: { status: 'ready' },
      diagnostics: { status: 'ok' },
      healthTrend: { status: 'ok' },
      resourceGuard: { status: 'blocked' },
    });
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
  });

  it('works with empty arguments (rooms defaults to [])', () => {
    buildClusterOpsGuard();
    const callArg = buildClusterOpsGuardReport.mock.calls[0][0];
    expect(callArg.currentReport.ok).toBe(false);
    expect(callArg.rooms).toEqual([]);
  });
});

describe('buildClusterCapabilityGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls buildClusterCapabilityGuardReport and returns its result', () => {
    const rooms = [];
    const result = buildClusterCapabilityGuard({ rooms, roomAdapterPool: null });
    expect(buildClusterCapabilityGuardReport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mocked: 'capability-guard' });
  });

  it('passes empty knownAdapterIds when no roomAdapterPool is provided', () => {
    buildClusterCapabilityGuard({ rooms: [] });
    const callArg = buildClusterCapabilityGuardReport.mock.calls[0][0];
    expect(callArg.knownAdapterIds).toEqual([]);
  });

  it('extracts adapter ids from a Map-based pool', () => {
    const adapters = new Map();
    adapters.set('a1', {});
    adapters.set('a2', {});
    buildClusterCapabilityGuard({ rooms: [], roomAdapterPool: { adapters } });
    const callArg = buildClusterCapabilityGuardReport.mock.calls[0][0];
    expect(callArg.knownAdapterIds).toEqual(['a1', 'a2']);
  });

  it('extracts adapter ids from an object-based pool', () => {
    buildClusterCapabilityGuard({
      rooms: [],
      roomAdapterPool: { adapters: { a1: {}, a2: {} } },
    });
    const callArg = buildClusterCapabilityGuardReport.mock.calls[0][0];
    expect(callArg.knownAdapterIds).toEqual(['a1', 'a2']);
  });

  it('extracts adapter ids from a list() function (preferring id then adapterId)', () => {
    buildClusterCapabilityGuard({
      rooms: [],
      roomAdapterPool: {
        list: () => [{ id: 'a1' }, { adapterId: 'a2' }, { id: '' }, { noId: true }],
      },
    });
    const callArg = buildClusterCapabilityGuardReport.mock.calls[0][0];
    expect(callArg.knownAdapterIds).toEqual(['a1', 'a2']);
  });

  it('returns empty list when list() throws', () => {
    buildClusterCapabilityGuard({
      rooms: [],
      roomAdapterPool: { list: () => { throw new Error('boom'); } },
    });
    const callArg = buildClusterCapabilityGuardReport.mock.calls[0][0];
    expect(callArg.knownAdapterIds).toEqual([]);
  });
});

describe('listRoomsForConcurrency', () => {
  it('returns empty array for null/undefined store', () => {
    expect(listRoomsForConcurrency(null)).toEqual([]);
    expect(listRoomsForConcurrency(undefined)).toEqual([]);
  });

  it('uses list() method when available and returns the array', () => {
    const rooms = [{ roomId: 'r1' }];
    expect(listRoomsForConcurrency({ list: () => rooms })).toBe(rooms);
  });

  it('returns empty when list() returns a non-array value', () => {
    expect(listRoomsForConcurrency({ list: () => 'not array' })).toEqual([]);
    expect(listRoomsForConcurrency({ list: () => null })).toEqual([]);
  });

  it('returns empty when list() throws', () => {
    expect(listRoomsForConcurrency({ list: () => { throw new Error('x'); } })).toEqual([]);
  });

  it('uses rooms.values() when list() is not available', () => {
    const room = { roomId: 'r1' };
    const map = new Map([['r1', room]]);
    expect(listRoomsForConcurrency({ rooms: map })).toEqual([room]);
  });

  it('uses _rooms.values() when list() and rooms are not available', () => {
    const room = { roomId: 'r1' };
    const map = new Map([['r1', room]]);
    expect(listRoomsForConcurrency({ _rooms: map })).toEqual([room]);
  });

  it('skips rooms that lack a values() function', () => {
    expect(listRoomsForConcurrency({ rooms: {} })).toEqual([]);
  });

  it('returns empty when no compatible method exists', () => {
    expect(listRoomsForConcurrency({})).toEqual([]);
  });
});

describe('clusterRoomId', () => {
  it('returns roomId when present', () => {
    expect(clusterRoomId({ roomId: 'r1' })).toBe('r1');
  });

  it('falls back to id when roomId is missing', () => {
    expect(clusterRoomId({ id: 'r2' })).toBe('r2');
  });

  it('prefers roomId over id', () => {
    expect(clusterRoomId({ roomId: 'r1', id: 'r2' })).toBe('r1');
  });

  it('trims whitespace from the id', () => {
    expect(clusterRoomId({ roomId: '  r3  ' })).toBe('r3');
  });

  it('returns empty string when no id is present', () => {
    expect(clusterRoomId({})).toBe('');
    expect(clusterRoomId(null)).toBe('');
    expect(clusterRoomId(undefined)).toBe('');
  });
});
