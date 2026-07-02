#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOE_MEMORY_CANDIDATE_PENDING,
  NOE_MEMORY_CANDIDATE_QUEUE,
  runNoeMemoryCandidateReview,
} from '../src/memory/NoeMemoryCandidateReview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hasFlag(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const report = runNoeMemoryCandidateReview({
  root: ROOT,
  queueRef: arg('--queue', NOE_MEMORY_CANDIDATE_QUEUE),
  pendingRef: arg('--pending', NOE_MEMORY_CANDIDATE_PENDING),
  dryRun: hasFlag('--dry-run'),
});

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok || report.status === 'skipped' ? 0 : 1;
