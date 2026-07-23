#!/usr/bin/env node
// @ts-check
/**
 * P6 记忆召回基准 CLI —— 把题集灌进 Neo 真召回链，跑 pass^k，出 NeoEval 可读报告。
 *
 * 两种模式：
 *   --mode=synthetic（默认）：用全新 temp db，只灌 fixture 语料 → 干净基准（确定可复现，CI 用）。
 *   --mode=live-copy --db=<副本路径>：用 live db 的【只读副本】拷一份到 temp 再灌 fixture →
 *       让真实记忆当 distractor，量「Neo 当前库下的召回基线」。绝不碰原 live db。
 *
 * 反向探针（--probe=wrong|stub）：证明这是真测召回，不是永远满分：
 *   --probe=wrong：把每题期望 id 换成不存在的 id → 分必须掉到 ~0。
 *   --probe=stub ：retriever 换成永远空召回的 stub → 分必须 0。
 *
 * 安全：默认不写 live db；live-copy 模式拷副本到 temp 再用，原副本/原库只读。
 * 输出 report 只含 id/count/分数，不含记忆 body / secret。
 */
import { mkdtempSync, rmSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { createMemorySemanticIndex } from '../src/memory/NoeMemorySemanticIndex.js';
import { loadBenchCases, loadBenchFixtures, runMemoryBench } from '../src/memory/NoeMemoryBenchRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
}

/** stub retriever：永远空召回（反向探针：召回链断开 → 分必 0，绝不报假高）。 */
const STUB_RETRIEVER = { retrieve: async () => ({ ok: true, selected: [], selectedIds: [], hitIds: [] }) };

function safeCount(fn) {
  try { return Number(fn()) || 0; } catch { return 0; }
}

