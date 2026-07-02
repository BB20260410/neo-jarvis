// @ts-check
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { sampleAwakening } from '../../src/cognition/NoeAwakeningSignals.js';

const DAY = 86_400_000;
// 2023-11-14T22:13:20Z — fixed to avoid Date.now() drift
const NOW = 1_700_000_000_000;
const SINCE = NOW - 7 * DAY;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE noe_expectations (
      id INTEGER PRIMARY KEY,
      created_at INTEGER,
      resolved_at INTEGER,
      outcome INTEGER,
      surprise REAL,
      p REAL,
      source TEXT,
      resolved_by TEXT
    );
    CREATE TABLE noe_goals (
      id INTEGER PRIMARY KEY,
      source TEXT,
      created_at INTEGER,
      status TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      kind TEXT,
      ts INTEGER
    );
    CREATE TABLE kv (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  return db;
}

describe('NoeAwakeningSignals.sampleAwakening', () => {
  let db;

  beforeEach(() => {
    db = freshDb();
  });

  it('returns deterministic envelope and safe defaults with an empty db', () => {
    const r = sampleAwakening(db, { now: NOW });
    expect(r.schemaVersion).toBe(1);
    expect(r.ts).toBe(NOW);
    expect(r.iso).toBe(new Date(NOW).toISOString());
    expect(r.liveDbMutated).toBe(false);
    expect(r.source.policy).toMatch(/read-only/);
    expect(r.dimensions.d1_predictionLearning).toEqual({
      failedSurpriseEligible: 0,
      surpriseGoals: 0,
      surpriseGoalsDone: 0,
      researchCompletionRate: null,
    });
    expect(r.dimensions.d2_integration).toEqual({
      integration: null,
      totalCorrelation: null,
      samples: 0,
      label: '未采样',
    });
    expect(r.dimensions.d3_calibration).toEqual({
      n: 0,
      brier: null,
      ownerN: 0,
      ownerBrier: null,
    });
    expect(r.dimensions.d4_spontaneity).toEqual({
      monologue24h: 0,
      episode24h: 0,
      activeSelfGoals: 0,
    });
  });

  it('D1 counts failedSurpriseEligible (excludes step_prediction) and computes researchCompletionRate', () => {
    // 2 eligible failed surprises within 7d, surprise >= 2, outcome=0
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 0, 5, 'neo')").run(SINCE + 1000);
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 0, 3, 'curiosity')").run(SINCE + 2000);
    // excluded: source='step_prediction' (bridge 伪预测)
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 0, 5, 'step_prediction')").run(SINCE + 3000);
    // excluded: older than 7d window
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 0, 5, 'neo')").run(SINCE - 1000);
    // excluded: surprise below gate (2)
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 0, 1, 'neo')").run(SINCE + 1000);
    // excluded: outcome=1 (hit, not miss)
    db.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise, source) VALUES (?, 1, 5, 'neo')").run(SINCE + 1000);

    // 3 surprise goals in window, 2 done
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('surprise', ?, 'done')").run(SINCE + 1000);
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('surprise', ?, 'open')").run(SINCE + 2000);
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('surprise', ?, 'done')").run(SINCE + 3000);
    // non-surprise goal: excluded from surpriseGoals counter
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('owner', ?, 'done')").run(SINCE + 1000);

    const r = sampleAwakening(db, { now: NOW });
    const d1 = r.dimensions.d1_predictionLearning;
    expect(d1.failedSurpriseEligible).toBe(2);
    expect(d1.surpriseGoals).toBe(3);
    expect(d1.surpriseGoalsDone).toBe(2);
    // 2/3 = 0.6666… → rounded(3) = 0.667
    expect(d1.researchCompletionRate).toBe(0.667);
  });

  it('D1 researchCompletionRate is null when no surprise goals exist', () => {
    const r = sampleAwakening(db, { now: NOW });
    expect(r.dimensions.d1_predictionLearning.researchCompletionRate).toBe(null);
  });

  it('D2 reads integration kv when present', () => {
    db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run(
      'noe.integration.reading',
      JSON.stringify({ integration: 0.73, totalCorrelation: 1.42, samples: 12, label: 'modular' })
    );
    const r = sampleAwakening(db, { now: NOW });
    expect(r.dimensions.d2_integration).toEqual({
      integration: 0.73,
      totalCorrelation: 1.42,
      samples: 12,
      label: 'modular',
    });
  });

  it('D3 brierAll computes all + owner holdout and excludes step_prediction', () => {
    // 3 included rows (owner, owner, system) — step_prediction row excluded
    db.prepare(`INSERT INTO noe_expectations
      (created_at, resolved_at, outcome, p, source, resolved_by)
      VALUES (?, ?, 1, 0.9, 'neo', 'owner')`).run(SINCE, NOW);
    db.prepare(`INSERT INTO noe_expectations
      (created_at, resolved_at, outcome, p, source, resolved_by)
      VALUES (?, ?, 0, 0.2, 'neo', 'owner')`).run(SINCE, NOW);
    db.prepare(`INSERT INTO noe_expectations
      (created_at, resolved_at, outcome, p, source, resolved_by)
      VALUES (?, ?, 1, 0.7, 'neo', 'system')`).run(SINCE, NOW);
    // excluded: source = 'step_prediction' (bridge 伪预测)
    db.prepare(`INSERT INTO noe_expectations
      (created_at, resolved_at, outcome, p, source, resolved_by)
      VALUES (?, ?, 0, 0.1, 'step_prediction', 'system')`).run(SINCE, NOW);
    // excluded: resolved_at IS NULL (未结算)
    db.prepare(`INSERT INTO noe_expectations
      (created_at, resolved_at, outcome, p, source, resolved_by)
      VALUES (?, NULL, 1, 0.5, 'neo', NULL)`).run(SINCE);

    const r = sampleAwakening(db, { now: NOW });
    // all 3: ((0.9-1)^2 + (0.2-0)^2 + (0.7-1)^2) / 3 = (0.01+0.04+0.09)/3 ≈ 0.0467 → 0.047
    expect(r.dimensions.d3_calibration.n).toBe(3);
    expect(r.dimensions.d3_calibration.brier).toBeCloseTo(0.047, 3);
    // owner 2: ((0.9-1)^2 + (0.2-0)^2) / 2 = 0.05/2 = 0.025
    expect(r.dimensions.d3_calibration.ownerN).toBe(2);
    expect(r.dimensions.d3_calibration.ownerBrier).toBeCloseTo(0.025, 3);
  });

  it('D4 counts monologue + episodes within 24h and active self goals (source != owner)', () => {
    // 2 self-talk within 24h
    db.prepare("INSERT INTO events (kind, ts) VALUES ('noe_self_talk_audit', ?)").run(NOW - 1000);
    db.prepare("INSERT INTO events (kind, ts) VALUES ('noe_self_talk_audit', ?)").run(NOW - 3_600_000);
    // 1 self-talk older than 24h — excluded
    db.prepare("INSERT INTO events (kind, ts) VALUES ('noe_self_talk_audit', ?)").run(NOW - 2 * DAY);
    // 1 episode within 24h
    db.prepare("INSERT INTO events (kind, ts) VALUES ('noe_episode', ?)").run(NOW - 2000);
    // 1 unrelated event
    db.prepare("INSERT INTO events (kind, ts) VALUES ('noe_goal_created', ?)").run(NOW - 1000);

    // 2 active self goals
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('curiosity', ?, 'active')").run(NOW - 1000);
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('surprise', ?, 'open')").run(NOW - 1000);
    // excluded: owner source
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('owner', ?, 'active')").run(NOW - 1000);
    // excluded: done status
    db.prepare("INSERT INTO noe_goals (source, created_at, status) VALUES ('curiosity', ?, 'done')").run(NOW - 1000);

    const r = sampleAwakening(db, { now: NOW });
    expect(r.dimensions.d4_spontaneity).toEqual({
      monologue24h: 2,
      episode24h: 1,
      activeSelfGoals: 2,
    });
  });

  it('D1 falls back to no source filter on old schema (no source column) — counts all eligible failures', () => {
    const oldDb = new Database(':memory:');
    oldDb.exec(`
      CREATE TABLE noe_expectations (
        id INTEGER PRIMARY KEY,
        created_at INTEGER,
        outcome INTEGER,
        surprise REAL
      );
      CREATE TABLE noe_goals (
        id INTEGER PRIMARY KEY,
        source TEXT,
        created_at INTEGER,
        status TEXT
      );
      CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, ts INTEGER);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);
    `);
    oldDb.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise) VALUES (?, 0, 5)").run(SINCE + 1000);
    oldDb.prepare("INSERT INTO noe_expectations (created_at, outcome, surprise) VALUES (?, 0, 5)").run(SINCE + 2000);

    const r = sampleAwakening(oldDb, { now: NOW });
    expect(r.dimensions.d1_predictionLearning.failedSurpriseEligible).toBe(2);
  });
});
