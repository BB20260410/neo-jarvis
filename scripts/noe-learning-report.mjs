#!/usr/bin/env node
// @ts-check
// Neo 自主学习「照妖镜」CLI —— 一眼看清 Neo 在搜什么、学到啥、有没有用上。
//   只读 live panel.db（readonly handle），不写库 / 不调模型 / 不联网。
//   用法：npm run noe:learning:report [--json] [--db <path>]
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildLearningReport } from '../src/cognition/NoeLearningReport.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const di = args.indexOf('--db');
const DB_PATH = di >= 0 && args[di + 1] ? args[di + 1] : join(homedir(), '.noe-panel', 'panel.db');

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`打不开 live 库 ${DB_PATH}：${(e && e.message) || e}`); process.exit(1); }
const r = buildLearningReport(db);
db.close();

if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

const bar = '─'.repeat(58);
const pct = (x) => `${Math.round(x * 100)}%`;
console.log(`\n  🔍 Neo 自主学习体检 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
console.log(bar);
console.log(`  ${r.verdict.level === 'spinning' ? '⚠️  ' : '✅ '}${r.verdict.summary}\n`);
console.log(`  ① 在搜什么：${r.searching.distinctTopics} 个不同主题 / 共学 ${r.searching.totalLearnings} 次（重复度 ${pct(r.searching.repeatRatio)}）`);
for (const t of r.searching.topRepeated) console.log(`       ${String(t.times).padStart(4)}× ${t.topic}`);
console.log(`\n  ② 学到啥：${r.learned.totalCards} 张学习卡`);
for (const c of r.learned.byType) console.log(`       ${c.type}：${c.count} 张 · ${c.used} 张被用过 · 最高命中 ${c.maxHit}`);
if (r.learned.recentCards.length) {
  console.log(`     最近几张：`);
  for (const c of r.learned.recentCards.slice(0, 5)) console.log(`       · [${c.hits}命中] ${c.title}`);
}
console.log(`\n  ③ 有用吗：${pct(r.usefulness.usedRatio)} 被召回用过，${r.usefulness.deadCards} 张从没被用过`);
console.log(bar + '\n');