async function main() {
  const mode = String(arg('mode', 'synthetic'));
  const probe = arg('probe', null); // 'wrong' | 'stub' | null
  const k = Number(arg('k', 5)) || 5;
  const z = Number(arg('z', 1.96)) || 1.96;
  const outDir = String(arg('out-dir', 'output/noe-memory-bench'));
  const liveCopy = arg('db', null);
  // embed=ollama → 真语义召回链（生产配置，NL 问句靠它）；hash → 零成本但精度近零；none → 纯 FTS。
  const embed = String(arg('embed', 'ollama'));
  const embedModel = String(arg('embed-model', 'qwen3-embedding:0.6b'));
  // 语义嵌入异步入库，给它时间落库再召回（小语料默认 3s；大副本可调大）。
  const embedSettleMs = Number(arg('embed-settle-ms', 3000)) || 3000;

  const fixtures = loadBenchFixtures({ root: ROOT });
  const loaded = loadBenchCases({ root: ROOT });
  if (loaded.errors.length) process.stderr.write(`case load warnings: ${JSON.stringify(loaded.errors)}\n`);
  let cases = loaded.cases;

  // 反向探针 wrong：把期望 id 全换成不存在的 → 应当几乎全 fail（证明评分真比对召回内容）。
  if (probe === 'wrong') {
    cases = cases.map((c) => ({
      ...c,
      bench: { ...c.bench, expectedIds: (c.bench?.expectedIds || []).map((id) => `__nonexistent__${id}`), expectEmpty: false },
    }));
  }

  const dir = mkdtempSync(join(tmpdir(), 'noe-mem-bench-'));
  const dbPath = join(dir, 'panel.db');
  let report;
  try {
    if (mode === 'live-copy') {
      if (!liveCopy || !existsSync(String(liveCopy))) throw new Error(`live-copy 模式需 --db=<已存在的只读副本路径>；缺失: ${liveCopy}`);
      // 把副本再拷一份到 temp（原副本/原库保持只读，绝不在它上面写 fixture）
      copyFileSync(String(liveCopy), dbPath);
      for (const ext of ['-wal', '-shm']) { if (existsSync(String(liveCopy) + ext)) copyFileSync(String(liveCopy) + ext, dbPath + ext); }
    }
    initSqlite(dbPath); // synthetic=空新库；live-copy=temp 里那份副本

    const semanticIndex = embed === 'none' ? null
      : createMemorySemanticIndex({ provider: embed, model: embedModel });
    const memory = new MemoryCore({ logger: SILENT, semanticIndex });
    const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
    const writeGate = new NoeMemoryWriteGate({ memory, auditLog, logger: SILENT });
    const realRetriever = new NoeMemoryRetriever({ memory, auditLog, logger: SILENT });
    const retriever = probe === 'stub' ? STUB_RETRIEVER : realRetriever;

    // seed 同步入库后，等异步嵌入落库再开跑（FTS 主路本就同步，仅语义路需要 settle）。
    const { seedBenchFixtures } = await import('../src/memory/NoeMemoryBenchRunner.js');
    const preSeed = seedBenchFixtures({ writeGate, memory, projectId: 'noe', fixtures });
    if (semanticIndex && embedSettleMs > 0) await new Promise((r) => setTimeout(r, embedSettleMs));
    const embeddedRows = semanticIndex ? safeCount(() => getDb().prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='noe_memory'").get().c) : 0;

    report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures, projectId: 'noe', k, z, seed: false });
    // CLI 自己 seed（runner 收到 seed:false）→ 这里覆写真实 seed 状态，并把它折进 report.ok（治 P1 ③ seed 不完整仍报 ok）。
    const seedOk = preSeed.seeded.length > 0 && preSeed.seeded.every((s) => s.ok);
    report.seed = { attempted: preSeed.seeded.length, ok: seedOk, failed: preSeed.seeded.filter((s) => !s.ok) };
    const a0 = report.aggregate;
    report.ok = a0.summary.cases > 0 && a0.summary.passedAtK === a0.summary.cases && a0.summary.schemaErrors === 0 && seedOk;
    report.embed = { provider: embed, model: embed === 'none' ? null : embedModel, embeddedRows };
    report.mode = mode;
    report.probe = probe || 'none';
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }

  // 写 NeoEval 可读 artifact（report 已脱敏）
  const targetDir = resolve(ROOT, outDir);
  if (!targetDir.startsWith(resolve(ROOT, 'output'))) throw new Error('out-dir 必须在 output/ 下');
  mkdirSync(targetDir, { recursive: true });
  const stamp = `${mode}${probe ? `-probe-${probe}` : ''}-${Date.now()}`;
  const file = join(targetDir, `bench-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  const a = report.aggregate;
  // 退出码契约（治 P1 ④ baseline 失败仍 exit0）：
  //  - probe=none（真基线）：seed 不完整 / 有 schema 错 / 不是全过 → report.ok=false → exit 1。
  //  - probe=wrong|stub（负样本）：期望「正样本题全被打到 floor」。只看「有期望 id 的题」(expectedCount>0)——
  //    它们在断链/错期望下必须全 fail；任何一个还过 = 反向探针失效（评分能刷分）→ exit 1。
  //    expectEmpty 题(expectedCount=0)在 stub 空召回下「正确地什么都没召」本就该过，不算刷分，不纳入断言。
  let exitCode = 0;
  const probeMode = report.probe && report.probe !== 'none';
  if (!probeMode) {
    if (!report.ok) exitCode = 1;
  } else {
    const positivePassed = (report.caseResults || []).filter((c) => Number(c.expectedCount) > 0 && c.passAtK);
    if (positivePassed.length > 0) {
      process.stderr.write(`probe=${report.probe} FAILED: 负样本探针下仍有 ${positivePassed.length} 道正样本题通过 → 评分可被刷分，bench 不可信。\n`);
      exitCode = 1;
    }
  }

  process.stdout.write([
    `mode=${report.mode} probe=${report.probe} embed=${report.embed.provider}(${report.embed.embeddedRows} vec) k=${a.k} (${a.confidence.level})`,
    `seed: ${report.seed.ok ? 'ok' : 'PARTIAL'} (${report.seed.attempted} fixtures, ${report.seed.failed.length} skipped)`,
    `schema errors: ${a.summary.schemaErrors || 0}  skipped(no-run): ${a.summary.skippedNoRun || 0}`,
    `pass^k: ${a.summary.passedAtK}/${a.summary.cases}  point=${a.passAtK.point}  CI=[${a.passAtK.lower}, ${a.passAtK.upper}] (Wilson)`,
    `pass@1: ${a.summary.passedAt1}/${a.summary.cases}  flaky=${a.summary.flaky}`,
    `by type: ${JSON.stringify(Object.fromEntries(Object.entries(a.byQuestionType).map(([t, v]) => [t, `${v.passed}/${v.total}`])))}`,
    `report: ${file.replace(ROOT + '/', '')}  ok=${report.ok}  exit=${exitCode}`,
    '',
  ].join('\n'));
  if (exitCode !== 0) process.exit(exitCode);
  return report;
}

main().catch((e) => { process.stderr.write(`bench failed: ${e?.stack || e}\n`); process.exit(1); });
