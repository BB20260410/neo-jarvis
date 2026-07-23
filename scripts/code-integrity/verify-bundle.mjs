#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertSafeRelativePath,
  canonicalJson,
  describePath,
  hashBytes,
  gitHead,
  listDirtyPaths,
  resolveWithin,
  runGit,
} from './lib/artifacts.mjs';
import { assertNoSymlinkSegments, existingRealDirectory } from './lib/policy.mjs';
import { validateBundleCandidateEvidence } from './lib/bundle-evidence.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ bundle?: string, targetRoot?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--bundle') out.bundle = value;
    else if (key === '--target-root') out.targetRoot = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.bundle || !out.targetRoot) throw new Error('--bundle and --target-root are required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundlePath = resolve(args.bundle);
  const targetRoot = existingRealDirectory(resolve(args.targetRoot), 'target root');
  const bundleParent = realpathSync.native(dirname(bundlePath));
  if (bundlePath !== join(bundleParent, basename(bundlePath))) throw new Error('bundle parent symlink refused');
  const bundleStat = lstatSync(bundlePath);
  if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) throw new Error('bundle must be a regular file');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  if (bundle.schema !== 'neo.code-integrity.patch-bundle-candidate.v3') throw new Error('unsupported bundle schema');
  const { metadataDigest, ...metadata } = bundle;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error('bundle metadata digest mismatch');
  if (!bundle.checkpoint?.checkpointId
    || bundle.checkpoint.state !== 'candidate'
    || bundle.checkpoint.productionReady !== false
    || bundle.baseOverlayDigest == null
    || !/^sha256:[a-f0-9]{64}$/.test(String(bundle.sourceDigest || ''))
    || bundle.integration?.mode !== 'candidate-verify-only'
    || bundle.integration?.applySource !== 'ours_payload_only_after_replay'
    || bundle.integration?.reviewPatchApplied !== false
    || bundle.integration?.productionReady !== false
    || bundle.integration?.candidateEvidence !== 'four_way_bound'
    || bundle.candidateEvidence?.assurance !== 'candidate_current'
    || bundle.candidateEvidence?.productionReady !== false
    || bundle.candidateEvidence?.authoritativeReplay !== false) {
    throw new Error('bundle lacks candidate checkpoint or fail-closed integration metadata');
  }
  if (bundle.baseSha !== bundle.checkpoint.baseSha
    || bundle.baseOverlayDigest !== bundle.checkpoint.baseOverlayDigest
    || bundle.sourceDigest !== bundle.checkpoint.sourceDigest) {
    throw new Error('bundle top-level and nested checkpoint metadata differ');
  }
  const allowedFiles = (bundle.allowedFiles || []).map(assertSafeRelativePath);
  const filePaths = (bundle.files || []).map((file) => assertSafeRelativePath(file.path));
  if (new Set(allowedFiles).size !== allowedFiles.length
    || new Set(filePaths).size !== filePaths.length
    || canonicalJson([...allowedFiles].sort()) !== canonicalJson([...filePaths].sort())) {
    throw new Error('bundle allowedFiles and file records differ');
  }

  const bundleRoot = dirname(bundlePath);
  assertNoSymlinkSegments(bundleRoot, bundleRoot, 'bundle root');
  const patchPath = resolveWithin(bundleRoot, bundle.reviewPatch.path);
  assertNoSymlinkSegments(bundleRoot, patchPath, 'tracked patch');
  const patchStat = lstatSync(patchPath);
  if (!patchStat.isFile() || patchStat.isSymbolicLink()) throw new Error('tracked patch must be a regular file');
  const patchBytes = readFileSync(patchPath);
  if (hashBytes(patchBytes) !== bundle.reviewPatch.sha256 || patchBytes.length !== bundle.reviewPatch.size) {
    throw new Error('review patch digest or size mismatch');
  }
  const evidenceFiles = bundle.candidateEvidence?.files || {};
  for (const key of ['gate', 'gateSafeRun', 'verification', 'verificationSafeRun']) {
    const evidence = evidenceFiles[key];
    if (!evidence?.bundledAs) throw new Error(`candidate evidence file missing: ${key}`);
    const pathValue = resolveWithin(bundleRoot, evidence.bundledAs);
    assertNoSymlinkSegments(bundleRoot, pathValue, 'bundled candidate evidence');
    const stat = lstatSync(pathValue);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`candidate evidence must be a regular file: ${pathValue}`);
    const bytes = readFileSync(pathValue);
    if (hashBytes(bytes) !== evidence.sha256 || bytes.length !== evidence.size) throw new Error(`candidate evidence digest mismatch: ${pathValue}`);
  }
  const postItems = (bundle.files || []).map((file) => ({
    path: file.path,
    kind: file.postimageKind,
    size: file.postimageSize,
    mode: file.postimageMode,
    sha256: file.postimageSha256,
  })).sort((a, b) => a.path.localeCompare(b.path));
  const currentCandidateEvidence = validateBundleCandidateEvidence({
    evidenceRoot: bundleRoot,
    gatePath: resolveWithin(bundleRoot, evidenceFiles.gate.bundledAs),
    gateSafeRunPath: resolveWithin(bundleRoot, evidenceFiles.gateSafeRun.bundledAs),
    verificationPath: resolveWithin(bundleRoot, evidenceFiles.verification.bundledAs),
    verificationSafeRunPath: resolveWithin(bundleRoot, evidenceFiles.verificationSafeRun.bundledAs),
    subjectRepoRoot: bundle.repoRoot,
    checkpoint: bundle.checkpoint,
    allowedFiles,
    postItems,
  });
  for (const key of ['schema', 'scope', 'assurance', 'productionReady', 'authoritativeReplay', 'subjectDigest']) {
    if (currentCandidateEvidence[key] !== bundle.candidateEvidence[key]) throw new Error(`candidate evidence metadata mismatch: ${key}`);
  }

  /** @type {Array<Record<string, unknown>>} */
  const artifactChecks = [];
  for (const file of bundle.files || []) {
    if (!['added', 'deleted', 'modified'].includes(file.changeType)
      || ![null, 0o644, 0o755].includes(file.preimageFsMode)
      || ![null, 0o644, 0o755].includes(file.postimageMode)) {
      throw new Error(`invalid file transition metadata: ${file.path}`);
    }
    const expectedArtifacts = [
      ...(file.preimageSha256 ? [{ artifact: file.artifacts?.base, expectedImage: file.preimageSha256 }] : []),
      ...(file.changeType === 'deleted' ? [] : [{ artifact: file.artifacts?.ours, expectedImage: file.postimageSha256 }]),
      ...(file.changeType === 'added' ? [{ artifact: file.artifacts?.newFile, expectedImage: file.postimageSha256 }] : []),
    ];
    if (expectedArtifacts.some((item) => !item.artifact)) throw new Error(`missing bundled artifact metadata: ${file.path}`);
    for (const { artifact, expectedImage } of expectedArtifacts) {
      const artifactPath = resolveWithin(bundleRoot, artifact.path);
      assertNoSymlinkSegments(bundleRoot, artifactPath, 'bundled artifact');
      const artifactStat = lstatSync(artifactPath);
      if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) throw new Error(`bundled artifact must be a regular file: ${artifactPath}`);
      const bytes = readFileSync(artifactPath);
      const ok = hashBytes(bytes) === artifact.sha256 && artifact.sha256 === expectedImage && bytes.length === artifact.size;
      artifactChecks.push({ path: artifact.path, sourcePath: file.path, ok });
      if (!ok) throw new Error(`bundled artifact digest mismatch: ${artifact.path}`);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const checks = [];
  const targetHead = gitHead(targetRoot);
  const targetTree = String(runGit(targetRoot, ['rev-parse', 'HEAD^{tree}']).stdout || '').trim();
  const targetDirty = listDirtyPaths(targetRoot);
  if (targetHead !== bundle.baseSha || targetTree !== bundle.checkpoint.baseTree || targetDirty.length > 0) {
    throw new Error('target must be a clean clone at the candidate checkpoint HEAD/tree');
  }
  for (const file of bundle.files || []) {
    const pathValue = assertSafeRelativePath(file.path);
    const target = resolveWithin(targetRoot, pathValue);
    const current = describePath(targetRoot, pathValue);
    let ok = false;
    let reason = '';
    if (file.changeType === 'added') {
      try {
        lstatSync(target);
        ok = false;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') ok = true;
        else throw error;
      }
      reason = ok ? 'added_path_absent' : 'added_path_already_exists';
    } else {
      ok = current.kind !== 'deleted'
        && current.sha256 === file.preimageSha256
        && current.mode === file.preimageFsMode;
      reason = ok ? 'preimage_and_mode_match' : 'preimage_or_mode_mismatch';
    }
    checks.push({ path: pathValue, ok, reason, currentSha256: current.sha256, expectedSha256: file.preimageSha256 });
  }
  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({ patchId: bundle.patchId, targetRoot, productionReady: false, artifactChecks, checks, failed: failed.length }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`bundle verification refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
