#!/usr/bin/env node
// @ts-check
// 阶段一B 能力题库 runner:用真实本地 implementer 对 held-out 题库跑分,量「通过率随难度/随时间」。
// 离线,不碰生产 51835(自建临时 adapter + tmp fixture)。用法:
//   node scripts/noe-capability-battery.mjs [--model qwen/qwen3.6-27b]
// 输出:通过率报告 + append output/noe-capability-battery/history.jsonl(时间序列→能力随时间曲线)。
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeNoeSelfEvolutionImplementer } from '../src/loop/NoeSelfEvolutionExecutors.js';
import { LmStudioChatAdapter } from '../src/room/LmStudioChatAdapter.js';
import { CAPABILITY_BATTERY, scorePatchAgainstTask, summarizeBatteryRun } from '../src/loop/NoeCapabilityBattery.js';
import { findFuzzyMatch } from '../src/runtime/mission/NoeFuzzyPatchMatcher.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'output', 'noe-capability-battery');
const modelArg = process.argv.indexOf('--model');
const MODEL = modelArg >= 0 ? process.argv[modelArg + 1] : (process.env.NOE_SELFEVO_CODE_MODEL || 'qwen/qwen3.6-27b');

const adapter = new LmStudioChatAdapter({
  model: MODEL, baseUrl: process.env.NOE_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio', reasoningEffort: 'none', temperature: 0, loadTtlSeconds: 1200,
});

// 临时工作根:每题写 fixture 到 tmp,implementer 据真实文件内容出 patch(和生产同链路)。
const work = mkdtempSync(join(tmpdir(), 'noe-battery-'));
const spawn = makeNoeSelfEvolutionImplementer({
  getAdapter: (id) => (id === 'lmstudio-code' || id === 'lmstudio') ? adapter : null,
  route: () => ({ adapterId: 'lmstudio-code' }), localFirst: true, localCodeAdapterId: 'lmstudio-code', root: work,
});

console.log(`\n🎯 能力题库 (model=${MODEL}, ${new Date().toLocaleString()})`);
console.log('─'.repeat(58));
const results = [];
for (const task of CAPABILITY_BATTERY) {
  const abs = join(work, task.file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, task.content);
  const t0 = Date.now();
  let score;
  try {
    const out = await spawn({ objective: task.objective, targetFile: task.file });
    const plan = JSON.parse(readFileSync(resolve(work, out.patchPlanRef), 'utf8'));
    // 纳入 fuzzy(仿生产 NOE_FUZZY_PATCH):量真实落地率;strictApplicable 另记模型精度
    score = scorePatchAgainstTask(task, plan.patchPlan || plan, task.content, { fuzzyMatch: findFuzzyMatch });
  } catch (e) {
    score = { id: task.id, tier: task.tier, pass: false, applicable: false, markerOk: false, reason: `error:${String(e.message).slice(0, 40)}` };
  }
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${task.tier.padEnd(6)}] ${task.id.padEnd(16)} ${score.pass ? '✅ pass' : '❌ ' + score.reason} (${s}s)`);
  results.push(score);
}

const summary = summarizeBatteryRun(results);
console.log('─'.repeat(58));
console.log(`落地率(含fuzzy,≈生产真实): ${(summary.passRate * 100).toFixed(0)}%  [${summary.passed}/${summary.total}]`);
console.log(`模型精度(strict,不靠fuzzy): ${(summary.strictPassRate * 100).toFixed(0)}%  [${summary.strictPassed}/${summary.total}]`);
for (const [tier, b] of Object.entries(summary.byTier)) {
  console.log(`  ${tier.padEnd(8)} 落地 ${(b.passRate * 100).toFixed(0)}% / 精度 ${(b.strictPassRate * 100).toFixed(0)}%  [${b.passed}/${b.total}]`);
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
appendFileSync(join(OUT, 'history.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), model: MODEL, ...summary })}\n`, { mode: 0o600 });
console.log(`\n📈 已追加 output/noe-capability-battery/history.jsonl(能力随时间曲线;定期重跑看 Neo 是否变强)`);
