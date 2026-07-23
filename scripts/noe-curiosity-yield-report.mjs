#!/usr/bin/env node
// @ts-check
// Curiosity-yield funnel report (READ-ONLY). Audits the live "想错了→好奇→学习"
// loop without ever writing: 期望立 N → 自动判证 M(outcome NOT NULL) → 落空 K(outcome=0)
//   → 够格立研究 E(surprise≥2bit) → harvestSurprise 立项 H(noe_goals source=surprise)
//   → 完成研究 J(status=done)。
// 诊断 RESEARCH §9.2 阶段0：outcome=0 是否罕见、好奇回路漏在哪一节。
// 只跑 SELECT；DB 以 readonly 打开，越权写直接抛错。无模型调用、不触网。
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NOW = Date.now();
const DAY = 86_400_000;
// harvestSurprise 立项门槛：surprise = -log2(p_actual) ≥ 2 bit（与 NoeGoalSystem 同源常量）。
const SURPRISE_BIT_GATE = 2;
const SURPRISE_GOAL_SOURCE = 'surprise';

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = process.env.PANEL_DB_PATH
  || argValue('--db', join(HOME, '.noe-panel', 'panel.db'));
const SINCE_DAYS = Math.max(0, Number(argValue('--since-days', process.env.NOE_CURIOSITY_YIELD_SINCE_DAYS || '0')) || 0);
const SINCE_TS = SINCE_DAYS > 0 ? NOW - SINCE_DAYS * DAY : 0;
const AS_JSON = process.argv.includes('--json');

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch { return false; }
}

function num(v) { return Math.max(0, Math.round(Number(v) || 0)); }

/**
 * 纯函数漏斗统计：吃已打开的 readonly db 句柄，产结构化报告。注入式，便于单测。
 * @param {{ prepare: Function }} db
 * @param {{ sinceTs?: number, now?: number }} [opts]
 */
export function buildCuriosityYieldReport(db, { sinceTs = 0, now = Date.now() } = {}) {
  const hasExpect = tableExists(db, 'noe_expectations');
  const hasGoals = tableExists(db, 'noe_goals');
  const one = (sql, ...args) => {
    try { return db.prepare(sql).get(...args); } catch { return null; }
  };

  // —— 期望侧漏斗 ——
  const created = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ?', sinceTs)?.n)
    : 0;
  const open = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND resolved_at IS NULL', sinceTs)?.n)
    : 0;
  const resolvedNull = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND resolved_at IS NOT NULL AND outcome IS NULL', sinceTs)?.n)
    : 0; // 7 天 sweep / 人工留账 unresolvable（不计分）
  const settled = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome IS NOT NULL', sinceTs)?.n)
    : 0;
  const applied = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome = 1', sinceTs)?.n)
    : 0;
  const failed = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome = 0', sinceTs)?.n)
    : 0;
  // 落空中够格立研究（surprise≥2bit）。surprise 由 ledger.resolve 写入。
  const failedSurpriseEligible = hasExpect
    ? num(one('SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome = 0 AND surprise IS NOT NULL AND surprise >= ?', sinceTs, SURPRISE_BIT_GATE)?.n)
    : 0;

  // —— 好奇/研究侧漏斗 ——
  const surpriseGoals = hasGoals
    ? num(one('SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND created_at >= ?', SURPRISE_GOAL_SOURCE, sinceTs)?.n)
    : 0;
  const surpriseGoalsDone = hasGoals
    ? num(one("SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND status = 'done' AND created_at >= ?", SURPRISE_GOAL_SOURCE, sinceTs)?.n)
    : 0;
  const surpriseGoalsActive = hasGoals
    ? num(one("SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND status IN ('open','active') AND created_at >= ?", SURPRISE_GOAL_SOURCE, sinceTs)?.n)
    : 0;

  // —— 学习侧：learningHook 产出（治 #6/Claude C10：surprise_lesson 写入 + 行为级被读信号，persisted 须与 recall 命中率成对）——
  const hasMemory = tableExists(db, 'noe_memory');
  const lessonsWritten = hasMemory
    ? num(one("SELECT COUNT(*) n FROM noe_memory WHERE source_type = 'surprise_lesson' AND project_id = 'noe' AND created_at >= ?", sinceTs)?.n)
    : 0;
  // hit_count>0 = lesson 真被 Neo 决策召回过（行为级 learned 信号，非仅写入）；治「写进可取回但永不被读的盲卡」
  const lessonsRead = hasMemory
    ? num(one("SELECT COUNT(*) n FROM noe_memory WHERE source_type = 'surprise_lesson' AND project_id = 'noe' AND created_at >= ? AND hit_count > 0", sinceTs)?.n)
    : 0;

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const funnel = [
    { stage: 'expectations_created', label: '期望立项', count: created },
    { stage: 'auto_settled', label: '自动判证(outcome≠null)', count: settled, ofPrev: pct(settled, created) },
    { stage: 'failed', label: '落空(outcome=0)', count: failed, ofPrev: pct(failed, settled) },
    { stage: 'failed_surprise_eligible', label: '够格立研究(surprise≥2bit)', count: failedSurpriseEligible, ofPrev: pct(failedSurpriseEligible, failed) },
    { stage: 'surprise_goals', label: 'harvestSurprise 立项', count: surpriseGoals, ofPrev: pct(surpriseGoals, failedSurpriseEligible) },
    { stage: 'surprise_goals_done', label: '完成研究', count: surpriseGoalsDone, ofPrev: pct(surpriseGoalsDone, surpriseGoals) },
    { stage: 'lessons_written', label: 'learningHook 写入认知修正', count: lessonsWritten, ofPrev: pct(lessonsWritten, surpriseGoalsDone) },
    { stage: 'lessons_read', label: 'lesson 被决策真召回(hit_count>0)', count: lessonsRead, ofPrev: pct(lessonsRead, lessonsWritten) },
  ];

  // —— 诊断：定位漏斗最大断点 ——
  const diagnostics = [];
  if (created === 0) diagnostics.push('no_expectations: 账本为空，好奇回路无输入');
  if (created > 0 && settled === 0) diagnostics.push('no_auto_settlement: 立了期望但 outcome 全 null（判证器没接通或全留 UNKNOWN）');
  if (settled > 0 && failed === 0) diagnostics.push('no_failed_outcome: 判证有结果但从无 outcome=0（落空判不出——多半证据门太严判 UNKNOWN，见 NOE_EXPECT_LOOSEN_FAIL）');
  if (failed > 0 && failedSurpriseEligible === 0) diagnostics.push('failed_below_surprise_gate: 有落空但都不到 2bit 惊奇（p 偏低，落空不"意外"，不立研究）');
  if (failedSurpriseEligible > 0 && surpriseGoals === 0) diagnostics.push('harvest_not_wired: 够格落空但 noe_goals 无 source=surprise（resolver 未注入 goalSystem 或 backlog 满）');
  if (surpriseGoals > 0 && surpriseGoalsDone === 0) diagnostics.push('research_not_completed: 立了好奇研究但无一完成（研究执行链未推进）');
  if (surpriseGoalsDone > 0 && lessonsWritten === 0) diagnostics.push('lessons_not_written: 研究完成但 learningHook 没写进 lesson（NOE_LEARNING_HOOK 未开 / 全 SKIP / 被 gate 拒）');
  if (lessonsWritten > 0 && lessonsRead === 0) diagnostics.push('lessons_never_read: 写了 lesson 但 hit_count 全 0（写进可取回但 Neo 决策从没召回=盲卡/指标繁荣，查 recall 子串面）');

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    liveDbMutated: false,
    sinceTs,
    tables: { noe_expectations: hasExpect, noe_goals: hasGoals },
    expectations: { created, open, resolvedUnresolvable: resolvedNull, settled, applied, failed, failedSurpriseEligible },
    research: { surpriseGoals, surpriseGoalsActive, surpriseGoalsDone },
    learning: { lessonsWritten, lessonsRead, readRate: pct(lessonsRead, lessonsWritten) },
    funnel,
    diagnostics,
    source: { policy: 'read-only SELECT on live panel.db (readonly handle); no writes, no model calls, no network' },
  };
}

