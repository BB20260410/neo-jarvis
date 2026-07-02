// @ts-check
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { redactSensitiveText } from '../NoeContextScrubber.js';

export const DEFAULT_SELF_LEARNING_DB_PATH = join(homedir(), '.noe-panel', 'panel.db');

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function artifactRef(missionId, name) {
  return `output/noe-missions/${missionId}/artifacts/${name}`;
}

function stepStatus(step = {}) {
  return clean(step.status || 'open', 80);
}

function isTerminalStep(step = {}) {
  return ['done', 'recovered'].includes(stepStatus(step));
}

function isActiveLike(status = '') {
  return ['open', 'active'].includes(clean(status, 80));
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

function compactCheckpoint(row = {}) {
  return {
    id: clean(row.id, 200),
    ts: Number(row.ts || 0),
    stepIndex: Number(row.step_index ?? -1),
    phase: clean(row.phase, 80),
    status: clean(row.status, 80),
    kind: clean(row.kind, 80),
    action: clean(row.action, 180),
    evidenceRef: clean(row.evidence_ref, 1000),
    replaySafe: Number(row.replay_safe || 0) === 1,
  };
}

function compactGoal(row = null) {
  if (!row) return null;
  const plan = parseJson(row.plan, []);
  return {
    id: clean(row.id, 200),
    createdAt: Number(row.created_at || 0),
    source: clean(row.source, 80),
    title: clean(row.title, 240),
    why: clean(row.why, 800),
    priority: Number(row.priority || 0),
    status: clean(row.status, 80),
    updatedAt: Number(row.updated_at || 0),
    plan: Array.isArray(plan) ? plan.map((step, index) => ({
      index,
      step: clean(step?.step, 300),
      kind: clean(step?.kind || 'think', 80),
      action: clean(step?.action || '', 180),
      status: stepStatus(step),
      updatedAt: Number(step?.updatedAt || 0),
      note: clean(step?.note || '', 500),
    })) : [],
  };
}

export function readSelfLearningGoalEvidence({ dbPath = DEFAULT_SELF_LEARNING_DB_PATH, goalId = '' } = {}) {
  const source = { dbPath: clean(dbPath, 1000), policy: 'read-only sqlite; no .env; no owner token; no model calls' };
  if (!existsSync(dbPath)) return { ok: false, error: `db_missing:${dbPath}`, source, goal: null, checkpoints: [] };
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (!tableExists(db, 'noe_goals')) return { ok: false, error: 'noe_goals_missing', source, goal: null, checkpoints: [] };
    const goal = goalId
      ? db.prepare("SELECT * FROM noe_goals WHERE id = ? AND source = 'self_learning'").get(goalId)
      : (
          db.prepare("SELECT * FROM noe_goals WHERE source = 'self_learning' AND status IN ('open','active') ORDER BY updated_at DESC LIMIT 1").get()
          || db.prepare("SELECT * FROM noe_goals WHERE source = 'self_learning' ORDER BY updated_at DESC LIMIT 1").get()
        );
    if (!goal) return { ok: false, error: goalId ? `self_learning_goal_not_found:${goalId}` : 'active_self_learning_goal_not_found', source, goal: null, checkpoints: [] };
    const checkpoints = tableExists(db, 'noe_goal_checkpoints')
      ? db.prepare('SELECT * FROM noe_goal_checkpoints WHERE goal_id = ? ORDER BY ts ASC, created_at ASC').all(goal.id).map(compactCheckpoint)
      : [];
    return { ok: true, error: '', source, goal: compactGoal(goal), checkpoints };
  } catch (error) {
    return { ok: false, error: clean(error?.message || error, 1000), source, goal: null, checkpoints: [] };
  } finally {
    try { db?.close?.(); } catch {}
  }
}

