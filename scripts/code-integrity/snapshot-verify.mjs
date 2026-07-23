#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  atomicJsonWrite,
  canonicalJson,
  describePaths,
  gitHead,
  listDirtyPaths,
  manifestDigest,
  hashBytes,
} from './lib/artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ snapshot?: string, sourceRoot?: string, output?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--snapshot') out.snapshot = value;
    else if (key === '--source-root') out.sourceRoot = value;
    else if (key === '--output') out.output = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.snapshot || !out.sourceRoot) throw new Error('--snapshot and --source-root are required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = existingRealDirectory(resolve(args.sourceRoot), 'source root');
  const snapshotPath = resolve(args.snapshot);
  const snapshotParent = realpathSync.native(dirname(snapshotPath));
  if (snapshotPath !== join(snapshotParent, basename(snapshotPath))) throw new Error('snapshot parent symlink refused');
  const snapshotStat = lstatSync(snapshotPath);
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) throw new Error('snapshot artifact must be a regular file');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (snapshot.schema !== 'neo.code-integrity.snapshot.v2' || snapshot.state !== 'accepted' || !snapshot.Bwork) {
    throw new Error('snapshot is not an accepted Bwork artifact');
  }
  const { metadataDigest, ...snapshotMetadata } = snapshot;
  if (hashBytes(canonicalJson(snapshotMetadata)) !== metadataDigest) throw new Error('snapshot metadata digest mismatch');
  const snapshotRoot = snapshotParent;
  const overlayInput = resolve(snapshot.overlayRoot);
  assertPathInside(snapshotRoot, overlayInput, 'snapshot overlay');
  assertNoSymlinkSegments(snapshotRoot, overlayInput, 'snapshot overlay');
  const overlayRoot = existingRealDirectory(overlayInput, 'snapshot overlay');
  const paths = listDirtyPaths(sourceRoot);
  const items = describePaths(sourceRoot, paths);
  const currentDigest = manifestDigest(items);
  const currentHead = gitHead(sourceRoot);
  const samePaths = JSON.stringify(paths) === JSON.stringify(snapshot.paths);
  const copiedItems = describePaths(overlayRoot, snapshot.paths);
  const copiedDigest = manifestDigest(copiedItems);
  const overlayCurrent = copiedDigest === snapshot.Bwork.overlayDigest;
  const current = currentHead === snapshot.B0.commit
    && samePaths
    && currentDigest === snapshot.Bwork.overlayDigest
    && overlayCurrent;
  const report = {
    schema: 'neo.code-integrity.snapshot-status.v1',
    checkedAt: new Date().toISOString(),
    snapshotId: snapshot.snapshotId,
    sourceRoot,
    state: current ? 'current' : 'stale',
    checks: {
      headMatches: currentHead === snapshot.B0.commit,
      pathSetMatches: samePaths,
      overlayDigestMatches: currentDigest === snapshot.Bwork.overlayDigest,
      copiedOverlayDigestMatches: overlayCurrent,
    },
    expected: { head: snapshot.B0.commit, overlayDigest: snapshot.Bwork.overlayDigest, pathCount: snapshot.paths.length },
    actual: { head: currentHead, overlayDigest: currentDigest, copiedOverlayDigest: copiedDigest, pathCount: paths.length },
  };
  if (args.output) atomicJsonWrite(resolve(args.output), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!current) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`snapshot verification refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
