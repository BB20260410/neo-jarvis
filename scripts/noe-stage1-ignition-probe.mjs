// @ts-check
// 阶段1 点火验证 probe（治 Claude F1-MOCK：mock 测试不代表生产）。
// 隔离 sqlite + 真组件 + 真 LM Studio 本地脑，触发 3 个 epistemic 源 → surprise goal → learningHook 真产 lesson，
// 查 noe_memory 真落库 + lesson 真质量(非同质方法论) + curiosity 漏斗 + surpriseOriginBreakdown。
// 绝不碰真实 panel.db（隔离 /tmp）。不设模型超时（owner 红线）。
//   跑：node scripts/noe-stage1-ignition-probe.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../src/memory/NoeMemoryWriteGate.js';
import { createExpectationLedger } from '../src/cognition/NoeExpectationLedger.js';
import { createGoalSystem } from '../src/cognition/NoeGoalSystem.js';
import { createStepExpectationBridge } from '../src/cognition/NoeStepExpectationBridge.js';
import { createWorldModelContradictionBridge } from '../src/cognition/NoeWorldModelContradictionBridge.js';
import { createOwnerCorrectionBridge } from '../src/cognition/NoeOwnerCorrectionBridge.js';
import { createLearningHook } from '../src/cognition/NoeLearningHook.js';
import { buildCuriosityYieldReport } from './noe-curiosity-yield-report.mjs';

const MODEL = process.env.NOE_PROBE_MODEL || 'qwen/qwen3.6-35b-a3b';
const LM = process.env.NOE_PROBE_LM || 'http://localhost:1234/v1/chat/completions';

// 真 LM Studio 本地脑（无超时，owner 红线）。
const adapter = {
  async chat(messages) {
    const res = await fetch(LM, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, max_tokens: 2000 }), // reasoning 模型 thinking 长，需大 max_tokens 否则 content 空
    });
    const d = await res.json();
    return { reply: d?.choices?.[0]?.message?.content || '' };
  },
};

