// @ts-check
// Approval -> act retry -> goal-step closure.
//
// Workspace act steps can pause at awaiting_approval. This resolver is wired from
// ApprovalStore.decide(): approved decisions resume the matching act, while
// rejected/cancelled decisions unblock the goal step as blocked.

const TERMINAL_DECISIONS = new Set(['approved', 'rejected', 'cancelled']);

function compactText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function goalRefFromAct(act = {}) {
  const payload = act?.payload && typeof act.payload === 'object' ? act.payload : {};
  const goalId = compactText(payload.goalId || payload.goal_id, 160);
  const stepIndex = Number(payload.stepIndex ?? payload.step_index);
  if (!goalId || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
  return { goalId, stepIndex };
}

function listAwaitingActs(actStore, approvalId) {
  if (!actStore) return [];
  if (typeof actStore.listByApprovalId === 'function') {
    return actStore.listByApprovalId(approvalId, { statuses: ['awaiting_approval'], limit: 100 });
  }
  if (typeof actStore.list === 'function') {
    return actStore.list({ status: 'awaiting_approval', limit: 100 }).filter((act) => act.approvalId === approvalId);
  }
  return [];
}

function statusFromRetry(result = {}) {
  const actStatus = result?.act?.status || '';
  if (result?.approvalRequired === true || actStatus === 'awaiting_approval') return 'awaiting_approval';
  if (result?.ok === true && actStatus === 'completed') return 'done';
  if (actStatus === 'failed') return 'failed';
  return 'blocked';
}

function noteForRetry(result = {}) {
  const finalStatus = statusFromRetry(result);
  const act = result?.act || {};
  if (finalStatus === 'done') {
    return `审批通过后自动续跑完成：${act.action || 'act'}${act.payload?.dryRunOnly ? '（dry-run 证据）' : ''}`;
  }
  if (finalStatus === 'awaiting_approval') {
    return `审批通过后续跑仍在等待审批：${act.approvalId || 'unknown'}`;
  }
  return `审批通过后自动续跑未完成：${compactText(result?.error || act.failureReason || act.status || 'unknown', 220)}`;
}

function noteForDecline(status) {
  const label = status === 'rejected' ? '拒绝' : '取消';
  return `审批已${label}，行动取消，目标步骤解除等待并标记为 blocked。`;
}

function recordActivity({ activityLog, approvalId, approvalStatus, act, goalRef, stepStatus, goalUpdated, retryResult = null, error = null }) {
  try {
    activityLog?.recordSafe?.({
      action: approvalStatus === 'approved' ? 'noe.goal_step.approval_resume' : 'noe.goal_step.approval_closed',
      actorType: 'system',
      actorId: 'approval-goal-resolver',
      entityType: goalRef ? 'noe_goal' : 'noe_act',
      entityId: goalRef?.goalId || act?.id || null,
      severity: stepStatus === 'done' ? 'info' : 'warn',
      status: stepStatus,
      details: {
        approvalId,
        approvalStatus,
        actId: act?.id || retryResult?.act?.id || null,
        actStatus: retryResult?.act?.status || act?.status || null,
        action: retryResult?.act?.action || act?.action || null,
        goalId: goalRef?.goalId || null,
        stepIndex: goalRef?.stepIndex ?? null,
        goalUpdated,
        retryOk: retryResult?.ok ?? null,
        error: error ? compactText(error, 300) : null,
      },
    });
  } catch { /* activity failure must not block approval decisions */ }
}

function syncGoalStep({ goalSystem, approvalId, approvalStatus, act, result = null, stepStatus, note, activityLog, error = null }) {
  const finalAct = result?.act || act;
  const goalRef = goalRefFromAct(finalAct) || goalRefFromAct(act);
  let goalUpdated = false;
  let goalDone = false;
  if (goalRef && goalSystem?.recordStepResult) {
    try {
      goalSystem.recordStepCheckpoint?.(goalRef.goalId, goalRef.stepIndex, {
        phase: approvalStatus === 'approved' ? 'approval_resume' : 'approval_decision',
        status: stepStatus,
        kind: 'act',
        action: finalAct?.action || act?.action || '',
        note,
        evidenceRef: finalAct?.logRef || act?.logRef || '',
        payload: {
          approvalId,
          approvalStatus,
          actId: finalAct?.id || act?.id || null,
          actStatus: finalAct?.status || act?.status || null,
          ok: result?.ok ?? null,
        },
        replaySafe: false,
      });
    } catch { /* checkpoint failure should not block closure */ }
    try {
      const res = stepStatus === 'done'
        ? goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { done: true, note })
        : goalSystem.recordStepResult(goalRef.goalId, goalRef.stepIndex, { status: stepStatus, note });
      goalUpdated = res?.ok === true;
      goalDone = res?.goalDone === true;
    } catch { /* goal update failure is reported through activity */ }
  }
  recordActivity({ activityLog, approvalId, approvalStatus, act: finalAct || act, goalRef, stepStatus, goalUpdated, retryResult: result, error });
  return { goalUpdated, goalDone, goalRef };
}

