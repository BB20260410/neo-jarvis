#!/usr/bin/env node
// @ts-check
// JSONL-only aggregation for RuntimeTrace output. It writes snapshot artifacts,
// but never calls live 51835, never reads private holdout data, and never writes memory-v2.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
  buildNoeRuntimeTraceSnapshot,
  readNoeRuntimeTraceRecords,
  resolveNoeRuntimeTraceDir,
} from '../src/runtime/NoeRuntimeTrace.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.now();

function cleanPath(file = '') {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    inputDir: process.env.NOE_RUNTIME_TRACE_DIR || DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
    outDir: process.env.NOE_RUNTIME_TRACE_SNAPSHOT_OUT_DIR || DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
    limit: Number(process.env.NOE_RUNTIME_TRACE_SNAPSHOT_LIMIT || 0) || 5000,
    requireTrace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input-dir') out.inputDir = argv[++i];
    else if (arg.startsWith('--input-dir=')) out.inputDir = arg.slice('--input-dir='.length);
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--limit') out.limit = Number(argv[++i]) || out.limit;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length)) || out.limit;
    else if (arg === '--require-trace') out.requireTrace = true;
  }
  return out;
}

export async function writeNoeRuntimeTraceSnapshot(report, { outDir, nowMs = NOW } = {}) {
  const dir = resolveNoeRuntimeTraceDir({
    root: ROOT,
    baseDir: outDir || DEFAULT_NOE_RUNTIME_TRACE_BASE_DIR,
    label: 'runtime_trace_snapshot_out_dir',
  });
  if (!dir.ok) throw dir.error;
  const fullOut = dir.fullDir;
  await mkdir(fullOut, { recursive: true, mode: 0o700 });
  const reportPath = join(fullOut, `runtime-trace-snapshot-${nowMs}.json`);
  const latestPath = join(fullOut, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, body, { mode: 0o600 });
  await writeFile(latestPath, body, { mode: 0o600 });
  return {
    reportPath: cleanPath(reportPath),
    latestPath: cleanPath(latestPath),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const readResult = await readNoeRuntimeTraceRecords({
    root: ROOT,
    baseDir: args.inputDir,
    limit: args.limit,
  });
  const report = buildNoeRuntimeTraceSnapshot({
    ...readResult,
    nowMs: NOW,
  });
  let paths = {};
  try {
    paths = await writeNoeRuntimeTraceSnapshot(report, {
      outDir: args.outDir,
      nowMs: NOW,
    });
  } catch (error) {
    const out = {
      ...report,
      ok: false,
      status: {
        ...report.status,
        blockers: [...new Set([...(report.status.blockers || []), 'runtime_trace_snapshot_write_rejected'])],
        error: {
          code: String(error?.code || 'NOE_RUNTIME_TRACE_SNAPSHOT_WRITE_FAILED'),
          message: String(error?.message || error || 'snapshot write failed').slice(0, 400),
        },
      },
    };
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 1;
    return;
  }
  const out = { ...report, ...paths };
  console.log(JSON.stringify(out, null, 2));
  if (args.requireTrace && !report.status.runtimeTraceReady) process.exitCode = 1;
  if (report.status.violations.length > 0) process.exitCode = 1;
  if (report.status.error?.code) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
