// @ts-check

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeRelativePath,
  canonicalJson,
  describePaths,
  hashBytes,
  manifestDigest,
} from './artifacts.mjs';
import { assertNoSymlinkSegments, assertPathInside, isPathInside } from './policy.mjs';

export const GATE_INTEGRATION_TEST = 'scripts/code-integrity/gate.integration.test.mjs';
const SAFE_RUN = fileURLToPath(new URL('../safe-run.mjs', import.meta.url));
const POLICY = fileURLToPath(new URL('./policy.mjs', import.meta.url));
const SUMMARY_WRITER = fileURLToPath(new URL('../gate-integration-summary.mjs', import.meta.url));
export const REQUIRED_GATE_SCENARIOS = Object.freeze([
  'guard:unguarded-gate-refusal:0',
  'gate:arbitrary-evidence:3',
  'gate:changed-test-auto:0',
  'gate:changed-test-fails:3',
  'gate:commit-range-clean:0',
  'gate:commit-range-dirty:3',
  'gate:critical-config:3',
  'gate:log-tamper:0',
  'gate:mechanical-new-file:3',
  'gate:missing-artifact:3',
  'gate:no-test-map:3',
  'gate:staged-clean:0',
  'gate:staged-mismatch:3',
  'gate:unrelated-test-map:3',
  'gate:worktree-current:0',
  'verify:log-tamper:stale:3',
  'verify:worktree-current:current:0',
  'verify:worktree-current:stale:3',
]);

/** @param {string} repoRoot */
export function codeIntegritySourceEvidence(repoRoot) {
  const root = resolve(repoRoot);
  const sourceRoot = join(root, 'scripts', 'code-integrity');
  /** @type {string[]} */
  const paths = [];
  /** @param {string} directory */
  const walk = (directory) => {
    assertNoSymlinkSegments(sourceRoot, directory, 'code-integrity source');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`code-integrity source symlink refused: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) paths.push(assertSafeRelativePath(relative(root, absolute).split(sep).join('/')));
      else throw new Error(`unsupported code-integrity source type: ${absolute}`);
    }
  };
  walk(sourceRoot);
  const items = describePaths(root, paths);
  return { paths, items, sourceDigest: manifestDigest(items) };
}

/** @param {string} pathValue @param {string} runtimeRoot */
function readBoundJson(pathValue, runtimeRoot) {
  const absolute = resolve(pathValue);
  assertPathInside(runtimeRoot, absolute, 'integration evidence');
  assertNoSymlinkSegments(runtimeRoot, absolute, 'integration evidence');
  if (!existsSync(absolute)) throw new Error(`integration evidence missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`integration evidence must be a regular file: ${absolute}`);
  const bytes = readFileSync(absolute);
  const value = JSON.parse(bytes.toString('utf8'));
  const { metadataDigest, ...metadata } = value;
  if (hashBytes(canonicalJson(metadata)) !== metadataDigest) throw new Error(`integration evidence digest mismatch: ${absolute}`);
  return { absolute, bytes, value };
}

/**
 * @param {string} summaryPath
 * @param {string} repoRoot
 * @param {string} runtimeRoot
 * @param {string[]} companionPaths
 * @param {string[]} requiredScenarioIds
 */
