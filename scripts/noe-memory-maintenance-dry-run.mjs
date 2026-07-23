#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { runNoeMemoryMaintenanceDryRun } from '../src/memory/NoeMemoryMaintenanceDryRun.js';

const outDir = join(process.cwd(), 'output', 'noe-memory-maintenance-dry-run');
mkdirSync(outDir, { recursive: true });

let report;
try {
  const _db = initSqlite();
  const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
  report = await runNoeMemoryMaintenanceDryRun({ memory, db: getDb(), projectId: 'noe' });
} finally {
  close();
}

const file = join(outDir, `noe-memory-maintenance-dry-run-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  reportPath: file,
  dream: {
    scanned: report.dream.scanned,
    mergeCount: report.dream.mergeCount,
    downgradeCount: report.dream.downgradeCount,
    promotionCount: report.dream.promotionCount,
  },
  gc: {
    candidateCount: report.gc.candidateCount,
    truncated: report.gc.truncated,
  },
}, null, 2));
