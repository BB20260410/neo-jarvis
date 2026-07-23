// @ts-check
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { sampleAwakening } from '../../scripts/noe-awakening-monitor.mjs';

const NOW = 1_781_000_000_000; // 固定毫秒时基（>1e12 → ts 判毫秒）
const HOUR = 3_600_000;

function makeDb({ withTables = true } = {}) {
  const db = new Database(':memory:');
  if (withTables) {
    db.exec(`
      CREATE TABLE noe_expectations (id INTEGER PRIMARY KEY, p REAL, outcome INTEGER, surprise REAL, resolved_at INTEGER, created_at INTEGER);
      CREATE TABLE noe_goals (id INTEGER PRIMARY KEY, source TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);
    `);
  }
  return db;
}

describe('sampleAwakening（P2 觉醒 4 维采样）', () => {
  it('空表（建表无数据）→ 4 维基线，不抛', () => {
    const db = makeDb();
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d1_predictionLearning.surpriseGoals).toBe(0);
    expect(s.dimensions.d2_integration.integration).toBeNull();
    expect(s.dimensions.d2_integration.label).toBe('未采样');
    expect(s.dimensions.d3_calibration.n).toBe(0);
    expect(s.dimensions.d4_spontaneity.monologue24h).toBe(0);
    expect(s.liveDbMutated).toBe(false);
    db.close();
  });

  it('D3 Brier：resolved 期望算对（解析值）', () => {
    const db = makeDb();
    const ins = db.prepare('INSERT INTO noe_expectations (p,outcome,surprise,resolved_at,created_at) VALUES (?,?,?,?,?)');
    ins.run(0.9, 1, 0.15, NOW, NOW); // (0.9-1)^2=0.01
    ins.run(0.2, 0, 0.32, NOW, NOW); // (0.2-0)^2=0.04
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d3_calibration.n).toBe(2);
    expect(s.dimensions.d3_calibration.brier).toBeCloseTo((0.01 + 0.04) / 2, 6);
    db.close();
  });

  it('P2-A（修三方审查 serious，三方共识）：D3 Brier 排除 source=step_prediction 伪预测 + owner holdout 分层（对齐账本 CAL-10）', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE noe_expectations (id INTEGER PRIMARY KEY, p REAL, outcome INTEGER, surprise REAL, resolved_at INTEGER, created_at INTEGER, source TEXT, resolved_by TEXT);
      CREATE TABLE noe_goals (id INTEGER PRIMARY KEY, source TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);
    `);
    const ins = db.prepare('INSERT INTO noe_expectations (p,outcome,surprise,resolved_at,created_at,source,resolved_by) VALUES (?,?,?,?,?,?,?)');
    ins.run(0.9, 1, 0.15, NOW, NOW, 'action_failure', 'owner');   // 真预测 (0.9-1)^2=0.01，owner holdout 旁证
    ins.run(0.2, 0, 0.32, NOW, NOW, 'owner_prediction', 'auto');  // 真预测 (0.2-0)^2=0.04
    ins.run(0.5, 1, 0.0, NOW, NOW, 'step_prediction', 'auto');    // 伪预测——bridge 代填 p 非 Neo 下注，应排除
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d3_calibration.n).toBe(2); // step_prediction 不计入（与账本 CAL-10 一致）
    expect(s.dimensions.d3_calibration.brier).toBeCloseTo((0.01 + 0.04) / 2, 6);
    expect(s.dimensions.d3_calibration.ownerN).toBe(1); // owner 裁决 holdout 分层（防 Goodhart 自评虚高）
    expect(s.dimensions.d3_calibration.ownerBrier).toBeCloseTo(0.01, 6);
    db.close();
  });

  it('P2[0]（修三方审查 minor）：D1 failedSurpriseEligible 排除 source=step_prediction，与同文件 D3 同口径', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE noe_expectations (id INTEGER PRIMARY KEY, p REAL, outcome INTEGER, surprise REAL, resolved_at INTEGER, created_at INTEGER, source TEXT);
      CREATE TABLE noe_goals (id INTEGER PRIMARY KEY, source TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);
    `);
    const ins = db.prepare('INSERT INTO noe_expectations (p,outcome,surprise,created_at,source) VALUES (?,?,?,?,?)');
    ins.run(0.8, 0, 2.5, NOW, 'action_failure');   // 真落空 surprise≥2 → 计入 D1
    ins.run(0.8, 0, 2.5, NOW, 'owner_prediction');  // 真落空 → 计入
    ins.run(0.5, 0, 3.0, NOW, 'step_prediction');   // bridge 伪预测落空——应排除，不虚高"预测-学习活性"
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d1_predictionLearning.failedSurpriseEligible).toBe(2); // step_prediction 不计入（与 D3 同口径）
    db.close();
  });

  it('D1 预测-学习：surprise 目标 + 完成率', () => {
    const db = makeDb();
    const ins = db.prepare('INSERT INTO noe_goals (source,status,created_at) VALUES (?,?,?)');
    ins.run('surprise', 'done', NOW);
    ins.run('surprise', 'active', NOW);
    ins.run('owner', 'done', NOW); // 非 surprise 不计 D1
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d1_predictionLearning.surpriseGoals).toBe(2);
    expect(s.dimensions.d1_predictionLearning.surpriseGoalsDone).toBe(1);
    expect(s.dimensions.d1_predictionLearning.researchCompletionRate).toBeCloseTo(0.5, 6);
    db.close();
  });

  it('D4 自发性：近 24h 内心独白 + 自主目标（排除 owner）', () => {
    const db = makeDb();
    const ev = db.prepare('INSERT INTO events (ts,kind) VALUES (?,?)');
    ev.run(NOW - HOUR, 'noe_self_talk_audit'); // 近 24h
    ev.run(NOW - HOUR * 2, 'noe_self_talk_audit');
    ev.run(NOW - HOUR * 48, 'noe_self_talk_audit'); // 超 24h 不计
    ev.run(NOW - HOUR, 'noe_episode');
    const g = db.prepare('INSERT INTO noe_goals (source,status,created_at) VALUES (?,?,?)');
    g.run('surprise', 'active', NOW); // 自主
    g.run('owner', 'active', NOW); // owner 不计自发
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d4_spontaneity.monologue24h).toBe(2);
    expect(s.dimensions.d4_spontaneity.episode24h).toBe(1);
    expect(s.dimensions.d4_spontaneity.activeSelfGoals).toBe(1);
    db.close();
  });

  it('D2 整合度：kv reading 解析', () => {
    const db = makeDb();
    db.prepare('INSERT INTO kv (k,v,updated_at) VALUES (?,?,?)')
      .run('noe.integration.reading', JSON.stringify({ integration: 0.42, totalCorrelation: 1.3, samples: 24, label: '中度整合' }), NOW);
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d2_integration.integration).toBe(0.42);
    expect(s.dimensions.d2_integration.samples).toBe(24);
    db.close();
  });

  it('完全无表（库空）→ fail-soft 全基线不抛', () => {
    const db = makeDb({ withTables: false });
    const s = sampleAwakening(db, { now: NOW });
    expect(s.dimensions.d3_calibration.n).toBe(0);
    expect(s.dimensions.d4_spontaneity.monologue24h).toBe(0);
    expect(s.schemaVersion).toBe(1);
    db.close();
  });
});
