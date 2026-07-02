// @ts-check
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEnd2EndReport,
  openReadonlyDb,
  writeEnd2EndReport,
} from '../../scripts/noe-self-maintenance-end2end-audit.mjs';

const tempRoots = [];

function makeTempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-self-maintenance-audit-'));
  tempRoots.push(dir);
  return dir;
}

function makeDb(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE noe_goals (
      id TEXT,
      created_at INTEGER,
      source TEXT,
      title TEXT,
      why TEXT,
      priority REAL,
      status TEXT,
      plan TEXT,
      updated_at INTEGER
    );
    CREATE TABLE noe_acts (
      id TEXT,
      title TEXT,
      action TEXT,
      status TEXT,
      failure_reason TEXT,
      payload TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      kind TEXT,
      tag TEXT,
      payload TEXT
    );
    CREATE TABLE noe_memory (
      id TEXT,
      source_type TEXT,
      scope TEXT,
      title TEXT,
      body TEXT,
      tags TEXT,
      hidden INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE noe_expectations (
      id TEXT,
      resolved_at INTEGER,
      surprise REAL
    );
  `);
  return db;
}

function writeFixtureFiles(root) {
  const skillsDir = join(root, 'skills');
  const sftDir = join(root, 'sft');
  mkdirSync(join(skillsDir, 'researcher'), { recursive: true });
  mkdirSync(sftDir, { recursive: true });
  writeFileSync(join(skillsDir, 'researcher', 'SKILL.md'), '# Researcher\n');
  writeFileSync(
    join(sftDir, 'pairs.jsonl'),
    [
      JSON.stringify({
        messages: [
          { role: 'system', content: 'You are Noe.' },
          { role: 'user', content: 'Summarize the lesson.' },
          { role: 'assistant', content: 'A valid assistant answer that is long enough.' },
        ],
      }),
      JSON.stringify({
        messages: [
          { role: 'user', content: 'What failed?' },
          { role: 'assistant', content: 'Another valid assistant answer with enough detail.' },
        ],
      }),
    ].join('\n') + '\n',
  );
  return { skillsDir, sftDir };
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('noe-self-maintenance-end2end-audit', () => {
  it('builds the P7-A0 top-level metrics from an isolated read-only baseline', () => {
    const root = makeTempRoot();
    const dbPath = join(root, 'panel.db');
    const db = makeDb(dbPath);
    const { skillsDir, sftDir } = writeFixtureFiles(root);
    const donePlan = [
      { step: 'research web evidence', kind: 'research', status: 'done' },
      { step: 'open browser', kind: 'act', action: 'browser.open_url', status: 'done' },
    ];
    const blockedPlan = [
      { step: 'scan local code', kind: 'act', action: 'shell.exec', status: 'blocked' },
      { step: 'write lesson', kind: 'think', status: 'open' },
    ];
    db.prepare('INSERT INTO noe_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('g1', 1, 'self_learning', 'Learn browser research', 'web memory reuse', 0.7, 'active', JSON.stringify(donePlan), 2);
    db.prepare('INSERT INTO noe_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('g2', 3, 'self_learning', 'Repair action failure', 'checkpoint recovery', 0.6, 'active', JSON.stringify(blockedPlan), 4);
    db.prepare('INSERT INTO noe_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('g3', 5, 'owner', 'Owner task', 'explicit', 1, 'done', JSON.stringify([{ step: 'done', kind: 'think', status: 'done' }]), 6);
    db.prepare('INSERT INTO noe_acts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a1', 'browser action', 'browser.open_url', 'completed', null, '{}', 10, 11);
    db.prepare('INSERT INTO noe_acts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a2', 'shell action', 'shell.exec', 'failed', 'browser_dom_host_mismatch: expected different host', '{}', 12, 13);
    db.prepare('INSERT INTO events (ts, kind, tag, payload) VALUES (?, ?, ?, ?)')
      .run(20, 'noe_episode', 'interaction', JSON.stringify({ episodeType: 'interaction' }));
    db.prepare('INSERT INTO events (ts, kind, tag, payload) VALUES (?, ?, ?, ?)')
      .run(21, 'noe_episode', 'inner', JSON.stringify({ episodeType: 'inner_monologue' }));
    db.prepare('INSERT INTO noe_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 'skill_distill', 'insight', 'web browser memory checkpoint', 'research web browser memory conflict checkpoint skill', 'night_reflection', 0, 30);
    db.prepare('INSERT INTO noe_expectations VALUES (?, ?, ?)')
      .run('e1', 40, 2.5);

    const report = buildEnd2EndReport({
      db,
      dbPath,
      now: 1_800_000_000_000,
      skillsDir,
      sftDir,
      sftTarget: 4,
      reportId: 'report-a',
    });

    expect(report.selfLearningGoalExecCount).toBe(2);
    expect(report.selfLearningSuccessRate).toBe(0.5);
    expect(report.failureModeClusters.length).toBeGreaterThan(0);
    expect(report.crossTopicKnowledgeReuse.score).toBeGreaterThan(0);
    expect(report.actStepOutcomeByKind['browser.open_url'].done).toBe(2);
    expect(report.actStepOutcomeByKind['shell.exec'].blocked).toBe(1);
    expect(report.actStepOutcomeByKind['shell.exec'].failed).toBe(1);
    expect(report.policy.readOnly).toBe(true);
    expect(report.policy.noLivePortsTouched).toBe(true);
    expect(report.skillDistillation.sftPairsProgress).toBe(0.5);
    db.close();
  });

  it('reports explicit blockers when there is no executed self-learning and SFT is insufficient', () => {
    const root = makeTempRoot();
    const dbPath = join(root, 'panel.db');
    const db = makeDb(dbPath);
    const { skillsDir, sftDir } = writeFixtureFiles(root);
    const report = buildEnd2EndReport({
      db,
      dbPath,
      skillsDir,
      sftDir,
      sftTarget: 100,
      reportId: 'report-b',
    });

    expect(report.readiness.ok).toBe(false);
    expect(report.readiness.blockers).toContain('no_self_learning_executed');
    expect(report.readiness.blockers).toContain('sft_dataset_insufficient');
    db.close();
  });

  it('opens the SQLite database with readonly and fileMustExist flags', () => {
    const root = makeTempRoot();
    const dbPath = join(root, 'panel.db');
    writeFileSync(dbPath, '');
    const calls = [];
    function FakeDb(path, opts) {
      calls.push({ path, opts });
      this.close = () => {};
    }

    const opened = openReadonlyDb({ dbPath, DatabaseCtor: FakeDb });

    expect(opened.exists).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ readonly: true, fileMustExist: true });
    opened.db.close();
  });

  it('writes timestamped reports and updates latest.json to the newest report', () => {
    const root = makeTempRoot();
    const outDir = join(root, 'out');
    const first = {
      reportId: 'first',
      generatedAt: 1_800_000_000_000,
      readiness: { ok: false, blockers: ['a'], warnings: [] },
    };
    const second = {
      reportId: 'second',
      generatedAt: 1_800_000_001_000,
      readiness: { ok: true, blockers: [], warnings: [] },
    };

    const writtenFirst = writeEnd2EndReport(first, { outDir });
    const writtenSecond = writeEnd2EndReport(second, { outDir });
    const latest = JSON.parse(readFileSync(writtenSecond.latest, 'utf8'));

    expect(writtenFirst.file).not.toBe(writtenSecond.file);
    expect(latest.reportId).toBe('second');
  });
});
