#!/usr/bin/env node
// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'output', 'qwen36-8bit-main-brain-benchmark-20260612');
const BENCH_SCRIPT = join(ROOT, 'scripts', 'noe-main-brain-candidate-benchmark.mjs');
const SDK_PATH = process.env.LMSTUDIO_SDK || `${process.env.HOME}/.lmstudio/extensions/plugins/lmstudio/rag-v1/node_modules/@lmstudio/sdk/dist/index.mjs`;
const LOAD_CONFIG = Object.freeze({ contextLength: 262144, parallel: 1 });
const COMPLETION_CONFIG = Object.freeze({
  temperature: 0.2,
  top_p: 0.9,
  max_tokens: 8192,
  reasoning_effort: 'none',
});
const SEEDS = String(process.env.NOE_QWEN8_BENCH_SEEDS || '42,43,44')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

const MODELS = [
  {
    key: 'qwen/qwen3.6-35b-a3b@6bit',
    loadKeys: ['qwen/qwen3.6-35b-a3b@6bit', 'qwen/qwen3.6-35b-a3b'],
    identifier: 'bench-qwen36-35b-a3b-6bit',
    label: 'Q35-6 当前主脑基准',
    quant: '6bit',
    role: 'main-baseline',
    sizeGb: 29.09,
    baseline: true,
  },
  {
    key: 'qwen/qwen3.6-35b-a3b@8bit',
    loadKeys: ['qwen/qwen3.6-35b-a3b@8bit'],
    identifier: 'bench-qwen36-35b-a3b-8bit',
    label: 'Q35-8 新下载候选',
    quant: '8bit',
    role: 'main-candidate',
    sizeGb: 37.75,
  },
  {
    key: 'qwen/qwen3.6-27b@8bit',
    loadKeys: ['qwen/qwen3.6-27b@8bit'],
    identifier: 'bench-qwen36-27b-8bit',
    label: 'Q27-8 新下载候选',
    quant: '8bit',
    role: 'review/main-candidate',
    sizeGb: 29.53,
  },
];

