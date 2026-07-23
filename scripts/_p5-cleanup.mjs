#!/usr/bin/env node
// @ts-check
// P5 历史污染卡清理(三方共识:hidden=1 软删可逆,每组同 title 留 hit 最高 1 张作兜底 + deadline 卡全删,用 MemoryCore.hide() 清向量索引)。
//   默认 DRY-RUN(只列计划不改库);传 --apply 才实际 hide。owner 方法论:先副本 dry-run 验证方案不误删真技能,再对生产执行。
//   用法: node scripts/_p5-cleanup.mjs <db路径> [--apply]
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { createMemorySemanticIndex } from '../src/memory/NoeMemorySemanticIndex.js';
import { resolveNoeMemorySemanticConfig } from '../src/memory/NoeMemorySemanticConfig.js';

const DB = process.argv[2] || '/tmp/noe-p5-cleanup.db';
const APPLY = process.argv.includes('--apply');
initSqlite(DB);
// apply 时才接 semanticIndex(清向量需 Ollama);dry-run 不需
const cfg = resolveNoeMemorySemanticConfig(process.env);
const si = (APPLY && cfg.enabled) ? createMemorySemanticIndex({ provider: cfg.provider, model: cfg.model || undefined, baseUrl: cfg.baseUrl || undefined }) : null;
const memory = new MemoryCore(si ? { semanticIndex: si } : {});
const db = memory.db();

// 与 server.js distillSkill 收紧后同款判定
const hasTimeAnchor = (t) => /(今晚|今天|明天|后天|\d+\s*点前|\d+\s*[:：]\s*\d+\s*前|截止|deadline|\d+月\d+[日号]前)/.test(t);
const hasCommitVerb = (t) => /(完成|提交|整理|截图|存档|上传|交付|发布|做完|搞定|初稿|交稿)/.test(t);
const isOneTime = (t) => (hasTimeAnchor(t) && hasCommitVerb(t)) || /(前完成|之前完成)/.test(t);

const all = db.prepare("SELECT id, title, hit_count FROM noe_memory WHERE source_type='skill_distill' AND hidden=0").all();
const deadline = all.filter((s) => isOneTime(String(s.title || '')));
const byTitle = {};
for (const s of all) { (byTitle[s.title] ||= []).push(s); }
const dupExcess = [];
for (const grp of Object.values(byTitle)) {
  if (grp.length > 1) { grp.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0)); dupExcess.push(...grp.slice(1)); } // 留 hit 最高 1 张兜底
}
const hideIds = new Set([...deadline.map((s) => s.id), ...dupExcess.map((s) => s.id)]);
const keep = all.length - hideIds.size;

console.log(`=== P5 历史污染清理${APPLY ? '(APPLY)' : '(DRY-RUN)'} ===`);
console.log(`可见 skill_distill: ${all.length} 张`);
console.log(`  deadline 卡(全删): ${deadline.length} 张`);
console.log(`  同 title 重复多余(每组留最高1张): ${dupExcess.length} 张`);
console.log(`→ 软删 ${hideIds.size} 张, 保留 ${keep} 张真技能`);
// 抽查:保留的卡(确认是真技能不是误留污染) + 被删的(确认是污染不是误删)
const keptTitles = all.filter((s) => !hideIds.has(s.id)).slice(0, 6).map((s) => String(s.title).slice(0, 30));
console.log(`保留样本(应是真技能): ${keptTitles.join(' / ')}`);

if (APPLY) {
  let done = 0;
  for (const id of hideIds) { if (memory.hide(id, { projectId: 'noe', reason: 'p5_distill_poison_cleanup' })) done++; }
  console.log(`✅ 已软删 ${done}/${hideIds.size} 张(hidden=1+清向量, 可 unhide 恢复)`);
} else {
  console.log('DRY-RUN: 未改库。验证方案 OK 后加 --apply 执行。');
}
close();
