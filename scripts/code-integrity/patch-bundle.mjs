#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertSafeRelativePath,
  atomicJsonWrite,
  canonicalJson,
  describePath,
  describePaths,
  gitHead,
  hashBytes,
  listDirtyPaths,
  resolveWithin,
  runGit,
} from './lib/artifacts.mjs';
import { verifyCandidateCheckpoint } from './lib/checkpoint.mjs';
import { validateBundleCandidateEvidence } from './lib/bundle-evidence.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ repoRoot?: string, outputRoot?: string, patchId?: string, purpose?: string, checkpoint?: string, gateReceipt?: string, gateSafeRunReceipt?: string, gateVerification?: string, gateVerifierSafeRunReceipt?: string, allowedFiles: string[], dependencies: string[] }} */
  const out = { allowedFiles: [], dependencies: [] };
  const singleton = new Set(['--repo-root', '--output-root', '--patch-id', '--purpose', '--checkpoint', '--gate-receipt', '--gate-safe-run-receipt', '--gate-verification', '--gate-verifier-safe-run-receipt']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (singleton.has(key) && seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--output-root') out.outputRoot = value;
    else if (key === '--patch-id') out.patchId = value;
    else if (key === '--purpose') out.purpose = value;
    else if (key === '--checkpoint') out.checkpoint = resolve(value);
    else if (key === '--gate-receipt') out.gateReceipt = resolve(value);
    else if (key === '--gate-safe-run-receipt') out.gateSafeRunReceipt = resolve(value);
    else if (key === '--gate-verification') out.gateVerification = resolve(value);
    else if (key === '--gate-verifier-safe-run-receipt') out.gateVerifierSafeRunReceipt = resolve(value);
    else if (key === '--allowed-file') out.allowedFiles.push(assertSafeRelativePath(value));
    else if (key === '--dependency') out.dependencies.push(value);
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.repoRoot || !out.outputRoot || !out.patchId || !out.purpose || !out.checkpoint
    || !out.gateReceipt || !out.gateSafeRunReceipt || !out.gateVerification || !out.gateVerifierSafeRunReceipt) {
    throw new Error('repo/output/id/purpose/checkpoint and the four candidate evidence files are required');
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(out.patchId)) throw new Error('invalid patch id');
  for (const dependency of out.dependencies) {
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(dependency)) throw new Error(`invalid dependency id: ${dependency}`);
    if (dependency === out.patchId) throw new Error('patch cannot depend on itself');
  }
  if (out.allowedFiles.length === 0) throw new Error('at least one --allowed-file is required');
  return out;
}

/** @param {string} checkpointPath @param {string} repoRoot */
function readCheckpoint(checkpointPath, repoRoot) {
  return verifyCandidateCheckpoint(checkpointPath, repoRoot).value;
}

/** @param {string} root @param {string} pathValue */
function baseFile(root, pathValue) {
  const probe = runGit(root, ['cat-file', '-e', `HEAD:${pathValue}`], { allowFailure: true });
  if (probe.status !== 0) return null;
  const content = /** @type {Buffer} */ (runGit(root, ['show', `HEAD:${pathValue}`], { encoding: null }).stdout);
  const tree = String(runGit(root, ['ls-tree', 'HEAD', '--', pathValue]).stdout || '').trim();
  const modeText = tree.split(/\s+/)[0] || '';
  if (!['100644', '100755'].includes(modeText)) throw new Error(`unsupported base file mode for bundle: ${pathValue}:${modeText}`);
  return { bytes: content, sha256: hashBytes(content), mode: modeText, fsMode: modeText === '100755' ? 0o755 : 0o644 };
}

