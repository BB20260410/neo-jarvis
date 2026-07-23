// @ts-check
import { requireOwnerToken } from '../auth/owner-token.js';
import { NoeMissionStore } from '../../runtime/mission/NoeMissionStore.js';
import { safeMissionId } from '../../runtime/mission/NoeMissionContract.js';

function capLimit(value, fallback = 20, max = 100) {
  return Math.max(1, Math.min(max, Number(value) || fallback));
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function missionIdFromReq(req = {}) {
  const raw = String(req.params?.missionId || '').trim();
  const safe = safeMissionId(raw);
  if (!raw || raw !== safe) {
    const error = new Error('invalid missionId');
    error.statusCode = 400;
    throw error;
  }
  return safe;
}

function compactWaitingApproval(waiting = null) {
  if (!waiting) return null;
  return {
    actionId: clean(waiting.actionId, 160),
    reasons: asArray(waiting.reasons).map((item) => clean(item, 240)),
    risks: asArray(waiting.risks).map((item) => clean(item, 160)),
    missionAutonomyLevel: clean(waiting.missionAutonomyLevel, 80),
    requiredAutonomyLevel: clean(waiting.requiredAutonomyLevel, 80),
    at: waiting.at || null,
  };
}

function compactMission({ mission = null, state = null, events = [] } = {}) {
  const plan = asArray(mission?.plan);
  const cursor = Number(state?.current_cursor || 0);
  const total = plan.length;
  const latestEvent = events[events.length - 1] || null;
  return {
    missionId: clean(state?.missionId || mission?.missionId, 160),
    objective: clean(mission?.objective, 240),
    status: clean(state?.status || 'unknown', 80),
    phase: clean(state?.phase || '', 80),
    autonomyLevel: clean(mission?.autonomyLevel || 'read_only', 80),
    currentCursor: cursor,
    currentSlice: Number(state?.current_slice || 0),
    totalActions: total,
    progressPct: total ? Math.round(Math.min(1, cursor / total) * 100) : 0,
    lastHeartbeat: state?.last_heartbeat || null,
    updatedAt: state?.updatedAt || null,
    blockers: asArray(state?.blockers).slice(0, 8),
    recoveryAttempts: Number(state?.recovery_attempts || 0),
    evidenceCount: asArray(state?.evidenceRefs).length,
    latestEvidenceRefs: asArray(state?.evidenceRefs).slice(-8),
    finalReportRef: state?.finalReportRef || null,
    lease: state?.lease ? {
      runnerId: clean(state.lease.runnerId, 120),
      acquiredAt: state.lease.acquiredAt || null,
      expiresAtMs: Number(state.lease.expiresAtMs || 0),
    } : null,
    nextAction: plan[cursor] ? {
      id: clean(plan[cursor].id, 160),
      type: clean(plan[cursor].type, 160),
      description: clean(plan[cursor].description || plan[cursor].why || plan[cursor].name, 220),
    } : null,
    waitingApproval: compactWaitingApproval(state?.waitingApproval || null),
    latestEvent: latestEvent ? {
      at: latestEvent.at || null,
      type: clean(latestEvent.type, 160),
      actionId: clean(latestEvent.actionId, 160),
    } : null,
  };
}

function reviewDecision(value) {
  const decision = clean(value, 40).toLowerCase();
  if (['approve', 'approved', 'allow', 'allowed', 'yes'].includes(decision)) return 'approved';
  if (['reject', 'rejected', 'deny', 'denied', 'no'].includes(decision)) return 'rejected';
  if (['cancel', 'cancelled', 'canceled'].includes(decision)) return 'cancelled';
  return '';
}

function sendError(res, error) {
  const status = Number(error?.statusCode || error?.status || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: error?.message || String(error) });
}

export function registerNoeMissionRoutes(app, {
  store = new NoeMissionStore(),
  now = Date.now,
} = {}) {
  app.get('/api/noe/missions', requireOwnerToken, (req, res) => {
    try {
      const states = store.listMissions({ limit: capLimit(req.query?.limit, 20, 100) });
      const missions = states.map((state) => {
        const mission = store.readMission(state.missionId);
        const events = store.readEvents(state.missionId, { limit: 1 });
        return compactMission({ mission, state, events });
      });
      const counts = missions.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});
      return res.json({ ok: true, enabled: true, missions, counts });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/missions/:missionId', requireOwnerToken, (req, res) => {
    try {
      const missionId = missionIdFromReq(req);
      const mission = store.readMission(missionId);
      const state = store.readState(missionId);
      if (!mission || !state) return res.status(404).json({ ok: false, error: 'mission not found' });
      const events = store.readEvents(missionId, { limit: capLimit(req.query?.eventsLimit, 80, 500) });
      return res.json({
        ok: true,
        mission: compactMission({ mission, state, events }),
        contract: mission,
        state,
        events,
        refs: store.refs(missionId),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/missions/:missionId/review', requireOwnerToken, (req, res) => {
    try {
      const missionId = missionIdFromReq(req);
      const state = store.readState(missionId);
      const mission = store.readMission(missionId);
      if (!mission || !state) return res.status(404).json({ ok: false, error: 'mission not found' });
      const waiting = compactWaitingApproval(state.waitingApproval);
      if (!waiting?.actionId) return res.status(409).json({ ok: false, error: 'mission is not waiting approval' });
      const decision = reviewDecision(req.body?.decision || req.body?.status);
      if (!decision) return res.status(400).json({ ok: false, error: 'decision must be approved|rejected|cancelled' });
      const at = new Date(Number(now())).toISOString();
      const approval = {
        decision,
        actionId: waiting.actionId,
        reasons: waiting.reasons,
        risks: waiting.risks,
        decidedAt: at,
        decidedBy: 'owner',
        note: clean(req.body?.note || '', 500),
      };
      const approvals = { ...(state.reviewApprovals || {}), [waiting.actionId]: approval };
      let nextState = {
        ...state,
        waitingApproval: null,
        reviewApprovals: approvals,
      };
      if (decision === 'approved') {
        nextState = { ...nextState, status: 'running', phase: 'running' };
      } else if (decision === 'cancelled') {
        nextState = { ...nextState, status: 'cancelled', phase: 'cancelled' };
      } else {
        nextState = {
          ...nextState,
          status: 'blocked',
          phase: 'blocked',
          blockers: [...asArray(state.blockers), { reason: `approval_rejected:${waiting.actionId}`, actionId: waiting.actionId, at }],
        };
      }
      nextState = store.writeState(missionId, nextState, { nowMs: now() });
      const checkpoint = store.writeCheckpoint(missionId, {
        slice: Number(nextState.current_slice || 0),
        cursor: Number(nextState.current_cursor || 0),
        actionId: waiting.actionId,
        status: `approval_${decision}`,
        approval,
      }, { nowMs: now() });
      store.addEvidenceRef(missionId, checkpoint.ref, { nowMs: now() });
      store.appendEvent(missionId, {
        type: 'mission.approval.decided',
        actionId: waiting.actionId,
        decision,
        reasons: waiting.reasons,
        risks: waiting.risks,
        evidenceRefs: [checkpoint.ref],
      }, { nowMs: now() });
      return res.json({ ok: true, decision, mission: compactMission({ mission, state: store.readState(missionId), events: store.readEvents(missionId, { limit: 1 }) }), checkpointRef: checkpoint.ref });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
