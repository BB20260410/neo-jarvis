#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNoeMemoryCopyValidation } from '../src/memory/NoeMemoryCopyValidation.js';

function valueAfter(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

const report = await runNoeMemoryCopyValidation({
  projectId: valueAfter('--project-id', 'noe'),
  model: valueAfter('--model', 'qwen3-embedding:0.6b'),
  provider: valueAfter('--provider', 'ollama'),
  baseUrl: valueAfter('--base-url', 'http://127.0.0.1:11434'),
  sourceDbPath: valueAfter('--source-db', ''),
  maxBackfill: Number(valueAfter('--max-backfill', '240')) || 240,
  cleanup: !flag('--keep-copy'),
});

const outDir = join(process.cwd(), 'output', 'noe-memory-copy-validation');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-copy-validation-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  reportPath: file,
  copyRetained: report.copy.retained,
  ollama: {
    ok: report.ollama.ok,
    reason: report.ollama.reason || '',
    model: report.ollama.model,
    dim: report.ollama.dim || null,
  },
  semanticBackfill: {
    ok: report.semanticBackfill.ok,
    candidates: report.semanticBackfill.candidates,
    upserted: report.semanticBackfill.upserted,
    fallbackCount: report.semanticBackfill.fallbackCount,
    models: report.semanticBackfill.models,
  },
  retrievalComparison: {
    ftsSelectedRows: report.retrievalComparison.fts.selectedRows,
    fusedSelectedRows: report.retrievalComparison.fused.selectedRows,
    selectedDelta: report.retrievalComparison.selectedDelta,
    semanticQualityOk: report.retrievalComparison.semanticQualityOk,
  },
  maintenanceApply: {
    ok: report.maintenance.apply.ok,
    hiddenCount: report.maintenance.apply.gcApply.hiddenCount,
    protectedAffected: report.maintenance.apply.gcApply.protectedAffected,
  },
}, null, 2));

if (flag('--require-pass') && !report.ok) process.exit(1);
