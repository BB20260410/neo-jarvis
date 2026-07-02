// CE12 单元测试阶段补测（Claude 成员独立稿）：
// 补齐 CE05 明确列出的补审点——ActPipeline.retry() 失败重试全生命周期，
// 以及 #permissionPreflight 中此前未直测的分支：
//   - retry 不存在 act → 404；retry 非可重试状态 → 409；retry failed→retrying→completed
//   - permission.evaluatePermission 返回 deny → blocked_safety
//   - permission.evaluatePermission 返回 ask → awaiting_approval
//   - input.destructive=true 对良性 action 也强制 blocked_safety
//   - 预算 warnings → budgetState=warn 但仍 completed
//   - normalizeRisk 从 action 名推断风险（无显式 riskLevel）
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
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-retry-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makePipeline(overrides = {}) {
  return new ActPipeline({
    projectId: 'noe-retry',
    store: new ActStore({ projectId: 'noe-retry' }),
    approvalStore: new ApprovalStore({ audit: { recordSafe() {} } }),
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    audit: { recordSafe() {} },
    broadcast: () => {},
    ...overrides,
  });
}

describe('ActPipeline.retry 生命周期（FR-P0-4 补审点）', () => {
  it('retry 不存在的 act → 404', async () => {
    const pipe = makePipeline();
    const res = await pipe.retry('does-not-exist');
    expect(res).toMatchObject({ ok: false, status: 404, act: null });
  });

  it('retry 处于 completed（非可重试态）→ 409', async () => {
    const pipe = makePipeline();
    const done = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: '复盘' });
    expect(done.act.status).toBe('completed');
    const res = await pipe.retry(done.act.id);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/not retryable/);
  });

  it('retry failed → retrying → 预算恢复后重新跑到 completed，retryCount 自增', async () => {
    let budgetOk = false;
    const budget = {
      preflight: () => (budgetOk
        ? { ok: true, warnings: [], blocked: [] }
        : { ok: false, blocked: [{ id: 'b', metric: 'usd' }], warnings: [] }),
    };
    const pipe = makePipeline({ budget });

    const first = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: '复盘', costEstimateUsd: 0.01 });
    expect(first.ok).toBe(false);
    expect(first.act.status).toBe('failed');
    expect(first.act.budgetState).toBe('blocked');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);

    budgetOk = true;
    const retried = await pipe.retry(first.act.id, { reason: 'budget restored' });
    expect(retried.ok).toBe(true);
    expect(retried.act.status).toBe('completed');
    expect(retried.act.payload.retryCount).toBe(1);
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(1);
  });
});

describe('ActPipeline 权限/风险分支（FR-P0-4）', () => {
  it('permission 返回 deny → blocked_safety，无 dry-run 证据', async () => {
    const pipe = makePipeline({
      permission: { evaluatePermission: () => ({ decision: 'deny', reason: 'policy deny' }) },
    });
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_safety');
    expect(res.act.status).toBe('blocked_safety');
    expect(res.act.permissionState).toBe('blocked_safety');
    expect(res.act.failureReason).toContain('policy deny');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('permission 返回 ask → awaiting_approval，带回 approval id', async () => {
    const pipe = makePipeline({
      permission: { evaluatePermission: () => ({ decision: 'ask', reason: 'needs approval', approval: { id: 'appr-xyz' } }) },
    });
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: 'x' });
    expect(res.ok).toBe(true);
    expect(res.approvalRequired).toBe(true);
    expect(res.act.status).toBe('awaiting_approval');
    expect(res.act.approvalId).toBe('appr-xyz');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('input.destructive=true 对良性低风险 action 也强制 blocked_safety', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: 'x', destructive: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_safety');
    expect(res.act.status).toBe('blocked_safety');
  });

  it('预算 warnings → budgetState=warn 但仍 completed', async () => {
    const pipe = makePipeline({
      budget: { preflight: () => ({ ok: true, warnings: ['near monthly cap'], blocked: [] }) },
    });
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: 'x' });
    expect(res.ok).toBe(true);
    expect(res.act.status).toBe('completed');
    expect(res.act.budgetState).toBe('warn');
  });

  it('normalizeRisk 从 action 名推断 high（无显式 riskLevel）→ 需审批', async () => {
    const pipe = makePipeline();
    // 'config.write' 命中 /write/ → high → 需审批（非 destructive）
    const res = await pipe.propose({ action: 'config.write', title: 'x' });
    expect(res.ok).toBe(true);
    expect(res.approvalRequired).toBe(true);
    expect(res.act.riskLevel).toBe('high');
    expect(res.act.status).toBe('awaiting_approval');
  });

  it('normalizeRisk 对 DESTRUCTIVE action 默认 critical（无显式 riskLevel）→ blocked_safety', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({ action: 'shell.exec', title: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_safety');
    expect(res.act.riskLevel).toBe('critical');
  });
});
