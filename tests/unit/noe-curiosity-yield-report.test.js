// @ts-check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildCuriosityYieldReport } from '../../scripts/noe-curiosity-yield-report.mjs';

// curiosity-yield 漏斗只读统计。隔离临时库 + readonly 句柄，证「只读不写 + 漏斗计数正确 + 诊断断点」。
// 不触网、不连 live 库、不依赖真实时钟（显式注入 now）。

const NOW = 1_700_000_000_000;

function seedDb(dbFile) {
  const w = new Database(dbFile);
  w.exec(`CREATE TABLE noe_expectations(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, source TEXT, claim TEXT, p REAL, due_at INTEGER, resolved_at INTEGER, outcome INTEGER, surprise REAL);
          CREATE TABLE noe_goals(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source TEXT, title TEXT, why TEXT, priority REAL, status TEXT, plan TEXT, budget TEXT, updated_at INTEGER);`);
  const e = w.prepare('INSERT INTO noe_expectations(created_at,source,claim,p,due_at,resolved_at,outcome,surprise) VALUES (?,?,?,?,?,?,?,?)');
  // 5 期望：1 open，1 unresolvable(resolved 但 outcome null)，1 应验，2 落空(1 个 surprise=3.3≥2 够格，1 个 surprise=0.7 不够)
  e.run(NOW, 'c', 'open one', 0.7, NOW - 1, null, null, null);
  e.run(NOW, 'c', 'sweep', 0.7, NOW - 1, NOW, null, null);
  e.run(NOW, 'c', 'applied', 0.8, NOW - 1, NOW, 1, 0.32);
  e.run(NOW, 'c', 'failed big', 0.9, NOW - 1, NOW, 0, 3.3);
  e.run(NOW, 'c', 'failed small', 0.4, NOW - 1, NOW, 0, 0.74);
  const g = w.prepare('INSERT INTO noe_goals(id,created_at,source,title,why,priority,status,plan,budget,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  g.run('g1', NOW, 'surprise', '搞明白A', '', 0, 'done', '[]', null, NOW);
  g.run('g2', NOW, 'surprise', '搞明白B', '', 0, 'open', '[]', null, NOW);
  g.run('g3', NOW, 'self', '别的目标', '', 0, 'open', '[]', null, NOW); // 非 surprise 不计入好奇漏斗
  w.close();
}

describe('buildCuriosityYieldReport（只读漏斗统计）', () => {
  let dir;
  let dbFile;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noe-cy-'));
    dbFile = join(dir, 'panel.sqlite');
    seedDb(dbFile);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('漏斗各节计数正确，且标记 liveDbMutated=false', () => {
    const ro = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const r = buildCuriosityYieldReport(ro, { sinceTs: 0, now: NOW });
      expect(r.liveDbMutated).toBe(false);
      expect(r.expectations).toMatchObject({
        created: 5, open: 1, resolvedUnresolvable: 1, settled: 3,
        applied: 1, failed: 2, failedSurpriseEligible: 1,
      });
      expect(r.research).toMatchObject({ surpriseGoals: 2, surpriseGoalsActive: 1, surpriseGoalsDone: 1 });
      const failedStage = r.funnel.find((s) => s.stage === 'failed');
      expect(failedStage.count).toBe(2);
      expect(failedStage.ofPrev).toBe(66.7); // 2/3 settled
      const doneStage = r.funnel.find((s) => s.stage === 'surprise_goals_done');
      expect(doneStage.ofPrev).toBe(50); // 1/2 surprise goals
    } finally { ro.close(); }
  });

  it('readonly 句柄拒绝任何写入（越权写抛错）', () => {
    const ro = new Database(dbFile, { readonly: true });
    try {
      expect(() => ro.prepare("INSERT INTO noe_goals(id,created_at,source,title,priority,status,updated_at) VALUES ('x',1,'s','t',0,'open',1)").run()).toThrow();
    } finally { ro.close(); }
  });

  it('空库：created=0 触发 no_expectations 诊断', () => {
    const empty = join(dir, 'empty.sqlite');
    const w = new Database(empty);
    w.exec('CREATE TABLE noe_expectations(id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, outcome INTEGER, resolved_at INTEGER, surprise REAL); CREATE TABLE noe_goals(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source TEXT, status TEXT);');
    w.close();
    const ro = new Database(empty, { readonly: true });
    try {
      const r = buildCuriosityYieldReport(ro, { sinceTs: 0, now: NOW });
      expect(r.expectations.created).toBe(0);
      expect(r.diagnostics).toContain('no_expectations: 账本为空，好奇回路无输入');
    } finally { ro.close(); }
  });

  it('缺表时不崩，计数归零', () => {
    const bare = join(dir, 'bare.sqlite');
    const w = new Database(bare);
    w.exec('CREATE TABLE kv(k TEXT, v TEXT);');
    w.close();
    const ro = new Database(bare, { readonly: true });
    try {
      const r = buildCuriosityYieldReport(ro, { sinceTs: 0, now: NOW });
      expect(r.tables).toEqual({ noe_expectations: false, noe_goals: false });
      expect(r.expectations.created).toBe(0);
      expect(r.research.surpriseGoals).toBe(0);
    } finally { ro.close(); }
  });

  it('#6 learning 段：surprise_lesson 写入 + hit_count>0 行为级被读信号（持久化可复核）', () => {
    const w = new Database(dbFile);
    w.exec('CREATE TABLE IF NOT EXISTS noe_memory(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, project_id TEXT, source_type TEXT, hit_count INTEGER DEFAULT 0, body TEXT)');
    const m = w.prepare('INSERT INTO noe_memory(id,created_at,project_id,source_type,hit_count,body) VALUES (?,?,?,?,?,?)');
    m.run('m1', NOW, 'noe', 'surprise_lesson', 2, 'lesson 被决策读过');
    m.run('m2', NOW, 'noe', 'surprise_lesson', 0, 'lesson 盲卡没人读');
    m.run('m3', NOW, 'noe', 'fact', 5, '普通 fact 不计入 lesson');
    w.close();
    const ro = new Database(dbFile, { readonly: true });
    try {
      const r = buildCuriosityYieldReport(ro, { sinceTs: 0, now: NOW });
      expect(r.learning).toMatchObject({ lessonsWritten: 2, lessonsRead: 1, readRate: 50 }); // 只 m1 hit_count>0
      expect(r.funnel.find((s) => s.stage === 'lessons_read').count).toBe(1);
    } finally { ro.close(); }
  });

  it('CLI 直跑产出 JSON 漏斗报告，且不修改库（mtime 不变）', () => {
    const before = statSync(dbFile).mtimeMs;
    const stdout = execFileSync(
      process.execPath,
      ['scripts/noe-curiosity-yield-report.mjs', '--json'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PANEL_DB_PATH: dbFile } },
    );
    const report = JSON.parse(stdout);
    expect(report.liveDbMutated).toBe(false);
    expect(report.expectations.failed).toBe(2);
    expect(report.research.surpriseGoalsDone).toBe(1);
    const after = statSync(dbFile).mtimeMs;
    expect(after).toBe(before);
  });
});
