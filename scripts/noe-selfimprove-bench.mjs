#!/usr/bin/env node
// @ts-check
// noe-selfimprove-bench — P6 自改可执行任务回归集的 CLI 入口（隔离执行 + pass^k + 防 reward-hack）。
//
// 任务集 = evals/neo/selfimprove-bench/ 下的合成任务（buggy -> 修复）。候选改动在隔离临时目录跑、
// 评测器在【父进程】用 oracle(probes 期望) 判分，候选 subject 在子进程里够不到期望值、也没有任何可
// 伪造的转绿凭证；候选写禁区/越界/空改动均被纯函数预检挡（0 分）。
//
// 候选策略（--candidate）：
//   oracle-fixed —— 用参考修复（subject.fixed.js）：应全部转绿。【区分性自检 = 验"基准能区分真修复
//                   与未修复"，不是 Neo 的能力分】。默认。
//   empty        —— 不给任何内容：反向 probe①，空改动 => 0 分。
//   buggy        —— 给 buggy 原文：反向 probe，等价空改动 => 0 分。
//   poison       —— 候选声称写评测结果/conftest：反向 probe②，被 FORBIDDEN 挡 => 0 分。
//
// 用法：
//   node scripts/noe-selfimprove-bench.mjs [--candidate oracle-fixed|empty|buggy|poison] [--k 3] [--out <file>]
// 全程隔离临时目录，不碰真仓源码/secret/.env/live db；只写 output/ 下报告。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNoeSelfImproveBenchTasks } from '../src/evals/NoeSelfImproveBenchLoader.js';
import { runNoeSelfImproveBench } from '../src/evals/NoeSelfImproveBenchRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-selfimprove-bench');

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

// 兼容旧名 fixed -> oracle-fixed（带一次性弃用提示）。
let strategy = arg('--candidate', 'oracle-fixed');
if (strategy === 'fixed') {
  console.warn('[selfimprove-bench] --candidate fixed 已更名为 oracle-fixed（语义：区分性自检，非能力分）。');
  strategy = 'oracle-fixed';
}
const k = Number(arg('--k', '3')) || 3;
const outPath = resolve(arg('--out', join(OUT_DIR, `bench-${strategy}-${Date.now()}.json`)));

/**
 * 按策略给每个任务造候选改动。
 * 注意：runner 喂给本函数的是【候选可见视图】(无 fixedContent/expect)。oracle-fixed 策略是【评测器
 * 自检】，需要参考修复，因此从【完整任务索引】取 fixedContent，而非从候选视图（候选视图里没有）。
 */
function makeCandidateFactory(fullTasks) {
  const fixedById = new Map(fullTasks.map((t) => [String(t.id), String(t.fixedContent || '')]));
  const buggyById = new Map(fullTasks.map((t) => [String(t.id), String(t.buggyContent || '')]));
  return function candidateFor(publicTask) {
    const id = String(publicTask.id);
    switch (strategy) {
      case 'empty':
        return {}; // 空改动：反向 probe①
      case 'buggy':
        return { content: buggyById.get(id) ?? publicTask.buggyContent }; // 等价空改动
      case 'poison':
        // 反向 probe②：除了真修复，还企图写评测结果文件刷分 -> 必被 FORBIDDEN 挡（整任务 0 分）
        return {
          writes: [
            { path: publicTask.subjectFile, content: fixedById.get(id) ?? '' },
            { path: 'output/noe-selfimprove-bench/result.json', content: '{"passed":true}' },
          ],
        };
      case 'oracle-fixed':
      default:
        return { content: fixedById.get(id) ?? '' }; // 区分性自检：参考修复
    }
  };
}

function main() {
  const loaded = loadNoeSelfImproveBenchTasks();
  if (!loaded.ok) {
    console.error('[selfimprove-bench] 任务集加载失败：', loaded.errors.join(', '));
    process.exit(1);
  }
  if (strategy === 'oracle-fixed') {
    console.warn('[selfimprove-bench] 注意：oracle-fixed 是【区分性自检】（验基准能区分真修复 vs 未修复），'
      + '不是 Neo 自改能力分。能力分请用真实候选生成器（NoeSelfEvolution）产出 candidate 后跑本基准。');
  }
  console.log(`[selfimprove-bench] 任务数=${loaded.tasks.length} 策略=${strategy} k=${k}`);
  const resultSink = [];
  const report = runNoeSelfImproveBench({
    tasks: loaded.tasks,
    getCandidate: makeCandidateFactory(loaded.tasks),
    k,
    resultSink,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  const out = {
    ...report,
    strategy,
    selfCheckOnly: strategy === 'oracle-fixed',
    reportRef: outPath,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  const s = report.summary;
  console.log(`[selfimprove-bench] 通过 ${s.passedTasks}/${s.totalTasks}（分数 ${s.score}），pass^${s.k}`);
  for (const c of report.caseResults) {
    const tag = c.passAtK?.passed ? '✅' : '❌';
    console.log(`  ${tag} ${c.id} [${c.category}] verdict=${c.verdict}${c.reason ? ' (' + c.reason + ')' : ''}`);
  }
  console.log(`[selfimprove-bench] 报告 -> ${outPath}`);
  // 退出码语义：策略=oracle-fixed 期望全绿(0)；反向 probe 期望 0 分(此时不当失败处理，仍 exit 0 便于编排)。
  process.exitCode = strategy === 'oracle-fixed' ? (report.ok ? 0 : 1) : 0;
}

main();
