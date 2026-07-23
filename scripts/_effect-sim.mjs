#!/usr/bin/env node
// @ts-check
// 临时真效果模拟（owner 建议:点火前用生产数据副本实测改动真效果,而非只验装配不崩）。
//   用生产 panel.db 副本 + 真 MemoryCore/semanticIndex(Ollama)/NoeMemoryRetriever,跑真实 query,
//   对比 NOE_MEMORY_VECTOR_POOL(P4#3) + NOE_MEMORY_LESSON_CHANNEL(P2杠杆1) ON/OFF 的 lesson/insight 召回。
//   只读副本,不碰生产。用后即删。
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { createMemorySemanticIndex } from '../src/memory/NoeMemorySemanticIndex.js';
import { resolveNoeMemorySemanticConfig } from '../src/memory/NoeMemorySemanticConfig.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';

const DB = process.argv[2] || '/tmp/noe-effect-sim.db';
initSqlite(DB);
const cfg = resolveNoeMemorySemanticConfig(process.env);
const si = cfg.enabled ? createMemorySemanticIndex({ provider: cfg.provider, model: cfg.model || undefined, baseUrl: cfg.baseUrl || undefined }) : null;
const memory = new MemoryCore(si ? { semanticIndex: si } : {});

const LESSON = ['learning_lesson', 'surprise_lesson', 'skill_distill'];

async function sim(query, pool, lessonCh) {
  process.env.NOE_MEMORY_VECTOR_POOL = pool;
  process.env.NOE_MEMORY_LESSON_CHANNEL = lessonCh;
  const retriever = new NoeMemoryRetriever({ memory }); // 重建以读 LESSON_RESERVE 等模块常量
  const r = await retriever.retrieve({ transcript: query, projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 6 } });
  const sel = r.selected || [];
  return {
    selected: sel.length,
    lessons: sel.filter((m) => LESSON.includes(m.sourceType)).length,
    insights: sel.filter((m) => m.scope === 'insight').length,
    lessonTitles: sel.filter((m) => LESSON.includes(m.sourceType)).map((m) => String(m.title || '').slice(0, 28)),
  };
}

console.log(`semanticIndex=${si ? cfg.provider + '/' + (cfg.model || 'default') : 'NONE(纯FTS)'}`);
const queries = ['本地模型怎么修', '系统自修复', '命令前缀 npm run', 'agent memory 记忆', '咖啡'];
for (const q of queries) {
  const off = await sim(q, '0', '0');
  const on = await sim(q, '1', '1');
  console.log(JSON.stringify({ query: q, OFF_lesson: off.lessons, ON_lesson: on.lessons, OFF_insight: off.insights, ON_insight: on.insights, ON_lessonTitles: on.lessonTitles }));
}
close();
