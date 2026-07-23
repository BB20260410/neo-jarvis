#!/usr/bin/env node
// @ts-check
// Read-only BaiLongma fusion audit. This does not start connectors, read secrets,
// or send external messages.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildBaiLongmaFusionReport,
  detectNoeFusionCapabilities,
  formatBaiLongmaFusionPlanMarkdown,
} from '../src/runtime/NoeBaiLongmaFusionPlanner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'output', 'noe-bailongma-fusion');

export function parseArgs(argv = [], env = process.env) {
  const out = {
    bailongmaRoot: env.BAILONGMA_ROOT || '',
    upstreamUrl: env.BAILONGMA_URL || 'https://github.com/xiaoyuanda666-ship-it/BaiLongma.git',
    outDir: '',
    noWrite: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bailongma-root') out.bailongmaRoot = argv[++i] || '';
    else if (arg.startsWith('--bailongma-root=')) out.bailongmaRoot = arg.slice('--bailongma-root='.length);
    else if (arg === '--upstream-url') out.upstreamUrl = argv[++i] || '';
    else if (arg.startsWith('--upstream-url=')) out.upstreamUrl = arg.slice('--upstream-url='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i] || '';
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--no-write') out.noWrite = true;
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function gitHead(root) {
  if (!root) return '';
  const out = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return out.status === 0 ? String(out.stdout || '').trim() : '';
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function buildAudit({ args = {}, env = process.env, now = new Date() } = {}) {
  const parsed = { ...parseArgs([], env), ...args };
  const noePackageJson = readJson(join(ROOT, 'package.json'));
  return buildBaiLongmaFusionReport({
    bailongmaRoot: parsed.bailongmaRoot,
    upstreamUrl: parsed.upstreamUrl,
    upstreamCommit: gitHead(parsed.bailongmaRoot),
    noePackageJson,
    noeCapabilities: detectNoeFusionCapabilities(ROOT),
    env,
    generatedAt: now.toISOString(),
  });
}

export function writeAudit(report, { outDir = '' } = {}) {
  const dir = outDir || join(OUT_ROOT, timestamp());
  mkdirSync(dir, { recursive: true });
  mkdirSync(OUT_ROOT, { recursive: true });
  const reportPath = join(dir, 'report.json');
  const planPath = join(dir, 'plan.md');
  const latestPath = join(OUT_ROOT, 'latest.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(planPath, formatBaiLongmaFusionPlanMarkdown(report));
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  return { reportPath, planPath, latestPath };
}

function printSummary(report, paths = null) {
  console.log(`ok=${report.ok === true}`);
  console.log(`upstreamCommit=${report.source?.upstreamCommit || ''}`);
  console.log(`files=${report.inventory?.totals?.files || 0}`);
  console.log(`lines=${report.inventory?.totals?.lines || 0}`);
  for (const feature of report.features || []) {
    console.log(`${feature.detected ? 'DETECTED' : 'MISSING'} ${feature.id}`);
  }
  for (const item of report.backlog || []) {
    console.log(`BACKLOG ${item.id} ${item.status}`);
  }
  if (paths) {
    console.log(`report=${paths.reportPath}`);
    console.log(`plan=${paths.planPath}`);
    console.log(`latest=${paths.latestPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildAudit({ args });
  const paths = args.noWrite ? null : writeAudit(report, { outDir: args.outDir });
  printSummary(report, paths);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
