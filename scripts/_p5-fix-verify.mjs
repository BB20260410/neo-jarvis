#!/usr/bin/env node
// @ts-check
// 量化 P5 修复(distillSkill ①一次性 deadline 任务不蒸馏 ②同 goal 身份去重)对生产现有 skill_distill 污染的拦截效果。
//   owner 方法论:点火前用生产副本实测真效果。注:改动只防未来蒸馏,历史污染卡仍在库(清理留 HANDOFF)。
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';

const DB = process.argv[2] || '/tmp/noe-p5-fix.db';
initSqlite(DB);
const db = new MemoryCore({}).db();
// 与 server.js distillSkill 改动①同款正则
const DEADLINE = /(\d+\s*[:：]\s*\d+|今晚|今天|明天|后天|本周|这周|下周|\d+\s*点前|\d+月\d+[日号]|截止|deadline|前完成|之前完成)/;

const all = db.prepare("SELECT title, hit_count FROM noe_memory WHERE source_type='skill_distill' AND hidden=0").all();
const deadlineCards = all.filter((s) => DEADLINE.test(String(s.title || '')));
const titleCounts = {};
for (const s of all) { const t = String(s.title || ''); titleCounts[t] = (titleCounts[t] || 0) + 1; }
const dupTitles = Object.entries(titleCounts).filter(([, n]) => n > 1);
const dupExtra = dupTitles.reduce((a, [, n]) => a + (n - 1), 0);
const deadlineHits = deadlineCards.reduce((a, s) => a + (s.hit_count || 0), 0);
const totalHits = all.reduce((a, s) => a + (s.hit_count || 0), 0);

console.log('=== P5 修复真效果(生产现有 skill_distill 污染拦截力) ===');
console.log(`总 skill_distill: ${all.length} 条, 累计 hit=${totalHits}`);
console.log(`改动①(一次性 deadline 任务,本应不蒸馏): ${deadlineCards.length} 条, 占 hit=${deadlineHits}(${Math.round(deadlineHits / Math.max(1, totalHits) * 100)}% 召回量!)`);
console.log(`  样本: ${deadlineCards.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0)).slice(0, 3).map((s) => String(s.title).slice(0, 26) + `[hit${s.hit_count}]`).join(' / ')}`);
console.log(`改动②(同 title 重复组): ${dupTitles.length} 组, 多余可去重 ${dupExtra} 条`);
console.log(`  样本: ${dupTitles.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t, n]) => `「${t.slice(0, 16)}」×${n}`).join(' / ')}`);
const cleaned = all.length - new Set([...deadlineCards, ...dupTitles.flatMap(([t]) => all.filter((s) => s.title === t).slice(1))]).size;
const pollution = all.length - cleaned;
console.log(`→ 若历史也按新规则: 召回池 ${all.length} → ~${cleaned} 条 (识别 ${pollution} 张污染卡, ${Math.round(pollution / all.length * 100)}%)`);
console.log(`→ 关键: 一次性任务占了 ${Math.round(deadlineHits / Math.max(1, totalHits) * 100)}% 的召回命中量 → 修复后真技能 lesson 不再被过期任务淹没`);
close();
