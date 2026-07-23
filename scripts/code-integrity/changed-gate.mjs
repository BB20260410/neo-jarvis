#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeRelativePath, atomicJsonWrite, canonicalJson, hashBytes, runGit } from './lib/artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside } from './lib/policy.mjs';
import { validateGuardContext } from './lib/guard-context.mjs';
import { validateGateIntegrationEvidence } from './lib/integration-evidence.mjs';
import { inspectChangedFiles } from './lib/mechanical.mjs';
import { validateRequiredArtifacts } from './lib/required-artifacts.mjs';
import {
  buildGateInput,
  collectChangeContext,
  evaluateGatePolicy,
  expectedCommandSpecs,
  selectTests,
} from './lib/gate.mjs';

const ENTRYPOINT = fileURLToPath(import.meta.url);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ repoRoot?: string, runtimeRoot?: string, receipt?: string, mode: 'worktree'|'staged'|'commit-range', range?: string, tests: string[], requiredArtifacts: string[], allowedFiles: string[] }} */
  const out = { mode: 'worktree', tests: [], requiredArtifacts: [], allowedFiles: [] };
  const singleton = new Set(['--repo-root', '--runtime-root', '--receipt', '--mode', '--range']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (singleton.has(key) && seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === '--repo-root') out.repoRoot = value;
    else if (key === '--runtime-root') out.runtimeRoot = value;
    else if (key === '--receipt') out.receipt = value;
    else if (key === '--mode' && ['worktree', 'staged', 'commit-range'].includes(value)) out.mode = /** @type {typeof out.mode} */ (value);
    else if (key === '--range') out.range = value;
    else if (key === '--test') out.tests.push(value);
    else if (key === '--require-artifact') out.requiredArtifacts.push(resolve(value));
    else if (key === '--allowed-file') out.allowedFiles.push(assertSafeRelativePath(value));
    else throw new Error(`unknown option: ${key}`);
  }
  if (!out.repoRoot || !out.runtimeRoot || !out.receipt) {
    throw new Error('--repo-root, --runtime-root and --receipt are required');
  }
  return out;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} runtimeRoot
 * @param {string} logRoot
 * @param {string} label
 */
function runNode(args, cwd, runtimeRoot, logRoot, label) {
  const tmpDir = join(runtimeRoot, 'tmp', 'changed-gate');
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(logRoot, { recursive: true, mode: 0o700 });
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: {
      CI: '1',
      NO_COLOR: '1',
      NOE_CODE_INTEGRITY_RUNTIME_ROOT: runtimeRoot,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=768',
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: tmpDir,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const stdoutPath = join(logRoot, `${label}.stdout.log`);
  const stderrPath = join(logRoot, `${label}.stderr.log`);
  writeFileSync(stdoutPath, stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(stderrPath, stderr, { flag: 'wx', mode: 0o600 });
  return {
    executable: process.execPath,
    args,
    exitCode: child.status,
    signal: child.signal || null,
    spawnError: child.error ? { code: child.error.code || null, message: child.error.message } : null,
    durationMs: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)),
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutSha256: hashBytes(stdout),
    stdoutLog: stdoutPath,
    stderrBytes: Buffer.byteLength(stderr),
    stderrSha256: hashBytes(stderr),
    stderrLog: stderrPath,
  };
}

