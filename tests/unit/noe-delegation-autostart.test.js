import { describe, expect, it } from 'vitest';
import { makeNoeDelegationAutostartHandler } from '../../src/autopilot/NoeDelegationAutostart.js';

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    roomId: 'room-1',
    taskId: 'noe-delegate:room-1',
    projectId: '/tmp/project',
    payload: {
      roomId: 'room-1',
      approvalId: 'approval-1',
      agentRunId: 'agent-run-1',
      autoStart: true,
      requireApproval: true,
      plan: { title: 'Fix login', instructions: 'Fix the login bug', targetMode: 'chat', targetAdapter: 'codex' },
      ...overrides.payload,
    },
    ...overrides,
  };
}

describe('Noe delegation autostart handler', () => {
  it('defers while approval is pending and does not start chat', async () => {
    let chatCalls = 0;
    const transitions = [];
    const handler = makeNoeDelegationAutostartHandler({
      roomStore: { get: () => ({ id: 'room-1', mode: 'chat', cwd: '/tmp/project', name: 'Noe派活' }) },
      approvalStore: { getApproval: () => ({ id: 'approval-1', status: 'pending' }) },
      budgetStore: { preflight: () => ({ ok: true, blocked: [] }) },
      startRoom: async () => { throw new Error('should not start non-chat'); },
      sendChatMessage: async () => { chatCalls += 1; },
      agentRunStore: { transition: (...args) => transitions.push(args) },
      now: () => 1000,
      gatePollMs: 5000,
    });

    const result = await handler(makeJob());

    expect(result.__defer).toBe(true);
    expect(result.reason).toBe('approval_pending');
    expect(result.runAfter).toBe(6000);
    expect(result.result).toMatchObject({ approvalId: 'approval-1', agentRunId: 'agent-run-1' });
    expect(chatCalls).toBe(0);
    expect(transitions[0][0]).toBe('agent-run-1');
    expect(transitions[0][1]).toBe('deferred');
    expect(transitions[0][2]).toMatchObject({ deferReason: 'approval_pending', approvalId: 'approval-1' });
  });

  it('starts a chat room by sending the delegated instructions only after approval', async () => {
    let sent = null;
    const transitions = [];
    const handler = makeNoeDelegationAutostartHandler({
      roomStore: { get: () => ({ id: 'room-1', mode: 'chat', cwd: '/tmp/project', name: 'Noe派活' }) },
      approvalStore: { getApproval: () => ({ id: 'approval-1', status: 'approved' }) },
      budgetStore: { preflight: () => ({ ok: true, blocked: [] }) },
      startRoom: async () => { throw new Error('should not start non-chat'); },
      sendChatMessage: async (room, text) => {
        sent = { room, text };
        return { content: 'done' };
      },
      agentRunStore: { transition: (...args) => transitions.push(args) },
    });

    const result = await handler(makeJob());

    expect(result).toMatchObject({ ok: true, started: true, room: { id: 'room-1' } });
    expect(result.startResult).toMatchObject({ started: true, mode: 'chat' });
    expect(sent.text).toBe('Fix the login bug');
    expect(transitions[0][0]).toBe('agent-run-1');
    expect(transitions[0][1]).toBe('succeeded');
    expect(transitions[0][2]).toMatchObject({ approvalId: 'approval-1', started: true });
  });

  it('returns a compact room summary so scheduler results stay below payload limits', async () => {
    const largeRoom = {
      id: 'room-1',
      mode: 'chat',
      cwd: '/tmp/project',
      name: 'Noe派活',
      messages: Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', content: `large message ${i} ${'x'.repeat(500)}` })),
    };
    const handler = makeNoeDelegationAutostartHandler({
      roomStore: { get: () => largeRoom },
      approvalStore: { getApproval: () => ({ id: 'approval-1', status: 'approved' }) },
      budgetStore: { preflight: () => ({ ok: true, blocked: [] }) },
      startRoom: async () => { throw new Error('should not start non-chat'); },
      sendChatMessage: async () => ({ content: 'done' }),
      agentRunStore: { transition: () => {} },
    });

    const result = await handler(makeJob());

    expect(result.room).toEqual({ id: 'room-1', name: 'Noe派活', mode: 'chat', status: '', cwd: '/tmp/project' });
    expect(JSON.stringify(result).length).toBeLessThan(4096);
  });
});
