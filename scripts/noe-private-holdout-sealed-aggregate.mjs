#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createNoePrivateHoldoutSealedAggregate } from '../src/eval/NoePrivateHoldoutSealedAggregate.js';

const ROOT = process.cwd();
const DEFAULT_DATASET = 'evals/neo/private_holdout';
const DEFAULT_OUT = 'output/noe-final-real-machine-stages/20260619/stage-C-sealed-holdout.json';

function _clean(value) {
  return String(value || '').trim();
}

function rel(file) {
  return relative(ROOT, resolve(ROOT, file)).replaceAll('\\', '/');
}

function parseArgs(argv) {
  const args = {
    dataset: DEFAULT_DATASET,
    out: DEFAULT_OUT,
    minFiles: 1,
    write: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dataset') args.dataset = argv[++i];
    else if (arg.startsWith('--dataset=')) args.dataset = arg.slice('--dataset='.length);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--min-files') args.minFiles = Number(argv[++i]);
    else if (arg.startsWith('--min-files=')) args.minFiles = Number(arg.slice('--min-files='.length));
    else if (arg === '--no-write') args.write = false;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return args;
}

function assertStageCPaths({ dataset, out }) {
  const datasetRef = rel(dataset);
  if (datasetRef !== DEFAULT_DATASET) {
    throw new Error('stage_c_dataset_must_be_sealed_private_holdout_dir');
  }
  const outRef = rel(out);
  if (outRef !== DEFAULT_OUT) {
    throw new Error('stage_c_out_must_match_authorization_matrix');
  }
  return { datasetRef, outRef };
}

const args = parseArgs(process.argv.slice(2));
const refs = assertStageCPaths(args);
const report = createNoePrivateHoldoutSealedAggregate({
  datasetDir: resolve(ROOT, refs.datasetRef),
  observedAt: new Date().toISOString(),
  stage: 'C',
  minFiles: Number.isFinite(args.minFiles) ? args.minFiles : 1,
});

if (args.write) {
  mkdirSync(dirname(resolve(ROOT, refs.outRef)), { recursive: true });
  writeFileSync(resolve(ROOT, refs.outRef), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (report.ok !== true) process.exit(1);