function renderText(report) {
  const lines = [];
  lines.push('Noe 好奇产出漏斗（curiosity-yield，只读）');
  lines.push(`生成于 ${report.generatedAt}  ·  库 ${rel(DB_PATH)}  ·  窗口 ${SINCE_DAYS > 0 ? `近 ${SINCE_DAYS} 天` : '全部历史'}`);
  if (!report.tables.noe_expectations) lines.push('warn: 无 noe_expectations 表');
  if (!report.tables.noe_goals) lines.push('warn: 无 noe_goals 表');
  lines.push('');
  lines.push('漏斗：');
  for (const s of report.funnel) {
    const ofPrev = s.ofPrev == null ? '' : `  (${s.ofPrev}% of 上一节)`;
    lines.push(`  ${String(s.count).padStart(6)}  ${s.label}${ofPrev}`);
  }
  lines.push('');
  lines.push(`留账未结(unresolvable/sweep)：${report.expectations.resolvedUnresolvable}  ·  仍 open：${report.expectations.open}  ·  应验：${report.expectations.applied}`);
  lines.push(`好奇研究：在途 ${report.research.surpriseGoalsActive}  ·  完成 ${report.research.surpriseGoalsDone}`);
  lines.push('');
  if (report.diagnostics.length) {
    lines.push('诊断（漏斗断点）：');
    for (const d of report.diagnostics) lines.push(`  - ${d}`);
  } else {
    lines.push('诊断：漏斗各节均有流量，好奇回路通畅。');
  }
  return lines.join('\n');
}

// CLI 入口：仅在直接运行时连库（被 import 测试时不连）。
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || '')) {
  if (!existsSync(DB_PATH)) {
    console.error(JSON.stringify({ ok: false, error: 'db_not_found', dbPath: rel(DB_PATH) }, null, 2));
    process.exitCode = 1;
  } else {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const report = buildCuriosityYieldReport(db, { sinceTs: SINCE_TS, now: NOW });
      if (AS_JSON) console.log(JSON.stringify({ ...report, dbPath: rel(DB_PATH) }, null, 2));
      else console.log(renderText(report));
    } finally {
      db.close();
    }
  }
}
