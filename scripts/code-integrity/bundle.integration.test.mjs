#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson, describePaths, hashBytes, manifestDigest } from './lib/artifacts.mjs';
import { computeCandidateCheckpoint } from './lib/checkpoint.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = resolve(SCRIPT_DIR, '../..');
const CHANGED_GATE = join(SCRIPT_DIR, 'changed-gate.mjs');
const VERIFY_GATE = join(SCRIPT_DIR, 'verify-gate-receipt.mjs');

/** @param {string} pathValue @param {Record<string, unknown>} metadata */
function writeJson(pathValue, metadata) {
  writeFileSync(pathValue, `${JSON.stringify({ ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) }, null, 2)}\n`);
  return readFileSync(pathValue);
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} expected
 */
function run(executable, args, cwd, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${executable} ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

function main() {
  const runtimeRoot = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('runtime root argument is required');
  const fixtureRoot = join(runtimeRoot, 'bundle-integration', randomUUID());
  const repoRoot = join(fixtureRoot, 'repo');
  const targetRoot = join(fixtureRoot, 'target');
  const outputRoot = join(fixtureRoot, 'bundles');
  mkdirSync(repoRoot, { recursive: true, mode: 0o700 });

  run('/usr/bin/git', ['init', '--initial-branch=noe-main'], repoRoot);
  run('/usr/bin/git', ['config', 'user.email', 'code-integrity@example.invalid'], repoRoot);
  run('/usr/bin/git', ['config', 'user.name', 'Code Integrity Test'], repoRoot);
  run('/usr/bin/git', ['config', 'commit.gpgsign', 'false'], repoRoot);
  writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n');
  run('/usr/bin/git', ['add', 'tracked.txt'], repoRoot);
  run('/usr/bin/git', ['commit', '-m', 'fixture base'], repoRoot);
  const current = computeCandidateCheckpoint(repoRoot);
  const checkpointMetadata = {
    schema: 'neo.code-integrity.candidate-checkpoint.v1',
    state: 'candidate',
    productionReady: false,
    createdAt: new Date().toISOString(),
    label: 'fixture-clean-candidate',
    repoRoot,
    ...current,
    authority: { status: 'fixture', canonicalSourceDigest: null },
  };
  const checkpointPath = join(fixtureRoot, 'fixture-checkpoint.json');
  writeFileSync(checkpointPath, `${JSON.stringify({ ...checkpointMetadata, metadataDigest: hashBytes(canonicalJson(checkpointMetadata)) }, null, 2)}\n`);
  run('/usr/bin/git', ['worktree', 'add', '--detach', targetRoot, 'HEAD'], repoRoot);

  writeFileSync(join(repoRoot, 'tracked.txt'), 'ours\n');
  writeFileSync(join(repoRoot, 'added.txt'), 'added\n');
  const patchBundle = join(SCRIPT_DIR, 'patch-bundle.mjs');
  const verifyBundle = join(SCRIPT_DIR, 'verify-bundle.mjs');
  const verifySet = join(SCRIPT_DIR, 'verify-bundle-set.mjs');

  /** @param {string} label @param {string[]} allowedFiles */
  function candidateEvidence(label, allowedFiles) {
    const root = join(fixtureRoot, `evidence-${label}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const gatePath = join(root, 'gate.json');
    const gateSafePath = join(root, 'gate-safe.json');
    const verificationPath = join(root, 'verification.json');
    const verificationSafePath = join(root, 'verification-safe.json');
    const changedItems = describePaths(repoRoot, [...allowedFiles].sort());
    const gateArgv = [
      '--repo-root', repoRoot,
      '--runtime-root', fixtureRoot,
      '--receipt', gatePath,
      ...[...allowedFiles].sort().flatMap((pathValue) => ['--allowed-file', pathValue]),
    ];
    const gateBytes = writeJson(gatePath, {
      schema: 'neo.code-integrity.changed-gate.v3',
      status: 'pass',
      statusScope: 'isolated-static',
      staticGate: { passed: true, blockers: [] },
      integration: { ready: false, blockers: ['bauth_unbound'] },
      mode: 'worktree',
      baseSha: current.baseSha,
      headSha: current.baseSha,
      repoRoot,
      allowedFiles: [...allowedFiles].sort(),
      changedPaths: [...allowedFiles].sort(),
      changedItems,
      overlayDigest: manifestDigest(changedItems),
      blockers: [],
      outsideSlice: [],
      request: { argv: gateArgv },
    });
    const gateSafeBytes = writeJson(gateSafePath, {
      schema: 'neo.code-integrity.safe-run.v2',
      taskRoot: TASK_ROOT,
      runtimeRoot: fixtureRoot,
      cwd: repoRoot,
      executable: process.execPath,
      args: [CHANGED_GATE, ...gateArgv],
      commandFiles: [{ path: CHANGED_GATE, sha256: hashBytes(readFileSync(CHANGED_GATE)), role: 'entrypoint' }],
      exitCode: 0,
      childExitCode: 0,
      signal: null,
      spawnError: null,
      network: 'denied',
      processSignals: 'denied',
      boundOutputs: [{ path: gatePath, valid: true, sha256: hashBytes(gateBytes), size: gateBytes.length }],
    });
    const verificationChecks = Object.fromEntries([
      'receiptPassed',
      'staticGatePassed',
      'blockersEmpty',
      'requiredEvidenceMatches',
      'requestMatches',
      'baseMatches',
      'headMatches',
      'pathSetMatches',
      'inputDigestMatches',
      'commandShapesMatch',
      'commandLogsMatch',
      'safeRunTaskRootExact',
      'safeRunScopeExact',
      'safeRunArgvExact',
      'safeRunEffectivePolicy',
      'safeRunProfileRebuilt',
      'safeRunEntrypoint',
      'safeRunToolHashes',
      'safeRunBoundGate',
      'guardContextBound',
    ].map((id) => [id, true]));
    const verificationBytes = writeJson(verificationPath, {
      schema: 'neo.code-integrity.gate-receipt-verification.v1',
      state: 'current',
      targetReceipt: { path: gatePath, sha256: hashBytes(gateBytes) },
      safeRunReceipt: { path: gateSafePath, sha256: hashBytes(gateSafeBytes) },
      checks: verificationChecks,
    });
    const verifierArgs = [
      '--receipt', gatePath,
      '--repo-root', repoRoot,
      '--safe-run-receipt', gateSafePath,
      '--output', verificationPath,
      '--expected-task-root', TASK_ROOT,
    ];
    writeJson(verificationSafePath, {
      schema: 'neo.code-integrity.safe-run.v2',
      taskRoot: TASK_ROOT,
      runtimeRoot: fixtureRoot,
      cwd: repoRoot,
      executable: process.execPath,
      args: [VERIFY_GATE, ...verifierArgs],
      commandFiles: [{ path: VERIFY_GATE, sha256: hashBytes(readFileSync(VERIFY_GATE)), role: 'entrypoint' }],
      exitCode: 0,
      childExitCode: 0,
      signal: null,
      spawnError: null,
      network: 'denied',
      processSignals: 'denied',
      boundOutputs: [{ path: verificationPath, valid: true, sha256: hashBytes(verificationBytes), size: verificationBytes.length }],
    });
    return { gatePath, gateSafePath, verificationPath, verificationSafePath };
  }

  const firstEvidence = candidateEvidence('first', ['tracked.txt', 'added.txt']);
  run(process.execPath, [
    patchBundle,
    '--repo-root', repoRoot,
    '--output-root', outputRoot,
    '--patch-id', 'fixture-first',
    '--purpose', 'exercise modified and added preimage checks',
    '--checkpoint', checkpointPath,
    '--gate-receipt', firstEvidence.gatePath,
    '--gate-safe-run-receipt', firstEvidence.gateSafePath,
    '--gate-verification', firstEvidence.verificationPath,
    '--gate-verifier-safe-run-receipt', firstEvidence.verificationSafePath,
    '--allowed-file', 'tracked.txt',
    '--allowed-file', 'added.txt',
  ], repoRoot);

  const firstBundle = join(outputRoot, 'fixture-first', 'bundle.json');
  run(process.execPath, [verifyBundle, '--bundle', firstBundle, '--target-root', targetRoot], repoRoot, 0);
  const bundledGate = join(outputRoot, 'fixture-first', 'candidate-evidence', '01-gate.json');
  const bundledGateBytes = readFileSync(bundledGate);
  writeFileSync(bundledGate, 'tampered\n');
  run(process.execPath, [verifyBundle, '--bundle', firstBundle, '--target-root', targetRoot], repoRoot, 2);
  writeFileSync(bundledGate, bundledGateBytes);
  writeFileSync(join(outputRoot, 'fixture-first', 'new-files', 'added.txt'), 'tampered\n');
  run(process.execPath, [verifyBundle, '--bundle', firstBundle, '--target-root', targetRoot], repoRoot, 2);
  writeFileSync(join(outputRoot, 'fixture-first', 'new-files', 'added.txt'), 'added\n');
  writeFileSync(join(targetRoot, 'tracked.txt'), 'theirs\n');
  run(process.execPath, [verifyBundle, '--bundle', firstBundle, '--target-root', targetRoot], repoRoot, 2);

  writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n');
  unlinkSync(join(repoRoot, 'added.txt'));
  writeFileSync(join(repoRoot, 'second.txt'), 'second\n');
  const secondEvidence = candidateEvidence('second', ['second.txt']);
  run(process.execPath, [
    patchBundle,
    '--repo-root', repoRoot,
    '--output-root', outputRoot,
    '--patch-id', 'fixture-second',
    '--purpose', 'exercise dependency order checks',
    '--checkpoint', checkpointPath,
    '--gate-receipt', secondEvidence.gatePath,
    '--gate-safe-run-receipt', secondEvidence.gateSafePath,
    '--gate-verification', secondEvidence.verificationPath,
    '--gate-verifier-safe-run-receipt', secondEvidence.verificationSafePath,
    '--dependency', 'fixture-first',
    '--allowed-file', 'second.txt',
  ], repoRoot);
  const secondBundle = join(outputRoot, 'fixture-second', 'bundle.json');
  run(process.execPath, [verifySet, '--bundle', firstBundle, '--bundle', secondBundle], repoRoot, 0);
  run(process.execPath, [verifySet, '--bundle', secondBundle, '--bundle', firstBundle], repoRoot, 3);

  process.stdout.write('bundle integration tests: PASS (checkpoint/payload/preimage/dependency order)\n');
}

main();
