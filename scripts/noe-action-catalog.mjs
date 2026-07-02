#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createNoeActionCatalog } from '../src/actions/NoeActionCatalog.js';

function parseInput(argv) {
  const index = argv.findIndex((arg) => arg === '--input' || arg.startsWith('--input='));
  if (index === -1) return {};
  const raw = argv[index].startsWith('--input=') ? argv[index].slice('--input='.length) : argv[index + 1];
  if (!raw) throw new Error('--input requires a JSON string or - for stdin');
  const text = raw === '-' ? readFileSync(0, 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid --input JSON: ${error.message}`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/noe-action-catalog.mjs list',
    '  node scripts/noe-action-catalog.mjs schema <action-id>',
    '  node scripts/noe-action-catalog.mjs help <action-id>',
    '  node scripts/noe-action-catalog.mjs dry-run <action-id> --input \'{"key":"value"}\'',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const [cmd, id] = argv;
  const catalog = createNoeActionCatalog();
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (cmd === 'list') {
    printJson({ ok: true, actions: catalog.list() });
    return;
  }
  if (cmd === 'schema') {
    printJson({ ok: true, schema: catalog.schema(id) });
    return;
  }
  if (cmd === 'help') {
    process.stdout.write(`${catalog.help(id)}\n`);
    return;
  }
  if (cmd === 'dry-run') {
    printJson(catalog.dryRun(id, parseInput(argv.slice(2))));
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

try {
  main();
} catch (error) {
  printJson({ ok: false, error: error.message, code: error.code || 'NOE_ACTION_CATALOG_ERROR' });
  process.exitCode = 1;
}
