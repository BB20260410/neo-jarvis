// @ts-check

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertSafeRelativePath,
  canonicalJson,
  gitHead,
  hashBytes,
  manifestDigest,
  runGit,
  splitNul,
} from './artifacts.mjs';
import { assertNoSymlinkSegments } from './policy.mjs';

/** @param {string} repoRoot @param {{ requireClean?: boolean }} [options] */
export function computeCandidateCheckpoint(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const dirty = splitNul(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout);
  if (options.requireClean !== false && dirty.length > 0) {
    throw new Error(`candidate checkpoint requires a clean repository: ${dirty.length} status records`);
  }
  const items = splitNul(runGit(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).stdout).map((record) => {
    const match = record.match(/^(\d+)\s+(\S+)\s+([a-f0-9]+)\t([\s\S]+)$/);
    if (!match) throw new Error(`unsupported git tree record: ${JSON.stringify(record.slice(0, 120))}`);
    return { path: assertSafeRelativePath(match[4]), kind: match[2], mode: match[1], gitObject: match[3] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const baseSha = gitHead(root);
  const baseTree = String(runGit(root, ['rev-parse', 'HEAD^{tree}']).stdout || '').trim();
  const core = {
    baseSha,
    baseTree,
    overlayDigest: manifestDigest([]),
    pathCount: 0,
    sourceDigest: `sha256:${manifestDigest(items)}`,
    sourceDigestKind: 'candidate-tracked-tree-v1',
    trackedItemsDigest: manifestDigest(items),
    trackedPathCount: items.length,
  };
  return { ...core, checkpointId: `sha256:${hashBytes(canonicalJson(core))}` };
}

/** @param {string} checkpointPath @param {string} repoRoot */
export function verifyCandidateCheckpoint(checkpointPath, repoRoot) {
  const absolute = resolve(checkpointPath);
  const realParent = realpathSync.native(dirname(absolute));
  if (absolute !== join(realParent, basename(absolute))) throw new Error('candidate checkpoint parent symlink refused');
  assertNoSymlinkSegments(realParent, absolute, 'candidate checkpoint');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('candidate checkpoint must be a regular file');
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== 'neo.code-integrity.candidate-checkpoint.v1'
    || value.state !== 'candidate'
    || value.productionReady !== false) {
    throw new Error('unsupported checkpoint assurance');
  }
  const { metadataDigest, ...metadata } = value;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error('candidate checkpoint metadata digest mismatch');
  if (resolve(value.repoRoot) !== resolve(repoRoot)) throw new Error('candidate checkpoint repository differs');
  const current = computeCandidateCheckpoint(repoRoot, { requireClean: false });
  for (const key of Object.keys(current)) {
    if (current[key] !== value[key]) throw new Error(`candidate checkpoint is stale: ${key}`);
  }
  return { path: absolute, sha256: hashBytes(bytes), value, current };
}
