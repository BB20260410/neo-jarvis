#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { validateRequiredArtifacts } from './lib/required-artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = resolve(SCRIPT_DIR, '../..');
const SAFE_RUN = join(SCRIPT_DIR, 'safe-run.mjs');
const POLICY = join(SCRIPT_DIR, 'lib', 'policy.mjs');
const PROBE = join(SCRIPT_DIR, 'probe.mjs');
const ACTIVITY_SCAN = join(SCRIPT_DIR, 'activity-scan.mjs');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const runtimeRoot = resolve(runtimeInput);
const fixtureRoot = join(runtimeRoot, 'required-artifact-tests', randomUUID());
const mainRoot = join(fixtureRoot, 'active-main');
mkdirSync(mainRoot, { recursive: true, mode: 0o700 });

/** @param {string} pathValue @param {Record<string, unknown>} metadata */
function writeJson(pathValue, metadata) {
  const value = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  writeFileSync(pathValue, `${JSON.stringify(value, null, 2)}\n`);
  return { value, bytes: readFileSync(pathValue), sha256: hashBytes(readFileSync(pathValue)) };
}

/** @param {string} pathValue @param {string} entrypoint @param {string[]} args @param {number} exitCode @param {Record<string, unknown>[]} [boundOutputs] */
function writeSafeReceipt(pathValue, entrypoint, args, exitCode, boundOutputs = []) {
  return writeJson(pathValue, {
    schema: 'neo.code-integrity.safe-run.v2',
    taskRoot: TASK_ROOT,
    runtimeRoot,
    cwd: TASK_ROOT,
    executable: process.execPath,
    args: [entrypoint, ...args],
    commandFiles: [
      { path: process.execPath, sha256: hashBytes(readFileSync(process.execPath)), role: 'executable' },
      { path: entrypoint, sha256: hashBytes(readFileSync(entrypoint)), role: 'entrypoint' },
    ],
    runnerSha256: hashBytes(readFileSync(SAFE_RUN)),
    policySha256: hashBytes(readFileSync(POLICY)),
    allowedReadRoots: [TASK_ROOT, runtimeRoot],
    allowedWriteRoots: [runtimeRoot],
    protectedReadRoots: [mainRoot],
    network: 'denied',
    processSignals: 'denied',
    childExitCode: exitCode,
    exitCode,
    signal: null,
    spawnError: null,
    boundOutputs,
  });
}

const caseActions = new Map([
  ['allowed-runtime-write', 'allowed-write'],
  ['clone-source-write-denied', 'create-denied'],
  ['control-dir-rename-denied', 'control-dir-rename-denied'],
  ['main-rplus-denied', 'open-rplus-denied'],
  ['main-read-denied', 'read-denied'],
  ['symlink-escape-denied', 'symlink-rplus-denied'],
  ['symlink-read-denied', 'symlink-read-denied'],
  ['foreign-signal-denied', 'signal-zero-denied'],
  ['launchctl-exec-denied', 'launchctl-denied'],
  ['network-denied', 'network-denied'],
]);
const results = [];
for (const [name, action] of caseActions) {
  const receiptPath = join(fixtureRoot, `${name}.json`);
  const receipt = writeSafeReceipt(receiptPath, PROBE, [action], 0);
  results.push({
    name,
    passed: true,
    exitCode: 0,
    signal: null,
    receipt: receiptPath,
    receiptSha256: receipt.sha256,
    receiptValid: true,
  });
}
const now = new Date().toISOString();
const canaryPath = join(fixtureRoot, 'canary.json');
writeJson(canaryPath, {
  schema: 'neo.code-integrity.canary.v2',
  createdAt: now,
  taskRoot: TASK_ROOT,
  runtimeRoot,
  mainRoot,
  protectedPid: 999,
  total: results.length,
  passed: results.length,
  failed: 0,
  readyForStaticChecks: true,
  readyForRuntimeChecks: false,
  results,
});

