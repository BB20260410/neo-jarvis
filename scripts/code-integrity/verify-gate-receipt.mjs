#!/usr/bin/env node
// @ts-check

import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJsonWrite, canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { buildGateInput, collectChangeContext, evaluateGatePolicy, expectedCommandSpecs, selectTests } from './lib/gate.mjs';
import { inspectChangedFiles } from './lib/mechanical.mjs';
import { validateGateIntegrationEvidence } from './lib/integration-evidence.mjs';
import { validateRequiredArtifacts } from './lib/required-artifacts.mjs';
import {
  assertNoSymlinkSegments,
  assertPathInside,
  buildSandboxProfile,
  defaultProtectedReadRoots,
  existingExecutable,
  existingRealDirectory,
  uniquePaths,
} from './lib/policy.mjs';

const CHANGED_GATE = resolve(fileURLToPath(new URL('./changed-gate.mjs', import.meta.url)));
const SAFE_RUN = resolve(fileURLToPath(new URL('./safe-run.mjs', import.meta.url)));
const POLICY = resolve(fileURLToPath(new URL('./lib/policy.mjs', import.meta.url)));
const GIT_SHIM = '/usr/bin/git';
const GIT_TARGET = '/Applications/Xcode.app/Contents/Developer/usr/bin/git';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ receipt?: string, repoRoot?: string, safeRunReceipt?: string, output?: string, expectedTaskRoot?: string, protectedReadRoots: string[] }} */
  const out = { protectedReadRoots: [] };
  const singleton = new Set(['--receipt', '--repo-root', '--safe-run-receipt', '--output', '--expected-task-root']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (singleton.has(key) && seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--receipt') out.receipt = value;
    else if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--safe-run-receipt') out.safeRunReceipt = value;
    else if (key === '--output') out.output = value;
    else if (key === '--expected-task-root') out.expectedTaskRoot = value;
    else if (key === '--require-protected-read') out.protectedReadRoots.push(value);
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.receipt || !out.repoRoot || !out.safeRunReceipt || !out.output || !out.expectedTaskRoot) {
    throw new Error('--receipt, --repo-root, --safe-run-receipt, --output and --expected-task-root are required');
  }
  return out;
}