function main() {
  const rawGateArgs = process.argv.slice(2);
  const args = parseArgs(rawGateArgs);
  const repoRoot = resolve(args.repoRoot);
  const runtimeRoot = resolve(args.runtimeRoot);
  const receiptPath = resolve(args.receipt);
  const guardContext = validateGuardContext({ runtimeRoot, repoRoot, entrypoint: ENTRYPOINT });
  assertPathInside(runtimeRoot, receiptPath, 'gate receipt');
  assertNoSymlinkSegments(runtimeRoot, receiptPath, 'gate receipt');
  if (existsSync(receiptPath)) throw new Error(`gate receipt already exists: ${receiptPath}`);
  for (const artifactPath of args.requiredArtifacts) {
    assertPathInside(runtimeRoot, artifactPath, 'required artifact');
    assertNoSymlinkSegments(runtimeRoot, artifactPath, 'required artifact');
  }
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const logRoot = join(runtimeRoot, 'gate-logs', runId);
  const context = collectChangeContext(repoRoot, args.mode, args.range || null);
  const selection = selectTests(repoRoot, context.paths, args.tests);
  const mechanical = inspectChangedFiles(repoRoot, context.paths, context.newPaths, context.addedLines);
  const requiredEvidence = validateRequiredArtifacts({
    artifactPaths: args.requiredArtifacts,
    repoRoot,
    runtimeRoot,
    changedPaths: context.paths,
    referenceTime: createdAt,
  });
  const artifacts = requiredEvidence.artifacts;
  const invalidArtifacts = artifacts.filter((item) => !item.valid);
  /** @type {Array<ReturnType<typeof validateGateIntegrationEvidence>>} */
  const externalEvidence = [];
  for (const plan of selection.plans.filter((item) => item.runner === 'external-evidence')) {
    let accepted = null;
    for (const artifact of artifacts.filter((item) => item.valid)) {
      try {
        const candidate = validateGateIntegrationEvidence(
          artifact.path,
          repoRoot,
          runtimeRoot,
          args.requiredArtifacts,
          selection.impactMap.requiredScenarioIds,
        );
        if (candidate.testPath === plan.path) {
          accepted = candidate;
          break;
        }
      } catch {
        // Required artifacts include non-integration evidence; try the next one.
      }
    }
    if (accepted) externalEvidence.push(accepted);
  }
  const policy = evaluateGatePolicy(context, selection, mechanical, args.allowedFiles);
  const {
    allowedFiles,
    outsideSlice,
    criticalPaths,
    unsupportedPaths,
    nonNodeBehaviorPaths,
    blockers,
  } = policy;
  blockers.push(...requiredEvidence.staticBlockers);
  for (const plan of selection.plans.filter((item) => item.runner === 'external-evidence')) {
    if (!externalEvidence.some((item) => item.testPath === plan.path)) blockers.push(`external_test_evidence_missing_or_stale:${plan.path}`);
  }

  const gateInput = buildGateInput(context, selection);
  const commandSpecs = expectedCommandSpecs(repoRoot, runtimeRoot, context, selection);
  /** @type {Array<Record<string, unknown>>} */
  const commands = [];
  if (blockers.length === 0) {
    for (const spec of commandSpecs) {
      const label = `${String(commands.length + 1).padStart(3, '0')}-${spec.kind}`;
      commands.push({ kind: spec.kind, path: spec.path, ...runNode(spec.args, repoRoot, runtimeRoot, logRoot, label) });
      if (commands.at(-1)?.exitCode !== 0) break;
    }
  }

  const commandFailures = commands.filter((item) => item.exitCode !== 0);
  const passed = blockers.length === 0 && commandFailures.length === 0 && invalidArtifacts.length === 0;
  const metadata = {
    schema: 'neo.code-integrity.changed-gate.v3',
    runId,
    createdAt,
    status: passed ? 'pass' : 'fail_closed',
    statusScope: 'isolated-static',
    staticGate: { passed, blockers },
    integration: requiredEvidence.integration,
    evidence: requiredEvidence.evidence,
    repoRoot,
    runtimeRoot,
    guardContext,
    mode: context.mode,
    range: context.range,
    baseSha: context.baseSha,
    headSha: context.headSha,
    changedPaths: context.paths,
    newPaths: context.newPaths,
    changedItems: context.items,
    allowedFiles,
    outsideSlice,
    inputDigest: gateInput.digest,
    overlayDigest: gateInput.overlayDigest,
    controlItems: gateInput.controlItems,
    controlDigest: gateInput.controlDigest,
    selectedTestItems: gateInput.selectedTestItems,
    selectedTestDigest: gateInput.selectedTestDigest,
    selection: {
      codePaths: selection.codePaths,
      tests: selection.tests,
      plans: selection.plans,
      supplementalTests: selection.supplementalTests,
      impactMap: selection.impactMap,
      externalEvidence,
      criticalPaths,
      unsupportedPaths,
      nonNodeBehaviorPaths,
      reason: criticalPaths.length > 0 || unsupportedPaths.length > 0 || nonNodeBehaviorPaths.length > 0
        ? 'full_gate_required'
        : selection.tests.length > 0 ? 'mapped_tests' : 'safe_non_code_only',
    },
    mechanical,
    blockers,
    commands,
    artifacts,
    request: {
      argv: rawGateArgs,
      argvSha256: hashBytes(JSON.stringify(rawGateArgs)),
      explicitTests: args.tests,
      requiredArtifacts: args.requiredArtifacts,
      allowedFiles: args.allowedFiles,
      mode: args.mode,
      range: args.range || null,
    },
    toolVersions: {
      node: process.version,
      git: String(runGit(repoRoot, ['--version']).stdout || '').trim(),
      gateSchema: 3,
    },
  };
  const receipt = { ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) };
  atomicJsonWrite(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, mode: receipt.mode, changed: receipt.changedPaths.length, tests: receipt.selection.tests.length, blockers, commandFailures: commandFailures.length, invalidArtifacts: invalidArtifacts.length, receiptPath })}\n`);
  if (!passed) process.exitCode = 3;
}

try {
  main();
} catch (error) {
  process.stderr.write(`changed gate refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