const changedPaths = ['scripts/code-integrity/changed-gate.mjs'];
const activityPath = join(fixtureRoot, 'activity.json');
const activity = writeJson(activityPath, {
  schema: 'neo.code-integrity.activity-scan.v2',
  observedAt: now,
  sourceRoot: mainRoot,
  head: 'a'.repeat(40),
  dirtyCount: 1,
  dirtyDigest: 'b'.repeat(64),
  dirtyPaths: ['active.mjs'],
  allowedFiles: changedPaths,
  blockedAllowedPaths: [],
  responsibilityTerms: [{ id: 'source-digest', term: 'NoeSourceDigest' }],
  semanticHits: [{ id: 'source-digest', term: 'NoeSourceDigest', paths: ['active.mjs'] }],
  semanticConflictPaths: ['active.mjs'],
  clearForSlice: false,
});
const activityReceiptPath = join(fixtureRoot, 'activity-safe.json');
const activityArgs = [
  '--source-root', mainRoot,
  '--output', activityPath,
  '--allowed-file', changedPaths[0],
  '--responsibility-term', 'source-digest=NoeSourceDigest',
];
const activityReceipt = writeSafeReceipt(activityReceiptPath, ACTIVITY_SCAN, activityArgs, 3, [{
  path: activityPath,
  valid: true,
  reason: 'regular_file',
  sha256: activity.sha256,
  size: activity.bytes.length,
}]);
activityReceipt.value.allowedReadRoots = [TASK_ROOT, runtimeRoot, mainRoot];
const { metadataDigest: ignoredDigest, ...activitySafeMetadata } = activityReceipt.value;
void ignoredDigest;
writeJson(activityReceiptPath, activitySafeMetadata);

const accepted = validateRequiredArtifacts({
  artifactPaths: [canaryPath, activityPath, activityReceiptPath],
  repoRoot: TASK_ROOT,
  runtimeRoot,
  changedPaths,
  referenceTime: now,
});
assert.deepEqual(accepted.staticBlockers, []);
assert.equal(accepted.evidence.activity?.valid, true);
assert.equal(accepted.evidence.activity?.clearForSlice, false);
assert.equal(accepted.integration.ready, false);
assert.ok(accepted.integration.blockers.includes('activity_not_clear'));

const mismatchedReceiptPath = join(fixtureRoot, 'activity-safe-wrong-exit.json');
const wrong = writeSafeReceipt(mismatchedReceiptPath, ACTIVITY_SCAN, activityArgs, 0, [{
  path: activityPath,
  valid: true,
  reason: 'regular_file',
  sha256: activity.sha256,
  size: activity.bytes.length,
}]);
wrong.value.allowedReadRoots = [TASK_ROOT, runtimeRoot, mainRoot];
const { metadataDigest: ignoredWrongDigest, ...wrongMetadata } = wrong.value;
void ignoredWrongDigest;
writeJson(mismatchedReceiptPath, wrongMetadata);
const rejectedExit = validateRequiredArtifacts({
  artifactPaths: [canaryPath, activityPath, mismatchedReceiptPath],
  repoRoot: TASK_ROOT,
  runtimeRoot,
  changedPaths,
  referenceTime: now,
});
assert.ok(rejectedExit.staticBlockers.some((item) => item.startsWith('typed_activity_invalid:')));

const unknownPath = join(fixtureRoot, 'unknown.json');
writeJson(unknownPath, { schema: 'untrusted.opaque.v1', passed: true });
const unknown = validateRequiredArtifacts({
  artifactPaths: [unknownPath],
  repoRoot: TASK_ROOT,
  runtimeRoot,
  changedPaths: [],
  referenceTime: now,
});
assert.ok(unknown.staticBlockers.some((item) => item.includes('unsupported_evidence_schema')));

process.stdout.write('required artifact tests: PASS (typed canary/activity and negative decision semantics)\n');
