// @ts-check
import { redactSensitiveText } from '../NoeContextScrubber.js';

export const NOE_MISSION_FINALIZER_SCHEMA_VERSION = 1;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function eventCounts(events = []) {
  return asArray(events).reduce((acc, event) => {
    const key = clean(event?.type || 'mission.event', 160);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function blockerReasons({ state = {}, criteria = {}, reconciliation = {} } = {}) {
  const stateBlockers = asArray(state.blockers).map((item) => (
    clean(typeof item === 'string' ? item : item.reason || item.id || JSON.stringify(item), 1000)
  ));
  return [...new Set([
    ...stateBlockers,
    ...asArray(criteria.blockers).map((item) => clean(item, 1000)),
    ...asArray(reconciliation.blockers).map((item) => clean(item, 1000)),
  ].filter(Boolean))];
}

function latestEvent(events = []) {
  const event = asArray(events).slice().reverse().find((item) => item && item.type);
  if (!event) return null;
  return {
    type: clean(event.type, 160),
    at: clean(event.at, 80),
    actionId: clean(event.actionId || event.commandId || '', 160) || null,
  };
}

export function buildMissionFinalization({
  mission = {},
  state = {},
  events = [],
  criteria = {},
  reconciliation = {},
  status = state.status || 'running',
  reason = '',
  trigger = 'evaluate',
  sliceCount = 0,
} = {}) {
  const blockers = blockerReasons({ state, criteria, reconciliation });
  const evidenceRefs = [...new Set([
    ...asArray(state.evidenceRefs),
    ...asArray(criteria.evidenceRefs),
    ...asArray(reconciliation.evidenceRefs),
  ].map((ref) => clean(ref, 1000)).filter(Boolean))];
  const terminal = ['succeeded', 'blocked', 'paused', 'cancelled', 'waiting_approval'].includes(clean(status, 80));
  const completed = status === 'succeeded' && blockers.length === 0;
  const explanation = completed
    ? 'Mission succeeded after criteria and evidence reconciliation passed.'
    : `Mission stopped with status ${clean(status, 80)}: ${clean(reason || blockers[0] || 'criteria_or_reconciliation_not_satisfied', 1000)}`;

  return {
    schemaVersion: NOE_MISSION_FINALIZER_SCHEMA_VERSION,
    kind: 'mission_finalization',
    missionId: clean(mission.missionId || state.missionId, 160),
    objective: clean(mission.objective, 4000),
    status: clean(status, 80),
    phase: clean(state.phase || status, 80),
    terminal,
    completed,
    reason: clean(reason || (completed ? 'criteria_and_reconciliation_ok' : 'not_completed'), 1000),
    trigger: clean(trigger, 160),
    sliceCount: Number(sliceCount || 0),
    current_cursor: Number(state.current_cursor || 0),
    current_slice: Number(state.current_slice || 0),
    recovery_attempts: Number(state.recovery_attempts || 0),
    evidenceRefs: evidenceRefs.slice(-50),
    blockers,
    warnings: [...new Set([
      ...asArray(criteria.warnings),
      ...asArray(reconciliation.warnings),
    ].map((item) => clean(item, 1000)).filter(Boolean))],
    eventCounts: eventCounts(events),
    latestEvent: latestEvent(events),
    criteria: {
      ok: criteria.ok === true,
      blockers: asArray(criteria.blockers).map((item) => clean(item, 1000)),
    },
    reconciliation: {
      ok: reconciliation.ok === true,
      blockers: asArray(reconciliation.blockers).map((item) => clean(item, 1000)),
      warnings: asArray(reconciliation.warnings).map((item) => clean(item, 1000)),
    },
    explanation,
    nextAction: completed ? 'none' : 'inspect blockers, add missing evidence, or resume mission from current cursor',
  };
}

export function writeMissionFinalization({
  store,
  missionId,
  mission,
  state,
  events,
  criteria,
  reconciliation,
  status,
  reason,
  trigger,
  sliceCount,
  nowMs,
} = {}) {
  if (!store || !missionId) return null;
  const payload = buildMissionFinalization({
    mission,
    state,
    events,
    criteria,
    reconciliation,
    status,
    reason,
    trigger,
    sliceCount,
  });
  const name = `finalization-${String(payload.current_slice || 0).padStart(6, '0')}.json`;
  const artifact = store.writeArtifact(missionId, name, payload, { nowMs });
  store.updateState(missionId, (current) => ({
    ...current,
    finalizationRef: artifact.ref,
    completionExplanation: payload.explanation,
  }), { nowMs });
  store.appendEvent(missionId, {
    type: 'mission.finalization.written',
    status: payload.status,
    reason: payload.reason,
    finalizationRef: artifact.ref,
    evidenceRefs: [artifact.ref],
  }, { nowMs });
  return { ...artifact, finalization: payload };
}
