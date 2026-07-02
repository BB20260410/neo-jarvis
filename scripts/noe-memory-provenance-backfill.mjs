#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { applyNoeMemoryProvenanceBackfill } from '../src/memory/NoeMemoryProvenanceBackfill.js';

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const apply = flag('--apply');
if (apply && !flag('--ack-provenance-apply')) {
  console.error(JSON.stringify({
    ok: false,
    error: 'ack_provenance_apply_required',
    message: '真实库来源回填会写强 source_episode 链；请先人工复核匹配，再同时传 --apply --ack-provenance-apply。',
  }, null, 2));
  process.exit(2);
}
const minScore = Number(argValue('--min-score', '0.78')) || 0.78;
const outDir = join(process.cwd(), 'output', 'noe-memory-provenance-backfill');
mkdirSync(outDir, { recursive: true });

let report;
try {
  initSqlite();
  report = applyNoeMemoryProvenanceBackfill({
    db: getDb(),
    apply,
    projectId: argValue('--project-id', 'noe') || 'noe',
    minScore,
  });
} finally {
  close();
}

const file = join(outDir, `noe-memory-provenance-backfill-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  mode: report.mode,
  applied: report.applied,
  reportPath: file,
  scannedMemories: report.scannedMemories,
  scannedEpisodes: report.scannedEpisodes,
  matchCount: report.matchCount,
  inserted: report.inserted || 0,
  updated: report.updated || 0,
}, null, 2));
