import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentRunLifecycle,
  shouldRecordAdapterChatRun,
} from '../../src/agents/AgentRunLifecycle.js';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-agent-run-lifecycle-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('AgentRunLifecycle', () => {
  it('tracks start, decision, defer, finish, fail, and cancel transitions', () => {
    const store = new AgentRunStore({ logger: null });
    const lifecycle = new AgentRunLifecycle({ store, logger: null });
    const opts = {
      cwd: '/tmp/project',
      model: 'test-model',
      budgetContext: {
        roomId: 'room-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        adapterId: 'codex',
        agentProfileId: 'xike-builder',
      },
    };
    const adapter = { id: 'codex', model: 'fallback', _countTokens: () => 42 };
    const run = lifecycle.startRun({ adapter, messages: [{ role: 'user', content: 'build' }], opts });

    expect(run).toMatchObject({
      status: 'running',
      roomId: 'room-1',
      agentProfileId: 'xike-builder',
      adapterId: 'codex',
      modelId: 'test-model',
    });
    expect(opts.agentRunId).toBe(run.id);

    lifecycle.appendDecision(run.id, { summary: 'Prepared prompt context.', reason: 'dispatch' });
    expect(store.getTimeline(run.id).messages[0]).toMatchObject({ kind: 'decision' });

    const deferred = lifecycle.deferRun(run.id, 'approval_pending', { approvalId: 'approval-1' });
    expect(deferred).toMatchObject({
      status: 'deferred',
      deferReason: 'approval_pending',
      approvalId: 'approval-1',
    });

    const finished = lifecycle.finishRun(run.id, { tokensIn: 10, tokensOut: 5, reply: 'ok' });
    expect(finished).toMatchObject({ status: 'succeeded' });
    expect(finished.details).toMatchObject({ tokensIn: 10, tokensOut: 5, replyLength: 2 });

    const failed = lifecycle.failRun(run.id, new Error('adapter failed'));
    expect(failed).toMatchObject({ status: 'failed', error: 'adapter failed' });

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const cancelled = lifecycle.cancelRun(run.id, abortError);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
  });

  it('ensureSettled is idempotent and only closes still-running runs', () => {
    const store = new AgentRunStore({ logger: null });
    const lifecycle = new AgentRunLifecycle({ store, logger: null });
    const run = lifecycle.startRun({
      adapter: { id: 'lmstudio', model: 'm' },
      messages: [{ role: 'user', content: 'x' }],
      opts: { budgetContext: { roomId: 'r', sessionId: 's' } },
    });
    expect(store.get(run.id).status).toBe('running');

    const first = lifecycle.ensureSettled(run.id, {
      outcome: 'failed',
      reason: 'rate_limit',
      error: new Error('rate limited'),
    });
    expect(first.status).toBe('failed');
    expect(first.error).toMatch(/rate limited/);

    // Second settle must not flip or throw
    const second = lifecycle.ensureSettled(run.id, {
      outcome: 'succeeded',
      result: { reply: 'too late' },
    });
    expect(second.status).toBe('failed');
  });

  it('shouldRecordAdapterChatRun respects skip / off / sample modes', () => {
    expect(shouldRecordAdapterChatRun({ skipAgentRun: true })).toBe(false);
    expect(shouldRecordAdapterChatRun({ agentRunLifecycle: false })).toBe(false);
    expect(shouldRecordAdapterChatRun({}, { NOE_AGENT_RUN_ADAPTER_CHAT: '0' })).toBe(false);
    expect(shouldRecordAdapterChatRun({}, { NOE_AGENT_RUN_ADAPTER_CHAT: 'off' })).toBe(false);
    expect(shouldRecordAdapterChatRun({ forceAgentRun: true }, { NOE_AGENT_RUN_ADAPTER_CHAT: '0' })).toBe(true);
    expect(shouldRecordAdapterChatRun({}, { NOE_AGENT_RUN_ADAPTER_CHAT: '1' })).toBe(true);
    // sample:1 always records
    expect(shouldRecordAdapterChatRun({}, { NOE_AGENT_RUN_ADAPTER_CHAT: 'sample:1' })).toBe(true);
  });

  it('startRun skips when NOE_AGENT_RUN_ADAPTER_CHAT=off', () => {
    const prev = process.env.NOE_AGENT_RUN_ADAPTER_CHAT;
    process.env.NOE_AGENT_RUN_ADAPTER_CHAT = 'off';
    try {
      const store = new AgentRunStore({ logger: null });
      const lifecycle = new AgentRunLifecycle({ store, logger: null });
      const run = lifecycle.startRun({
        adapter: { id: 'lmstudio' },
        messages: [],
        opts: {},
      });
      expect(run).toBeNull();
      expect(store.list({}).length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.NOE_AGENT_RUN_ADAPTER_CHAT;
      else process.env.NOE_AGENT_RUN_ADAPTER_CHAT = prev;
    }
  });
});
