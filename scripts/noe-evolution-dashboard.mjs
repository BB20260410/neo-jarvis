#!/usr/bin/env node
// @ts-check
// 阶段一 诚实仪表盘薄壳:只读 panel.db → 聚合真进步率/归因分布/信号drop率 → 打印 + append 时间序列。
// 零风险(READ-ONLY,-readonly 打开)。用法: node scripts/noe-evolution-dashboard.mjs [--days N]
//   --days N: 只统计最近 N 天(默认 3;0=全时段)。输出追加 output/noe-evolution-dashboard/history.jsonl。
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  buildEvolutionDashboard,
} from '../src/loop/NoeEvolutionDashboard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.NOE_DASHBOARD_DB || join(homedir(), '.noe-panel', 'panel.db');
const OUT = join(ROOT, 'output', 'noe-evolution-dashboard');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? Number(process.argv[daysArg + 1]) || 0 : 3;
const sinceMs = DAYS > 0 ? Date.now() - DAYS * 86400_000 : 0;

if (!existsSync(DB)) { console.error(`panel.db 不存在: ${DB}`); process.exit(1); }
const db = new Database(DB, { readonly: true, fileMustExist: true });

// evolution_outcome 事件 → {verdict, applied, reason}
const outcomes = db.prepare(
  `SELECT json_extract(payload,'$.verdict') verdict, json_extract(payload,'$.applied') applied, json_extract(payload,'$.reason') reason
   FROM events WHERE kind='evolution_outcome' AND ts >= ? ORDER BY ts`,
).all(sinceMs);

// self_evolution goals → {signal, status}
const goals = db.prepare(
  `SELECT json_extract(meta,'$.signal') signal, status FROM noe_goals WHERE source='self_evolution' AND created_at >= ?`,
).all(sinceMs);

// 失败/reject 教训条数(自我学习是否起量)
let lessonCount = 0;
try {
  lessonCount = db.prepare(
    `SELECT COUNT(*) n FROM noe_memory WHERE (source_type LIKE '%lesson%' OR source_type LIKE '%reject%') AND created_at >= ?`,
  ).get(sinceMs).n;
} catch { lessonCount = 0; }

db.close();

const snap = buildEvolutionDashboard({ outcomes, goals, lessonCount, at: new Date().toISOString() });

// 人读输出
const o = snap.outcomes;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`\n📊 Neo 进化仪表盘  (最近 ${DAYS || '全时段'} 天, ${new Date().toLocaleString()})`);
console.log('─'.repeat(58));
console.log(`总 outcome: ${o.total}`);
console.log(`⭐ 真进步率(真保留改逻辑/总): ${pct(o.realProgressRate)}  [${o.realProgress}/${o.total}]  ← 北极星,别看 apply 率`);
console.log(`   apply 率: ${pct(o.appliedRate)}   回滚率: ${pct(o.rollbackRate)}`);
console.log(`verdict 分布:`, o.verdictDist);
console.log(`回滚归因分布(reason):`, o.reasonDist);
console.log(`\n信号源 drop 率(暴露黑洞):`);
for (const [sig, b] of Object.entries(snap.goals.bySignal).sort((a, c) => c[1].dropRate - a[1].dropRate)) {
  console.log(`  ${sig.padEnd(26)} drop ${pct(b.dropRate)}  (done ${b.done} / dropped ${b.dropped} / open ${b.open})`);
}
console.log(`\n失败/reject 教训累计: ${lessonCount}  ← 轴4 起量的话应涨(此前长期 1-2)`);

// 落时间序列
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'history.jsonl'), `${JSON.stringify(snap)}\n`, { mode: 0o600 });
console.log(`\n📈 快照已追加 output/noe-evolution-dashboard/history.jsonl(时间序列→画能力随时间曲线)`);
