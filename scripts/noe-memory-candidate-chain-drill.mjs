#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNoeMemoryCandidateChainDrill } from '../src/memory/NoeMemoryCandidateChainDrill.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = runNoeMemoryCandidateChainDrill({ root: ROOT });

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
