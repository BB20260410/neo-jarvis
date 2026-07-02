#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runNoeDoctor } from '../src/runtime/NoeDoctor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { json: false, skipNetwork: true };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    if (arg === '--network' || arg === '--models') out.skipNetwork = false;
    if (arg === '--skip-network') out.skipNetwork = true;
  }
  return out;
}

function printHuman(result) {
  console.log(`Noe doctor: ${result.status} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`);
  for (const item of result.findings) {
    console.log(`[${item.severity}] ${item.checkId}: ${item.message}`);
    if (item.fixHint) console.log(`  fix: ${item.fixHint}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const result = await runNoeDoctor({ root: ROOT, skipNetwork: args.skipNetwork });
if (args.json) console.log(JSON.stringify(result, null, 2));
else printHuman(result);
process.exitCode = result.ok ? 0 : 1;

