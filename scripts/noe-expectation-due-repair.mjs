#!/usr/bin/env node
// @ts-check
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { createExpectationLedger } from '../src/cognition/NoeExpectationLedger.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes('--apply');
const dbPath = argValue('--db', join(homedir(), '.noe-panel', 'panel.db'));
const limit = Number(argValue('--limit', '500')) || 500;

try {
  initSqlite(dbPath);
  const ledger = createExpectationLedger({});
  const out = ledger.repairDueAtFromClaim({ dryRun: !apply, limit });
  console.log(JSON.stringify({ ...out, dbPath }, null, 2));
  process.exitCode = out.ok ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error), dbPath }, null, 2));
  process.exitCode = 1;
} finally {
  close();
}
