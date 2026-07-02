#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { close } from '../src/storage/SqliteStore.js';
import { runNoeMemorySemanticBackfill } from '../src/memory/NoeMemorySemanticBackfill.js';

function flag(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const report = await runNoeMemorySemanticBackfill({
  projectId: valueAfter('--project-id', 'noe'),
  provider: valueAfter('--provider', 'ollama'),
  model: valueAfter('--model', 'qwen3-embedding:0.6b'),
  baseUrl: valueAfter('--base-url', 'http://127.0.0.1:11434'),
  maxBackfill: Number(valueAfter('--max-backfill', '10000')) || 10000,
  apply: flag('--apply'),
  ackApply: flag('--ack-semantic-backfill-apply'),
});
close();

const outDir = join(process.cwd(), 'output', 'noe-memory-semantic-backfill');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-semantic-backfill-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  mode: report.mode,
  reportPath: file,
  candidates: report.candidates || report.apply?.candidates || 0,
  plannedHashPurge: report.plannedHashPurge ?? null,
  purge: report.apply?.purge || null,
  upserted: report.apply?.upserted || 0,
  fallbackCount: report.apply?.fallbackCount || 0,
  models: report.apply?.models || {},
  beforeModels: report.before?.semanticProvider?.stored?.models || {},
  afterModels: report.after?.semanticProvider?.stored?.models || {},
  realDbWrites: report.policy?.realDbWrites === true,
}, null, 2));

if (flag('--require-pass') && !report.ok) process.exit(1);
