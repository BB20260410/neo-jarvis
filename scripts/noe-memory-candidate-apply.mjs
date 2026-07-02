#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import {
  runNoeMemoryCandidateApply,
} from '../src/memory/NoeMemoryCandidateApply.js';
import { NOE_MEMORY_CANDIDATE_PENDING } from '../src/memory/NoeMemoryCandidateReview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hasFlag(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const apply = hasFlag('--apply');
const report = runNoeMemoryCandidateApply({
  root: ROOT,
  pendingRef: arg('--pending', NOE_MEMORY_CANDIDATE_PENDING),
  dryRun: !apply,
  confirmOwner: hasFlag('--confirm-owner'),
  memoryCore: apply ? new MemoryCore() : null,
});

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok || report.status === 'skipped' ? 0 : 1;
