#!/usr/bin/env node
// @ts-check
// Controlled expectation settlement drill: verify Noe's prediction ledger can
// settle >=20 outcomes and compute Brier without mutating the live panel DB.
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExpectationLedger } from '../src/cognition/NoeExpectationLedger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_EXPECTATION_DRILL_OUT_DIR
  ? resolve(process.env.NOE_EXPECTATION_DRILL_OUT_DIR)
  : join(ROOT, 'output', 'noe-expectation-settlement-drill');
const NOW = Date.now();
const SAMPLE_COUNT = Math.max(20, Number(process.env.NOE_EXPECTATION_DRILL_COUNT || 20) || 20);

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function initExpectationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS noe_expectations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'conversation',
      claim TEXT NOT NULL,
      p REAL NOT NULL,
      due_at INTEGER,
      resolved_at INTEGER,
      outcome INTEGER,
      surprise REAL
    );
    CREATE INDEX IF NOT EXISTS idx_noe_expectations_open ON noe_expectations(resolved_at, due_at);
  `);
}

function expectedOutcome(index) {
  // Mix hits and misses so the Brier path exercises both p and 1-p surprise.
  return index % 5 === 0 ? 0 : 1;
}

mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const runDir = join(OUT_DIR, new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
mkdirSync(runDir, { recursive: true, mode: 0o700 });

const dbPath = join(runDir, 'expectation-drill.sqlite');
const reportPath = join(runDir, 'report.json');
const db = new Database(dbPath);

try {
  initExpectationSchema(db);
  const ledger = createExpectationLedger({ db, now: () => NOW });
  const rows = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const outcome = expectedOutcome(i);
    const p = outcome === 1 ? 0.8 : 0.65;
    const id = ledger.add({
      claim: `受控期望结算样本 ${i + 1}: ${outcome === 1 ? '应验' : '落空'} 路径应该被正确计入 Brier`,
      p,
      dueAt: NOW - 1000,
      source: 'controlled_expectation_drill',
    });
    const resolved = ledger.resolve(id, outcome, NOW + i + 1);
    rows.push({
      id,
      claim: resolved?.claim || '',
      p,
      outcome,
      surprise: resolved?.surprise ?? null,
      resolved: Boolean(resolved && resolved.outcome === outcome),
    });
  }
  const brier = ledger.brier({ sinceTs: NOW - 1 });
  const unresolved = ledger.open({ limit: SAMPLE_COUNT }).filter((row) => row.source === 'controlled_expectation_drill');
  const invalid = rows.filter((row) => !row.resolved);
  const report = {
    schemaVersion: 1,
    ok: invalid.length === 0 && unresolved.length === 0 && Number(brier.n || 0) >= SAMPLE_COUNT && Number.isFinite(Number(brier.brier)),
    generatedAt: new Date(NOW).toISOString(),
    liveDbMutated: false,
    dbPath: rel(dbPath),
    sampleCount: SAMPLE_COUNT,
    resolvedCount: rows.filter((row) => row.resolved).length,
    unresolvedCount: unresolved.length,
    brier,
    rows,
    invalid,
    source: {
      policy: 'controlled isolated sqlite drill; no live noe_expectations mutation; no model calls',
    },
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath: rel(reportPath) }, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  db.close();
}
