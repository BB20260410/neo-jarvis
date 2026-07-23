// FR-P0-4 补充安全不变量单测（Claude 成员独立稿，补 GPT canonical 测试未覆盖的路径）：
//   - 预算超限 -> failed + budgetState=blocked，绝不进入 dry_run
//   - asHandler()（NoeLoop 注入点）从 loop 上下文产出安全 act 并 completed
//   - 终态（blocked_safety）不会被 cancel 覆盖
//   - noe_acts 迁移已落地
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb, listEvents } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';

let tmp;

function makePipeline(overrides = {}) {
  return new ActPipeline({
    projectId: 'noe-safety',
    store: new ActStore({ projectId: 'noe-safety' }),
    approvalStore: new ApprovalStore({ audit: { recordSafe() {} } }),
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test' }) },
    audit: { recordSafe() {} },
    broadcast: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-safety-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ActPipeline 补充安全不变量（FR-P0-4）', () => {
  it('noe_acts 表存在（迁移已落地）', () => {
    const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='noe_acts'").get();
    expect(row?.name).toBe('noe_acts');
  });

  it('预算超限 → failed + budgetState=blocked，绝不进入 dry_run', async () => {
    const budget = {
      preflight() {
        const e = new Error('monthly budget exceeded');
        e.code = 'BUDGET_LIMIT_EXCEEDED';
        throw e;
      },
    };
    const pipe = makePipeline({ budget });
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: '复盘' });
    expect(res.ok).toBe(false);
    expect(res.act.status).toBe('failed');
    expect(res.act.budgetState).toBe('blocked');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('预算实现返回 blocked 数组但不抛错时也 fail-closed', async () => {
    const budget = {
      preflight() {
        return { ok: false, blocked: [{ id: 'budget-p0', metric: 'usd' }], warnings: [] };
      },
    };
    const pipe = makePipeline({ budget });
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: '复盘' });
    expect(res.ok).toBe(false);
    expect(res.act.status).toBe('failed');
    expect(res.act.budgetState).toBe('blocked');
    expect(res.act.failureReason).toContain('budget blocked');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('asHandler()（NoeLoop 注入点）从 loop 上下文产出安全 act 并 completed', async () => {
    const pipe = makePipeline();
    const handler = pipe.asHandler();
    const res = await handler({ focusItems: [{ id: 'f1', title: '焦点A' }], memoryStats: { visible: 3 } });
    expect(res.ok).toBe(true);
    expect(res.act.status).toBe('completed');
    expect(res.act.payload?.dryRunOnly).toBe(true);
  });

  it('does not run context sufficiency gating when requiredContext is absent', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({ action: 'noe.focus.review', riskLevel: 'low', title: '普通复盘' });

    expect(res.ok).toBe(true);
    expect(res.act.status).toBe('completed');
    expect(res.act.payload.contextSufficiency).toBeUndefined();
    expect(res.act.payload.actionEvidence.contextSufficiency).toBeNull();
  });

  it('blocks acts when critical context sufficiency is not met', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({
      action: 'noe.focus.review',
      riskLevel: 'low',
      title: '需要上下文',
      requiredContext: [{ id: 'permission-evidence', keywords: ['permission-evidence'], critical: true }],
      contextBundle: { sources: [{ kind: 'brief', text: 'missing required evidence' }] },
      maxGatherRounds: 1,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('context_sufficiency_not_met');
    expect(res.act.status).toBe('blocked_safety');
    expect(res.act.payload.contextSufficiency.blockers).toContain('critical_context_missing');
    expect(listEvents({ kind: 'noe_act_dry_run' })).toHaveLength(0);
  });

  it('records action evidence after context sufficiency passes', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({
      action: 'noe.focus.review',
      riskLevel: 'low',
      title: '上下文足够',
      requiredContext: [{ id: 'permission-evidence', keywords: ['permission-evidence'], critical: true }],
      contextBundle: { sources: [{ kind: 'brief', text: 'permission-evidence is present' }] },
      evidenceRefs: { plan: ['output/noe/plan.md'] },
    });

    expect(res.ok).toBe(true);
    expect(res.act.status).toBe('completed');
    expect(res.act.payload.contextSufficiency.sufficient).toBe(true);
    expect(res.act.payload.actionEvidence.refs.plan).toEqual(['output/noe/plan.md']);
    expect(res.act.payload.actionEvidence.contextSufficiency.sufficient).toBe(true);
  });

  it('records action evidence for real execution as well as dry-run paths', async () => {
    const pipe = makePipeline({
      executors: {
        'noe.focus.review': async () => ({ reviewed: true, evidenceRef: 'output/runtime.json' }),
      },
    });
    const res = await pipe.propose({
      action: 'noe.focus.review',
      riskLevel: 'low',
      title: '真实执行复盘',
      realExecute: true,
      requiredContext: [{ id: 'runtime-context', keywords: ['runtime-context'], critical: true }],
      contextBundle: { sources: [{ kind: 'brief', text: 'runtime-context is present' }] },
      evidenceRefs: {
        runtimeReport: ['output/runtime.json'],
        rollback: ['output/rollback.md'],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.act.status).toBe('completed');
    expect(res.act.payload.dryRunOnly).toBe(false);
    expect(res.act.payload.actionEvidence.dryRunOnly).toBe(false);
    expect(res.act.payload.actionEvidence.runtime).toMatchObject({ reviewed: true });
    expect(res.act.payload.actionEvidence.refs.runtimeReport).toEqual(['output/runtime.json']);
    expect(res.act.payload.actionEvidence.refs.rollback).toEqual(['output/rollback.md']);
  });

  it('终态 blocked_safety 不会被 cancel 覆盖', async () => {
    const pipe = makePipeline();
    const res = await pipe.propose({ action: 'file.delete', title: '删文件' });
    expect(res.act.status).toBe('blocked_safety');
    const after = pipe.store.cancel(res.act.id);
    expect(after.status).toBe('blocked_safety');
  });
});
