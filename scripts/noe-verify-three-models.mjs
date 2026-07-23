#!/usr/bin/env node
// noe-verify-three-models — 端到端验证 Gemini / MiniMax-M3 / MiMo 三个辅助模型能真实被调用。
//
// 各发同一个具体问题（不是让它们投票祝福，符合多模型打法：给可回答的具体问题），
// 打印 reply 摘要 + token + 延迟。key 运行时从 NoeProviderSecrets resolver 拿，绝不打印 key 值。
// 失败按 unavailable 如实记录，不伪装成功。

import { MiniMaxChatAdapter } from '../src/room/MiniMaxChatAdapter.js';
import { OpenAICompatChatAdapter } from '../src/room/OpenAICompatChatAdapter.js';
import { GeminiSpawnAdapter } from '../src/room/GeminiSpawnAdapter.js';
import { resolveNoeProviderSecret } from '../src/secrets/NoeProviderSecrets.js';

const Q = [{ role: 'user', content: '只回答一个城市名、不要任何解释：中华人民共和国的首都是哪座城市？' }];
const CALL = { skipResilience: true, skipBudget: true, agentRunLifecycle: false };

async function probe(name, makeAdapter) {
  const t0 = Date.now();
  try {
    const adapter = makeAdapter();
    if (!adapter) return { name, ok: false, error: 'key 未配置 / adapter 不可用' };
    const r = await adapter.chat(Q, CALL);
    const reply = String(r?.reply || '').replace(/\s+/g, ' ').trim();
    return { name, ok: !!reply, reply: reply.slice(0, 100), tokensIn: r?.tokensIn || 0, tokensOut: r?.tokensOut || 0, ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 };
  }
}

const results = [];

results.push(await probe('MiniMax-M3', () => {
  const s = resolveNoeProviderSecret('minimax');
  return s?.ok ? new MiniMaxChatAdapter({ apiKey: s.value }) : null;
}));

results.push(await probe('MiMo (mimo-v2.5-pro)', () => {
  const s = resolveNoeProviderSecret('xiaomi');
  return s?.ok ? new OpenAICompatChatAdapter({
    id: 'mimo', displayName: 'MiMo', apiKey: s.value,
    baseUrl: process.env.MIMO_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1',
    model: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
  }) : null;
}));

results.push(await probe('Gemini (CLI)', () => new GeminiSpawnAdapter({ model: process.env.GEMINI_VERIFY_MODEL || 'gemini-2.5-flash' })));

console.log('\n=== 三模型连通自检 ===');
for (const r of results) {
  if (r.ok) console.log(`✅ ${r.name.padEnd(22)} "${r.reply}"  (in=${r.tokensIn} out=${r.tokensOut}, ${r.ms}ms)`);
  else console.log(`❌ ${r.name.padEnd(22)} ${r.error}  (${r.ms ?? 0}ms)`);
}
const okCount = results.filter((r) => r.ok).length;
console.log(`\n打通 ${okCount}/${results.length}`);
process.exit(okCount === results.length ? 0 : 1);
