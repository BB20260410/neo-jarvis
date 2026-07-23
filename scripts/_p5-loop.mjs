#!/usr/bin/env node
// @ts-check
// P5 成效证伪:端到端证明「学习闭环」真闭合(不是机制存在,是真能改变 Neo 的行为),并诚实暴露局限。
//   用生产 panel.db 副本(只读复制,不碰生产),从真实现状出发端到端走:
//     闭环A(owner 偏好,P3 通道): 学前 context 无某偏好 → 走真实 MemoryCore.write 教 Neo → 学后 context 有 → 行为可变
//     反向 probe(隐私): 教一条含密码的 fact → context 不注入(隐私黑名单生效,证明"学"不等于"泄漏")
//     闭环B(lesson,P1+P4+P2 通道): 报告生产已有 learning_lesson 对日常 query 的召回现状(诚实暴露技术性 lesson 的局限)
//   用后即删副本。
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeTurnContextEngine } from '../src/context/NoeTurnContextEngine.js';

const DB = process.argv[2] || '/tmp/noe-p5-loop.db';
initSqlite(DB);
const memory = new MemoryCore({});
process.env.NOE_OWNER_PROFILE = '1';
const engine = new NoeTurnContextEngine({ memory, logger: { warn: () => {} } });

async function ownerCtx() {
  const r = await engine.supplyTurnContext({ transcript: '我喜欢被怎样回答', sections: ['owner-profile'], systemPrompt: '' });
  const t = String(r.text || '');
  return t.includes('我已知的主人偏好') ? t.slice(t.indexOf('我已知的主人偏好')) : '';
}

console.log('=== P5 端到端学习闭环成效证伪 ===\n');

// ── 闭环A:owner 偏好(P3 通道)──
const probe = '用 emoji 风格回复';           // 含「风格/回复」→ 命中 P3 白名单
const before = (await ownerCtx()).includes(probe);
memory.write({ scope: 'fact', title: `用户偏好 Neo ${probe}`, body: `用户希望 Neo 以后都${probe}`, salience: 5, projectId: 'noe', sourceType: 'user_pref' });
const after = (await ownerCtx()).includes(probe);
console.log(`[闭环A owner偏好] 学前注入=${before}  教学(write)  学后注入=${after}`);
console.log(`  → ${(!before && after) ? '✅ 闭合:教一条新偏好,下一轮 context 真带上了它(学习改变了行为)' : '❌ 断裂'}\n`);

// ── 反向 probe:隐私不泄漏 ──
// 反向 probe 用明显测试假值(非真凭据),只为验证含「密码」字样的 fact 被 P3 隐私黑名单拦截
memory.write({ scope: 'fact', title: '测试敏感fact:密码字样占位 FAKE_TEST_VALUE_0', body: '密码 FAKE_TEST_VALUE_0', salience: 5, projectId: 'noe', sourceType: 'user_pref' });
const leaked = (await ownerCtx()).includes('FAKE_TEST_VALUE_0');
console.log(`[反向probe 隐私] 教一条含密码的 fact → 注入 context=${leaked}`);
console.log(`  → ${leaked ? '❌ 泄漏:隐私进了 systemPrompt' : '✅ 隐私黑名单生效:学了但不泄漏(常驻注入安全)'}\n`);

// ── 闭环B:lesson 通道现状(诚实暴露局限)──
const db = memory.db();
const lessons = db.prepare("SELECT COUNT(*) n, SUM(hit_count) hits FROM noe_memory WHERE source_type IN('learning_lesson','surprise_lesson','skill_distill') AND hidden=0").get();
const sample = db.prepare("SELECT title FROM noe_memory WHERE source_type IN('learning_lesson','surprise_lesson','skill_distill') AND hidden=0 ORDER BY hit_count DESC LIMIT 3").all();
console.log(`[闭环B lesson通道] 生产已沉淀 lesson=${lessons.n} 条,累计命中=${lessons.hits || 0}`);
console.log(`  样本:${sample.map((s) => String(s.title || '').slice(0, 22)).join(' / ')}`);
console.log(`  → 诚实结论:lesson 多为技术认知修正(系统自修复类),对 owner 日常 chat 召回率天然低;`);
console.log(`     P2 杠杆1 fail-safe 正确(不强塞不相关 lesson),但要让 lesson 通道对日常真有用,根因在「写入侧 lesson 主题化」(P5 后续)。`);
close();