export function summarizeSelfLearningMissionCoverage({ goal = null, checkpoints = [] } = {}) {
  const blockers = [];
  if (!goal) {
    blockers.push('self_learning_goal_missing');
    return { ok: false, blockers, goalTerminal: false, stepCoverage: [], actionStepCount: 0, satisfiedActionSteps: 0 };
  }
  if (goal.source !== 'self_learning') blockers.push(`goal_source_not_self_learning:${goal.source}`);
  if (isActiveLike(goal.status)) blockers.push(`goal_not_terminal:${goal.status}`);
  if (!goal.plan.length) blockers.push('goal_plan_missing');

  const checkpointByStep = new Map();
  const evidenceByStep = new Map();
  const recoveryByStep = new Map();
  for (const checkpoint of checkpoints) {
    const index = Number(checkpoint.stepIndex);
    if (!checkpointByStep.has(index)) checkpointByStep.set(index, []);
    checkpointByStep.get(index).push(checkpoint);
    if (checkpoint.kind === 'act' && checkpoint.phase === 'evidence' && checkpoint.evidenceRef) evidenceByStep.set(index, checkpoint);
    if (checkpoint.phase === 'step_recovered' && checkpoint.status === 'recovered') recoveryByStep.set(index, checkpoint);
  }

  const stepCoverage = goal.plan.map((step) => {
    const index = Number(step.index);
    const terminal = isTerminalStep(step);
    const checkpointsForStep = checkpointByStep.get(index) || [];
    const evidence = evidenceByStep.get(index) || null;
    const recovery = recoveryByStep.get(index) || null;
    const stepBlockers = [];
    if (!terminal) stepBlockers.push(`step_not_terminal:${index}:${step.status}`);
    if (checkpointsForStep.length === 0) stepBlockers.push(`step_checkpoint_missing:${index}`);
    if (step.kind === 'act' && step.status === 'done' && !evidence) stepBlockers.push(`act_evidence_missing:${index}`);
    if (step.kind === 'act' && step.status === 'recovered' && !recovery) stepBlockers.push(`act_recovery_checkpoint_missing:${index}`);
    blockers.push(...stepBlockers);
    return {
      index,
      kind: step.kind,
      action: step.action || '',
      status: step.status,
      terminal,
      checkpointCount: checkpointsForStep.length,
      evidenceRef: evidence?.evidenceRef || '',
      recoveredByCheckpoint: Boolean(recovery),
      ok: stepBlockers.length === 0,
      blockers: stepBlockers,
    };
  });

  const actionSteps = stepCoverage.filter((step) => step.kind === 'act');
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    goalTerminal: goal.status === 'done' || (goal.plan.length > 0 && goal.plan.every(isTerminalStep)),
    stepCoverage,
    stepCount: goal.plan.length,
    terminalStepCount: goal.plan.filter(isTerminalStep).length,
    checkpointCount: checkpoints.length,
    actionStepCount: actionSteps.length,
    satisfiedActionSteps: actionSteps.filter((step) => step.ok).length,
  };
}

export function createSelfLearningMissionContract({ missionId = `p7-self-learning-${Date.now()}`, goalId = '' } = {}) {
  const snapshotRef = artifactRef(missionId, 'goal-snapshot.json');
  const coverageRef = artifactRef(missionId, 'goal-step-coverage.json');
  const observationRef = artifactRef(missionId, 'self-observation.json');
  const reportRef = artifactRef(missionId, 'final-report.json');
  const requiredRefs = [snapshotRef, coverageRef, observationRef];
  const target = goalId ? `goal ${goalId}` : 'the latest active self_learning goal';
  return {
    missionId,
    objective: `Attach ${target} to Mission Runtime so self-learning completion is evidence-gated and visible.`,
    scope: ['read panel SQLite self_learning rows', 'read goal checkpoints', 'write output/noe-missions/**'],
    forbidden: ['.env', 'secret values', 'owner token', 'room-adapters.json', '51735', 'games/cartoon-apocalypse/**', 'live write', 'external write', 'git reset', 'git clean'],
    autonomyLevel: 'read_only',
    rollbackPlan: ['Remove output/noe-missions/<missionId> if the generated local bridge evidence is no longer needed.'],
    reviewPolicy: {
      ownerGate: ['external_write', 'live_write', 'delete', 'publish', 'secret_access'],
      reviewBrain: ['code_write', 'self_evolution_apply', 'identity_memory_write'],
    },
    expectedArtifacts: [
      { id: 'goal_step_coverage', type: 'coverage_table', ref: coverageRef },
      { id: 'final_report', type: 'final_report', ref: reportRef },
    ],
    evidenceRequirements: requiredRefs.map((ref, index) => ({ id: `self-learning-required-${index + 1}`, ref, required: true })),
    completionCriteria: [
      ...requiredRefs.map((ref, index) => ({ id: `self-learning-evidence-${index + 1}`, type: 'evidence_ref_exists', ref })),
      { id: 'final-report-traces-self-learning-refs', type: 'final_report_traces_evidence', reportRef, evidenceRefs: requiredRefs },
      { id: 'no-open-blockers', type: 'no_unresolved_blockers' },
      { id: 'no-truncation', type: 'no_truncated_results' },
    ],
    metadata: {
      kind: 'p7_self_learning_mission_bridge',
      source: 'sqlite:noe_goals',
      goalId: goalId || null,
    },
    plan: [
      { id: 'goal-snapshot', type: 'self_learning_goal_snapshot', name: 'goal-snapshot.json', goalId },
      { id: 'goal-step-coverage', type: 'self_learning_step_coverage', name: 'goal-step-coverage.json', goalId },
      { id: 'observe-thinking', type: 'self_observation', name: 'self-observation.json' },
      { id: 'final-report', type: 'self_learning_final_report', name: 'final-report.json', goalId, evidenceRefs: requiredRefs },
    ],
  };
}