export function validateGateIntegrationEvidence(summaryPath, repoRoot, runtimeRoot, companionPaths = [], requiredScenarioIds = []) {
  const summaryFile = readBoundJson(summaryPath, runtimeRoot);
  const summary = summaryFile.value;
  if (summary.schema !== 'neo.code-integrity.gate-integration.v2'
    || summary.testPath !== GATE_INTEGRATION_TEST
    || !/^[0-9a-f-]{36}$/.test(summary.roundId || '')
    || summary.sourceDigestBefore !== summary.sourceDigest
    || summary.passed !== true) {
    throw new Error('unsupported or failed gate integration summary');
  }
  const roundRoot = resolve(runtimeRoot, 'gate-integration', summary.roundId);
  assertPathInside(roundRoot, summaryFile.absolute, 'integration summary round');
  const source = codeIntegritySourceEvidence(repoRoot);
  if (summary.sourceDigest !== source.sourceDigest
    || canonicalJson(summary.sourceItems) !== canonicalJson(source.items)) {
    throw new Error('gate integration summary is stale for current source');
  }
  if (!Array.isArray(summary.receipts) || summary.receipts.length < 40) {
    throw new Error('gate integration summary has incomplete scenario receipts');
  }
  const scenarioIds = summary.receipts.map((item) => item.scenarioId);
  const requiredScenarios = [...new Set([...REQUIRED_GATE_SCENARIOS, ...requiredScenarioIds])].sort();
  if (new Set(scenarioIds).size !== scenarioIds.length
    || requiredScenarios.some((id) => !scenarioIds.includes(id))) {
    throw new Error('gate integration summary lacks unique required scenarios');
  }
  for (const receipt of summary.receipts) {
    assertPathInside(roundRoot, resolve(receipt.path), 'scenario receipt round');
    const current = readBoundJson(receipt.path, runtimeRoot);
    const entrypoint = current.value.commandFiles?.find((item) => item.role === 'entrypoint');
    const receiptEntrypoint = resolve(receipt.entrypoint);
    assertPathInside(repoRoot, receiptEntrypoint, 'scenario entrypoint');
    assertNoSymlinkSegments(repoRoot, receiptEntrypoint, 'scenario entrypoint');
    if (current.value.schema !== 'neo.code-integrity.safe-run.v2'
      || hashBytes(current.bytes) !== receipt.sha256
      || current.value.exitCode !== receipt.expectedExitCode
      || current.value.childExitCode !== receipt.expectedExitCode
      || current.value.argsSha256 !== receipt.argsSha256
      || resolve(current.value.cwd) !== resolve(receipt.cwd)
      || current.value.executable !== receipt.executable
      || resolve(entrypoint?.path || '') !== receiptEntrypoint
      || entrypoint?.sha256 !== receipt.entrypointSha256
      || receipt.entrypointSha256 !== hashBytes(readFileSync(receiptEntrypoint))
      || resolve(current.value.taskRoot) !== resolve(repoRoot)
      || !(current.value.allowedWriteRoots || []).every((item) => isPathInside(runtimeRoot, resolve(item)))
      || current.value.network !== 'denied'
      || current.value.processSignals !== 'denied') {
      throw new Error(`invalid gate integration scenario receipt: ${receipt.path}`);
    }
  }
  let writerReceipt = null;
  for (const companionPath of companionPaths) {
    try {
      const companion = readBoundJson(companionPath, runtimeRoot);
      if (companion.value.schema !== 'neo.code-integrity.safe-run.v2') continue;
      assertPathInside(roundRoot, companion.absolute, 'integration writer receipt round');
      const bound = (companion.value.boundOutputs || []).find((item) => resolve(item.path) === summaryFile.absolute);
      const entrypoint = (companion.value.commandFiles || []).find((item) => item.role === 'entrypoint');
      const writerArgs = companion.value.args || [];
      /** @param {string} name */
      const option = (name) => {
        const index = writerArgs.indexOf(name);
        return index >= 0 ? writerArgs[index + 1] : null;
      };
      if (bound?.valid === true
        && bound.sha256 === hashBytes(summaryFile.bytes)
        && resolve(entrypoint?.path || '') === SUMMARY_WRITER
        && entrypoint?.sha256 === hashBytes(readFileSync(SUMMARY_WRITER))
        && companion.value.runnerSha256 === hashBytes(readFileSync(SAFE_RUN))
        && companion.value.policySha256 === hashBytes(readFileSync(POLICY))
        && resolve(option('--output') || '') === summaryFile.absolute
        && option('--round-id') === summary.roundId
        && option('--expected-source-digest') === summary.sourceDigestBefore
        && resolve(companion.value.taskRoot) === resolve(repoRoot)
        && companion.value.exitCode === 0
        && companion.value.network === 'denied'
        && companion.value.processSignals === 'denied') {
        writerReceipt = { path: companion.absolute, sha256: hashBytes(companion.bytes) };
        break;
      }
    } catch {
      // Non-JSON or unrelated required artifacts are not companion receipts.
    }
  }
  if (!writerReceipt) throw new Error('gate integration summary lacks a bound safe-run writer receipt');
  return {
    testPath: summary.testPath,
    summaryPath: summaryFile.absolute,
    summarySha256: hashBytes(summaryFile.bytes),
    sourceDigest: summary.sourceDigest,
    scenarioReceiptCount: summary.receipts.length,
    requiredScenarioIds: requiredScenarios,
    writerReceipt,
  };
}