/** @param {string} pathValue @param {string} root @param {string} expectedHash */
function fileCheck(pathValue, root, expectedHash) {
  const absolute = resolve(pathValue || '/__missing__');
  try {
    assertPathInside(root, absolute, 'receipt-bound file');
    assertNoSymlinkSegments(root, absolute, 'receipt-bound file');
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return { path: absolute, ok: false, reason: 'not_regular_file' };
    const ok = hashBytes(readFileSync(absolute)) === expectedHash;
    return { path: absolute, ok, reason: ok ? 'hash_matches' : 'hash_mismatch' };
  } catch (error) {
    return { path: absolute, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {string} pathValue */
function readReceipt(pathValue) {
  const absolute = resolve(pathValue);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`receipt must be a regular file: ${absolute}`);
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error(`receipt metadata digest mismatch: ${absolute}`);
  return { absolute, bytes, value };
}

/** @param {string[]} argv @param {string} name */
function valuesFor(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 2) if (argv[i] === name) values.push(argv[i + 1]);
  return values;
}

/** @param {string[]} argv @param {string} name */
function singletonValue(argv, name) {
  const values = valuesFor(argv, name);
  return values.length === 1 ? values[0] : null;
}

/** @param {string} pathValue */
function directoryIdentity(pathValue) {
  const realPath = existingRealDirectory(pathValue, 'expected policy directory');
  const stat = lstatSync(realPath);
  return { resolvedPath: resolve(pathValue), realPath, dev: stat.dev, ino: stat.ino, kind: 'directory' };
}

/** @param {unknown[]} left @param {unknown[]} right */
function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = existingRealDirectory(resolve(args.repoRoot), 'repository root');
  const expectedTaskRoot = existingRealDirectory(resolve(args.expectedTaskRoot), 'expected task root');
  assertPathInside(expectedTaskRoot, repoRoot, 'repository root');
  const gateFile = readReceipt(args.receipt);
  const safeFile = readReceipt(args.safeRunReceipt);
  const receipt = gateFile.value;
  const safe = safeFile.value;
  if (receipt.schema !== 'neo.code-integrity.changed-gate.v3') throw new Error('unsupported gate receipt schema');
  if (safe.schema !== 'neo.code-integrity.safe-run.v2') throw new Error('unsupported safe-run receipt schema');
  const runtimeRoot = existingRealDirectory(resolve(receipt.runtimeRoot), 'runtime root');
  const outputPath = resolve(args.output);
  assertPathInside(runtimeRoot, gateFile.absolute, 'gate receipt');
  assertPathInside(runtimeRoot, safeFile.absolute, 'safe-run receipt');
  assertPathInside(runtimeRoot, outputPath, 'verification result');
  assertNoSymlinkSegments(runtimeRoot, outputPath, 'verification result');

  const rawGateArgs = Array.isArray(receipt.request?.argv) ? receipt.request.argv : [];
  // path.resolve as map callback would receive (value, index, array) and treat the array as a path segment.
  const requestArtifacts = Array.isArray(receipt.request?.requiredArtifacts)
    ? receipt.request.requiredArtifacts.map((item) => resolve(String(item)))
    : [];
  const requestAllowed = Array.isArray(receipt.request?.allowedFiles) ? receipt.request.allowedFiles : [];
  const requestTests = Array.isArray(receipt.request?.explicitTests) ? receipt.request.explicitTests : [];
  const context = collectChangeContext(repoRoot, receipt.mode, receipt.range || null);
  const selection = selectTests(repoRoot, context.paths, requestTests);
  const mechanical = inspectChangedFiles(repoRoot, context.paths, context.newPaths, context.addedLines);
  const requiredEvidence = validateRequiredArtifacts({
    artifactPaths: requestArtifacts,
    repoRoot,
    runtimeRoot,
    changedPaths: context.paths,
    referenceTime: receipt.createdAt,
  });
  const policy = evaluateGatePolicy(context, selection, mechanical, requestAllowed);
  policy.blockers.push(...requiredEvidence.staticBlockers);
  const currentInput = buildGateInput(context, selection);
  const expectedCommands = expectedCommandSpecs(repoRoot, runtimeRoot, context, selection);

  const companionPaths = requestArtifacts;
  const externalEvidenceChecks = selection.plans.filter((item) => item.runner === 'external-evidence').map((plan) => {
    const recorded = (receipt.selection.externalEvidence || []).find((item) => item.testPath === plan.path);
    try {
      const current = validateGateIntegrationEvidence(
        recorded?.summaryPath || '',
        repoRoot,
        runtimeRoot,
        companionPaths,
        selection.impactMap.requiredScenarioIds,
      );
      return { path: plan.path, ok: canonicalJson(current) === canonicalJson(recorded) };
    } catch (error) {
      return { path: plan.path, ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  for (const item of externalEvidenceChecks.filter((entry) => !entry.ok)) {
    policy.blockers.push(`external_test_evidence_missing_or_stale:${item.path}`);
  }

  const artifactChecks = (receipt.artifacts || []).map((artifact) => fileCheck(artifact.path, runtimeRoot, artifact.sha256));
  const commandLogChecks = (receipt.commands || []).flatMap((command) => [
    fileCheck(command.stdoutLog, runtimeRoot, command.stdoutSha256),
    fileCheck(command.stderrLog, runtimeRoot, command.stderrSha256),
  ]);
  const commandShapeChecks = expectedCommands.map((expected, index) => {
    const actual = receipt.commands?.[index];
    const ok = Boolean(actual)
      && actual.kind === expected.kind
      && actual.path === expected.path
      && actual.executable === safe.executable
      && same(actual.args, expected.args)
      && actual.exitCode === 0
      && actual.signal === null
      && actual.spawnError === null;
    return { index, kind: expected.kind, path: expected.path, ok };
  });

  const expectedAllowedReadRoots = uniquePaths([expectedTaskRoot, runtimeRoot]);
  const expectedAllowedWriteRoots = [runtimeRoot];
  const expectedProtectedReadRoots = uniquePaths([
    ...defaultProtectedReadRoots(safe.homeReadRoot || homedir()),
    ...args.protectedReadRoots.map((item) => resolve(item)),
  ]);
  const expectedProtectedWriteRoots = uniquePaths([
    join(runtimeRoot, 'profiles'),
    join(runtimeRoot, 'receipts'),
    join(runtimeRoot, 'guard-contexts'),
    dirname(safeFile.absolute),
  ]);
  const expectedExecutables = uniquePaths([
    existingExecutable(process.execPath),
    existingExecutable(GIT_SHIM),
    existingExecutable(GIT_TARGET),
  ]);
  const expectedProfile = buildSandboxProfile({
    allowedExecutables: expectedExecutables,
    allowedWriteRoots: expectedAllowedWriteRoots,
    protectedWriteRoots: expectedProtectedWriteRoots,
    allowedReadRoots: expectedAllowedReadRoots,
    homeReadRoot: safe.homeReadRoot || homedir(),
    protectedReadRoots: expectedProtectedReadRoots,
    allowNetwork: false,
  });
  const expectedEffectivePolicy = {
    taskRoot: directoryIdentity(expectedTaskRoot),
    runtimeRoot: directoryIdentity(runtimeRoot),
    cwd: directoryIdentity(repoRoot),
    allowedExecutables: expectedExecutables,
    allowedWriteRoots: expectedAllowedWriteRoots,
    protectedWriteRoots: expectedProtectedWriteRoots,
    allowedReadRoots: expectedAllowedReadRoots,
    protectedReadRoots: expectedProtectedReadRoots,
    network: 'denied',
    processSignals: 'denied',
    profileSha256: hashBytes(expectedProfile),
  };

  const boundGate = (safe.boundOutputs || []).find((item) => resolve(item.path || '') === gateFile.absolute);
  const safeEntrypoint = (safe.commandFiles || []).find((item) => item.role === 'entrypoint');
  const guardContextCheck = fileCheck(safe.guardContext?.path || '', runtimeRoot, safe.guardContext?.sha256 || '');
  const profileCheck = fileCheck(safe.profilePath || '', runtimeRoot, safe.profileSha256 || '');
  const requestedMode = singletonValue(rawGateArgs, '--mode') || 'worktree';
  const requestedRange = singletonValue(rawGateArgs, '--range');
  const requestChecks = {
    argvHash: receipt.request?.argvSha256 === hashBytes(JSON.stringify(rawGateArgs)),
    repo: resolve(singletonValue(rawGateArgs, '--repo-root') || '') === repoRoot,
    runtime: resolve(singletonValue(rawGateArgs, '--runtime-root') || '') === runtimeRoot,
    receipt: resolve(singletonValue(rawGateArgs, '--receipt') || '') === gateFile.absolute,
    mode: requestedMode === receipt.mode,
    range: (requestedRange || null) === (receipt.range || null),
    tests: same(valuesFor(rawGateArgs, '--test'), requestTests),
    artifacts: same(
      valuesFor(rawGateArgs, '--require-artifact').map((item) => resolve(String(item))),
      requestArtifacts,
    ),
    allowed: same(valuesFor(rawGateArgs, '--allowed-file'), requestAllowed),
  };

  const checks = {
    receiptPassed: receipt.status === 'pass' && receipt.statusScope === 'isolated-static',
    staticGatePassed: receipt.staticGate?.passed === true && same(receipt.staticGate?.blockers || [], receipt.blockers || []),
    blockersEmpty: Array.isArray(receipt.blockers) && receipt.blockers.length === 0,
    mechanicalPassed: receipt.mechanical?.passed === true && receipt.mechanical?.issues?.length === 0,
    mechanicalMatches: canonicalJson(mechanical) === canonicalJson(receipt.mechanical),
    blockersMatch: canonicalJson(policy.blockers) === canonicalJson(receipt.blockers),
    allowedFilesMatch: canonicalJson(policy.allowedFiles) === canonicalJson(receipt.allowedFiles),
    outsideSliceMatches: canonicalJson(policy.outsideSlice) === canonicalJson(receipt.outsideSlice),
    requiredEvidenceMatches: canonicalJson(requiredEvidence.evidence) === canonicalJson(receipt.evidence)
      && canonicalJson(requiredEvidence.integration) === canonicalJson(receipt.integration)
      && canonicalJson(requiredEvidence.artifacts) === canonicalJson(receipt.artifacts),
    integrationDispositionMatches: context.paths.some((item) => item.startsWith('scripts/code-integrity/'))
      ? receipt.integration?.ready === false
        && Array.isArray(receipt.integration?.blockers)
        && receipt.integration.blockers.length > 0
      : receipt.integration?.ready === null,
    policyClassificationMatches: canonicalJson(policy.criticalPaths) === canonicalJson(receipt.selection.criticalPaths)
      && canonicalJson(policy.unsupportedPaths) === canonicalJson(receipt.selection.unsupportedPaths)
      && canonicalJson(policy.nonNodeBehaviorPaths) === canonicalJson(receipt.selection.nonNodeBehaviorPaths),
    artifactsDeclaredValid: (receipt.artifacts || []).every((item) => item.exists === true && item.valid === true),
    requestMatches: Object.values(requestChecks).every(Boolean),
    repoRootMatches: repoRoot === receipt.repoRoot,
    baseMatches: context.baseSha === receipt.baseSha,
    headMatches: context.headSha === receipt.headSha,
    pathSetMatches: same(context.paths, receipt.changedPaths),
    newPathSetMatches: same(context.newPaths, receipt.newPaths),
    inputDigestMatches: currentInput.digest === receipt.inputDigest,
    overlayDigestMatches: currentInput.overlayDigest === receipt.overlayDigest,
    controlDigestMatches: currentInput.controlDigest === receipt.controlDigest,
    selectedTestDigestMatches: currentInput.selectedTestDigest === receipt.selectedTestDigest,
    selectionMatches: canonicalJson(selection.plans) === canonicalJson(receipt.selection.plans)
      && canonicalJson(selection.impactMap) === canonicalJson(receipt.selection.impactMap),
    selectionHasNoBlockers: selection.blockers.length === 0,
    externalEvidenceMatches: externalEvidenceChecks.every((item) => item.ok),
    commandCountMatches: receipt.commands?.length === expectedCommands.length,
    commandShapesMatch: commandShapeChecks.every((item) => item.ok),
    commandLogsMatch: commandLogChecks.every((item) => item.ok),
    artifactsMatch: artifactChecks.every((item) => item.ok),
    safeRunPassed: safe.exitCode === 0 && safe.childExitCode === 0 && safe.signal === null && safe.spawnError === null,
    safeRunTaskRootExact: resolve(safe.taskRoot || '') === expectedTaskRoot,
    safeRunScopeExact: resolve(safe.cwd || '') === repoRoot
      && resolve(safe.runtimeRoot || '') === runtimeRoot
      && same(safe.allowedReadRoots || [], expectedAllowedReadRoots)
      && same(safe.allowedWriteRoots || [], expectedAllowedWriteRoots)
      && same(safe.protectedReadRoots || [], expectedProtectedReadRoots)
      && same(safe.protectedWriteRoots || [], expectedProtectedWriteRoots)
      && same(safe.allowedExecutables || [], expectedExecutables),
    safeRunArgvExact: same(safe.args || [], [CHANGED_GATE, ...rawGateArgs])
      && safe.argsSha256 === hashBytes(JSON.stringify([CHANGED_GATE, ...rawGateArgs]))
      && Number.isInteger(safe.safeRunArgvCount)
      && safe.safeRunArgvCount > 0
      && /^[a-f0-9]{64}$/.test(safe.safeRunArgvSha256 || ''),
    safeRunEffectivePolicy: canonicalJson(safe.effectivePolicy) === canonicalJson(expectedEffectivePolicy)
      && safe.effectivePolicyHash === hashBytes(canonicalJson(expectedEffectivePolicy)),
    safeRunProfileRebuilt: safe.profileSha256 === hashBytes(expectedProfile),
    safeRunEntrypoint: resolve(safeEntrypoint?.path || '') === CHANGED_GATE
      && safeEntrypoint?.sha256 === hashBytes(readFileSync(CHANGED_GATE)),
    safeRunToolHashes: safe.runnerSha256 === hashBytes(readFileSync(SAFE_RUN))
      && safe.policySha256 === hashBytes(readFileSync(POLICY)),
    safeRunGuardFile: guardContextCheck.ok,
    safeRunProfileFile: profileCheck.ok,
    safeRunBoundGate: safe.boundOutputs?.length === 1
      && boundGate?.valid === true
      && boundGate?.sha256 === hashBytes(gateFile.bytes),
    guardContextBound: safe.guardContext?.runId === receipt.guardContext?.runId
      && safe.guardContext?.sha256 === receipt.guardContext?.sha256,
  };
  const current = Object.values(checks).every(Boolean);
  const metadata = {
    schema: 'neo.code-integrity.gate-receipt-verification.v1',
    verifiedAt: new Date().toISOString(),
    state: current ? 'current' : 'stale',
    targetReceipt: { path: gateFile.absolute, sha256: hashBytes(gateFile.bytes) },
    safeRunReceipt: { path: safeFile.absolute, sha256: hashBytes(safeFile.bytes) },
    expectedTaskRoot,
    requiredProtectedReadRoots: uniquePaths(args.protectedReadRoots.map((item) => resolve(item))),
    checks,
    requestChecks,
    artifactChecks,
    externalEvidenceChecks,
    commandLogChecks,
    commandShapeChecks,
    expectedInputDigest: receipt.inputDigest,
    actualInputDigest: currentInput.digest,
  };
  const result = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  atomicJsonWrite(outputPath, result);
  process.stdout.write(`${JSON.stringify({ state: result.state, outputPath, checks: Object.keys(checks).length })}\n`);
  if (!current) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`gate receipt verification refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
