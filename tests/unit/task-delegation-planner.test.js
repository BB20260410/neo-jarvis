import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/license/LicenseManager.js', () => ({
  getCurrentTier: vi.fn(() => 'community'),
  hasFeature: vi.fn(() => true),
}));

import {
  normalizeTaskPlan,
  validateTaskDelegationPlan,
  buildNoeDelegatedTopic,
  createNoeDelegationRoom,
} from '../../src/room/TaskDelegationPlanner.js';
import { hasFeature } from '../../src/license/LicenseManager.js';

describe('normalizeTaskPlan', () => {
  it('returns null for non-object input', () => {
    expect(normalizeTaskPlan(null)).toBeNull();
    expect(normalizeTaskPlan('hello')).toBeNull();
    expect(normalizeTaskPlan(42)).toBeNull();
    expect(normalizeTaskPlan(undefined)).toBeNull();
  });

  it('returns null when instructions are empty or whitespace', () => {
    expect(normalizeTaskPlan({})).toBeNull();
    expect(normalizeTaskPlan({ instructions: '' })).toBeNull();
    expect(normalizeTaskPlan({ instructions: '   ' })).toBeNull();
  });

  it('normalizes a chat task with explicit adapter', () => {
    const result = normalizeTaskPlan({
      instructions: 'Write a poem',
      targetMode: 'chat',
      targetAdapter: 'codex',
    });
    expect(result).toEqual({
      intent: 'delegate_task',
      targetAdapter: 'codex',
      targetMode: 'chat',
      title: 'Write a poem',
      instructions: 'Write a poem',
      approvalRequired: true,
      dryRunOnly: true,
    });
  });

  it('defaults targetAdapter to "auto" and targetMode to "debate"', () => {
    const result = normalizeTaskPlan({ instructions: 'Do something' });
    expect(result.targetAdapter).toBe('auto');
    expect(result.targetMode).toBe('debate');
  });

  it('maps targetAdapter "squad" to targetMode "squad"', () => {
    const result = normalizeTaskPlan({ instructions: 'X', targetAdapter: 'squad' });
    expect(result.targetMode).toBe('squad');
  });

  it('maps targetAdapter "arena" to targetMode "arena"', () => {
    const result = normalizeTaskPlan({ instructions: 'X', targetAdapter: 'arena' });
    expect(result.targetMode).toBe('arena');
  });

  it('falls back to "debate" for invalid targetMode', () => {
    const result = normalizeTaskPlan({ instructions: 'X', targetMode: 'invalid' });
    expect(result.targetMode).toBe('debate');
  });

  it('truncates instructions longer than 1200 chars', () => {
    const long = 'a'.repeat(2000);
    const result = normalizeTaskPlan({ instructions: long });
    expect(result.instructions.length).toBe(1200);
  });

  it('uses prompt field as fallback for instructions', () => {
    expect(normalizeTaskPlan({ prompt: 'from prompt' }).instructions).toBe('from prompt');
  });

  it('uses title field as fallback for instructions', () => {
    expect(normalizeTaskPlan({ title: 'from title' }).instructions).toBe('from title');
  });

  it('lowercases targetAdapter', () => {
    const result = normalizeTaskPlan({ instructions: 'X', targetAdapter: 'CODEX' });
    expect(result.targetAdapter).toBe('codex');
  });
});

