// P1-A 集成验证（双代理验收 R2+R3 整改后）：embed 召回让 judge 第一轮就看到语义相关证据、据实自主判（修死链），
// 且 embed 软证据绝不点亮词面 semanticLinked 高置信门——不强制触发 decisive reask、不放大误判。
// 跑：node scripts/noe-judge-embedding-integration.mjs（需 ollama + qwen3-embedding:0.6b）
import { createExpectationResolver, buildEventsEvidence } from '../src/cognition/NoeExpectationResolver.js';
import { createClaimEventEmbedRecall } from '../src/cognition/NoeExpectationSemanticRecall.js';
import { embed as embedText, cosineSim } from '../src/embeddings/EmbeddingProvider.js';

const recall = createClaimEventEmbedRecall({
  embed: (t, o) => embedText(t, { baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434', ...o }),
  cosineSim,
  model: 'qwen3-embedding:0.6b',
  threshold: 0.5,
});

// 词面与 claim 完全不重合、但语义相关的 action 成功事件
const events = [{
  ts: 1500,
  kind: 'activity',
  payload: { action: 'noe.goal_step.act', status: 'succeeded', ok: true, result: 'done', details: { stdoutSummary: '把空调温度调到 24 度制冷' } },
}];
const exp = { id: 1, claim: '让房间凉快一点', p: 0.8, created_at: 1000, due_at: 2000 };
const resolved = [];
const ledger = { resolved, due: () => [exp], resolve: (id, outcome, t) => { resolved.push({ id, outcome, t }); return { id, outcome }; } };

let calls = 0;
let firstPrompt = '';
const adapter = {
  chat: async (msgs) => {
    calls += 1;
    if (calls === 1) firstPrompt = msgs.find((m) => m.role === 'user')?.content || '';
    // judge 第一轮就看到 embed 召回的语义证据（result=done 的 action）→ 据实自主判 APPLIED，不需要二轮
    return { reply: '{"verdict":"APPLIED","reasonCode":"direct_success","hintAgreement":"agree"}' };
  },
};

const resolver = createExpectationResolver({
  ledger,
  getAdapter: () => adapter,
  evidence: buildEventsEvidence(() => events, { recall }),
  decisiveReask: true, // 显式开 decisive reask，验证 embed 软证据「不」误触发它
});

await resolver.tick(2500);
const embedSimMatch = firstPrompt.match(/embedSim=([0-9.]+)/);
const embedRecalledMatch = firstPrompt.match(/embedRecalledActionEvents=(\d+)/);
const semLinkedMatch = firstPrompt.match(/"semanticLinkedActionEvents":(\d+)/);

console.log('--- judge 第一轮看到的证据(关键行) ---');
console.log(firstPrompt.split('\n').filter((l) => /embedSim|embedRecalledActionEvents|对齐摘要/.test(l)).join('\n') || '(无 embed 证据)');
console.log('\n=== P1-A 整改后集成结果 ===');
console.log('judge 调用次数:', calls, calls === 1 ? '✓ 仅第一轮（embed 不点亮 decisive reask 高置信门，未强制二轮）' : `✗ 触发了 ${calls} 轮`);
console.log('落账:', JSON.stringify(resolved), resolved[0]?.outcome === 1 ? '✓ judge 据 embed 证据自主判 APPLIED 落账' : '✗');
console.log('embed 召回可观测:', embedSimMatch ? `embedSim=${embedSimMatch[1]}, embedRecalledActionEvents=${embedRecalledMatch?.[1] ?? '?'}` : '无');
console.log('词面 semanticLinkedActionEvents(应为 0，embed 不污染):', semLinkedMatch ? semLinkedMatch[1] : '(未出现=0)');

const ok = calls === 1
  && resolved[0]?.outcome === 1
  && !!embedSimMatch
  && (!semLinkedMatch || semLinkedMatch[1] === '0');
console.log(ok
  ? '\n✓ 整改后闭环成立：embed 召回让 judge 第一轮看到语义证据→据实自主判 APPLIED→落账（修死链）；embed 不点亮 semanticLinked、不误触发 decisive reask（无误判放大）。'
  : '\n⚠ 核对上面数值');
process.exit(ok ? 0 : 1);
