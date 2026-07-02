#!/usr/bin/env node
// @ts-check

import { writeNeoEvalRunScore } from '../src/eval/NeoEvalScorer.js';

function parseArgs(argv) {
  const args = {
    run: 'evals/neo/dev/run-replay-collection-001.json',
    outDir: 'output/noe-eval-runs',
    requirePass: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--run=')) args.run = arg.slice('--run='.length).trim() || args.run;
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length).trim() || args.outDir;
    else if (arg === '--require-pass') args.requirePass = true;
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/noe-eval-score.mjs [--run=evals/neo/dev/run-replay-collection-001.json] [--out-dir=output/noe-eval-runs] [--require-pass]',
        '',
        'Offline scorer only. It reads sanitized dev/regression artifacts, refuses private_holdout refs,',
        'does not touch 51835, does not call models, and does not write memory-v2.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = writeNeoEvalRunScore({ runFile: args.run, outDir: args.outDir });
console.log(JSON.stringify({
  ok: result.ok,
  runId: result.score.runId,
  rawRef: result.rawRef,
  scoreRef: result.scoreRef,
  outDir: result.outDir,
  summary: result.score.summary,
  scores: result.score.scores,
  policy: result.raw.policy,
}, null, 2));
if (args.requirePass && !result.ok) process.exit(1);
