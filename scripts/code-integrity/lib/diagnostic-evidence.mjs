// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, describePaths, gitHead, hashBytes, listDirtyPaths, manifestDigest, runGit } from './artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, existingRealDirectory } from './policy.mjs';

const CAPTURE = fileURLToPath(new URL('../typescript-diagnostic-capture.mjs', import.meta.url));
const SAFE_RUN = fileURLToPath(new URL('../safe-run.mjs', import.meta.url));
const POLICY = fileURLToPath(new URL('./policy.mjs', import.meta.url));

/** @param {string} pathValue @param {string} root @param {string} label */
function readJson(pathValue, root, label) {
  const absolute = resolve(pathValue);
  assertPathInside(root, absolute, label);
  assertNoSymlinkSegments(root, absolute, label);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error(`${label} metadata digest mismatch`);
  return { absolute, bytes, value };
}

/** @param {string} pathValue @param {string} runtimeRoot @param {string} expectedHash @param {number} expectedSize */
function outputFile(pathValue, runtimeRoot, expectedHash, expectedSize) {
  const absolute = resolve(pathValue);
  assertPathInside(runtimeRoot, absolute, 'diagnostic stream');
  assertNoSymlinkSegments(runtimeRoot, absolute, 'diagnostic stream');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('diagnostic stream must be a regular file');
  const bytes = readFileSync(absolute);
  if (hashBytes(bytes) !== expectedHash || bytes.length !== expectedSize) throw new Error('diagnostic stream digest mismatch');
  return { absolute, bytes };
}

/** @param {string} repoRoot */
function currentSource(repoRoot) {
  const baseSha = gitHead(repoRoot);
  const baseTree = String(runGit(repoRoot, ['rev-parse', 'HEAD^{tree}']).stdout || '').trim();
  const dirtyItems = describePaths(repoRoot, listDirtyPaths(repoRoot));
  const overlayDigest = manifestDigest(dirtyItems);
  const subject = { kind: 'candidate-git-worktree-v1', baseSha, baseTree, dirtyItems, overlayDigest };
  return { ...subject, sourceDigest: `sha256:${hashBytes(canonicalJson(subject))}` };
}

/**
 * @param {{ evidencePath: string, safeRunReceiptPath: string, repoRoot: string, runtimeRoot: string }} input
 */
export function validateDiagnosticEvidence(input) {
  const repoRoot = existingRealDirectory(resolve(input.repoRoot), 'repository root');
  const runtimeRoot = existingRealDirectory(resolve(input.runtimeRoot), 'runtime root');
  const evidenceFile = readJson(input.evidencePath, runtimeRoot, 'diagnostic evidence');
  const safeFile = readJson(input.safeRunReceiptPath, runtimeRoot, 'diagnostic safe-run receipt');
  const evidence = evidenceFile.value;
  const safe = safeFile.value;
  if (evidence.schema !== 'neo.code-integrity.typescript-diagnostic-evidence.v1'
    || safe.schema !== 'neo.code-integrity.safe-run.v2'
    || evidence.tool?.name !== 'typescript'
    || evidence.stability?.stable !== true
    || evidence.stability.beforeSourceDigest !== evidence.stability.afterSourceDigest
    || evidence.stability.beforeSourceDigest !== evidence.source?.sourceDigest
    || !/^sha256:[a-f0-9]{64}$/.test(evidence.source?.sourceDigest || '')
    || canonicalJson(evidence.invocation?.args) !== canonicalJson(['--noEmit', '--pretty', 'false'])
    || evidence.invocation?.argsSha256 !== hashBytes(JSON.stringify(['--noEmit', '--pretty', 'false']))) {
    throw new Error('diagnostic evidence schema or invariant mismatch');
  }
  const current = currentSource(repoRoot);
  if (canonicalJson(current) !== canonicalJson(evidence.source)) throw new Error('diagnostic evidence is stale for source');
  const tscPath = resolve(evidence.tool.entrypoint || '');
  const packagePath = resolve(evidence.tool.packageJson || '');
  for (const [pathValue, expectedHash, label] of [
    [tscPath, evidence.tool.entrypointSha256, 'TypeScript entrypoint'],
    [packagePath, evidence.tool.packageJsonSha256, 'TypeScript package'],
  ]) {
    assertPathInside(repoRoot, pathValue, label);
    assertNoSymlinkSegments(repoRoot, pathValue, label);
    const stat = lstatSync(pathValue);
    if (!stat.isFile() || stat.isSymbolicLink() || hashBytes(readFileSync(pathValue)) !== expectedHash) throw new Error(`${label} mismatch`);
  }
  if (resolve(evidence.tool.nodePath || '') !== process.execPath
    || evidence.tool.nodeSha256 !== hashBytes(readFileSync(process.execPath))
    || !/^Version\s+\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(evidence.tool.version || '')) {
    throw new Error('TypeScript runtime identity mismatch');
  }
  const stdout = outputFile(evidence.result.stdout.path, runtimeRoot, evidence.result.stdout.sha256, evidence.result.stdout.size);
  const stderr = outputFile(evidence.result.stderr.path, runtimeRoot, evidence.result.stderr.sha256, evidence.result.stderr.size);
  const expectedCaptureArgs = [
    CAPTURE,
    '--repo-root', repoRoot,
    '--runtime-root', runtimeRoot,
    '--tsc-entrypoint', tscPath,
    '--typescript-package', packagePath,
    '--output', evidenceFile.absolute,
    '--stdout', stdout.absolute,
    '--stderr', stderr.absolute,
  ];
  const entrypoint = (safe.commandFiles || []).find((item) => item.role === 'entrypoint');
  const boundByPath = new Map((safe.boundOutputs || []).map((item) => [resolve(item.path || ''), item]));
  for (const [pathValue, bytes] of [[evidenceFile.absolute, evidenceFile.bytes], [stdout.absolute, stdout.bytes], [stderr.absolute, stderr.bytes]]) {
    const bound = boundByPath.get(pathValue);
    if (bound?.valid !== true || bound.sha256 !== hashBytes(bytes) || bound.size !== bytes.length) throw new Error('safe-run does not bind diagnostic outputs');
  }
  if ((safe.boundOutputs || []).length !== 3
    || safe.exitCode !== 0
    || safe.childExitCode !== 0
    || safe.signal !== null
    || safe.spawnError !== null
    || safe.network !== 'denied'
    || safe.processSignals !== 'denied'
    || resolve(safe.taskRoot || '') !== repoRoot
    || resolve(safe.cwd || '') !== repoRoot
    || resolve(safe.runtimeRoot || '') !== runtimeRoot
    || canonicalJson(safe.args) !== canonicalJson(expectedCaptureArgs)
    || resolve(entrypoint?.path || '') !== CAPTURE
    || entrypoint?.sha256 !== hashBytes(readFileSync(CAPTURE))
    || safe.runnerSha256 !== hashBytes(readFileSync(SAFE_RUN))
    || safe.policySha256 !== hashBytes(readFileSync(POLICY))) {
    throw new Error('diagnostic safe-run scope or command mismatch');
  }
  return {
    schema: evidence.schema,
    evidencePath: evidenceFile.absolute,
    evidenceSha256: hashBytes(evidenceFile.bytes),
    safeRunReceiptPath: safeFile.absolute,
    safeRunReceiptSha256: hashBytes(safeFile.bytes),
    repoRoot,
    runtimeRoot,
    source: evidence.source,
    tool: evidence.tool,
    invocation: evidence.invocation,
    result: evidence.result,
    stdoutText: stdout.bytes.toString('utf8'),
    stderrText: stderr.bytes.toString('utf8'),
  };
}
