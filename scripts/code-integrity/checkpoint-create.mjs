#!/usr/bin/env node
// @ts-check

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { computeCandidateCheckpoint } from './lib/checkpoint.mjs';
import { validateGuardContext } from './lib/guard-context.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

const ENTRYPOINT = fileURLToPath(import.meta.url);

function main() {
  /** @type {{ repoRoot?: string, runtimeRoot?: string, output?: string, label?: string }} */
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--repo-root') args.repoRoot = value;
    else if (key === '--runtime-root') args.runtimeRoot = value;
    else if (key === '--output') args.output = value;
    else if (key === '--label') args.label = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!args.repoRoot || !args.runtimeRoot || !args.output || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(args.label || '')) {
    throw new Error('--repo-root, --runtime-root, --output and a safe --label are required');
  }
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const runtimeRoot = existingRealDirectory(resolve(args.runtimeRoot), 'runtime root');
  const outputPath = resolve(args.output);
  const guardContext = validateGuardContext({ runtimeRoot, repoRoot, entrypoint: ENTRYPOINT });
  assertPathInside(runtimeRoot, outputPath, 'candidate checkpoint');
  assertNoSymlinkSegments(runtimeRoot, outputPath, 'candidate checkpoint');
  const current = computeCandidateCheckpoint(repoRoot);
  const metadata = {
    schema: 'neo.code-integrity.candidate-checkpoint.v1',
    state: 'candidate',
    productionReady: false,
    createdAt: new Date().toISOString(),
    label: args.label,
    repoRoot,
    ...current,
    authority: {
      status: 'unverified_integrator',
      canonicalSourceDigest: null,
      reason: 'NoeSourceDigest and unique-integrator authority must be rebound on the latest Bauth.',
    },
    guardContext,
  };
  atomicJsonWrite(outputPath, { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) });
  process.stdout.write(`${JSON.stringify({ state: metadata.state, productionReady: false, checkpointId: metadata.checkpointId, outputPath })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`candidate checkpoint refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
