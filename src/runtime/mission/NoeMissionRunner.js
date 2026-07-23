// @ts-check
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { withActiveGuard } from '../NoeActiveJobGuard.js';
import { redactSensitiveText } from '../NoeContextScrubber.js';
import { NoeMissionCriteriaEngine } from './NoeMissionCriteriaEngine.js';
import { writeMissionFinalization } from './NoeMissionFinalizer.js';
import { NoeMissionReconciler } from './NoeMissionReconciler.js';
import { NoeMissionReviewGate } from './NoeMissionReviewGate.js';
import { NoeMissionStore } from './NoeMissionStore.js';

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowMs(deps) {
  return Number(typeof deps.nowMs === 'function' ? deps.nowMs() : deps.nowMs) || Date.now();
}

function refsFromResult(result = {}) {
  return [...new Set([...asArray(result.evidenceRefs), result.evidenceRef, result.artifactRef].filter(Boolean).map((ref) => clean(ref, 1000)))];
}

function compactRuntimeContext(context = null) {
  if (!context || typeof context !== 'object') return null;
  const vision = context.vision || context.peekVision || null;
  const out = {};
  if (vision?.summary) {
    out.vision = {
      summary: clean(vision.summary, 800),
      mode: clean(vision.mode || 'unknown', 80),
      at: vision.at || null,
      situation: vision.situation ? {
        activity: clean(vision.situation.activity || 'unknown', 80),
        attention: clean(vision.situation.attention || 'unknown', 80),
        possibleNeed: clean(vision.situation.possibleNeed || 'unknown', 120),
        shouldInterrupt: vision.situation.shouldInterrupt === true,
        confidence: Number(vision.situation.confidence || 0),
        stale: vision.situation.stale === true,
      } : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

function approvedReview(state = {}, actionId = '', gate = {}) {
  const approval = state.reviewApprovals?.[actionId];
  if (!approval || approval.decision !== 'approved') return false;
  const approvedReasons = new Set(asArray(approval.reasons));
  return asArray(gate.reasons).every((reason) => approvedReasons.has(reason));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Number(ms) || 0)));
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function observeMissionThinking({ mission = {}, state = {} } = {}) {
  const cursor = Number(state.current_cursor || 0);
  const plan = asArray(mission.plan);
  const evidenceCount = asArray(state.evidenceRefs).length;
  const recoveryAttempts = Number(state.recovery_attempts || 0);
  const noEvidenceSlices = Number(state.noEvidenceSlices || 0);
  const blockers = asArray(state.blockers).length;
  return {
    focus: plan[cursor] ? `next_action:${clean(plan[cursor].id || plan[cursor].type, 160)}` : 'criteria_reconciliation',
    confidence: blockers > 0 ? 'blocked' : (evidenceCount > 0 ? 'grounded' : 'needs_evidence'),
    uncertainty: noEvidenceSlices > 0 ? `no_new_evidence_slices:${noEvidenceSlices}` : null,
    recoveryAttempts,
    evidenceCount,
    rationale: clean(plan[cursor]?.why || plan[cursor]?.description || 'advance the next smallest verifiable action', 1000),
  };
}

export function buildMissionContext({ mission = {}, state = {}, runtimeContext = null } = {}) {
  const plan = asArray(mission.plan);
  const out = {
    missionId: clean(mission.missionId, 160),
    objective: clean(mission.objective, 4000),
    currentCriteria: asArray(mission.completionCriteria).map((item) => ({
      id: clean(item.id, 160),
      type: clean(item.type || item.description, 240),
      required: item.required !== false,
    })),
    lastCheckpoint: {
      current_cursor: Number(state.current_cursor || 0),
      current_slice: Number(state.current_slice || 0),
      last_heartbeat: state.last_heartbeat || null,
    },
    activeBlockers: asArray(state.blockers).map((item) => clean(typeof item === 'string' ? item : item.reason || item.id, 500)),
    latestEvidenceRefs: asArray(state.evidenceRefs).slice(-20).map((ref) => clean(ref, 1000)),
    nextAction: plan[Number(state.current_cursor || 0)] ? {
      id: clean(plan[Number(state.current_cursor || 0)].id, 160),
      type: clean(plan[Number(state.current_cursor || 0)].type, 160),
    } : null,
    selfObservation: observeMissionThinking({ mission, state }),
    hardBoundaries: {
      scope: asArray(mission.scope).map((item) => clean(JSON.stringify(item), 500)),
      forbidden: asArray(mission.forbidden).map((item) => clean(JSON.stringify(item), 500)),
      autonomyLevel: clean(mission.autonomyLevel, 80),
    },
  };
  const compact = compactRuntimeContext(runtimeContext);
  if (compact) out.runtimeContext = compact;
  return out;
}

export class NoeMissionRunner {
  constructor({
    root,
    store = new NoeMissionStore({ root }),
    criteriaEngine = new NoeMissionCriteriaEngine({ root: root || store.root }),
    reconciler = new NoeMissionReconciler({ root: root || store.root }),
    reviewGate = new NoeMissionReviewGate(),
    runnerId = `mission-runner-${process.pid}`,
    actionExecutors = {},
    leaseTtlMs = 30 * 60 * 1000,
    noEvidenceRecoveryAfter = 3,
    repeatedErrorBlockAfter = 3,
    runtimeContextProvider = null,
    nowMs: now = Date.now,
  } = {}) {
    this.root = resolve(root || store.root || process.cwd());
    this.store = store;
    this.criteriaEngine = criteriaEngine;
    this.reconciler = reconciler;
    this.reviewGate = reviewGate;
    this.runnerId = runnerId;
    this.actionExecutors = actionExecutors;
    this.leaseTtlMs = leaseTtlMs;
    this.noEvidenceRecoveryAfter = noEvidenceRecoveryAfter;
    this.repeatedErrorBlockAfter = repeatedErrorBlockAfter;
    this.runtimeContextProvider = typeof runtimeContextProvider === 'function' ? runtimeContextProvider : null;
    this.nowMs = now;
  }

  getRuntimeContext() {
    try { return this.runtimeContextProvider?.() || null; } catch { return null; }
  }

  buildContext(mission, state) {
    return buildMissionContext({ mission, state, runtimeContext: this.getRuntimeContext() });
  }

  async runSlice(missionId, opts = {}) {
    const guarded = await withActiveGuard(`mission:${missionId}`, () => this.runSliceLocked(missionId, opts));
    if (guarded.skipped) return { ok: false, status: 'running', reason: 'active_guard_conflict', guarded };
    return guarded.result;
  }

  async runUntilTerminal(missionId, opts = {}) {
    const terminal = new Set(['succeeded', 'blocked', 'paused', 'cancelled', 'waiting_approval']);
    const maxSlices = Number.isFinite(opts.maxSlices) ? Number(opts.maxSlices) : Infinity;
    const sliceDelayMs = Math.max(0, Number(opts.sliceDelayMs) || 0);
    const summaryEverySlices = Math.max(0, Number(opts.summaryEverySlices) || 0);
    const summaryEveryMs = Math.max(0, Number(opts.summaryEveryMs) || 0);
    const slices = [];
    if (this.isTimeSummaryDue(missionId, summaryEveryMs)) {
      this.writeRunSummary(missionId, { sliceCount: 0, trigger: 'time_catchup' });
    }
    while (slices.length < maxSlices) {
      const result = await this.runSlice(missionId, { maxActions: opts.maxActions || 1 });
      slices.push(result);
      const dueBySlice = summaryEverySlices > 0 && slices.length % summaryEverySlices === 0;
      const dueByTime = this.isTimeSummaryDue(missionId, summaryEveryMs);
      if (dueBySlice || dueByTime) {
        this.writeRunSummary(missionId, { sliceCount: slices.length, trigger: dueByTime ? 'time' : 'slice' });
      }
      if (terminal.has(result.status)) return { ok: result.status === 'succeeded', status: result.status, slices };
      if (sliceDelayMs > 0) await (opts.sleep || sleep)(sliceDelayMs);
    }
    this.pauseForCallerSliceLimit(missionId, { sliceCount: slices.length, reason: 'max_slices_reached_by_caller' });
    return { ok: false, status: 'paused', reason: 'max_slices_reached_by_caller', slices };
  }

  isTimeSummaryDue(missionId, summaryEveryMs = 0) {
    const intervalMs = Math.max(0, Number(summaryEveryMs) || 0);
    if (intervalMs <= 0) return false;
    const state = this.store.readState(missionId);
    if (!state) return false;
    const events = this.store.readEvents(missionId, { limit: 5000 });
    const createdAtMs = timestampMs(state.createdAt) ?? timestampMs(events[0]?.at || events[0]?.ts) ?? nowMs(this);
    const elapsedMs = Math.max(0, nowMs(this) - createdAtMs);
    const summaryCount = events.filter((event) => event.type === 'mission.run_summary.written').length;
    return elapsedMs >= (summaryCount + 1) * intervalMs;
  }

  pauseForCallerSliceLimit(missionId, { sliceCount = 0, reason = 'caller_limit' } = {}) {
    const mission = this.store.readMission(missionId);
    const state = this.store.readState(missionId);
    if (!mission || !state || ['succeeded', 'blocked', 'paused', 'cancelled', 'waiting_approval'].includes(state.status)) return null;
    const next = this.store.writeState(missionId, {
      ...state,
      status: 'paused',
      phase: 'paused',
      pauseReason: clean(reason, 1000),
    }, { nowMs: nowMs(this) });
    this.store.appendEvent(missionId, {
      type: 'mission.paused_by_caller_limit',
      reason,
      sliceCount,
    }, { nowMs: nowMs(this) });
    const events = this.store.readEvents(missionId, { limit: 5000 });
    const criteria = this.criteriaEngine.evaluate({ mission, state: next, events, root: this.root });
    const reconciliation = this.reconciler.reconcile({ mission, state: next, events, root: this.root });
    return writeMissionFinalization({
      store: this.store,
      missionId,
      mission,
      state: next,
      events,
      criteria,
      reconciliation,
      status: 'paused',
      reason,
      trigger: 'caller_slice_limit',
      sliceCount,
      nowMs: nowMs(this),
    });
  }

  writeRunSummary(missionId, { sliceCount = 0, trigger = 'manual' } = {}) {
    const mission = this.store.readMission(missionId);
    const state = this.store.readState(missionId);
    const events = this.store.readEvents(missionId, { limit: 5000 });
    if (!mission || !state) return null;
    const payload = {
      ok: true,
      kind: 'mission_run_summary',
      trigger,
      sliceCount,
      status: state.status,
      phase: state.phase,
      current_cursor: state.current_cursor,
      current_slice: state.current_slice,
      recovery_attempts: state.recovery_attempts,
      evidenceRefs: asArray(state.evidenceRefs).slice(-30),
      activeBlockers: asArray(state.blockers),
      eventCounts: events.reduce((acc, event) => {
        const key = clean(event.type || 'unknown', 160);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      selfObservation: observeMissionThinking({ mission, state }),
    };
    const artifact = this.store.writeArtifact(missionId, `run-summary-${String(state.current_slice || 0).padStart(6, '0')}.json`, payload, { nowMs: nowMs(this) });
    this.store.appendEvent(missionId, { type: 'mission.run_summary.written', summaryRef: artifact.ref, trigger, sliceCount }, { nowMs: nowMs(this) });
    return artifact;
  }

  async runSliceLocked(missionId, { maxActions = 1 } = {}) {
    const now = nowMs(this);
    const acquired = this.store.acquireLease(missionId, {
      runnerId: this.runnerId,
      ttlMs: this.leaseTtlMs,
      nowMs: now,
    });
    if (!acquired.ok) return { ok: false, status: 'running', reason: acquired.reason, lease: acquired.state?.lease };

    try {
      this.store.heartbeat(missionId, { runnerId: this.runnerId, ttlMs: this.leaseTtlMs, nowMs: nowMs(this) });
      const mission = this.store.readMission(missionId);
      let state = this.store.readState(missionId);
      if (!mission || !state) throw new Error(`mission not found: ${missionId}`);
      if (['succeeded', 'cancelled', 'paused', 'waiting_approval'].includes(state.status)) {
        return { ok: true, status: state.status, skipped: true };
      }

      const executed = [];
      const plan = asArray(mission.plan);
      const count = Math.max(1, Math.min(10, Number(maxActions) || 1));
      for (let i = 0; i < count && Number(state.current_cursor || 0) < plan.length; i += 1) {
        const action = plan[Number(state.current_cursor || 0)];
        const result = await this.executeAction(mission, state, action);
        executed.push(result);
        state = this.store.readState(missionId);
        if (state.status === 'blocked') break;
      }

      if (executed.length === 0) {
        state = this.applyNoEvidenceGuard(missionId, state, 'no_next_action');
      }

      const finalState = this.evaluateAndMaybeFinish(missionId);
      return { ok: finalState.status !== 'blocked', status: finalState.status, executed, state: finalState };
    } finally {
      this.store.releaseLease(missionId, { runnerId: this.runnerId, nowMs: nowMs(this) });
    }
  }

  async executeAction(mission, state, action = {}) {
    const actionId = clean(action.id || `action-${state.current_cursor || 0}`, 160);
    const gate = this.reviewGate.evaluate({ mission, action });
    if (!gate.ok && !approvedReview(state, actionId, gate)) return this.recordWaitingApproval(mission, state, actionId, gate);
    if (!gate.ok) {
      this.store.appendEvent(mission.missionId, { type: 'mission.action.review_approval_used', actionId, reasons: gate.reasons, risks: gate.risks }, { nowMs: nowMs(this) });
    }
    const startedAt = nowMs(this);
    this.store.appendEvent(mission.missionId, { type: 'mission.action.started', actionId, actionType: action.type }, { nowMs: startedAt });
    try {
      const executor = this.actionExecutors[action.type] || this.defaultExecutor.bind(this);
      const output = await executor({ mission, state, action, runner: this });
      const guarded = this.guardIncompleteResult(mission, state, actionId, output);
      if (guarded) return guarded;
      const evidenceRefs = refsFromResult(output);
      let next = this.store.readState(mission.missionId);
      for (const ref of evidenceRefs) next = this.store.addEvidenceRef(mission.missionId, ref, { nowMs: nowMs(this) });
      const hadEvidence = evidenceRefs.length > 0;
      next = this.store.updateState(mission.missionId, {
        ...next,
        status: next.status === 'recovering' ? 'running' : next.status,
        phase: next.phase === 'recovering' ? 'running' : next.phase,
        current_cursor: Number(next.current_cursor || 0) + 1,
        current_slice: Number(next.current_slice || 0) + 1,
        noEvidenceSlices: hadEvidence ? 0 : Number(next.noEvidenceSlices || 0) + 1,
        repeatedError: null,
        repeatedErrorCount: 0,
      }, { nowMs: nowMs(this) });
      if (!hadEvidence) next = this.applyNoEvidenceGuard(mission.missionId, next, `action_without_evidence:${actionId}`);
      const checkpoint = this.store.writeCheckpoint(mission.missionId, {
        slice: next.current_slice,
        cursor: next.current_cursor,
        actionId,
        status: 'completed',
        evidenceRefs,
        missionContext: this.buildContext(mission, next),
        result: output,
      }, { nowMs: nowMs(this) });
      this.store.addEvidenceRef(mission.missionId, checkpoint.ref, { nowMs: nowMs(this) });
      this.store.appendEvent(mission.missionId, {
        type: 'mission.action.completed',
        actionId,
        actionType: action.type,
        evidenceRefs: [...evidenceRefs, checkpoint.ref],
        exitCode: Number(output?.exitCode ?? 0),
      }, { nowMs: nowMs(this) });
      return { actionId, status: 'completed', evidenceRefs: [...new Set([...evidenceRefs, checkpoint.ref])] };
    } catch (error) {
      return this.recordActionError(mission, state, actionId, error);
    }
  }

  recordActionError(mission, state, actionId, error) {
    const reason = clean(error?.message || error, 1000);
    const same = state.repeatedError === reason;
    const repeated = same ? Number(state.repeatedErrorCount || 0) + 1 : 1;
    const blocker = repeated >= this.repeatedErrorBlockAfter ? { reason: `repeated_error:${reason}`, actionId } : null;
    const next = this.store.updateState(mission.missionId, {
      ...state,
      status: blocker ? 'blocked' : 'recovering',
      phase: blocker ? 'blocked' : 'recovering',
      current_slice: Number(state.current_slice || 0) + 1,
      recovery_attempts: Number(state.recovery_attempts || 0) + 1,
      repeatedError: reason,
      repeatedErrorCount: repeated,
      blockers: blocker ? [...asArray(state.blockers), blocker] : asArray(state.blockers),
    }, { nowMs: nowMs(this) });
    const checkpoint = this.store.writeCheckpoint(mission.missionId, {
      slice: next.current_slice,
      cursor: next.current_cursor,
      actionId,
      status: 'failed',
      error: reason,
      missionContext: this.buildContext(mission, next),
    }, { nowMs: nowMs(this) });
    this.store.addEvidenceRef(mission.missionId, checkpoint.ref, { nowMs: nowMs(this) });
    this.store.appendEvent(mission.missionId, { type: 'mission.action.failed', actionId, error: reason, evidenceRefs: [checkpoint.ref] }, { nowMs: nowMs(this) });
    return { actionId, status: 'failed', error: reason, evidenceRefs: [checkpoint.ref] };
  }

  recordWaitingApproval(mission, state, actionId, gate) {
    const next = this.store.updateState(mission.missionId, {
      ...state,
      status: 'waiting_approval',
      phase: 'waiting_approval',
      current_slice: Number(state.current_slice || 0) + 1,
      waitingApproval: {
        actionId,
        reasons: gate.reasons,
        risks: gate.risks,
        missionAutonomyLevel: gate.missionAutonomyLevel,
        requiredAutonomyLevel: gate.requiredAutonomyLevel,
        at: new Date(nowMs(this)).toISOString(),
      },
    }, { nowMs: nowMs(this) });
    const checkpoint = this.store.writeCheckpoint(mission.missionId, {
      slice: next.current_slice,
      cursor: next.current_cursor,
      actionId,
      status: 'waiting_approval',
      reviewGate: gate,
      missionContext: this.buildContext(mission, next),
    }, { nowMs: nowMs(this) });
    this.store.addEvidenceRef(mission.missionId, checkpoint.ref, { nowMs: nowMs(this) });
    this.store.appendEvent(mission.missionId, {
      type: 'mission.action.waiting_approval',
      actionId,
      reasons: gate.reasons,
      risks: gate.risks,
      evidenceRefs: [checkpoint.ref],
    }, { nowMs: nowMs(this) });
    return { actionId, status: 'waiting_approval', reasons: gate.reasons, evidenceRefs: [checkpoint.ref] };
  }

  guardIncompleteResult(mission, state, actionId, output = {}) {
    const reasons = [];
    if (output.truncated === true || output.incomplete === true || output.finishReason === 'length') reasons.push('truncated_or_incomplete_result');
    if (output.unavailable === true) reasons.push(`external_unavailable:${clean(output.provider || output.service || 'unknown', 160)}`);
    if (output.unverified === true) reasons.push('result_unverified');
    if (output.noOutputWatchdog === true) reasons.push('no_output_watchdog_process_tree_check_required');
    if (reasons.length === 0) return null;

    const refs = refsFromResult(output);
    let next = this.store.readState(mission.missionId) || state;
    for (const ref of refs) next = this.store.addEvidenceRef(mission.missionId, ref, { nowMs: nowMs(this) });
    next = this.store.updateState(mission.missionId, {
      ...next,
      status: 'recovering',
      phase: 'recovering',
      current_slice: Number(next.current_slice || 0) + 1,
      recovery_attempts: Number(next.recovery_attempts || 0) + 1,
    }, { nowMs: nowMs(this) });
    const checkpoint = this.store.writeCheckpoint(mission.missionId, {
      slice: next.current_slice,
      cursor: next.current_cursor,
      actionId,
      status: 'recovering',
      reasons,
      evidenceRefs: refs,
      missionContext: this.buildContext(mission, next),
    }, { nowMs: nowMs(this) });
    this.store.addEvidenceRef(mission.missionId, checkpoint.ref, { nowMs: nowMs(this) });
    this.store.appendEvent(mission.missionId, {
      type: 'mission.action.recovering',
      actionId,
      reasons,
      evidenceRefs: [...new Set([...refs, checkpoint.ref])],
      truncated: output.truncated === true || output.incomplete === true || output.finishReason === 'length',
      unavailable: output.unavailable === true,
      unverified: output.unverified === true,
      noOutputWatchdog: output.noOutputWatchdog === true,
      processTreeCheckRequired: output.noOutputWatchdog === true,
    }, { nowMs: nowMs(this) });
    return { actionId, status: 'recovering', reasons, evidenceRefs: [...new Set([...refs, checkpoint.ref])] };
  }

  applyNoEvidenceGuard(missionId, state, reason) {
    if (Number(state.noEvidenceSlices || 0) < this.noEvidenceRecoveryAfter) return state;
    const next = {
      ...state,
      status: 'recovering',
      phase: 'recovering',
      recovery_attempts: Number(state.recovery_attempts || 0) + 1,
    };
    this.store.appendEvent(missionId, { type: 'mission.progress_guard.recovery', reason }, { nowMs: nowMs(this) });
    return this.store.writeState(missionId, next, { nowMs: nowMs(this) });
  }

  evaluateAndMaybeFinish(missionId) {
    const mission = this.store.readMission(missionId);
    const state = this.store.readState(missionId);
    const events = this.store.readEvents(missionId, { limit: 5000 });
    const criteria = this.criteriaEngine.evaluate({ mission, state, events, root: this.root });
    const reconciliation = this.reconciler.reconcile({ mission, state, events, root: this.root });
    if (criteria.ok && reconciliation.ok) {
      const next = this.store.writeState(missionId, { ...state, status: 'succeeded', phase: 'complete', blockers: [] }, { nowMs: nowMs(this) });
      this.store.appendEvent(missionId, { type: 'mission.succeeded', criteria, reconciliation }, { nowMs: nowMs(this) });
      writeMissionFinalization({
        store: this.store,
        missionId,
        mission,
        state: next,
        events: this.store.readEvents(missionId, { limit: 5000 }),
        criteria,
        reconciliation,
        status: 'succeeded',
        reason: 'criteria_and_reconciliation_ok',
        trigger: 'evaluate',
        nowMs: nowMs(this),
      });
      return next;
    }
    const hasPlanLeft = Number(state.current_cursor || 0) < asArray(mission.plan).length;
    if (!hasPlanLeft && state.status !== 'recovering') {
      const next = this.store.writeState(missionId, {
        ...state,
        status: 'blocked',
        phase: 'blocked',
        blockers: [...new Set([...criteria.blockers, ...reconciliation.blockers])].map((reason) => ({ reason })),
      }, { nowMs: nowMs(this) });
      this.store.appendEvent(missionId, { type: 'mission.blocked', criteria, reconciliation }, { nowMs: nowMs(this) });
      writeMissionFinalization({
        store: this.store,
        missionId,
        mission,
        state: next,
        events: this.store.readEvents(missionId, { limit: 5000 }),
        criteria,
        reconciliation,
        status: 'blocked',
        reason: next.blockers[0]?.reason || 'criteria_or_reconciliation_blocked',
        trigger: 'evaluate',
        nowMs: nowMs(this),
      });
      return next;
    }
    this.store.appendEvent(missionId, { type: 'mission.evaluated', criteria, reconciliation }, { nowMs: nowMs(this) });
    return this.store.readState(missionId);
  }

  async defaultExecutor({ mission, action }) {
    if (action.type === 'write_artifact') {
      const name = clean(action.name || `${action.id || 'artifact'}.json`, 200);
      const artifact = this.store.writeArtifact(mission.missionId, name, action.content || { actionId: action.id, ok: true }, { nowMs: nowMs(this) });
      return { ok: true, artifactRef: artifact.ref, evidenceRefs: [artifact.ref] };
    }
    if (action.type === 'final_report') {
      const evidenceRefs = asArray(action.evidenceRefs).map((ref) => clean(ref, 1000));
      const artifact = this.store.writeArtifact(mission.missionId, action.name || 'final-report.json', {
        ok: true,
        missionId: mission.missionId,
        summary: clean(action.summary || 'Mission completed with evidence.', 4000),
        evidenceRefs,
      }, { nowMs: nowMs(this) });
      this.store.updateState(mission.missionId, (current) => ({ ...current, finalReportRef: artifact.ref }), { nowMs: nowMs(this) });
      return { ok: true, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], reportRef: artifact.ref };
    }
    if (action.type === 'self_observation') {
      const state = this.store.readState(mission.missionId);
      const observation = observeMissionThinking({ mission, state });
      const runtimeContext = compactRuntimeContext(this.getRuntimeContext());
      const artifact = this.store.writeArtifact(mission.missionId, action.name || 'self-observation.json', {
        ok: true,
        kind: 'mission_self_observation',
        observation,
        runtimeContext,
        note: clean(action.note || 'Structured observation of mission state, not hidden chain-of-thought.', 1000),
      }, { nowMs: nowMs(this) });
      this.store.appendEvent(mission.missionId, { type: 'mission.self_observation', observation, evidenceRefs: [artifact.ref] }, { nowMs: nowMs(this) });
      return { ok: true, artifactRef: artifact.ref, evidenceRefs: [artifact.ref] };
    }
    if (action.type === 'verify_file_exists') {
      const ref = clean(action.path || action.ref, 1000);
      const file = resolve(this.root, ref);
      // 前缀越界修复：带尾分隔符比对，防 /root 放行 /root-evil（姊妹文件 Reconciler/PatchTransaction 同款）。
      if (!(file === this.root || file.startsWith(this.root + sep)) || !existsSync(file)) throw new Error(`verify_file_missing:${ref}`);
      // 符号链接逃逸防护（多模型 review：MissionRunner 未继承 NoePatchTransaction 的 realpath 边界）：
      //   解析真实路径仍须在 root 内，防 root 内软链指向外部文件被当合法证据。两侧都 realpath（避 /tmp→/private/tmp 误杀）。
      const realRoot = realpathSync(this.root);
      const realFile = realpathSync(file);
      if (!(realFile === realRoot || realFile.startsWith(realRoot + sep))) throw new Error(`verify_file_missing:${ref}`);
      return { ok: true, evidenceRefs: [ref], commandId: action.commandId || action.id, exitCode: 0 };
    }
    if (action.type === 'noop') return { ok: true, evidenceRefs: [] };
    if (action.type === 'record_truncated') return { ok: false, truncated: true, finishReason: 'length' };
    if (action.type === 'record_unavailable') return { ok: false, unavailable: true, provider: action.provider || 'external_service' };
    if (action.type === 'record_unverified') return { ok: false, unverified: true };
    if (action.type === 'record_no_output_watchdog') return { ok: false, noOutputWatchdog: true };
    if (action.type === 'fail') throw new Error(clean(action.error || 'planned_failure', 1000));
    throw new Error(`unsupported_mission_action:${clean(action.type, 160)}`);
  }
}