/** @param {string} pathValue @param {string} label */
function assertRegularFile(pathValue, label) {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${pathValue}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const outputRoot = resolve(args.outputRoot);
  if (process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT) {
    const guardRoot = resolve(process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT);
    assertPathInside(guardRoot, outputRoot, 'bundle output root');
    assertPathInside(guardRoot, args.checkpoint, 'checkpoint');
    for (const evidencePath of [args.gateReceipt, args.gateSafeRunReceipt, args.gateVerification, args.gateVerifierSafeRunReceipt]) {
      assertPathInside(guardRoot, evidencePath, 'candidate evidence');
    }
  }
  if (process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT) {
    const guardRoot = resolve(process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT);
    assertNoSymlinkSegments(guardRoot, outputRoot, 'bundle output root');
    assertNoSymlinkSegments(guardRoot, args.checkpoint, 'checkpoint');
  }
  const checkpoint = readCheckpoint(args.checkpoint, repoRoot);
  const allowedFiles = [...new Set(args.allowedFiles)].sort();
  const dirtyPaths = listDirtyPaths(repoRoot);
  const dirtyOutsideSlice = dirtyPaths.filter((item) => !allowedFiles.includes(item));
  const allowedNotDirty = allowedFiles.filter((item) => !dirtyPaths.includes(item));
  if (dirtyOutsideSlice.length > 0) throw new Error(`dirty paths outside patch slice: ${dirtyOutsideSlice.join(',')}`);
  if (allowedNotDirty.length > 0) throw new Error(`allowed paths are not dirty: ${allowedNotDirty.join(',')}`);
  const baseSha = gitHead(repoRoot);
  const postItems = describePaths(repoRoot, allowedFiles);
  const evidenceRoot = process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT
    ? existingRealDirectory(resolve(process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT), 'evidence root')
    : existingRealDirectory(dirname(args.checkpoint), 'evidence root');
  const candidateEvidence = validateBundleCandidateEvidence({
    evidenceRoot,
    gatePath: args.gateReceipt,
    gateSafeRunPath: args.gateSafeRunReceipt,
    verificationPath: args.gateVerification,
    verificationSafeRunPath: args.gateVerifierSafeRunReceipt,
    subjectRepoRoot: repoRoot,
    checkpoint,
    allowedFiles,
    postItems,
  });
  const patchRoot = join(outputRoot, args.patchId);
  if (existsSync(patchRoot)) throw new Error(`patch bundle already exists: ${patchRoot}`);
  mkdirSync(patchRoot, { recursive: true, mode: 0o700 });
  /** @type {Array<Record<string, unknown>>} */
  const files = [];
  for (const pathValue of allowedFiles) {
    const base = baseFile(repoRoot, pathValue);
    const post = describePath(repoRoot, pathValue);
    if (!base && post.kind === 'deleted') throw new Error(`allowed path absent in base and worktree: ${pathValue}`);
    if (post.kind === 'symlink') throw new Error(`patch symlink refused: ${pathValue}`);
    const changeType = !base ? 'added' : post.kind === 'deleted' ? 'deleted' : 'modified';
    let baseArtifact = null;
    let oursArtifact = null;
    let newFileArtifact = null;

    if (base) {
      const baseTarget = resolveWithin(join(patchRoot, 'base'), pathValue);
      mkdirSync(dirname(baseTarget), { recursive: true, mode: 0o700 });
      writeFileSync(baseTarget, base.bytes, { mode: 0o600 });
      assertRegularFile(baseTarget, 'base artifact');
      const baseBytes = readFileSync(baseTarget);
      if (hashBytes(baseBytes) !== base.sha256) throw new Error(`base artifact digest mismatch: ${pathValue}`);
      baseArtifact = { path: `base/${pathValue}`, sha256: hashBytes(baseBytes), size: baseBytes.length };
    }
    if (post.kind !== 'deleted') {
      const source = resolveWithin(repoRoot, pathValue);
      const oursTarget = resolveWithin(join(patchRoot, 'ours'), pathValue);
      mkdirSync(dirname(oursTarget), { recursive: true, mode: 0o700 });
      copyFileSync(source, oursTarget);
      assertRegularFile(oursTarget, 'ours artifact');
      const oursBytes = readFileSync(oursTarget);
      if (hashBytes(oursBytes) !== post.sha256) throw new Error(`ours artifact digest mismatch: ${pathValue}`);
      oursArtifact = { path: `ours/${pathValue}`, sha256: hashBytes(oursBytes), size: oursBytes.length };
      if (changeType === 'added') {
        const newTarget = resolveWithin(join(patchRoot, 'new-files'), pathValue);
        mkdirSync(dirname(newTarget), { recursive: true, mode: 0o700 });
        copyFileSync(source, newTarget);
        assertRegularFile(newTarget, 'new-file artifact');
        const newBytes = readFileSync(newTarget);
        if (hashBytes(newBytes) !== post.sha256) throw new Error(`new-file artifact digest mismatch: ${pathValue}`);
        newFileArtifact = { path: `new-files/${pathValue}`, sha256: hashBytes(newBytes), size: newBytes.length };
      }
    }
    files.push({
      path: pathValue,
      changeType,
      preimageSha256: base?.sha256 || null,
      preimageMode: base?.mode || null,
      preimageFsMode: base?.fsMode || null,
      postimageSha256: post.sha256,
      postimageMode: post.mode,
      postimageKind: post.kind,
      postimageSize: post.size,
      artifacts: { base: baseArtifact, ours: oursArtifact, newFile: newFileArtifact },
    });
  }

  const patchResult = runGit(repoRoot, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...allowedFiles], { encoding: null });
  const trackedPatch = /** @type {Buffer} */ (patchResult.stdout);
  const trackedPatchPath = join(patchRoot, 'tracked.patch');
  writeFileSync(trackedPatchPath, trackedPatch, { mode: 0o600 });

  const evidenceOutputRoot = join(patchRoot, 'candidate-evidence');
  mkdirSync(evidenceOutputRoot, { recursive: true, mode: 0o700 });
  const evidenceInputs = [
    ['gate', args.gateReceipt],
    ['gateSafeRun', args.gateSafeRunReceipt],
    ['verification', args.gateVerification],
    ['verificationSafeRun', args.gateVerifierSafeRunReceipt],
  ];
  const bundledEvidenceFiles = Object.fromEntries(evidenceInputs.map(([key, source], index) => {
    const target = join(evidenceOutputRoot, `${String(index + 1).padStart(2, '0')}-${key}.json`);
    copyFileSync(source, target);
    assertRegularFile(target, 'candidate evidence');
    const bytes = readFileSync(target);
    return [key, { source, bundledAs: `candidate-evidence/${basename(target)}`, sha256: hashBytes(bytes), size: bytes.length }];
  }));

  const metadata = {
    schema: 'neo.code-integrity.patch-bundle-candidate.v3',
    patchId: args.patchId,
    purpose: args.purpose,
    createdAt: new Date().toISOString(),
    repoRoot,
    baseSha,
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      state: checkpoint.state,
      baseSha: checkpoint.baseSha,
      baseTree: checkpoint.baseTree,
      baseOverlayDigest: checkpoint.overlayDigest,
      sourceDigest: checkpoint.sourceDigest,
      sourceDigestKind: checkpoint.sourceDigestKind,
      pathCount: checkpoint.pathCount,
      productionReady: false,
    },
    baseOverlayDigest: checkpoint.overlayDigest,
    sourceDigest: checkpoint.sourceDigest,
    dependencies: [...new Set(args.dependencies)],
    allowedFiles,
    files,
    reviewPatch: { path: 'tracked.patch', sha256: hashBytes(trackedPatch), size: trackedPatch.length, applied: false },
    candidateEvidence: {
      ...candidateEvidence,
      files: bundledEvidenceFiles,
    },
    attachments: [],
    integration: {
      mode: 'candidate-verify-only',
      applySource: 'ours_payload_only_after_replay',
      reviewPatchApplied: false,
      productionReady: false,
      requiresUniqueIntegrator: true,
      requiresLatestBauthReplay: true,
      preimageMismatch: 'refuse',
      existingAddedPath: 'refuse',
      staleReceiptsAfterReplay: true,
      candidateEvidence: 'four_way_bound',
    },
  };
  const bundle = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  const bundlePath = join(patchRoot, 'bundle.json');
  atomicJsonWrite(bundlePath, bundle);
  writeFileSync(join(patchRoot, 'APPLY.md'), `# ${args.patchId}\n\nPurpose: ${args.purpose}\n\nThis is a candidate bundle, not an authoritative or directly applicable patch. tracked.patch is review-only; replay uses verified ours payloads after a unique integrator creates the latest Bauth. Do not copy files into an active working tree. Any preimage, mode, HEAD, semantic-overlap or receipt mismatch refuses replay.\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ patchId: args.patchId, baseSha, fileCount: files.length, bundlePath })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`patch bundle refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
