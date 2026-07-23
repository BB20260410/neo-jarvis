#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNoeFreedomRunLedger } from '../src/runtime/NoeFreedomRunLedger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'output/noe-freedom-runs';

function clean(value = '', max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    ledger: [],
    dir: DEFAULT_DIR,
    requireOk: false,
    json: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--ledger') args.ledger.push(clean(argv[++i]));
    else if (item === '--dir') args.dir = clean(argv[++i]) || DEFAULT_DIR;
    else if (item === '--require-ok') args.requireOk = true;
    else if (item === '--no-json') args.json = false;
  }
  return args;
}

function findLedgerFiles(root, dir = DEFAULT_DIR) {
  const base = resolve(root, dir);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (path) => {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (st.isFile() && path.endsWith('/ledger.json')) out.push(path);
  };
  walk(base);
  return out.sort();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function verifyNoeFreedomRunLedgerFile(file, { root = ROOT, requireOk = false } = {}) {
  const absolute = resolve(root, file);
  const errors = [];
  let ledger = null;
  try {
    ledger = readJson(absolute);
  } catch (error) {
    errors.push(`ledger_read_failed:${clean(error?.message || error, 500)}`);
  }
  if (ledger) {
    const validation = validateNoeFreedomRunLedger(ledger);
    errors.push(...validation.errors);
    if (requireOk && ledger.ok !== true) errors.push('freedom_run_ledger_not_ok');
  }
  return {
    ok: errors.length === 0,
    ref: relative(root, absolute),
    errors,
    runId: clean(ledger?.runId, 180),
    action: clean(ledger?.action?.operation, 180),
    dryRunOnly: ledger?.dryRunOnly !== false,
    realExecute: ledger?.realExecute === true,
    sha256: clean(ledger?.sha256, 80),
  };
}

export function runNoeFreedomRunLedgerVerify({
  root = ROOT,
  ledger = [],
  dir = DEFAULT_DIR,
  requireOk = false,
} = {}) {
  const files = ledger.length ? ledger.map((item) => resolve(root, item)) : findLedgerFiles(root, dir);
  const results = files.map((file) => verifyNoeFreedomRunLedgerFile(file, { root, requireOk }));
  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    checked: results.length,
    failed: failed.length,
    mode: requireOk ? 'require_ok' : 'structural',
    results,
  };
}

async function main() {
  const args = parseArgs();
  const result = runNoeFreedomRunLedgerVerify({
    root: ROOT,
    ledger: args.ledger,
    dir: args.dir,
    requireOk: args.requireOk,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const item of result.results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.ref}${item.errors.length ? ` ${item.errors.join(',')}` : ''}`);
    console.log(`${result.ok ? 'ok' : 'failed'} checked=${result.checked} failed=${result.failed}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
