import { describe, it, expect } from 'vitest';
import { dryRun } from '../../src/autopilot/learned/rule-dry-run.js';

describe('dryRun', () => {
  it('returns empty arrays when rules is not an array', () => {
    const result = dryRun(null, { type: 'room_done' });
    expect(result).toEqual({ matched: [], actions: [], skipped: [] });
  });

  it('returns empty arrays when event is missing', () => {
    const result = dryRun([{ id: 'r1', name: 'A' }], null);
    expect(result).toEqual({ matched: [], actions: [], skipped: [] });
  });

  it('returns empty arrays when both inputs are invalid', () => {
    const result = dryRun(undefined, undefined);
    expect(result).toEqual({ matched: [], actions: [], skipped: [] });
  });

  it('skips rules with enabled === false', () => {
    const rules = [{ id: 'r1', name: 'Disabled', enabled: false }];
    const result = dryRun(rules, { type: 'room_done' });
    expect(result.matched).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'r1', name: 'Disabled', reason: 'disabled' },
    ]);
  });

  it('matches a rule with no eventTypes and no sourceRoomFilter (universal)', () => {
    const rules = [
      { id: 'r1', name: 'Catch-all', action: 'forward', targetMode: 'squad', autoStart: true },
    ];
    const result = dryRun(rules, { type: 'room_done', sourceRoomId: 'room-1' });
    expect(result.matched).toEqual([{ id: 'r1', name: 'Catch-all' }]);
    expect(result.actions).toEqual([
      {
        ruleName: 'Catch-all',
        action: 'forward',
        targetMode: 'squad',
        autoStart: true,
        wouldFire: true,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('matches when event.type is in rule.eventTypes and room matches', () => {
    const rules = [
      {
        id: 'r1',
        name: 'Room-done to squad',
        eventTypes: ['room_done', 'task_done'],
        sourceRoomFilter: 'room-1',
        action: 'forward',
        targetMode: 'squad',
        autoStart: false,
      },
    ];
    const result = dryRun(rules, { type: 'room_done', sourceRoomId: 'room-1' });
    expect(result.matched).toEqual([{ id: 'r1', name: 'Room-done to squad' }]);
    expect(result.actions).toEqual([
      {
        ruleName: 'Room-done to squad',
        action: 'forward',
        targetMode: 'squad',
        autoStart: false,
        wouldFire: true,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('skips when event.type is not in rule.eventTypes', () => {
    const rules = [
      {
        id: 'r1',
        name: 'Only room_done',
        eventTypes: ['room_done'],
        action: 'forward',
        targetMode: 'arena',
      },
    ];
    const result = dryRun(rules, { type: 'message' });
    expect(result.matched).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'r1',
        name: 'Only room_done',
        reason: 'event.type !== room_done',
      },
    ]);
  });

  it('skips when sourceRoomId does not match sourceRoomFilter', () => {
    const rules = [
      {
        id: 'r1',
        name: 'Room-1 only',
        sourceRoomFilter: 'room-1',
        action: 'forward',
        targetMode: 'squad',
      },
    ];
    const result = dryRun(rules, { type: 'room_done', sourceRoomId: 'room-2' });
    expect(result.matched).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'r1',
        name: 'Room-1 only',
        reason: 'sourceRoom 不匹配',
      },
    ]);
  });

  it('coerces autoStart to boolean in action output', () => {
    const rules = [
      { id: 'r1', name: 'A', action: 'forward', targetMode: 'squad', autoStart: 1 },
    ];
    const result = dryRun(rules, { type: 'room_done' });
    expect(result.actions[0].autoStart).toBe(true);
  });

  it('processes a mixed list of rules and partitions them correctly', () => {
    const rules = [
      { id: 'r1', name: 'Universal', action: 'forward', targetMode: 'squad' },
      { id: 'r2', name: 'Disabled one', enabled: false, action: 'noop' },
      {
        id: 'r3',
        name: 'Room-1 only',
        sourceRoomFilter: 'room-1',
        action: 'forward',
        targetMode: 'arena',
        autoStart: true,
      },
      {
        id: 'r4',
        name: 'Wrong type',
        eventTypes: ['message'],
        action: 'forward',
        targetMode: 'squad',
      },
    ];
    const result = dryRun(rules, { type: 'room_done', sourceRoomId: 'room-1' });

    expect(result.matched.map((m) => m.id)).toEqual(['r1', 'r3']);
    expect(result.actions).toEqual([
      {
        ruleName: 'Universal',
        action: 'forward',
        targetMode: 'squad',
        autoStart: false,
        wouldFire: true,
      },
      {
        ruleName: 'Room-1 only',
        action: 'forward',
        targetMode: 'arena',
        autoStart: true,
        wouldFire: true,
      },
    ]);
    expect(result.skipped).toEqual([
      { id: 'r2', name: 'Disabled one', reason: 'disabled' },
      {
        id: 'r4',
        name: 'Wrong type',
        reason: 'event.type !== message',
      },
    ]);
  });

  it('returns empty buckets for an empty rules array', () => {
    const result = dryRun([], { type: 'room_done' });
    expect(result).toEqual({ matched: [], actions: [], skipped: [] });
  });
});
