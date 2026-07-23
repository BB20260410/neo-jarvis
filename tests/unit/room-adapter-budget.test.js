import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { budgetPolicyStore } from '../../src/budget/BudgetPolicyStore.js';
import { AgentRunStore } from '../../src/agents/AgentRunStore.js';
import { RoomAdapter } from '../../src/room/RoomAdapter.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

class FakeAdapter extends RoomAdapter {
  constructor() {
    super({ id: 'fake-adapter', displayName: 'Fake' });
    this.calls = 0;
  }

  async _doChat() {
    this.calls += 1;
    return { reply: 'ok', tokensIn: 1, tokensOut: 1 };
  }
}

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-room-budget-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('RoomAdapter budget guard', () => {
  it('blocks adapter calls before resilience when adapter budget is exhausted', async () => {
    budgetPolicyStore.createPolicy({
      scopeType: 'adapter',
      scopeId: 'fake-adapter',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });
    budgetPolicyStore.recordMetric({
      adapter: 'fake-adapter',
      estCostUSD: 0,
      tokensIn: 1,
      tokensOut: 1,
    });

    const adapter = new FakeAdapter();
    await expect(adapter.chat([{ role: 'user', content: 'hello' }], {
      skipResilience: true,
      budgetContext: { adapterId: 'fake-adapter' },
    })).rejects.toMatchObject({ code: 'BUDGET_LIMIT_EXCEEDED' });
    expect(adapter.calls).toBe(0);
    const runs = new AgentRunStore({ logger: null }).list({ sourceType: 'adapter_chat' });
    expect(runs).toEqual([expect.objectContaining({
      status: 'deferred',
      deferReason: 'budget_blocked',
      adapterId: 'fake-adapter',
    })]);
  });

  it('blocks calls by agent profile budget before invoking the adapter', async () => {
    budgetPolicyStore.createPolicy({
      scopeType: 'agent_profile',
      scopeId: 'xike-verifier',
      metric: 'calls',
      windowKind: 'daily',
      amount: 1,
      hardStopEnabled: true,
    });
    budgetPolicyStore.recordMetric({
      agentProfileId: 'xike-verifier',
      adapter: 'fake-adapter',
      estCostUSD: 0,
      tokensIn: 1,
      tokensOut: 1,
    });

    const adapter = new FakeAdapter();
    await expect(adapter.chat([{ role: 'user', content: 'verify' }], {
      skipResilience: true,
      budgetContext: { adapterId: 'fake-adapter', agentProfileId: 'xike-verifier' },
    })).rejects.toMatchObject({ code: 'BUDGET_LIMIT_EXCEEDED' });
    expect(adapter.calls).toBe(0);
    const runs = new AgentRunStore({ logger: null }).list({ agentProfileId: 'xike-verifier' });
    expect(runs[0]).toMatchObject({
      status: 'deferred',
      deferReason: 'budget_blocked',
      agentProfileId: 'xike-verifier',
    });
  });

  it('marks adapter runs succeeded and exposes agentRunId on the adapter result', async () => {
    const adapter = new FakeAdapter();
    const result = await adapter.chat([{ role: 'user', content: 'hello' }], {
      skipResilience: true,
      budgetContext: { roomId: 'room-1', taskId: 'task-1', adapterId: 'fake-adapter' },
    });

    expect(result.agentRunId).toMatch(/^agent-run-/);
    const run = new AgentRunStore({ logger: null }).get(result.agentRunId);
    expect(run).toMatchObject({
      status: 'succeeded',
      roomId: 'room-1',
      taskId: 'task-1',
      adapterId: 'fake-adapter',
    });
  });

  it('settles agent run on _doChat failure (no zombie running)', async () => {
    class BoomAdapter extends RoomAdapter {
      constructor() { super({ id: 'boom-adapter', displayName: 'Boom' }); }
      async _doChat() { throw new Error('model_down'); }
    }
    const adapter = new BoomAdapter();
    await expect(adapter.chat([{ role: 'user', content: 'x' }], {
      skipResilience: true,
      budgetContext: { roomId: 'room-z', adapterId: 'boom-adapter' },
    })).rejects.toThrow(/model_down/);

    const runs = new AgentRunStore({ logger: null }).list({ status: 'failed', limit: 10 });
    expect(runs.some((r) => r.adapterId === 'boom-adapter' && r.status === 'failed')).toBe(true);
    const stillRunning = new AgentRunStore({ logger: null }).list({ status: 'running', limit: 50 });
    expect(stillRunning.filter((r) => r.adapterId === 'boom-adapter')).toHaveLength(0);
  });

  it('finally safety net settles if success settle throws (ensureSettled path)', async () => {
    const store = new AgentRunStore({ logger: null });
    const { AgentRunLifecycle } = await import('../../src/agents/AgentRunLifecycle.js');
    const real = new AgentRunLifecycle({ store, logger: null });
    let ensureCalls = 0;
    const lifecycle = {
      startRun: (args) => real.startRun(args),
      ensureSettled: (id, spec) => {
        ensureCalls += 1;
        // First success attempt throws → settleOk leaves unsettled; finally retries fail path.
        if (spec?.outcome === 'succeeded') throw new Error('finish_broke');
        return real.ensureSettled(id, spec);
      },
      finishRun: (...a) => real.finishRun(...a),
      failRun: (...a) => real.failRun(...a),
      cancelRun: (...a) => real.cancelRun(...a),
      deferRun: (...a) => real.deferRun(...a),
    };
    const adapter = new FakeAdapter();
    const result = await adapter.chat([{ role: 'user', content: 'hello' }], {
      skipResilience: true,
      agentRunLifecycle: lifecycle,
      budgetContext: { roomId: 'room-fn', adapterId: 'fake-adapter' },
    });
    expect(ensureCalls).toBeGreaterThanOrEqual(2);
    expect(result.agentRunId).toBeTruthy();
    const run = store.get(result.agentRunId);
    expect(run.status).toBe('failed');
    expect(String(run.error || '')).toMatch(/unterminated_run_settled_in_finally|finish_broke|failed/);
  });
});
