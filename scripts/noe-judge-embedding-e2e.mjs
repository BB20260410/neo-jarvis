// P1-A 端到端验证：真实 ollama qwen3-embedding:0.6b 召回词面漏掉的语义相关证据。
// 跑：node scripts/noe-judge-embedding-e2e.mjs（需 ollama 在线 + qwen3-embedding:0.6b）
// 验证：①OFF 词面路径对「词面不重合」证据全漏（证实 R1 根因）②ON embedding 召回语义相关
//       ③反向 probe：语义不相关的事件不被召回（不是无脑召回所有）。
import { buildEventsEvidence } from '../src/cognition/NoeExpectationResolver.js';
import { createClaimEventEmbedRecall } from '../src/cognition/NoeExpectationSemanticRecall.js';
import { embed as embedText, cosineSim } from '../src/embeddings/EmbeddingProvider.js';

const recall = createClaimEventEmbedRecall({
  embed: (t, o) => embedText(t, { baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434', ...o }),
  cosineSim,
  model: process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b',
  threshold: Number(process.env.NOE_JUDGE_EMBED_THRESHOLD) || 0.5,
});

const mkEvent = (text) => ({
  ts: 1700000005000,
  kind: 'activity',
  payload: { action: 'noe.goal_step.act', status: 'succeeded', result: 'done', details: { stdoutSummary: text } },
});

// [claim, eventText, 期望]：相关=应召回；不相关=反向 probe，不应召回
const CASES = [
  ['让房间凉快一点', '把空调温度调到 24 度制冷', '相关'],
  ['让房间凉快一点', '给小狗喂了狗粮并带它出门散步', '不相关'],
  ['整理今天的工作笔记', '把会议要点归纳成三条写进文档', '相关'],
  ['整理今天的工作笔记', '修好了浴室漏水的水龙头', '不相关'],
  ['提醒我早点休息', '设置了一个 23 点的就寝闹钟', '相关'],
  ['学习一下机器学习基础', '看完了一章关于神经网络的教程', '相关'],
];

console.log('=== P1-A judge embedding 端到端验证（真实 ollama qwen3-embedding:0.6b，阈值 0.5）===\n');
let pass = 0;
const sims = [];
for (const [claim, eventText, expect] of CASES) {
  const events = [mkEvent(eventText)];
  const exp = { claim, created_at: 0 };
  const evOff = buildEventsEvidence(() => events)(exp);
  const evOn = await buildEventsEvidence(() => events, { recall })(exp);
  const offHas = String(evOff || '').trim().length > 0;
  const m = String(evOn || '').match(/embedSim=([0-9.]+)/);
  const sim = m ? Number(m[1]) : null;
  const recalled = sim !== null;
  const ok = expect === '相关' ? (!offHas && recalled) : !recalled;
  if (ok) pass++;
  sims.push({ claim, expect, sim });
  console.log(`[${ok ? '✓' : '✗'}] ${expect} | claim="${claim}"`);
  console.log(`    event="${eventText}"`);
  console.log(`    OFF 词面=${offHas ? '有' : '空'} | ON embed 召回=${recalled ? `是 sim=${sim}` : '否(<阈值)'}`);
  console.log('');
}
console.log(`=== 结果：${pass}/${CASES.length} 符合预期 ===`);
const rel = sims.filter((s) => s.expect === '相关' && s.sim !== null).map((s) => s.sim);
const irr = sims.filter((s) => s.expect === '不相关' && s.sim !== null).map((s) => s.sim);
console.log(`相关用例 sim：${rel.join(', ') || '（无召回）'}`);
console.log(`不相关用例 sim（应 <0.5 不召回）：${irr.join(', ') || '（全部正确排除）'}`);
console.log(pass === CASES.length
  ? '\n✓ P1-A 端到端通过：真实 embedding 召回语义相关证据、排除不相关，OFF 词面全漏（证实 R1 根因主体 + 修复有效）'
  : '\n✗ 有用例不符预期 — 看上面 sim 值判断是阈值问题还是 embedding 区分度问题');
process.exit(pass === CASES.length ? 0 : 1);