describe('validateTaskDelegationPlan', () => {
  beforeEach(() => {
    hasFeature.mockReturnValue(true);
  });

  it('returns 422 when plan is invalid', () => {
    const result = validateTaskDelegationPlan({});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).toContain('delegate task plan');
  });

  it('returns 402 for squad mode without feature license', () => {
    hasFeature.mockImplementation((f) => f !== 'squad');
    const result = validateTaskDelegationPlan({
      instructions: 'X', targetMode: 'squad',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(result.feature).toBe('squad');
  });

  it('returns 402 for arena mode without feature license', () => {
    hasFeature.mockImplementation((f) => f !== 'arena');
    const result = validateTaskDelegationPlan({
      instructions: 'X', targetMode: 'arena',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(result.feature).toBe('arena');
  });

  it('returns 409 when required chat adapter is missing', () => {
    const pool = new Map();
    const result = validateTaskDelegationPlan(
      { instructions: 'X', targetMode: 'chat', targetAdapter: 'codex' },
      { roomAdapterPool: pool }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.missingAdapters).toContain('codex');
  });

  it('returns ok:true for valid chat plan with available adapter', () => {
    const pool = new Map([['codex', { displayName: 'Codex' }]]);
    const result = validateTaskDelegationPlan(
      { instructions: 'X', targetMode: 'chat', targetAdapter: 'codex' },
      { roomAdapterPool: pool }
    );
    expect(result.ok).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.members).toHaveLength(1);
    expect(result.members[0].adapterId).toBe('codex');
  });

  it('returns ok:true for valid debate plan with claude+codex in pool', () => {
    const pool = new Map([
      ['claude', { displayName: 'Claude' }],
      ['codex', { displayName: 'Codex' }],
    ]);
    const result = validateTaskDelegationPlan(
      { instructions: 'X', targetMode: 'debate' },
      { roomAdapterPool: pool }
    );
    expect(result.ok).toBe(true);
    expect(result.members.length).toBeGreaterThan(0);
  });

  it('treats null pool as all-adapters-available', () => {
    const result = validateTaskDelegationPlan(
      { instructions: 'X', targetMode: 'chat', targetAdapter: 'codex' },
      { roomAdapterPool: null }
    );
    expect(result.ok).toBe(true);
  });
});

describe('buildNoeDelegatedTopic', () => {
  it('includes the plan title', () => {
    const topic = buildNoeDelegatedTopic({ title: 'My Plan', instructions: 'Do X' });
    expect(topic).toContain('My Plan');
  });

  it('includes the plan instructions', () => {
    const topic = buildNoeDelegatedTopic({ title: 'T', instructions: 'Run tests and report' });
    expect(topic).toContain('Run tests and report');
  });

  it('includes the safety constraints section', () => {
    const topic = buildNoeDelegatedTopic({ title: 'T', instructions: 'I' });
    expect(topic).toContain('安全约束');
    expect(topic).toContain('用户确认');
  });
});

describe('createNoeDelegationRoom', () => {
  let roomStore;

  beforeEach(() => {
    hasFeature.mockReturnValue(true);
    roomStore = {
      create: vi.fn((data) => ({ id: 'room-1', ...data })),
      update: vi.fn((id, patch) => ({ id, ...patch })),
      get: vi.fn(() => ({ id: 'room-1', name: 'updated-room' })),
    };
  });

  it('throws when roomStore is missing', () => {
    expect(() => createNoeDelegationRoom({ plan: { instructions: 'X' } }))
      .toThrow(/roomStore/);
  });

  it('throws when roomStore.create is not a function', () => {
    expect(() => createNoeDelegationRoom({ plan: { instructions: 'X' }, roomStore: {} }))
      .toThrow(/roomStore/);
  });

  it('throws with statusCode 422 for invalid plan', () => {
    let caught;
    try {
      createNoeDelegationRoom({ plan: {}, roomStore });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(422);
    expect(caught.extra).toBeDefined();
  });

  it('throws with statusCode 402 when license missing for squad', () => {
    hasFeature.mockReturnValue(false);
    let caught;
    try {
      createNoeDelegationRoom({
        plan: { instructions: 'X', targetMode: 'squad' },
        roomStore,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(402);
  });

  it('creates a room with correct structure on valid plan', () => {
    const result = createNoeDelegationRoom({
      plan: { instructions: 'Build X', targetMode: 'chat', targetAdapter: 'codex' },
      roomStore,
    });
    expect(result.plan).toBeDefined();
    expect(result.plan.instructions).toBe('Build X');
    expect(result.room).toBeDefined();
    expect(roomStore.create).toHaveBeenCalledTimes(1);
    expect(roomStore.update).toHaveBeenCalledTimes(1);
  });

  it('passes cwd to room creation when provided', () => {
    createNoeDelegationRoom({
      plan: { instructions: 'X', targetMode: 'chat', targetAdapter: 'codex' },
      roomStore,
      cwd: '/tmp/work',
    });
    const callArgs = roomStore.create.mock.calls[0][0];
    expect(callArgs.cwd).toBe('/tmp/work');
  });

  it('sets topic and delegatedFromNoe on update', () => {
    createNoeDelegationRoom({
      plan: { instructions: 'X', targetMode: 'chat', targetAdapter: 'codex' },
      roomStore,
    });
    const updateCall = roomStore.update.mock.calls[0];
    expect(updateCall[0]).toBe('room-1');
    expect(updateCall[1].topic).toContain('Noe 派活计划');
    expect(updateCall[1].delegatedFromNoe).toBeDefined();
    expect(updateCall[1].delegatedFromNoe.dryRunOnly).toBe(true);
  });
});