async function main() {
  // 4 个根除 flag 全开
  process.env.NOE_STEP_EXPECTATION_RESOLVE = '1';
  process.env.NOE_LEARNING_HOOK = '1';
  process.env.NOE_WORLDMODEL_CONFLICT = '1';
  process.env.NOE_OWNER_CORRECTION = '1';

  const dir = mkdtempSync(join(tmpdir(), 'noe-ignition-'));
  initSqlite(join(dir, 'panel.db'));
  const now = () => Date.now();
  const ledger = createExpectationLedger({ now });
  const goalSystem = createGoalSystem({ now });
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now, logger: { warn: () => {} } });
  const stepBridge = createStepExpectationBridge({ expectationLedger: ledger, goalSystem, now });
  const wmBridge = createWorldModelContradictionBridge({ adapter, memory, goalSystem, now });
  const ocBridge = createOwnerCorrectionBridge({ goalSystem, now });
  const learningHook = createLearningHook({ adapter, memory, writeGate });

  const log = (...a) => console.log(...a);
  log('# 阶段1 点火验证（真组件 + 真 LM Studio：' + MODEL + '）\n');

  // —— 源1：owner 纠正 ——
  log('## 源1：owner 纠正 Neo 事实判断');
  const oc = ocBridge.onOwnerInteraction({ text: '不对，HTTP 状态码 301 其实是永久重定向，不是临时重定向' });
  log('  owner_correction →', oc?.curiosityGoalId ? '产 surprise goal ✓' : `未产(${oc?.skipped || 'none'})`);

  // —— 源2：worldModel 矛盾（先写 belief，再喂矛盾内容，真本地脑判）——
  log('## 源2：worldModel 矛盾（真本地脑判矛盾）');
  memory.write({ kind: 'fact', projectId: 'noe', scope: 'fact', body: 'Python 的 GIL 让多线程无法真正并行执行 CPU 密集任务' });
  const wmContent = '最新研究：Python 3.13 引入了实验性的 free-threading（无 GIL）模式，多线程可以真正并行执行 CPU 密集任务了，这与过去的认知完全不同。';
  const wm = await wmBridge.onContentObserved({ content: wmContent, topic: 'Python GIL 多线程 并行' });
  log('  world_model_conflict →', wm?.conflict ? `判出矛盾「${wm.conflictPoint?.slice(0, 40)}」✓` : `无矛盾/跳过(${wm?.skipped || 'NONE'})`);
  if (!wm?.conflict && wm?.skipped !== 'no_belief' && wm?.skipped !== 'no_relevant_belief') {
    const dbg = await adapter.chat([
      { role: 'system', content: '我刚读到一段新内容，下面还有我记忆里关于这个主题的已有认知。判断新内容与我的已有认知有没有【事实层面的矛盾】——不是补充、不是细化，是直接冲突：我原以为 A，新内容说非 A。若有矛盾，只输出一行 `CONFLICT: 我原以为X，实际Y`（一句话说清矛盾点）；若无矛盾（一致 / 只是补充新信息）只输出 `NONE`。' },
      { role: 'user', content: `【新读到的内容】\n${wmContent}\n\n【我的已有认知】\nPython 的 GIL 让多线程无法真正并行执行 CPU 密集任务` },
    ]);
    log('    [debug] 35b raw 判矛盾:', JSON.stringify(String(dbg?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 200)));
  }

  // —— 源3：act 真失败 ——
  log('## 源3：act 真执行失败');
  const sf = stepBridge.onStepFailed({ stepText: '调用第三方天气 API 获取实时数据并解析返回的 JSON', kind: 'act', terminal: 'failed', failureReason: 'exit code 1: JSON parse error, unexpected token at position 0' });
  log('  action_failure →', sf?.curiosityGoalId ? '产 surprise goal ✓' : `未产(${sf?.skipped || 'none'})`);

  // —— learningHook：对每个 surprise goal 真本地脑产 lesson ——
  log('\n## learningHook：surprise goal → 真本地脑产 lesson → 写 memory');
  const surpriseGoals = getDb().prepare("SELECT id, title, source, why FROM noe_goals WHERE source='surprise'").all();
  log(`  surprise goal 数：${surpriseGoals.length}`);
  for (const g of surpriseGoals) {
    const r = await learningHook.onSurpriseGoalDone({ ...g, source: 'surprise' });
    log(`  - 「${String(g.title).slice(0, 36)}」→ persisted=${r?.persisted} ${r?.reason ? '('+r.reason+')' : ''}`);
    if (r?.lesson) log(`      lesson: ${r.lesson.slice(0, 120)}`);
  }

  // —— 行为级 learned 验证（Claude 强调：persisted 须与 recall 命中率成对，否则只是"写进的盲卡"）——
  // 模拟 Neo 后续决策时按 lesson 主题 recall（NoeDeliberation 同款 projectId:'noe'），验证写进的 lesson 真能被读到→hit_count++。
  log('\n## 行为级 learned：模拟 Neo 决策 recall（验证 lesson 真能被读到，非写进盲卡）');
  for (const l of getDb().prepare("SELECT id, body FROM noe_memory WHERE source_type='surprise_lesson' AND project_id='noe'").all()) {
    const hits = memory.recall({ query: String(l.body).slice(0, 24), projectId: 'noe', limit: 5 }); // bumpHits 默认 true → hit_count++
    log(`  - lesson「${String(l.body).slice(0, 26)}…」→ Neo 决策 recall ${hits.some((m) => m.id === l.id) ? '命中 ✓（hit_count++，行为级 learned 成立）' : '未命中 ✗'}`);
  }

  // —— 验收 ——
  log('\n## 验收');
  const lessons = getDb().prepare("SELECT title, body FROM noe_memory WHERE source_type='surprise_lesson' AND project_id='noe'").all();
  log(`  noe_memory surprise_lesson 落库：${lessons.length} 条`);
  const breakdown = goalSystem.surpriseOriginBreakdown();
  log(`  surpriseOriginBreakdown: total=${breakdown.total} nonNoise=${breakdown.nonNoise} noise=${breakdown.noise}`);
  log(`    byOrigin: ${JSON.stringify(breakdown.byOrigin)}`);
  const report = buildCuriosityYieldReport(getDb(), { sinceTs: 0, now: Date.now() });
  log(`  curiosity 漏斗 learning: ${JSON.stringify(report.learning)}`);
  log(`  funnel: ${report.funnel.map((s) => `${s.stage}=${s.count}`).join(' → ')}`);

  log('\n## lesson 真质量抽查（owner 抽查真伪用）');
  for (const l of lessons) log(`  • [${l.title}] ${l.body}`);

  close();
  rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error('点火失败:', e); process.exit(1); });
