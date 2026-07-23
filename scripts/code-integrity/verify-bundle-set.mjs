#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { assertSafeRelativePath, canonicalJson, hashBytes } from './lib/artifacts.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const bundles = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--bundle' || !argv[i + 1]) throw new Error('use one or more --bundle <bundle.json> arguments');
    bundles.push(resolve(argv[i + 1]));
  }
  if (bundles.length === 0) throw new Error('at least one bundle is required');
  return bundles;
}

function main() {
  const paths = parseArgs(process.argv.slice(2));
  const bundles = paths.map((pathValue) => {
    const realParent = realpathSync.native(dirname(pathValue));
    if (pathValue !== join(realParent, basename(pathValue))) throw new Error(`bundle parent symlink refused: ${pathValue}`);
    const stat = lstatSync(pathValue);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`bundle must be a regular file: ${pathValue}`);
    const bundle = JSON.parse(readFileSync(pathValue, 'utf8'));
    if (bundle.schema !== 'neo.code-integrity.patch-bundle-candidate.v3') throw new Error(`unsupported bundle schema: ${pathValue}`);
    const { metadataDigest, ...metadata } = bundle;
    if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error(`metadata digest mismatch: ${pathValue}`);
    const allowedFiles = [...(bundle.allowedFiles || [])].map(assertSafeRelativePath);
    if (!/^[a-f0-9]{40,64}$/.test(String(bundle.baseSha || ''))
      || !/^[a-f0-9]{40,64}$/.test(String(bundle.checkpoint?.baseTree || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(bundle.sourceDigest || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(bundle.checkpoint?.checkpointId || ''))
      || bundle.baseOverlayDigest == null
      || bundle.checkpoint?.state !== 'candidate'
      || bundle.integration?.productionReady !== false
      || bundle.candidateEvidence?.assurance !== 'candidate_current'
      || bundle.candidateEvidence?.productionReady !== false
      || bundle.baseSha !== bundle.checkpoint?.baseSha
      || bundle.sourceDigest !== bundle.checkpoint?.sourceDigest
      || bundle.baseOverlayDigest !== bundle.checkpoint?.baseOverlayDigest) {
      throw new Error(`bundle lacks compatible candidate base metadata: ${pathValue}`);
    }
    return {
      path: pathValue,
      patchId: String(bundle.patchId),
      dependencies: [...(bundle.dependencies || [])],
      baseSha: String(bundle.baseSha || ''),
      sourceDigest: String(bundle.sourceDigest || ''),
      baseTree: String(bundle.checkpoint?.baseTree || ''),
      baseOverlayDigest: String(bundle.baseOverlayDigest),
      checkpointId: String(bundle.checkpoint?.checkpointId || ''),
      allowedFiles,
    };
  });
  const ids = bundles.map((item) => item.patchId);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate patch id in bundle order');
  const position = new Map(ids.map((id, index) => [id, index]));
  /** @type {Array<Record<string, unknown>>} */
  const checks = [];
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index];
    for (const dependency of bundle.dependencies) {
      const dependencyIndex = position.get(dependency);
      const ok = dependencyIndex !== undefined && dependencyIndex < index;
      checks.push({ patchId: bundle.patchId, dependency, ok, dependencyIndex: dependencyIndex ?? null, patchIndex: index });
    }
    if (bundle.baseSha !== bundles[0].baseSha
      || bundle.sourceDigest !== bundles[0].sourceDigest
      || bundle.baseTree !== bundles[0].baseTree
      || bundle.baseOverlayDigest !== bundles[0].baseOverlayDigest
      || bundle.checkpointId !== bundles[0].checkpointId) {
      checks.push({ patchId: bundle.patchId, compatibility: 'authoritative_base', ok: false });
    }
    for (let earlier = 0; earlier < index; earlier += 1) {
      const overlap = bundle.allowedFiles.filter((item) => bundles[earlier].allowedFiles.includes(item));
      checks.push({ patchId: bundle.patchId, comparedWith: bundles[earlier].patchId, compatibility: 'file_overlap', overlap, ok: overlap.length === 0 });
    }
  }
  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({ assurance: 'candidate_set_metadata_only', productionReady: false, order: ids, checks, failed: failed.length }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`bundle set verification refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