export function createSelfLearningMissionActionExecutors({ dbPath = DEFAULT_SELF_LEARNING_DB_PATH } = {}) {
  return {
    self_learning_goal_snapshot: async ({ mission, action, runner }) => {
      const evidence = readSelfLearningGoalEvidence({ dbPath, goalId: action.goalId || mission.metadata?.goalId || '' });
      const payload = {
        ok: evidence.ok,
        kind: 'self_learning_goal_snapshot',
        error: evidence.error || '',
        source: evidence.source,
        goal: evidence.goal ? { ...evidence.goal, plan: evidence.goal.plan.map((step) => ({ ...step, note: step.note ? '[present]' : '' })) } : null,
        checkpointCount: evidence.checkpoints.length,
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'goal-snapshot.json', payload);
      return { ok: evidence.ok, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], unverified: !evidence.ok };
    },
    self_learning_step_coverage: async ({ mission, action, runner }) => {
      const evidence = readSelfLearningGoalEvidence({ dbPath, goalId: action.goalId || mission.metadata?.goalId || '' });
      const coverage = summarizeSelfLearningMissionCoverage(evidence);
      const payload = {
        ok: evidence.ok && coverage.ok,
        kind: 'self_learning_goal_step_coverage',
        error: evidence.error || '',
        source: evidence.source,
        goal: evidence.goal ? {
          id: evidence.goal.id,
          title: evidence.goal.title,
          source: evidence.goal.source,
          status: evidence.goal.status,
          stepCount: evidence.goal.plan.length,
        } : null,
        coverage,
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'goal-step-coverage.json', payload);
      return { ok: payload.ok, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], unverified: !payload.ok };
    },
    self_learning_final_report: async ({ mission, action, runner }) => {
      const evidence = readSelfLearningGoalEvidence({ dbPath, goalId: action.goalId || mission.metadata?.goalId || '' });
      const coverage = summarizeSelfLearningMissionCoverage(evidence);
      const refs = (action.evidenceRefs || []).map((ref) => clean(ref, 1000));
      const payload = {
        ok: evidence.ok && coverage.ok,
        kind: 'self_learning_mission_final_report',
        missionId: mission.missionId,
        objective: mission.objective,
        goal: evidence.goal ? {
          id: evidence.goal.id,
          title: evidence.goal.title,
          status: evidence.goal.status,
          terminalStepCount: coverage.terminalStepCount,
          stepCount: coverage.stepCount,
        } : null,
        coverage,
        requiredEvidenceRefs: refs,
        evidenceRefs: refs,
        nextAction: coverage.ok
          ? 'Self-learning goal can be treated as Mission Runtime verified.'
          : 'Keep the mission recovering until the goal reaches done/recovered steps with checkpoints and action evidence.',
      };
      const artifact = runner.store.writeArtifact(mission.missionId, action.name || 'final-report.json', payload);
      runner.store.updateState(mission.missionId, (current) => ({ ...current, finalReportRef: artifact.ref }));
      return { ok: payload.ok, artifactRef: artifact.ref, evidenceRefs: [artifact.ref], reportRef: artifact.ref, unverified: !payload.ok };
    },
  };
}

export function writeSelfLearningMissionSmokeDb(dbPath, { now = Date.parse('2026-06-13T00:00:00.000Z') } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(resolve(dbPath));
  const goalId = 'self-learning-smoke-goal';
  const plan = [
    { step: 'search', kind: 'research', status: 'done', updatedAt: now },
    { step: 'activate browser', kind: 'act', action: 'macos.app.activate', status: 'done', updatedAt: now },
    { step: 'recover observe', kind: 'act', action: 'browser.observe_page', status: 'recovered', updatedAt: now },
    { step: 'think', kind: 'think', status: 'done', updatedAt: now },
  ];
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS noe_goals (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        source TEXT,
        title TEXT,
        why TEXT,
        priority REAL,
        status TEXT,
        plan TEXT,
        budget TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS noe_goal_checkpoints (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        goal_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        step TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        evidence_ref TEXT NOT NULL DEFAULT '',
        payload TEXT,
        replay_safe INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO noe_goals(id, created_at, source, title, why, priority, status, plan, budget, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(goalId, now, 'self_learning', '自主学习：Mission Runtime smoke', 'fixture', 0.7, 'done', JSON.stringify(plan), null, now);
    const insert = db.prepare('INSERT INTO noe_goal_checkpoints(id, ts, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    plan.forEach((step, index) => {
      insert.run(`cp-${index}`, now + index, goalId, index, 'step_done', step.status, step.kind, step.action || '', step.step, 'done', '', '{}', step.kind !== 'act' ? 1 : 0, now + index);
    });
    insert.run('cp-act-evidence', now + 20, goalId, 1, 'evidence', 'done', 'act', 'macos.app.activate', 'activate browser', 'evidence', 'sqlite:events/1', '{}', 0, now + 20);
    insert.run('cp-act-recovered', now + 21, goalId, 2, 'step_recovered', 'recovered', 'act', 'browser.observe_page', 'recover observe', 'recovered', '', '{}', 0, now + 21);
    return { dbPath, goalId };
  } finally {
    try { db.close(); } catch {}
  }
}
