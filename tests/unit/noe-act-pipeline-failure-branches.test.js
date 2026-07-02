import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, listEvents } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-failure-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makePipeline(overrides = {}) {
  const store = new ActStore({ projectId: 'noe-failure' });
  const pipeline = new ActPipeline({
    projectId: 'noe-failure',
    store,
    approvalStore: new ApprovalStore({ audit: { recordSafe() {} } }),
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    audit: { recordSafe() {} },
    broadcast: () => {},
    logger: null,
    ...overrides,
  });
  return { pipeline, store };
}

describe('ActPipeline failure branches and retry behavior', () => {
  it('blocks low-risk dry-run acts when permission governance denies them', async () => {
    const { pipeline } = makePipeline({
      permission: { evaluatePermission: () => ({ decision: 'deny', reason: 'policy denied dry-run' }) },
    });

    const result = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked_safety');
    expect(result.act).toMatchObject({
      status: 'blocked_safety',
      permissionState: 'blocked_safety',
      failureReason: 'policy denied dry-run',
    });
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('keeps low-risk acts awaiting approval when permission governance asks', async () => {
    const { pipeline } = makePipeline({
      permission: { evaluatePermission: () => ({ decision: 'ask', reason: 'owner approval required by policy' }) },
    });

    const result = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low' });

    expect(result).toMatchObject({ ok: true, approvalRequired: true });
    expect(result.act).toMatchObject({
      status: 'awaiting_approval',
      permissionState: 'approval_required',
      failureReason: 'owner approval required by policy',
    });
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('retries a failed budget act after policy recovery and records one dry-run event', async () => {
    let budgetBlocked = true;
    const { pipeline } = makePipeline({
      budget: {
        preflight: () => budgetBlocked
          ? { ok: false, blocked: [{ metric: 'usd' }], warnings: [] }
          : { ok: true, blocked: [], warnings: [] },
      },
    });

    const failed = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low' });
    expect(failed.ok).toBe(false);
    expect(failed.act).toMatchObject({ status: 'failed', budgetState: 'blocked' });
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);

    budgetBlocked = false;
    const retried = await pipeline.retry(failed.act.id, { reason: 'budget recovered' });

    expect(retried.ok).toBe(true);
    expect(retried.act).toMatchObject({ status: 'completed', budgetState: 'ok' });
    expect(retried.act.payload).toMatchObject({
      retryCount: 1,
      retryReason: 'budget recovered',
      dryRunOnly: true,
    });
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });

  it('rejects retry from completed acts to avoid duplicate dry-run evidence', async () => {
    const { pipeline } = makePipeline();
    const completed = await pipeline.propose({ title: 'Review focus', action: 'noe.focus.review', riskLevel: 'low' });

    const retry = await pipeline.retry(completed.act.id, { reason: 'should not retry completed' });

    expect(retry).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('not retryable'),
      act: { status: 'completed' },
    });
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });

  it('F2 防御：executor 返回 {ok:false} 软失败(不抛错)→记 failed 非 completed（治 codex 第三轮 act 漏判残留）', async () => {
    const { pipeline } = makePipeline({
      autoExecuteLowRisk: true,
      executors: { 'noe.soft.fail': async () => ({ ok: false, error: 'soft failure not thrown' }) }, // 返回失败值不抛错
    });
    const result = await pipeline.propose({ title: 'soft fail', action: 'noe.soft.fail', riskLevel: 'low' });
    expect(result.ok).toBe(false); // 不再被无条件当成功吞掉
    expect(result.act.status).toBe('failed');
    expect(String(result.error || '')).toContain('soft failure');
  });
});