const RESTORE = {
  key: 'qwen/qwen3.6-35b-a3b@6bit',
  loadKeys: ['qwen/qwen3.6-35b-a3b@6bit', 'qwen/qwen3.6-35b-a3b'],
  identifier: 'qwen/qwen3.6-35b-a3b',
};

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, {
      cwd: ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.pipe) process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.pipe) process.stderr.write(s);
    });
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${String(error?.message || error)}` }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function runLms(args, opts = {}) {
  const bins = ['lms', `${process.env.HOME || ''}/.lmstudio/bin/lms`].filter(Boolean);
  let last = null;
  for (const bin of bins) {
    const result = await run(bin, args, opts);
    last = result;
    if (result.ok || !/ENOENT|not found/i.test(result.stderr || '')) return result;
  }
  return last || { ok: false, code: -1, stdout: '', stderr: 'lms not found' };
}

async function unloadAll(client = null) {
  if (client) {
    const loaded = await client.llm.listLoaded().catch(() => []);
    for (const model of loaded) await model.unload().catch(() => {});
  }
  await runLms(['unload', '-a']).catch(() => {});
}

async function loadModel(client, model) {
  await unloadAll(client);
  const startedAt = Date.now();
  let lastError = null;
  for (const key of model.loadKeys || [model.key]) {
    try {
      await client.llm.load(key, {
        identifier: model.identifier,
        verbose: false,
        config: {
          contextLength: LOAD_CONFIG.contextLength,
          maxParallelPredictions: LOAD_CONFIG.parallel,
          seed: 42,
        },
      });
      const ps = await runLms(['ps']);
      return { loadKey: key, loadMs: Date.now() - startedAt, output: `loaded via SDK: ${key}`, lmsPs: ps.stdout + ps.stderr };
    } catch (error) {
      lastError = error;
    }
  }
  const ps = await runLms(['ps']);
  throw new Error(`SDK load ${model.key} failed: ${String(lastError?.message || lastError || 'unknown error').slice(-1200)}\n${ps.stdout}${ps.stderr}`);
}

async function restoreResidentMain(client) {
  await unloadAll(client);
  const startedAt = Date.now();
  let lastError = null;
  for (const key of RESTORE.loadKeys || [RESTORE.key]) {
    try {
      await client.llm.load(key, {
        identifier: RESTORE.identifier,
        verbose: false,
        config: {
          contextLength: LOAD_CONFIG.contextLength,
          maxParallelPredictions: LOAD_CONFIG.parallel,
          seed: 42,
        },
      });
      const ps = await runLms(['ps']);
      return { ok: true, loadKey: key, loadMs: Date.now() - startedAt, stdout: `loaded via SDK: ${key}`, stderr: '', lmsPs: ps.stdout + ps.stderr };
    } catch (error) {
      lastError = error;
    }
  }
  const ps = await runLms(['ps']);
  return { ok: false, loadMs: Date.now() - startedAt, stdout: '', stderr: String(lastError?.message || lastError || 'unknown restore error'), lmsPs: ps.stdout + ps.stderr };
}

function parseBenchOutDir(stdout) {
  const match = stdout.match(/输出目录:\s*([^\n\r]+)/);
  if (!match) return '';
  return resolve(ROOT, match[1].trim());
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sameStringSet(a = [], b = []) {
  return JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());
}

async function runRound(model, seed) {
  const result = await run(process.execPath, [
    BENCH_SCRIPT,
    '--loaded-only',
    '--ack-manual-benchmark',
    '--model',
    model.identifier,
    '--seed',
    String(seed),
  ], {
    pipe: true,
    env: {
      NOE_ACK_MANUAL_BENCHMARK: '1',
      NOE_BENCH_LOADED_ONLY: '1',
      NOE_BENCH_MODEL: model.identifier,
      NOE_BENCH_SEED: String(seed),
    },
  });
  const outDir = parseBenchOutDir(result.stdout);
  if (!result.ok) {
    throw new Error(`round seed=${seed} failed for ${model.identifier}: ${(result.stderr || result.stdout || '').slice(-1400)}`);
  }
  if (!outDir || !existsSync(join(outDir, 'results.json'))) {
    throw new Error(`round seed=${seed} did not produce results.json; parsed outDir=${outDir || '(none)'}`);
  }
  const json = readJson(join(outDir, 'results.json'));
  const modelResult = json.results?.[0];
  if (!modelResult?.summary) throw new Error(`round seed=${seed} missing model summary`);
  const activeBefore = json.restoreStatus?.activeBefore || [];
  const activeAfter = json.restoreStatus?.activeAfter || [];
  const expectedLoaded = [model.identifier];
  if (!sameStringSet(activeBefore, expectedLoaded) || !sameStringSet(activeAfter, expectedLoaded)) {
    throw new Error(`round seed=${seed} loaded set changed for ${model.identifier}; before=${JSON.stringify(activeBefore)} after=${JSON.stringify(activeAfter)} expected=${JSON.stringify(expectedLoaded)}`);
  }
  return { seed, outDir, summary: modelResult.summary, tasks: modelResult.tasks || [] };
}

function avg(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function one(n, fallback = '—') {
  return n === null || n === undefined || Number.isNaN(Number(n)) ? fallback : String(Math.round(Number(n) * 10) / 10);
}

function pct(score, max) {
  return Math.round((Number(score || 0) / Math.max(1, Number(max || 0))) * 1000) / 10;
}

function signed(n, suffix = '') {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const x = Math.round(Number(n) * 10) / 10;
  return `${x > 0 ? '+' : ''}${x}${suffix}`;
}

function taskLabel(id) {
  return String(id || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function aggregateModel(entry) {
  const rounds = entry.rounds || [];
  const taskMap = new Map();
  const domainMap = new Map();
  for (const round of rounds) {
    for (const task of round.tasks || []) {
      if (!taskMap.has(task.id)) taskMap.set(task.id, { id: task.id, domain: task.domain, max: task.max, scores: [], passPct: [], ms: [], errors: 0, finishReasons: [] });
      const item = taskMap.get(task.id);
      item.scores.push(Number(task.score || 0));
      item.passPct.push(Number(task.passPct || 0));
      item.ms.push(Number(task.ms || 0));
      if (task.error) item.errors += 1;
      if (task.finishReason) item.finishReasons.push(task.finishReason);
      const key = task.domain || 'unknown';
      if (!domainMap.has(key)) domainMap.set(key, { domain: key, score: 0, max: 0, count: 0 });
      const d = domainMap.get(key);
      d.score += Number(task.score || 0);
      d.max += Number(task.max || 0);
      d.count += 1;
    }
  }
  const tasks = [...taskMap.values()].map((item) => ({
    id: item.id,
    label: taskLabel(item.id),
    domain: item.domain,
    max: item.max,
    avgScore: avg(item.scores),
    avgPassPct: avg(item.passPct),
    scores: item.scores,
    avgMs: avg(item.ms),
    errors: item.errors,
    finishReasons: [...new Set(item.finishReasons)],
  }));
  const domains = [...domainMap.values()].map((item) => ({
    domain: item.domain,
    avgScore: item.score / Math.max(1, rounds.length),
    avgMax: item.max / Math.max(1, rounds.length),
    passPct: pct(item.score, item.max),
  }));
  const summary = {
    label: entry.model.label,
    key: entry.model.key,
    identifier: entry.model.identifier,
    quant: entry.model.quant,
    role: entry.model.role,
    sizeGb: entry.model.sizeGb,
    baseline: Boolean(entry.model.baseline),
    loadMs: entry.load?.loadMs ?? null,
    roundCount: rounds.length,
    avgMainBrainScore: avg(rounds.map((r) => r.summary.mainBrainScore)),
    avgQualityPct: avg(rounds.map((r) => r.summary.qualityPct)),
    avgQualityScore: avg(rounds.map((r) => r.summary.qualityScore)),
    qualityMax: rounds[0]?.summary.qualityMax ?? null,
    avgTokPerSec: avg(rounds.map((r) => r.summary.avgTokPerSec)),
    avgMs: avg(rounds.map((r) => r.summary.avgMs)),
    avgJsonOk: avg(rounds.map((r) => r.summary.jsonOk)),
    taskCount: rounds[0]?.summary.taskCount ?? tasks.length,
    avgErrors: avg(rounds.map((r) => r.summary.errors)),
    tasks,
    domains,
    outDirs: rounds.map((r) => rel(r.outDir)),
  };
  return summary;
}

function byTask(summary) {
  const m = new Map();
  for (const t of summary.tasks || []) m.set(t.id, t);
  return m;
}

function relativeAdvice(summary, baseline) {
  if (summary.baseline) return '保留为当前主脑基准。';
  const scoreDiff = Number(summary.avgMainBrainScore || 0) - Number(baseline?.avgMainBrainScore || 0);
  const qualityDiff = Number(summary.avgQualityPct || 0) - Number(baseline?.avgQualityPct || 0);
  const speedDiff = Number(summary.avgTokPerSec || 0) - Number(baseline?.avgTokPerSec || 0);
  if (scoreDiff >= 4 && qualityDiff >= 2) return '可以进入主脑替换候选，但仍需长稳运行验证。';
  if (qualityDiff >= 2 && speedDiff < -2) return '质量略强但更慢，适合作为复杂任务候选，不宜直接替换。';
  if (scoreDiff > -2 && scoreDiff < 2) return '综合接近当前主脑，除非有明确专项优势，否则不建议切换。';
  if (scoreDiff < -2 && speedDiff > 2) return '速度优势可用于轻任务或复核，但不适合作主脑。';
  return scoreDiff >= 0 ? '略优，需要看每项稳定性。' : '综合弱于当前主脑，不建议替换。';
}

function makeReport({ outDir, startedAt, finishedAt, aggregates, restoreStatus }) {
  const sorted = [...aggregates].sort((a, b) => Number(b.avgMainBrainScore || 0) - Number(a.avgMainBrainScore || 0));
  const baseline = aggregates.find((x) => x.baseline) || sorted[0];
  const _modelById = new Map(aggregates.map((x) => [x.identifier, x]));
  const baselineTasks = byTask(baseline);
  const lines = [
    `# Qwen 3.6 8bit 主脑候选实测报告`,
    '',
    `- 开始：${startedAt}`,
    `- 结束：${finishedAt}`,
    `- 加载参数：${JSON.stringify(LOAD_CONFIG)}`,
    `- 推理参数：${JSON.stringify(COMPLETION_CONFIG)}`,
    `- 三轮 seeds：${SEEDS.join(', ')}`,
    '- 公平性：每个模型同一组任务、同一上下文长度、同一并发、同一推理参数；每轮 seed 对所有模型一致。',
    '- 运行边界：只操作 LM Studio loaded models；不重启 51835，不触碰 51735，不读密钥。',
    '',
    '## 总排名',
    '',
    '| 排名 | 模型 | 加载键 | 主脑分均值 | 质量均值 | 速度均值 | 平均耗时 | 加载耗时 | JSON | 错误 | 建议 |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  sorted.forEach((s, index) => {
    lines.push(`| ${index + 1} | ${s.label} | \`${s.key}\` | ${one(s.avgMainBrainScore)} | ${one(s.avgQualityScore)}/${s.qualityMax ?? '—'} (${one(s.avgQualityPct)}%) | ${one(s.avgTokPerSec)} tok/s | ${one(s.avgMs)} ms | ${one((s.loadMs || 0) / 1000)}s | ${one(s.avgJsonOk)}/${s.taskCount} | ${one(s.avgErrors)} | ${relativeAdvice(s, baseline)} |`);
  });

  lines.push('', '## 相对当前主脑', '');
  lines.push('| 模型 | 主脑分差 | 质量差 | 速度差 | 加载差 | 结论 |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const s of sorted) {
    lines.push(`| ${s.label} | ${signed(Number(s.avgMainBrainScore || 0) - Number(baseline.avgMainBrainScore || 0))} | ${signed(Number(s.avgQualityPct || 0) - Number(baseline.avgQualityPct || 0), '%')} | ${signed(Number(s.avgTokPerSec || 0) - Number(baseline.avgTokPerSec || 0), ' tok/s')} | ${signed(((s.loadMs || 0) - (baseline.loadMs || 0)) / 1000, 's')} | ${relativeAdvice(s, baseline)} |`);
  }

  lines.push('', '## 分领域均值', '');
  const domains = [...new Set(aggregates.flatMap((s) => (s.domains || []).map((d) => d.domain)))];
  lines.push(`| 领域 | ${aggregates.map((s) => s.label).join(' | ')} |`);
  lines.push(`|---|${aggregates.map(() => '---:').join('|')}|`);
  for (const domain of domains) {
    lines.push(`| ${domain} | ${aggregates.map((s) => {
      const d = (s.domains || []).find((x) => x.domain === domain);
      return d ? `${one(d.avgScore)}/${one(d.avgMax)} (${one(d.passPct)}%)` : '—';
    }).join(' | ')} |`);
  }

  lines.push('', '## 每项分数均值', '');
  const taskIds = [...new Set(aggregates.flatMap((s) => (s.tasks || []).map((t) => t.id)))];
  lines.push(`| 任务 | 领域 | ${aggregates.map((s) => s.label).join(' | ')} |`);
  lines.push(`|---|---|${aggregates.map(() => '---:').join('|')}|`);
  for (const taskId of taskIds) {
    const sample = aggregates.find((s) => byTask(s).has(taskId));
    const task = sample ? byTask(sample).get(taskId) : null;
    lines.push(`| ${taskLabel(taskId)} | ${task?.domain || ''} | ${aggregates.map((s) => {
      const t = byTask(s).get(taskId);
      return t ? `${one(t.avgScore)}/${t.max} (${one(t.avgPassPct)}%) [${t.scores.map((x) => one(x)).join('/')}]` : '—';
    }).join(' | ')} |`);
  }

  lines.push('', '## 新模型优势和短板', '');
  for (const s of aggregates.filter((x) => !x.baseline)) {
    const tasks = byTask(s);
    const diffs = [...tasks.values()].map((t) => {
      const b = baselineTasks.get(t.id);
      return {
        id: t.id,
        label: taskLabel(t.id),
        domain: t.domain,
        diff: Number(t.avgPassPct || 0) - Number(b?.avgPassPct || 0),
        score: t.avgPassPct,
      };
    }).sort((a, b) => b.diff - a.diff);
    const strengths = diffs.filter((d) => d.diff > 0).slice(0, 4);
    const weaknesses = [...diffs].reverse().filter((d) => d.diff < 0).slice(0, 4);
    lines.push(`### ${s.label}`, '');
    lines.push(`- 综合：${relativeAdvice(s, baseline)}`);
    lines.push(`- 优势：${strengths.length ? strengths.map((d) => `${d.label} ${signed(d.diff, '%')}`).join('；') : '没有稳定超过当前主脑的项目。'}`);
    lines.push(`- 短板：${weaknesses.length ? weaknesses.map((d) => `${d.label} ${signed(d.diff, '%')}`).join('；') : '未看到明显低于当前主脑的项目。'}`);
    lines.push('');
  }

  lines.push('## 原始证据', '');
  for (const s of aggregates) {
    lines.push(`- ${s.label}: ${s.outDirs.map((p) => `\`${p}\``).join('，')}`);
  }
  lines.push(`- 聚合 JSON：\`${rel(join(outDir, 'results.json'))}\``);
  lines.push(`- 恢复状态：${restoreStatus?.ok ? 'ok' : 'failed'}；${restoreStatus?.lmsPs ? `\`${restoreStatus.lmsPs.trim().replace(/\s+/g, ' ').slice(0, 220)}\`` : ''}`);
  return lines.join('\n');
}

async function main() {
  if (!SEEDS.length) throw new Error('No valid seeds configured');
  if (!existsSync(SDK_PATH)) throw new Error(`LM Studio SDK not found: ${SDK_PATH}`);
  const { LMStudioClient } = await import(pathToFileURL(SDK_PATH).href);
  const client = new LMStudioClient();
  mkdirSync(OUT_ROOT, { recursive: true });
  const outDir = join(OUT_ROOT, stamp());
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const entries = [];
  let restoreStatus = null;
  try {
    for (const model of MODELS) {
      console.log(`\n### Loading ${model.label}: ${model.key}`);
      const load = await loadModel(client, model);
      writeFileSync(join(outDir, `${model.identifier}.load.txt`), `${load.output}\n\n${load.lmsPs}`);
      const rounds = [];
      for (const seed of SEEDS) {
        console.log(`\n### Benchmark ${model.label}; seed=${seed}`);
        const round = await runRound(model, seed);
        rounds.push(round);
        console.log(`round seed=${seed}: main=${round.summary.mainBrainScore}, quality=${round.summary.qualityPct}%, speed=${round.summary.avgTokPerSec ?? 'n/a'} tok/s`);
      }
      entries.push({ model, load, rounds });
    }
  } finally {
    console.log('\n### Restoring resident Q35-6 main brain');
    restoreStatus = await restoreResidentMain(client).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    writeFileSync(join(outDir, 'restore-status.json'), JSON.stringify(restoreStatus, null, 2));
  }
  const finishedAt = new Date().toISOString();
  const aggregates = entries.map(aggregateModel);
  const results = {
    startedAt,
    finishedAt,
    loadConfig: LOAD_CONFIG,
    completionConfig: COMPLETION_CONFIG,
    seeds: SEEDS,
    models: MODELS,
    entries: entries.map((entry) => ({
      model: entry.model,
      load: entry.load,
      rounds: entry.rounds.map((round) => ({
        seed: round.seed,
        outDir: rel(round.outDir),
        summary: round.summary,
        tasks: round.tasks,
      })),
    })),
    aggregates,
    restoreStatus,
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const report = makeReport({ outDir, startedAt, finishedAt, aggregates, restoreStatus });
  writeFileSync(join(outDir, 'REPORT.md'), report);
  console.log(`\n${report}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
