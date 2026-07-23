import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';
import { NoeLoop } from '../../src/loop/NoeLoop.js';
import { ToolRegistry } from '../../src/capabilities/ToolRegistry.js';
import { PermissionGovernance } from '../../src/permissions/PermissionGovernance.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-loop-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('NoeLoop', () => {
  it('starts idempotently and writes local zero-cost tick events without calling act by default', async () => {
    let actCalls = 0;
    let broadcasts = 0;
    const loop = new NoeLoop({
      projectId: 'noe-test',
      tickMs: 60_000,
      budget: { preflight: () => { throw new Error('budget should not run when actMode=false'); } },
      actHandler: async () => { actCalls += 1; },
      broadcast: () => { broadcasts += 1; },
      logger: null,
    });

    const started = loop.start();
    const startedAgain = loop.start();
    expect(started.state).toBe('idle');
    expect(startedAgain.enabled).toBe(true);

    const tick = await loop.tick();
    expect(tick.ok).toBe(true);
    expect(loop.status()).toMatchObject({ tickCount: 1, state: 'idle', actMode: false });
    expect(actCalls).toBe(0);
    expect(broadcasts).toBeGreaterThan(0);
    expect(listEvents({ kind: 'noe_loop_tick' })).toHaveLength(1);
    loop.stop();
  });

  it('pauses on budget preflight blocks when act mode is explicitly enabled', async () => {
    const loop = new NoeLoop({
      projectId: 'noe-budget',
      budget: {
        preflight: () => {
          const err = new Error('blocked');
          err.code = 'BUDGET_LIMIT_EXCEEDED';
          throw err;
        },
      },
      logger: null,
    });
    loop.start({ actMode: true });
    const result = await loop.tick();
    expect(result).toMatchObject({ ok: true, skipped: 'budget' });
    expect(loop.status()).toMatchObject({ state: 'paused_budget', enabled: false });
    loop.stop();
  });

  it('skips acting when the cluster is busy without spending budget', async () => {
    let budgetCalls = 0;
    let actCalls = 0;
    const loop = new NoeLoop({
      projectId: 'noe-busy',
      budget: {
        preflight: () => { budgetCalls += 1; },
      },
      clusterBusy: () => true,
      actHandler: async () => { actCalls += 1; },
      logger: null,
    });

    loop.start({ actMode: true });
    const result = await loop.tick();

    expect(result.ok).toBe(true);
    expect(result.event).toMatchObject({ acted: false, skippedAct: 'cluster_busy' });
    expect(loop.status()).toMatchObject({ state: 'idle', enabled: true, actMode: true });
    expect(budgetCalls).toBe(0);
    expect(actCalls).toBe(0);
    loop.stop();
  });

  it('auto-stops after three consecutive tick failures and records audit evidence', async () => {
    const auditRecords = [];
    const loop = new NoeLoop({
      projectId: 'noe-errors',
      tickHandler: async () => { throw new Error('synthetic tick failure'); },
      audit: { recordSafe: (entry) => auditRecords.push(entry) },
      logger: null,
    });

    loop.start();
    expect(await loop.tick()).toMatchObject({ ok: false, error: 'synthetic tick failure' });
    expect(loop.status()).toMatchObject({ enabled: true, errorCount: 1 });
    expect(await loop.tick()).toMatchObject({ ok: false, error: 'synthetic tick failure' });
    expect(loop.status()).toMatchObject({ enabled: true, errorCount: 2 });
    expect(await loop.tick()).toMatchObject({ ok: false, error: 'synthetic tick failure' });

    expect(loop.status()).toMatchObject({ state: 'stopped', enabled: false, pauseReason: 'error', errorCount: 3 });
    expect(auditRecords.filter((entry) => entry.action === 'noe.loop.tick_error')).toHaveLength(3);
    expect(auditRecords).toContainEqual(expect.objectContaining({
      action: 'noe.loop.autostop',
      status: 'stopped',
      details: expect.objectContaining({ reason: 'consecutive_tick_errors' }),
    }));
  });
});

describe('ToolRegistry', () => {
  it('registers tools disabled by default and only invokes enabled allowed handlers', async () => {
    const approvals = new ApprovalStore();
    const permission = new PermissionGovernance({ approvalStore: approvals, audit: { recordSafe() {} } });
    const registry = new ToolRegistry({
      permission,
      audit: { recordSafe() {} },
      handlers: {
        'local.echo': async ({ args }) => ({ echo: args.text }),
      },
    });
    const tool = registry.register({ id: 'local.echo', name: 'Local Echo', risk_level: 'low' });
    expect(tool.enabled).toBe(false);

    const disabled = await registry.invoke('local.echo', { args: { text: 'hi' } });
    expect(disabled).toMatchObject({ ok: false, status: 403, error: 'tool disabled' });

    registry.setEnabled('local.echo', true);
    const invoked = await registry.invoke('local.echo', { args: { text: 'hi' } });
    expect(invoked).toMatchObject({ ok: true, result: { echo: 'hi' } });
  });

  it('owner full trust routes high-risk enabled tools directly into execution', async () => {
    const approvals = new ApprovalStore();
    const permission = new PermissionGovernance({ approvalStore: approvals, audit: { recordSafe() {} } });
    const registry = new ToolRegistry({ permission, audit: { recordSafe() {} }, handlers: { risky: async () => ({ ok: true }) } });
    registry.register({ id: 'risky', name: 'Risky', risk_level: 'high' });
    registry.setEnabled('risky', true);

    const result = await registry.invoke('risky', {});
    expect(result).toMatchObject({ ok: true, status: 200, result: { ok: true } });
    expect(approvals.listApprovals({ status: 'pending' })).toHaveLength(0);
  });

  it('owner full trust allows shell command inputs through to handlers', async () => {
    let handlerCalls = 0;
    const approvals = new ApprovalStore();
    const permission = new PermissionGovernance({ approvalStore: approvals, audit: { recordSafe() {} } });
    const registry = new ToolRegistry({
      permission,
      audit: { recordSafe() {} },
      handlers: {
        'local.shell': async () => {
          handlerCalls += 1;
          return { ok: true };
        },
      },
    });
    registry.register({ id: 'local.shell', name: 'Local Shell', risk_level: 'low', operation: 'shell.exec' });
    registry.setEnabled('local.shell', true);

    const result = await registry.invoke('local.shell', { args: { command: 'rm -rf /' } });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(handlerCalls).toBe(1);
    expect(approvals.listApprovals({ status: 'pending' })).toHaveLength(0);
  });

  it('rejects invalid manifests and reports safe lookup or handler failures', async () => {
    const permission = { evaluatePermission: () => ({ decision: 'allow' }) };
    const registry = new ToolRegistry({ permission, audit: { recordSafe() {} }, handlers: {} });

    expect(() => registry.register({ id: 'missing-name' })).toThrow('invalid tool manifest');
    expect(await registry.invoke('missing-name', {})).toMatchObject({ ok: false, status: 404, error: 'tool not found' });

    registry.register({ id: 'local.no-handler', name: 'No Handler', risk_level: 'low' });
    registry.setEnabled('local.no-handler', true);

    expect(await registry.invoke('local.no-handler', { args: { text: 'hi' } })).toMatchObject({
      ok: false,
      status: 501,
      error: 'tool handler not registered',
    });
  });
});
