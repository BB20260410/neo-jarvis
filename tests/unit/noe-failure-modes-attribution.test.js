// @ts-check
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFailureModesAttributionReport,
  runFailureModesAttribution,
} from '../../scripts/noe-failure-modes-attribution.mjs';

const tempRoots = [];
const T0 = 1_780_000_000_000;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-failure-attribution-'));
  tempRoots.push(dir);
  return dir;
}

function maintenanceReport() {
  return {
    schemaVersion: 1,
    generatedAtIso: '2026-06-12T15:58:12.653Z',
    readiness: { ok: true, blockers: [], warnings: ['failure_modes_present'] },
    failureModeClusters: [
      { cluster: 'browser_dom_host_mismatch', count: 9, examples: ['host mismatch'] },
      { cluster: 'act:blocked', count: 1, examples: ['config.write'] },
    ],
  };
}

function fixtureDb(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE noe_goals (id TEXT, created_at INTEGER, source TEXT, title TEXT, why TEXT, priority REAL, status TEXT, plan TEXT, updated_at INTEGER);
    CREATE TABLE noe_acts (id TEXT, project_id TEXT, title TEXT, action TEXT, risk_level TEXT, status TEXT, approval_id TEXT, budget_state TEXT, permission_state TEXT, failure_reason TEXT, evidence_event_id INTEGER, log_ref TEXT, cost_estimate_usd REAL, payload TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE noe_goal_checkpoints (id INTEGER PRIMARY KEY, ts INTEGER, goal_id TEXT, step_index INTEGER, phase TEXT, status TEXT, kind TEXT, action TEXT, step TEXT, note TEXT, evidence_ref TEXT, payload TEXT, replay_safe INTEGER, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, room_id TEXT, session_id TEXT, tag TEXT, entity_type TEXT, entity_id TEXT, task_id TEXT, payload TEXT, created_at INTEGER);
  `);
  const goalId = 'goal-raw-uuid-000000000000000000000000000000';
  const plan = [
    {
      kind: 'act',
      action: 'browser.observe_page',
      status: 'recovered',
      step: 'observe page',
      note: 'browser_dom_host_mismatch token sk-cp-1234567890abcdef1234567890',
    },
    {
      kind: 'act',
      action: 'config.write',
      status: 'blocked_safety',
      step: 'write config',
      note: 'blocked by safety gate',
    },
  ];
  db.prepare('INSERT INTO noe_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(goalId, T0, 'self_learning', '自主学习：浏览器证据', '', 0.5, 'done', JSON.stringify(plan), T0 + 1);
  db.prepare('INSERT INTO noe_acts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('act-raw-uuid-000000000000000000000000000000', null, 'observe', 'browser.observe_page', 'low', 'failed', null, null, null, 'browser_dom_host_mismatch', 42, 'sqlite:events/42', 0, '{}', T0, T0 + 1);
  db.prepare('INSERT INTO noe_acts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('act-missing-executor-0000000000000000000000000', null, 'write config', 'config.write', 'high', 'blocked_safety', null, null, null, 'real executor not registered for config.write', null, '', 0, '{}', T0, T0 + 1);
  db.prepare('INSERT INTO noe_goal_checkpoints (ts, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(T0, goalId, 0, 'act_done', 'recovered', 'act', 'browser.observe_page', 'observe', 'host mismatch recovered', 'sqlite:events/42', '{}', 1, T0 + 2);
  db.prepare('INSERT INTO noe_goal_checkpoints (ts, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(T0, goalId, 1, 'evidence', 'blocked', 'research', '', 'collect evidence', 'missing claim/action evidence link', '', '{}', 1, T0 + 3);
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(42, T0, 'noe_act_execute', null, null, 'act', 'act', 'act-raw-uuid-000000000000000000000000000000', null, '{}', T0);
  db.close();
}

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('noe-failure-modes-attribution', () => {
  it('attributes maintenance clusters to redacted goal/act/checkpoint evidence without leaking secrets', () => {
    const root = tempDir();
    const dbPath = join(root, 'panel.db');
    fixtureDb(dbPath);
    const source = join(root, 'maintenance.json');
    writeFileSync(source, JSON.stringify(maintenanceReport()));
    const { report, written } = runFailureModesAttribution({
      sourceReportRef: source,
      dbPath,
      outDir: join(root, 'out'),
      now: T0,
    });
    const raw = readFileSync(written.latest, 'utf8');

    expect(report.ok).toBe(true);
    expect(report.failureModeClusters).toHaveLength(5);
    expect(report.summary.sourceClusterCount).toBe(2);
    expect(report.summary.derivedClusterCount).toBe(3);
    expect(report.failureModeClusters[0]).toMatchObject({
      cluster: 'browser_dom_host_mismatch',
      count: 9,
      derived: false,
      origin: 'maintenance_report',
      secretLeakRisk: true,
      severity: 'critical',
    });
    expect(report.failureModeClusters.map((cluster) => cluster.cluster)).toEqual([
      'browser_dom_host_mismatch',
      'act:blocked',
      'goal_checkpoint:evidence_blocked',
      'goal_checkpoint:step_recovered',
      'act_executor_missing',
    ]);
    expect(report.failureModeClusters.find((cluster) => cluster.cluster === 'goal_checkpoint:evidence_blocked')).toMatchObject({
      derived: true,
      origin: 'sqlite_goal_checkpoints',
      count: 1,
      matchedEvidenceCount: 1,
    });
    expect(report.failureModeClusters[0].sourceKinds).toContain('goal_plan');
    expect(report.failureModeClusters[0].sourceKinds).toContain('goal_checkpoint');
    expect(report.failureModeClusters[0].sourceKinds).toContain('act_ledger');
    expect(report.failureModeClusters[0].affectedGoalIds[0]).toMatch(/^goal_[a-f0-9]{12}$/);
    expect(report.failureModeClusters[0].affectedActIds[0]).toMatch(/^act_[a-f0-9]{12}$/);
    expect(report.summary.j0LiteGapSeedCount).toBe(5);
    expect(raw).not.toContain('goal-raw-uuid');
    expect(raw).not.toContain('act-raw-uuid');
    expect(raw).not.toContain('sqlite:noe_goal_checkpoints/NaN');
    expect(raw).not.toContain('sk-cp-1234567890abcdef1234567890');
  });

  it('keeps source count separate from matched evidence count', () => {
    const report = buildFailureModesAttributionReport({
      sourceReport: maintenanceReport(),
      sourceReportRef: '/repo/output/noe-self-maintenance-end2end/latest.json',
      db: null,
      dbPath: '/tmp/missing.db',
      dbExists: false,
      now: T0,
      reportRefs: [],
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('db_missing');
    expect(report.blockers).toContain('failure_mode_clusters_below_3');
    expect(report.failureModeClusters[0].count).toBe(9);
    expect(report.failureModeClusters[0].matchedEvidenceCount).toBe(0);
    expect(report.failureModeClusters[0].warnings).toContain('no_sqlite_match_for_cluster');
  });

  it('writes timestamped report.json and latest.json', () => {
    const root = tempDir();
    const dbPath = join(root, 'panel.db');
    fixtureDb(dbPath);
    const source = join(root, 'maintenance.json');
    writeFileSync(source, JSON.stringify(maintenanceReport()));
    const outDir = join(root, 'out');
    const { written } = runFailureModesAttribution({ sourceReportRef: source, dbPath, outDir, now: T0 });

    expect(written.file).toMatch(/report\.json$/);
    expect(JSON.parse(readFileSync(written.file, 'utf8')).policy.noLivePortsTouched).toBe(true);
    expect(JSON.parse(readFileSync(written.latest, 'utf8')).source.maintenanceReportFound).toBe(true);
  });
});
