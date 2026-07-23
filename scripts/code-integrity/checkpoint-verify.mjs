#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path';
import { verifyCandidateCheckpoint } from './lib/checkpoint.mjs';
import { existingRealDirectory } from './lib/policy.mjs';

function main() {
  const argv = process.argv.slice(2);
  /** @type {{ checkpoint?: string, repoRoot?: string }} */
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--checkpoint') args.checkpoint = value;
    else if (key === '--repo-root') args.repoRoot = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!args.checkpoint || !args.repoRoot) throw new Error('--checkpoint and --repo-root are required');
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const result = verifyCandidateCheckpoint(args.checkpoint, repoRoot);
  process.stdout.write(`${JSON.stringify({ state: 'current_candidate', productionReady: false, checkpointId: result.value.checkpointId })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`candidate checkpoint verification refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
