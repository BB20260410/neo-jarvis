// @ts-check
// P7-G0: extracted goal-step recording state machine from NoeGoalSystem.
import { appendGoalCheckpoint } from './NoeGoalCheckpoints.js';

const STEP_STATUSES = new Set(['open', 'doing', 'awaiting_approval', 'blocked', 'failed', 'recovered', 'done']);
export const BLOCKING_STEP_STATUSES = new Set(['doing', 'awaiting_approval']);

export function normalizeGoalStepStatus(status, fallback = 'open') {
  const s = String(status || '').trim();
  return STEP_STATUSES.has(s) ? s : fallback;
}

function phaseForStepUpdate({ stepIndex, done, doing, status, newSteps }) {
  if (stepIndex === -1 && Array.isArray(newSteps) && newSteps.length) return 'plan_created';
  const s = normalizeGoalStepStatus(status, '');
  if (s === 'awaiting_approval') return 'approval_wait';
  if (s === 'blocked') return 'step_blocked';
  if (s === 'failed') return 'step_failed';
  if (s === 'recovered') return 'step_recovered';
  if (done) return 'step_done';
  if (doing) return 'step_started';
  return 'step_update';
}

function normalizeNewSteps(newSteps, { allowActKind = false, now = Date.now } = {}) {
  return newSteps.filter(Boolean).slice(0, 12).map((s) => {
    const text = typeof s === 'object' ? String(s.step || '') : String(s);
    // act 同 NoeGoalSystem.add()：只认显式对象声明；文本永不推断。
    const kind = (typeof s === 'object' && s.kind === 'act' && allowActKind)
      ? 'act'
      : (typeof s === 'object' && s.kind === 'research') || /搜|查资料|研究|调研|search|research/i.test(text)
        ? 'research'
        : 'think';
    return {
      step: text.slice(0, 200),
      kind,
      status: 'open',
      note: '',
      updatedAt: now(),
      ...(kind === 'act' && s.action ? { action: String(s.action).slice(0, 160) } : {}),
      ...(kind === 'act' && s.payload && typeof s.payload === 'object' ? { payload: s.payload } : {}),
    };
  }).filter((s) => s.step);
}

/**
 * @returns {{ok: boolean, goalDone: boolean, goal?: object}}
 */
export function recordGoalStepResult({
  getdb,
  getGoal,
  now = Date.now,
  allowActKind = false,
  goalId,
  stepIndex,
  input = {},
} = {}) {
  const { note = '', done = false, doing = false, status = null, newSteps = null } = input || {};
  try {
    const g = getGoal(goalId);
    if (!g) return { ok: false, goalDone: false };
    let plan = g.plan;
    if (stepIndex === -1 && Array.isArray(newSteps) && newSteps.length) {
      plan = normalizeNewSteps(newSteps, { allowActKind, now });
    } else if (stepIndex >= 0 && stepIndex < plan.length) {
      const currentStatus = normalizeGoalStepStatus(plan[stepIndex].status, 'open');
      const nextStatus = status
        ? normalizeGoalStepStatus(status, currentStatus)
        : done ? 'done' : doing ? 'doing' : currentStatus === 'doing' && !doing ? 'open' : currentStatus;
      plan[stepIndex] = {
        ...plan[stepIndex],
        note: note ? String(note).slice(0, 500) : plan[stepIndex].note,
        status: nextStatus,
        updatedAt: now(),
      };
    } else return { ok: false, goalDone: false };
    const allDone = plan.length > 0 && plan.every((s) => ['done', 'recovered'].includes(s.status));
    getdb().prepare('UPDATE noe_goals SET plan = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(plan), allDone ? 'done' : g.status, now(), goalId);
    const phase = phaseForStepUpdate({ stepIndex, done, doing, status, newSteps });
    const current = stepIndex >= 0 ? plan[stepIndex] : null;
    appendGoalCheckpoint(getdb(), {
      now,
      goal: { ...g, plan, status: allDone ? 'done' : g.status },
      goalId,
      stepIndex,
      phase,
      status: current?.status || (allDone ? 'done' : g.status),
      note,
      payload: stepIndex === -1 && Array.isArray(newSteps) ? { newStepCount: plan.length } : null,
      replaySafe: current?.kind !== 'act',
    });
    return { ok: true, goalDone: allDone, goal: allDone ? { ...g, plan, status: 'done' } : undefined };
  } catch {
    return { ok: false, goalDone: false };
  }
}
