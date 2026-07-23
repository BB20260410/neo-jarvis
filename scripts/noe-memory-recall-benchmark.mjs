#!/usr/bin/env node
// @ts-check

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { runNoeMemoryRecallBenchmark } from '../src/memory/NoeMemoryRecallBenchmark.js';

function flag(name) {
  return process.argv.includes(name);
}

const dir = mkdtempSync(join(tmpdir(), 'noe-memory-recall-benchmark-'));
let report;
try {
  initSqlite(join(dir, 'panel.db'));
  const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, logger: { warn: () => {} } });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });
  report = await runNoeMemoryRecallBenchmark({ writeGate, retriever });
} finally {
  close();
  rmSync(dir, { recursive: true, force: true });
}

const outDir = join(process.cwd(), 'output', 'noe-memory-recall-benchmark');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-recall-benchmark-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  reportPath: file,
  summary: report.summary,
  failed: report.results.filter((r) => !r.passed).map((r) => r.id),
}, null, 2));
if (flag('--require-pass') && !report.ok) process.exit(1);
