import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/license/LicenseManager.js', () => ({
  getCurrentTier: vi.fn(() => 'pro'),
  hasFeature: vi.fn(() => true),
}));

import {
  normalizeTaskPlan,
  validateTaskDelegationPlan,
  buildNoeDelegatedTopic,
  createNoeDelegationRoom,
} from '../../../src/room/TaskDelegationPlanner.js';
import { getCurrentTier, hasFeature } from '../../../src/license/LicenseManager.js';

function makeRoomStore() {
  const rooms = {};
  return {
    create: vi.fn((payload) => {
      const id = 'r-' + Math.random().toString(36).slice(2, 10);
      const room = { id, ...payload };
      rooms[id] = room;
      return room;
    }),
    update: vi.fn((id, patch) => {
      rooms[id] = { ...rooms[id], ...patch };
      return rooms[id];
    }),
    get: vi.fn((id) => rooms[id]),
  };
}

describe('normalizeTaskPlan', () => {
  it('returns null for null input', () => {
    expect(normalizeTaskPlan(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeTaskPlan(undefined)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(normalizeTaskPlan('hi')).toBeNull();
    expect(normalizeTaskPlan(42)).toBeNull();
    expect(normalizeTaskPlan(true)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(normalizeTaskPlan({})).toBeNull();
  });

  it('returns null when instructions are blank', () => {
    expect(normalizeTaskPlan({ instructions: '' })).toBeNull();
    expect(normalizeTaskPlan({ instructions: '   \n\t' })).toBeNull();
  });

  it('uses the instructions field', () => {
    const plan = normalizeTaskPlan({ instructions: 'do it' });
    expect(plan.instructions).toBe('do it');
  });

  it('falls back to prompt field when instructions missing', () => {
    const plan = normalizeTaskPlan({ prompt: 'via prompt' });
    expect(plan.instructions).toBe('via prompt');
  });

  it('falls back to title field when instructions and prompt missing', () => {
    const plan = normalizeTaskPlan({ title: 'via title' });
    expect(plan.instructions).toBe('via title');
  });

  it('trims whitespace from instructions', () => {
    const plan = normalizeTaskPlan({ instructions: '  hello  ' });
    expect(plan.instructions).toBe('hello');
  });

  it('truncates instructions to 1200 characters', () => {
    const long = 'a'.repeat(2500);
    const plan = normalizeTaskPlan({ instructions: long });
    expect(plan.instructions).toHaveLength(1200);
  });

  it('defaults targetAdapter to auto', () => {
    const plan = normalizeTaskPlan({ instructions: 'x' });
    expect(plan.targetAdapter).toBe('auto');
  });

  it('lowercases targetAdapter', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', targetAdapter: 'CLAUDE' });
    expect(plan.targetAdapter).toBe('claude');
  });

  it('defaults targetMode to debate', () => {
    const plan = normalizeTaskPlan({ instructions: 'x' });
    expect(plan.targetMode).toBe('debate');
  });

  it('infers squad targetMode when targetAdapter is squad', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', targetAdapter: 'squad' });
    expect(plan.targetMode).toBe('squad');
  });

  it('infers arena targetMode when targetAdapter is arena', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', targetAdapter: 'arena' });
    expect(plan.targetMode).toBe('arena');
  });

  it('falls back to debate for an invalid targetMode', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', targetMode: 'gibberish' });
    expect(plan.targetMode).toBe('debate');
  });

  it('accepts an explicit valid targetMode', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', targetMode: 'chat' });
    expect(plan.targetMode).toBe('chat');
  });

  it('reads target_mode snake_case alias', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', target_mode: 'arena' });
    expect(plan.targetMode).toBe('arena');
  });

  it('reads target_adapter snake_case alias', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', target_adapter: 'codex' });
    expect(plan.targetAdapter).toBe('codex');
  });

  it('always sets intent=delegate_task, approvalRequired=true, dryRunOnly=true', () => {
    const plan = normalizeTaskPlan({ instructions: 'x' });
    expect(plan.intent).toBe('delegate_task');
    expect(plan.approvalRequired).toBe(true);
    expect(plan.dryRunOnly).toBe(true);
  });

  it('uses title when provided for the plan title', () => {
    const plan = normalizeTaskPlan({ instructions: 'body', title: 'Heading' });
    expect(plan.title).toBe('Heading');
  });

  it('falls back to instructions for the plan title', () => {
    const plan = normalizeTaskPlan({ instructions: 'body text' });
    expect(plan.title).toBe('body text');
  });

  it('truncates title to 80 characters', () => {
    const plan = normalizeTaskPlan({ instructions: 'x', title: 't'.repeat(500) });
    expect(plan.title).toHaveLength(80);
  });
});

