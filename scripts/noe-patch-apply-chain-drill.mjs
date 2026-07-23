#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNoePatchApplyChainDrill } from '../src/runtime/mission/NoePatchApplyChainDrill.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const report = runNoePatchApplyChainDrill({
  root: ROOT,
  runId: arg('--run-id', ''),
});

console.log(JSON.stringify({
  ok: report.ok,
  status: report.status,
  runId: report.runId,
  reportRef: report.reportRef,
  latestRef: report.latestRef,
  gates: report.gates,
  safety: report.safety,
}, null, 2));

process.exitCode = report.ok ? 0 : 1;
