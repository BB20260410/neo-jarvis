#!/usr/bin/env node
// @ts-check
// P3 真效果模拟（owner 方法论:点火前用生产数据副本实测改动真效果,而非只验装配不崩）。
//   用生产 panel.db 副本 + 真 MemoryCore + NoeTurnContextEngine,调真 supplyTurnContext,
//   对比 NOE_OWNER_PROFILE OFF/ON 实际注入的 owner-profile 段内容(证明真生产数据下注入的是干净 owner 偏好、无隐私)。
//   只读副本,不碰生产。用后即删。
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeTurnContextEngine } from '../src/context/NoeTurnContextEngine.js';

const DB = process.argv[2] || '/tmp/noe-p3-sim.db';
initSqlite(DB);
const memory = new MemoryCore({});
const engine = new NoeTurnContextEngine({ memory, logger: { warn: () => {} } });

function ownerSeg(text) {
  const t = String(text || '');
  if (!t.includes('我已知的主人偏好')) return '(无 owner-profile 段)';
  return t.slice(t.indexOf('我已知的主人偏好')).split('\n\n')[0].replace(/\n/g, ' | ');
}

for (const flag of [undefined, '1']) {
  if (flag === undefined) delete process.env.NOE_OWNER_PROFILE; else process.env.NOE_OWNER_PROFILE = flag;
  // 段级白名单含 owner-profile（聊天室口径）；也测 sections 不含时段级守卫是否拦住
  const inWhitelist = await engine.supplyTurnContext({ transcript: '随便聊聊', sections: ['owner-profile', 'recall'], systemPrompt: '' });
  console.log(`NOE_OWNER_PROFILE=${flag || 'OFF'} sections含owner-profile → ${ownerSeg(inWhitelist.text)}`);
}
// 段级守卫:flag ON 但 sections 不含 owner-profile,应不注入
process.env.NOE_OWNER_PROFILE = '1';
const guarded = await engine.supplyTurnContext({ transcript: '随便聊聊', sections: ['recall'], systemPrompt: '' });
console.log(`NOE_OWNER_PROFILE=ON  sections不含owner-profile(段级守卫) → ${ownerSeg(guarded.text)}`);
close();