describe('validateTaskDelegationPlan', () => {
  beforeEach(() => {
    hasFeature.mockReturnValue(true);
    getCurrentTier.mockReturnValue('pro');
  });

  it('returns 422 when the plan is null', () => {
    const result = validateTaskDelegationPlan(null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
  });

  it('returns 422 when the plan has no instructions', () => {
    const result = validateTaskDelegationPlan({});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
  });

  it('returns 402 for squad mode when the feature is unavailable', () => {
    hasFeature.mockImplementation((f) => f !== 'squad');
    const result = validateTaskDelegationPlan({
      instructions: 'x',
      targetMode: 'squad',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(result.feature).toBe('squad');
    expect(result.tier).toBe('pro');
  });

  it('returns 402 for arena mode when the feature is unavailable', () => {
    hasFeature.mockImplementation((f) => f !== 'arena');
    const result = validateTaskDelegationPlan({
      instructions: 'x',
      targetMode: 'arena',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(result.feature).toBe('arena');
  });

  it('returns ok for a valid chat plan with the adapter available', () => {
    const pool = {
      has: vi.fn((id) => id === 'claude'),
      get: vi.fn((id) => (id === 'claude' ? { displayName: 'Claude' } : null)),
    };
    const result = validateTaskDelegationPlan(
      { instructions: 'x', targetMode: 'chat', targetAdapter: 'claude' },
      { roomAdapterPool: pool },
    );
    expect(result.ok).toBe(true);
    expect(result.plan.targetMode).toBe('chat');
    expect(result.members).toHaveLength(1);
    expect(result.members[0].adapterId).toBe('claude');
  });

  it('returns ok for a valid debate plan when required adapters are present', () => {
    const pool = {
      has: vi.fn(() => true),
      get: vi.fn((id) => ({ displayName: id })),
    };
    const result = validateTaskDelegationPlan(
      { instructions: 'x', targetMode: 'debate' },
      { roomAdapterPool: pool },
    );
    expect(result.ok).toBe(true);
    expect(result.members.length).toBeGreaterThan(0);
  });

  it('returns 409 when the required chat adapter is missing', () => {
    const pool = {
      has: vi.fn(() => false),
      get: vi.fn(() => null),
    };
    const result = validateTaskDelegationPlan(
      { instructions: 'x', targetMode: 'chat', targetAdapter: 'claude' },
      { roomAdapterPool: pool },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.missingAdapters).toEqual(['claude']);
  });

  it('treats a null pool as all adapters available', () => {
    const result = validateTaskDelegationPlan({
      instructions: 'x',
      targetMode: 'chat',
      targetAdapter: 'claude',
    });
    expect(result.ok).toBe(true);
    expect(result.members[0].enabled).toBe(true);
  });
});

describe('buildNoeDelegatedTopic', () => {
  it('returns a string', () => {
    const topic = buildNoeDelegatedTopic({ title: 'T', instructions: 'I' });
    expect(typeof topic).toBe('string');
  });

  it('contains the plan title', () => {
    const topic = buildNoeDelegatedTopic({ title: 'My Task Title', instructions: 'I' });
    expect(topic).toContain('My Task Title');
  });

  it('contains the plan instructions', () => {
    const topic = buildNoeDelegatedTopic({ title: 'T', instructions: 'specific body' });
    expect(topic).toContain('specific body');
  });

  it('includes the safety constraints section', () => {
    const topic = buildNoeDelegatedTopic({ title: 'T', instructions: 'I' });
    expect(topic).toContain('安全约束');
  });

  it('starts with the Noe 派活计划 prefix', () => {
    const topic = buildNoeDelegatedTopic({ title: 'Task X', instructions: 'I' });
    expect(topic.startsWith('# Noe 派活计划：Task X')).toBe(true);
  });
});

describe('createNoeDelegationRoom', () => {
  beforeEach(() => {
    hasFeature.mockReturnValue(true);
  });

  it('throws when roomStore is missing', () => {
    expect(() => createNoeDelegationRoom({ plan: { instructions: 'x' } })).toThrow('roomStore required');
  });

  it('throws when roomStore.create is not a function', () => {
    expect(() => createNoeDelegationRoom({ plan: { instructions: 'x' }, roomStore: {} })).toThrow('roomStore required');
  });

  it('throws with statusCode 422 when the plan is invalid', () => {
    const roomStore = makeRoomStore();
    let caught;
    try {
      createNoeDelegationRoom({ plan: {}, roomStore });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(422);
    expect(caught.extra).toBeDefined();
    expect(caught.extra.status).toBe(422);
    expect(roomStore.create).not.toHaveBeenCalled();
  });

  it('throws with statusCode 402 when squad feature is unavailable', () => {
    hasFeature.mockImplementation((f) => f !== 'squad');
    const roomStore = makeRoomStore();
    let caught;
    try {
      createNoeDelegationRoom({
        plan: { instructions: 'x', targetMode: 'squad' },
        roomStore,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(402);
  });

  it('creates a room and returns plan + room', () => {
    const roomStore = makeRoomStore();
    const result = createNoeDelegationRoom({
      plan: { instructions: 'do the thing', title: 'My Task' },
      roomStore,
    });
    expect(result.plan).toBeDefined();
    expect(result.plan.intent).toBe('delegate_task');
    expect(result.room).toBeDefined();
    expect(result.room.id).toBeDefined();
    expect(roomStore.create).toHaveBeenCalledTimes(1);
    expect(roomStore.update).toHaveBeenCalledTimes(1);
  });

  it('passes members, mode, and objective to roomStore.create', () => {
    const roomStore = makeRoomStore();
    createNoeDelegationRoom({
      plan: { instructions: 'x', title: 'Task' },
      roomStore,
    });
    const payload = roomStore.create.mock.calls[0][0];
    expect(payload.name).toContain('Noe派活');
    expect(payload.members).toBeInstanceOf(Array);
    expect(payload.members.length).toBeGreaterThan(0);
    expect(payload.mode).toBe('debate');
    expect(payload.objective).toBeDefined();
    expect(payload.objective.title).toBe('Task');
    expect(payload.objective.description).toBe('x');
    expect(payload.objective.acceptanceCriteria).toBeInstanceOf(Array);
    expect(payload.lineage.source).toBe('noe_delegate');
  });

  it('generates ids for objective and lineage with the expected prefixes', () => {
    const roomStore = makeRoomStore();
    createNoeDelegationRoom({
      plan: { instructions: 'x', title: 'T' },
      roomStore,
    });
    const payload = roomStore.create.mock.calls[0][0];
    expect(payload.objective.id).toMatch(/^obj-noe-delegate-/);
    expect(payload.lineage.taskId).toMatch(/^noe-delegate:/);
  });

  it('sets topic and delegatedFromNoe metadata on the room', () => {
    const roomStore = makeRoomStore();
    const result = createNoeDelegationRoom({
      plan: { instructions: 'x', title: 'Task' },
      roomStore,
    });
    expect(result.room.topic).toContain('Noe 派活计划');
    expect(result.room.delegatedFromNoe).toBeDefined();
    expect(result.room.delegatedFromNoe.dryRunOnly).toBe(true);
    expect(result.room.delegatedFromNoe.plan.title).toBe('Task');
    expect(typeof result.room.delegatedFromNoe.createdAt).toBe('string');
  });

  it('uses the provided cwd', () => {
    const roomStore = makeRoomStore();
    createNoeDelegationRoom({
      plan: { instructions: 'x', title: 'T' },
      roomStore,
      cwd: '/tmp/noe-test',
    });
    const payload = roomStore.create.mock.calls[0][0];
    expect(payload.cwd).toBe('/tmp/noe-test');
    expect(payload.lineage.projectId).toBe('/tmp/noe-test');
  });

  it('falls back to process.cwd() when cwd is not provided', () => {
    const roomStore = makeRoomStore();
    createNoeDelegationRoom({
      plan: { instructions: 'x', title: 'T' },
      roomStore,
    });
    const payload = roomStore.create.mock.calls[0][0];
    expect(payload.cwd).toBe(process.cwd());
  });
});
