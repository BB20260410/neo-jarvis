#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  atomicJsonWrite,
  canonicalJson,
  copyManifestFiles,
  describePaths,
  gitHead,
  listDirtyPaths,
  manifestDigest,
  hashBytes,
} from './lib/artifacts.mjs';
import { existingRealDirectory } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ sourceRoot?: string, runtimeRoot?: string, label?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--source-root') out.sourceRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else if (key === '--label') out.label = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.sourceRoot || !out.runtimeRoot) throw new Error('--source-root and --runtime-root are required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = existingRealDirectory(resolve(args.sourceRoot), 'source root');
  const runtimeRoot = existingRealDirectory(resolve(args.runtimeRoot), 'runtime root');
  const snapshotId = `${args.label || 'bwork'}-${Date.now()}-${randomUUID()}`;
  const snapshotRoot = join(runtimeRoot, 'snapshots', snapshotId);
  const overlayRoot = join(snapshotRoot, 'overlay');
  mkdirSync(overlayRoot, { recursive: true, mode: 0o700 });

  const startedAt = new Date().toISOString();
  const b0 = gitHead(sourceRoot);
  const prePaths = listDirtyPaths(sourceRoot);
  const preItems = describePaths(sourceRoot, prePaths);
  const preDigest = manifestDigest(preItems);
  copyManifestFiles(sourceRoot, overlayRoot, preItems);

  const postPaths = listDirtyPaths(sourceRoot);
  const postItems = describePaths(sourceRoot, postPaths);
  const postDigest = manifestDigest(postItems);
  const copiedItems = describePaths(overlayRoot, prePaths);
  const copiedDigest = manifestDigest(copiedItems);
  const samePathSet = JSON.stringify(prePaths) === JSON.stringify(postPaths);
  const accepted = samePathSet && preDigest === postDigest && preDigest === copiedDigest;

  const metadata = {
    schema: 'neo.code-integrity.snapshot.v2',
    snapshotId,
    label: args.label || 'bwork',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRoot,
    snapshotRoot,
    overlayRoot,
    B0: { commit: b0 },
    Bwork: accepted ? { overlayDigest: preDigest, pathCount: prePaths.length } : null,
    Bauth: null,
    state: accepted ? 'accepted' : 'rejected_unstable',
    checks: {
      samePathSet,
      preDigest,
      postDigest,
      copiedDigest,
      preEqualsPost: preDigest === postDigest,
      preEqualsCopy: preDigest === copiedDigest,
    },
    paths: prePaths,
    items: preItems,
  };
  const artifact = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  const artifactPath = join(snapshotRoot, 'snapshot.json');
  atomicJsonWrite(artifactPath, artifact);
  process.stdout.write(`${JSON.stringify({ state: artifact.state, snapshotId, pathCount: prePaths.length, artifactPath })}\n`);
  if (!accepted) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`snapshot refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
