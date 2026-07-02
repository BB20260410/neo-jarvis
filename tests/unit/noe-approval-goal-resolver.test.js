import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { createNoeApprovalGoalResolver } from '../../src/cognition/NoeApprovalGoalResolver.js';

let dir;
const T0 = 1_780_000_000_000;

beforeEach(() => {
  close();
  dir = mkdtempSync(join(tmpdir(), 'noe-approval-goal-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function makeHarness({ executor = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) } = {}) {
  const approvalStore = new ApprovalStore({ audit: { recordSafe() {} } });
  const actStore = new ActStore({ projectId: 'noe' });
  const goalSystem = createGoalSystem({ now: () => T0, allowActKind: true });
  const activityEvents = [];
  const actPipeline = new ActPipeline({
    projectId: 'noe',
    store: actStore,
    approvalStore,
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    executors: { 'config.write': executor },
    audit: { recordSafe() {} },
    broadcast: () => {},
    logger: { warn() {} },
  });
  const resolver = createNoeApprovalGoalResolver({
    actStore,
    actPipeline,
    goalSystem,
    activityLog: { recordSafe: (event) => activityEvents.push(event) },
    logger: { warn() {} },
  });
  return { approvalStore, actStore, goalSystem, actPipeline, resolver, activityEvents };
}

async function createAwaitingGoalAct({ goalSystem, actPipeline }) {
  const goalId = goalSystem.add({
    title: '审批闭环目标',
    source: 'owner',
    steps: [{ step: '写入配置', kind: 'act', action: 'config.write' }],
  });
  const first = await actPipeline.propose({
    title: '目标行动：写入配置',
    action: 'config.write',
    payload: {
      source: 'goal_step_act',
      goalId,
      stepIndex: 0,
      stepText: '写入配置',
    },
    realExecute: true,
    proposedBy: 'test',
  });
  expect(first.approvalRequired).toBe(true);
  expect(first.act.status).toBe('awaiting_approval');
  goalSystem.recordStepResult(goalId, 0, { status: 'awaiting_approval', note: first.act.approvalId });
  return { goalId, actId: first.act.id, approvalId: first.act.approvalId };
}

describe('NoeApprovalGoalResolver', () => {
  it('approved：自动 retry awaiting act，并把目标步骤收口为 done', async () => {
    const h = makeHarness();
    const { goalId, actId, approvalId } = await createAwaitingGoalAct(h);
    let hookPromise = null;
    h.approvalStore.setDecisionHook((id, ctx) => { hookPromise = h.resolver(id, ctx); });

    h.approvalStore.approve(approvalId, { decisionBy: 'owner-test' });
    const resolved = await hookPromise;

    expect(resolved).toMatchObject({ ok: true, approvalId, status: 'approved', count: 1 });
    expect(h.actStore.get(actId).status).toBe('completed');
    expect(h.goalSystem.get(goalId).plan[0].status).toBe('done');
    const checkpoints = h.goalSystem.checkpoints({ goalId, stepIndex: 0 });
    expect(checkpoints[checkpoints.length - 1]).toMatchObject({
      phase: 'step_done',
      status: 'done',
    });
    expect(checkpoints.some((cp) => cp.phase === 'approval_resume' && cp.status === 'done')).toBe(true);
    expect(h.activityEvents[0]).toMatchObject({
      action: 'noe.goal_step.approval_resume',
      entityType: 'noe_goal',
      entityId: goalId,
      status: 'done',
    });
  });

  it('rejected：取消 awaiting act，并把目标步骤解除等待为 blocked', async () => {
    const h = makeHarness();
    const { goalId, actId, approvalId } = await createAwaitingGoalAct(h);
    let hookPromise = null;
    h.approvalStore.setDecisionHook((id, ctx) => { hookPromise = h.resolver(id, ctx); });

    h.approvalStore.reject(approvalId, { decisionBy: 'owner-test', reason: 'not now' });
    const resolved = await hookPromise;

    expect(resolved).toMatchObject({ ok: true, approvalId, status: 'rejected', count: 1 });
    expect(h.actStore.get(actId).status).toBe('cancelled');
    expect(h.goalSystem.get(goalId).plan[0].status).toBe('blocked');
    expect(h.goalSystem.nextStep()).toBe(null);
    expect(h.goalSystem.checkpoints({ goalId, stepIndex: 0 }).some((cp) => cp.phase === 'approval_decision' && cp.status === 'blocked')).toBe(true);
    expect(h.activityEvents[0]).toMatchObject({
      action: 'noe.goal_step.approval_closed',
      entityType: 'noe_goal',
      entityId: goalId,
      status: 'blocked',
    });
  });
});
