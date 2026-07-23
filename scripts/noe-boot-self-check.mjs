#!/usr/bin/env node
// @ts-check
import { resolve } from 'node:path';
import { compactBootSelfCheck, runNoeBootSelfCheck } from '../src/runtime/NoeBootSelfCheck.js';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    rootDir: process.cwd(),
    baseUrl: `http://127.0.0.1:${process.env.PORT || 51835}`,
    repair: false,
    writeReport: true,
    network: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--root') { options.rootDir = resolve(String(next || '')); i += 1; }
    else if (arg === '--base-url') { options.baseUrl = String(next || options.baseUrl); i += 1; }
    else if (arg === '--repair') options.repair = true;
    else if (arg === '--no-write') options.writeReport = false;
    else if (arg === '--no-network') options.network = false;
  }
  return options;
}

const options = parseArgs();
const report = await runNoeBootSelfCheck({
  rootDir: options.rootDir,
  baseUrl: options.baseUrl,
  repair: options.repair,
  writeReport: options.writeReport,
  fetchImpl: options.network ? globalThis.fetch : null,
});
const bootSelfCheck = compactBootSelfCheck(report);
console.log(JSON.stringify({
  ok: true,
  bootSelfCheck,
  reportPath: bootSelfCheck.reportPath,
  latestPath: bootSelfCheck.latestPath,
}, null, 2));
process.exitCode = bootSelfCheck.status === 'blocked' ? 1 : 0;