export function createNoeApprovalGoalResolver({
  actStore = null,
  actPipeline = null,
  goalSystem = null,
  activityLog = null,
  logger = console,
} = {}) {
  return async function resolveApprovalGoalDecision(approvalId, { status, approval } = {}) {
    const id = compactText(approvalId || approval?.id, 160);
    const approvalStatus = compactText(status || approval?.status, 40);
    if (!id || !TERMINAL_DECISIONS.has(approvalStatus)) {
      return { ok: true, skipped: true, reason: 'non_terminal_or_missing_approval', approvalId: id || null, status: approvalStatus || null };
    }
    const acts = listAwaitingActs(actStore, id);
    if (!acts.length) return { ok: true, approvalId: id, status: approvalStatus, count: 0, results: [] };
    const results = [];
    for (const act of acts) {
      if (approvalStatus === 'approved') {
        if (!actPipeline?.retry) {
          const note = '审批通过，但 ActPipeline.retry 未配置，目标步骤保持 blocked 以免永久等待。';
          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, stepStatus: 'blocked', note, activityLog, error: 'act_pipeline_retry_not_configured' });
          results.push({ actId: act.id, ok: false, status: 'blocked', error: 'act_pipeline_retry_not_configured', ...synced });
          continue;
        }
        try {
          const retryResult = await actPipeline.retry(act.id, { approvalId: id, realExecute: true, reason: 'approval_approved_auto_resume' });
          const stepStatus = statusFromRetry(retryResult);
          const note = noteForRetry(retryResult);
          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, result: retryResult, stepStatus, note, activityLog, error: retryResult?.error || null });
          results.push({ actId: act.id, ok: retryResult?.ok === true, status: stepStatus, actStatus: retryResult?.act?.status || null, ...synced });
        } catch (e) {
          const error = e?.message || String(e);
          const note = `审批通过后自动续跑失败：${compactText(error, 220)}`;
          const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act, stepStatus: 'failed', note, activityLog, error });
          logger?.warn?.('[noe-approval-goal] auto resume failed:', error);
          results.push({ actId: act.id, ok: false, status: 'failed', error: compactText(error, 300), ...synced });
        }
        continue;
      }
      const cancelled = actStore?.cancel?.(act.id, { reason: `approval_${approvalStatus}` }) || act;
      const note = noteForDecline(approvalStatus);
      const synced = syncGoalStep({ goalSystem, approvalId: id, approvalStatus, act: cancelled || act, stepStatus: 'blocked', note, activityLog });
      results.push({ actId: act.id, ok: true, status: 'blocked', actStatus: cancelled?.status || act.status, ...synced });
    }
    return { ok: true, approvalId: id, status: approvalStatus, count: results.length, results };
  };
}
