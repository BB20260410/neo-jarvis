#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { buildNoeMemoryStatus } from '../src/memory/NoeMemoryStatus.js';

const root = process.cwd();
const outDir = join(root, 'output', 'noe-memory-status');
mkdirSync(outDir, { recursive: true });

let status;
try {
  const db = initSqlite();
  status = buildNoeMemoryStatus({ db });
} finally {
  close();
}

const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  status,
  policy: {
    noMemoryBodyOutput: true,
    noSecretOutput: true,
    livePanelTouched: false,
  },
};
const file = join(outDir, `noe-memory-status-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  reportPath: file,
  visible: status.counts.visible,
  orphanFacts: status.sourceLinked.orphanFacts,
  semanticProvider: status.semanticProvider.status,
  quarantineCount: status.writeGate.quarantineCount,
}, null, 2));
