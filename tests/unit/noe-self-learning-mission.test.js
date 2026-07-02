import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { NoeMissionReconciler } from '../../src/runtime/mission/NoeMissionReconciler.js';
import { NoeMissionRunner } from '../../src/runtime/mission/NoeMissionRunner.js';
import { NoeMissionStore } from '../../src/runtime/mission/NoeMissionStore.js';
import {
  createSelfLearningMissionActionExecutors,
  createSelfLearningMissionContract,
  summarizeSelfLearningMissionCoverage,
  writeSelfLearningMissionSmokeDb,
} from '../../src/runtime/mission/NoeSelfLearningMission.js';

const T0 = Date.parse('2026-06-13T00:00:00.000Z');

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'noe-self-learning-mission-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initGoalDb(dbPath, { goalId = 'goal-active', status = 'active', plan = [] } = {}) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE noe_goals (
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
      CREATE TABLE noe_goal_checkpoints (
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
      .run(goalId, T0, 'self_learning', '自主学习：fixture active', 'fixture', 0.7, status, JSON.stringify(plan), null, T0);
    db.prepare('INSERT INTO noe_goal_checkpoints(id, ts, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cp-0', T0 + 1, goalId, 0, 'step_done', 'done', 'research', '', 'search', 'done', '', '{}', 1, T0 + 1);
  } finally {
    db.close();
  }
  return { dbPath, goalId };
}

describe('Noe self-learning mission bridge', () => {
  it('runs a completed self_learning goal through Mission Runtime criteria and reconciler', async () => withTempRoot(async (root) => {
    const dbPath = join(root, 'panel.db');
    const fixture = writeSelfLearningMissionSmokeDb(dbPath, { now: T0 });
    const missionId = 'self-learning-complete';
    const store = new NoeMissionStore({ root });
    store.createMission(createSelfLearningMissionContract({ missionId, goalId: fixture.goalId }));
    const runner = new NoeMissionRunner({
      root,
      store,
      runnerId: 'self-learning-runner',
      actionExecutors: createSelfLearningMissionActionExecutors({ dbPath }),
    });

    const run = await runner.runUntilTerminal(missionId, { maxActions: 1, maxSlices: 10 });
    const state = store.readState(missionId);
    const mission = store.readMission(missionId);
    const events = store.readEvents(missionId, { limit: 500 });
    const reconciliation = new NoeMissionReconciler({ root }).reconcile({ mission, state, events, root });
    const report = JSON.parse(readFileSync(join(root, state.finalReportRef), 'utf8'));

    expect(run.status).toBe('succeeded');
    expect(state.status).toBe('succeeded');
    expect(reconciliation.ok).toBe(true);
    expect(report.kind).toBe('self_learning_mission_final_report');
    expect(report.goal.id).toBe(fixture.goalId);
    expect(report.coverage.ok).toBe(true);
    expect(report.evidenceRefs).toContain(`output/noe-missions/${missionId}/artifacts/goal-step-coverage.json`);
  }));

  it('keeps an unfinished active self_learning goal recovering instead of marking done', async () => withTempRoot(async (root) => {
    const dbPath = join(root, 'panel.db');
    const plan = [
      { step: 'search', kind: 'research', status: 'done', updatedAt: T0 },
      { step: 'use browser', kind: 'act', action: 'browser.open_url', status: 'open', updatedAt: T0 },
    ];
    const fixture = initGoalDb(dbPath, { status: 'active', plan });
    const missionId = 'self-learning-active';
    const store = new NoeMissionStore({ root });
    store.createMission(createSelfLearningMissionContract({ missionId, goalId: fixture.goalId }));
    const runner = new NoeMissionRunner({
      root,
      store,
      runnerId: 'self-learning-runner',
      actionExecutors: createSelfLearningMissionActionExecutors({ dbPath }),
    });

    await runner.runSlice(missionId, { maxActions: 1 });
    const second = await runner.runSlice(missionId, { maxActions: 1 });
    const state = store.readState(missionId);
    const coverage = JSON.parse(readFileSync(join(root, `output/noe-missions/${missionId}/artifacts/goal-step-coverage.json`), 'utf8'));

    expect(second.status).toBe('recovering');
    expect(state.status).toBe('recovering');
    expect(state.current_cursor).toBe(1);
    expect(coverage.ok).toBe(false);
    expect(coverage.coverage.blockers).toContain('goal_not_terminal:active');
    expect(coverage.coverage.blockers).toContain('step_not_terminal:1:open');
  }));

  it('requires recovered act steps to have recovery checkpoints', () => {
    const coverage = summarizeSelfLearningMissionCoverage({
      goal: {
        id: 'g',
        source: 'self_learning',
        status: 'done',
        plan: [{ index: 0, kind: 'act', action: 'browser.observe_page', status: 'recovered' }],
      },
      checkpoints: [],
    });

    expect(coverage.ok).toBe(false);
    expect(coverage.blockers).toContain('act_recovery_checkpoint_missing:0');
  });
});
