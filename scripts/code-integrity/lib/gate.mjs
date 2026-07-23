// @ts-check

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSafeRelativePath,
  canonicalJson,
  describePath,
  describePaths,
  gitHead,
  hashBytes,
  listDirtyPaths,
  runGit,
  splitNul,
} from './artifacts.mjs';
import { assertNoSymlinkSegments } from './policy.mjs';
import { GATE_INTEGRATION_TEST } from './integration-evidence.mjs';
import { INTERNAL_IMPACT_MAP, PROJECT_IMPACT_MAP, loadImpactMap } from './impact-map.mjs';

export const CONTROL_PATHS = Object.freeze([
  '.nvmrc',
  'AGENTS.md',
  'CLAUDE.md',
  'eslint.config.mjs',
  'jsconfig.json',
  'package-lock.json',
  'package.json',
  INTERNAL_IMPACT_MAP,
  PROJECT_IMPACT_MAP,
  'vitest.config.mjs',
]);

const CRITICAL_EXACT = new Set([
  '.nvmrc',
  'AGENTS.md',
  'CLAUDE.md',
  'electron-main.js',
  'eslint.config.mjs',
  'jsconfig.json',
  'package-lock.json',
  'package.json',
  'server.js',
  'vitest.config.mjs',
]);

const INTERNAL_TESTS = new Set([
  'scripts/code-integrity/activity-scan.test.mjs',
  'scripts/code-integrity/policy.test.mjs',
  'scripts/code-integrity/artifacts.test.mjs',
  'scripts/code-integrity/bundle.integration.test.mjs',
  'scripts/code-integrity/checkpoint.test.mjs',
  'scripts/code-integrity/gate.test.mjs',
  'scripts/code-integrity/impact-map.test.mjs',
  'scripts/code-integrity/diagnostics.test.mjs',
  'scripts/code-integrity/mechanical.test.mjs',
  'scripts/code-integrity/required-artifacts.test.mjs',
  'scripts/code-integrity/snapshot.integration.test.mjs',
]);

const EXTERNAL_EVIDENCE_TESTS = new Set([GATE_INTEGRATION_TEST]);

const NODE_CODE_PATH = /\.(?:cjs|js|mjs)$/i;
const BEHAVIOR_PATH = /\.(?:bash|cjs|css|fish|go|html?|java|js|jsx|kt|mjs|ps1|py|rb|rs|sh|swift|ts|tsx|zsh)$/i;
const SAFE_NON_CODE_PATH = /\.(?:avif|gif|ico|jpe?g|md|png|txt|webp)$/i;
const TEST_PATH = /(?:^|\/)(?:test|tests)\/.*\.(?:spec|test)\.(?:cjs|js|mjs)$|\.(?:spec|test)\.(?:cjs|js|mjs)$/i;

/** @param {string} pathValue */
export function isCodePath(pathValue) {
  return pathValue === INTERNAL_IMPACT_MAP || BEHAVIOR_PATH.test(pathValue);
}

/** @param {string} pathValue */
export function isNodeSyntaxPath(pathValue) {
  return NODE_CODE_PATH.test(pathValue);
}

/** @param {string} pathValue */
export function isTestPath(pathValue) {
  return TEST_PATH.test(pathValue);
}

/** @param {string} pathValue */
export function isSafeNonCodePath(pathValue) {
  return pathValue === INTERNAL_IMPACT_MAP || pathValue === PROJECT_IMPACT_MAP || SAFE_NON_CODE_PATH.test(pathValue);
}

/** @param {string} pathValue */
export function isCriticalPath(pathValue) {
  if (pathValue === INTERNAL_IMPACT_MAP) return false;
  return CRITICAL_EXACT.has(pathValue)
    || pathValue.startsWith('.github/workflows/')
    || pathValue.startsWith('scripts/git-hooks/')
    || /\.(?:json|toml|ya?ml)$/i.test(pathValue);
}

/**
 * Central fail-closed policy evaluation shared by the gate and its verifier so
 * a receipt cannot omit or rewrite blockers after execution.
 * @param {ReturnType<typeof collectChangeContext>} context
 * @param {ReturnType<typeof selectTests>} selection
 * @param {{ issues: unknown[] }} mechanical
 * @param {string[]} allowedInput
 */
export function evaluateGatePolicy(context, selection, mechanical, allowedInput) {
  const allowedFiles = [...new Set(allowedInput.map(assertSafeRelativePath))].sort();
  const dirtySet = new Set(context.paths);
  const missingAllowed = allowedFiles.filter((item) => !dirtySet.has(item));
  const outsideSlice = allowedFiles.length > 0 ? context.paths.filter((item) => !allowedFiles.includes(item)) : [];
  const criticalPaths = context.paths.filter(isCriticalPath);
  const unsupportedPaths = context.paths.filter((item) => !isCodePath(item) && !isSafeNonCodePath(item));
  const nonNodeBehaviorPaths = context.paths.filter((item) => isCodePath(item) && !isNodeSyntaxPath(item) && item !== INTERNAL_IMPACT_MAP);
  const blockers = [...context.blockers, ...selection.blockers];
  if (missingAllowed.length > 0) blockers.push(`allowed_file_not_changed:${missingAllowed.join(',')}`);
  if (outsideSlice.length > 0) blockers.push(`dirty_path_outside_slice:${outsideSlice.join(',')}`);
  if (mechanical.issues.length > 0) blockers.push(`mechanical_policy_failed:${mechanical.issues.length}`);
  if (context.paths.length === 0) blockers.push('empty_change_set');
  if (criticalPaths.length > 0) blockers.push(`full_gate_required:${criticalPaths.join(',')}`);
  if (unsupportedPaths.length > 0) blockers.push(`unknown_or_control_path_requires_full_gate:${unsupportedPaths.join(',')}`);
  if (nonNodeBehaviorPaths.length > 0) blockers.push(`non_node_behavior_requires_full_gate:${nonNodeBehaviorPaths.join(',')}`);
  return {
    allowedFiles,
    missingAllowed,
    outsideSlice,
    criticalPaths,
    unsupportedPaths,
    nonNodeBehaviorPaths,
    blockers,
  };
}

/** @param {string} root @param {string[]} args */
function gitPaths(root, args) {
  return [...new Set(splitNul(runGit(root, args).stdout).map(assertSafeRelativePath))].sort();
}

/**
 * Parse only added lines from a zero-context unified diff. Keeping the new-file
 * line number lets mechanical policy reject newly introduced bypasses without
 * blaming untouched legacy lines in the same file.
 * @param {string} patch
 */
function parseAddedLines(patch) {
  /** @type {Array<{ line: number, text: string }>} */
  const added = [];
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of patch.split('\n')) {
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine.startsWith('\\ No newline at end of file')) continue;
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++ ')) {
      added.push({ line: newLine, text: rawLine.slice(1) });
      newLine += 1;
    } else if (!rawLine.startsWith('-')) {
      newLine += 1;
    }
  }
  return added;
}

/**
 * @param {string} root
 * @param {'worktree'|'staged'|'commit-range'} mode
 * @param {string} baseSha
 * @param {string} headSha
 * @param {string[]} paths
 */
function collectAddedLines(root, mode, baseSha, headSha, paths) {
  /** @type {Record<string, Array<{ line: number, text: string }>>} */
  const result = {};
  for (const pathValue of paths) {
    const prefix = ['diff', '--no-ext-diff', '--no-renames', '--unified=0'];
    if (mode === 'worktree') prefix.push('HEAD');
    else if (mode === 'staged') prefix.push('--cached');
    else prefix.push(`${baseSha}..${headSha}`);
    const patch = String(runGit(root, [...prefix, '--', pathValue]).stdout || '');
    result[pathValue] = parseAddedLines(patch);
  }
  return result;
}

/**
 * @param {string} root
 * @param {'worktree'|'staged'|'commit-range'} mode
 * @param {string|null} rangeValue
 */
export function collectChangeContext(root, mode, rangeValue = null) {
  const repoRoot = resolve(root);
  const currentHead = gitHead(repoRoot);
  /** @type {string[]} */
  let paths = [];
  /** @type {string[]} */
  let newPaths = [];
  let baseSha = currentHead;
  let headSha = currentHead;
  /** @type {string[]} */
  const blockers = [];

  if (mode === 'worktree') {
    paths = listDirtyPaths(repoRoot);
    newPaths = [...new Set([
      ...gitPaths(repoRoot, ['diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '-z', '--']),
      ...gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
    ])].sort();
  } else if (mode === 'staged') {
    paths = gitPaths(repoRoot, ['diff', '--cached', '--no-renames', '--name-only', '-z', '--']);
    newPaths = gitPaths(repoRoot, ['diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '-z', '--']);
    const unstaged = gitPaths(repoRoot, ['diff', '--no-renames', '--name-only', '-z', '--']);
    const untracked = gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    const nonIndexChanges = [...new Set([...unstaged, ...untracked])].sort();
    const nonIndexSet = new Set(nonIndexChanges);
    const overlap = paths.filter((item) => nonIndexSet.has(item));
    if (overlap.length > 0) blockers.push(`staged_worktree_mismatch:${overlap.join(',')}`);
    const unrelated = nonIndexChanges.filter((item) => !overlap.includes(item));
    if (unrelated.length > 0) blockers.push(`staged_worktree_not_index_clean:${unrelated.join(',')}`);
  } else if (mode === 'commit-range') {
    if (!rangeValue || !/^[A-Za-z0-9_./-]+\.\.[A-Za-z0-9_./-]+$/.test(rangeValue)) {
      throw new Error('commit-range mode requires a safe <base>..<head> range');
    }
    const [baseRef, headRef] = rangeValue.split('..');
    baseSha = String(runGit(repoRoot, ['rev-parse', baseRef]).stdout || '').trim();
    headSha = String(runGit(repoRoot, ['rev-parse', headRef]).stdout || '').trim();
    paths = gitPaths(repoRoot, ['diff', '--no-renames', '--name-only', '-z', `${baseSha}..${headSha}`, '--']);
    newPaths = gitPaths(repoRoot, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', `${baseSha}..${headSha}`, '--']);
    if (currentHead !== headSha) blockers.push(`range_head_not_checked_out:${headSha}`);
    const dirty = listDirtyPaths(repoRoot);
    if (dirty.length > 0) blockers.push(`range_worktree_not_clean:${dirty.length}`);
  } else {
    throw new Error(`unsupported mode: ${mode}`);
  }

  const items = describePaths(repoRoot, paths);
  const addedLines = collectAddedLines(repoRoot, mode, baseSha, headSha, paths);
  return { repoRoot, mode, range: rangeValue, baseSha, headSha, currentHead, paths, newPaths, addedLines, items, blockers };
}

/** @param {string} repoRoot */
export function controlItems(repoRoot) {
  return CONTROL_PATHS.map((pathValue) => describePath(repoRoot, pathValue));
}

/**
 * @param {ReturnType<typeof collectChangeContext>} context
 * @param {ReturnType<typeof selectTests>} selection
 */
export function buildGateInput(context, selection) {
  const tests = [...new Set(selection.tests)].sort();
  const testItems = tests.map((pathValue) => describePath(context.repoRoot, pathValue));
  const controls = controlItems(context.repoRoot);
  const value = {
    mode: context.mode,
    range: context.range,
    baseSha: context.baseSha,
    headSha: context.headSha,
    changedItems: context.items,
    newPaths: context.newPaths,
    controlItems: controls,
    selectedTestItems: testItems,
    selectedTestPlans: selection.plans,
    impactMap: selection.impactMap,
  };
  return {
    ...value,
    overlayDigest: hashBytes(canonicalJson(context.items)),
    controlDigest: hashBytes(canonicalJson(controls)),
    selectedTestDigest: hashBytes(canonicalJson(testItems)),
    digest: hashBytes(canonicalJson(value)),
  };
}

/** @param {string} repoRoot @param {string[]} changedPaths @param {string[]} explicitTests */
export function selectTests(repoRoot, changedPaths, explicitTests) {
  const explicit = explicitTests.map(assertSafeRelativePath);
  const invalidExplicit = explicit.filter((item) => !isTestPath(item));
  const selected = new Set();
  for (const changedPath of changedPaths.filter(isTestPath)) selected.add(changedPath);
  const codePaths = changedPaths.filter(isCodePath).filter((item) => !isTestPath(item));
  const impactMap = loadImpactMap(repoRoot, codePaths);
  for (const pathValue of impactMap.tests) selected.add(pathValue);
  const supplemental = explicit.filter(isTestPath);
  const unmappedSupplemental = supplemental.filter((item) => !impactMap.tests.includes(item) && !changedPaths.includes(item));
  for (const pathValue of supplemental.filter((item) => !unmappedSupplemental.includes(item))) selected.add(pathValue);
  const tests = [...selected].sort();
  const missing = tests.filter((item) => !existsSync(resolve(repoRoot, item)));
  const blockers = [...impactMap.blockers];
  if (invalidExplicit.length > 0) blockers.push(`explicit_test_not_test_file:${invalidExplicit.join(',')}`);
  if (unmappedSupplemental.length > 0) blockers.push(`supplemental_test_not_in_impact_map:${unmappedSupplemental.join(',')}`);
  if (missing.length > 0) blockers.push(`selected_test_missing:${missing.join(',')}`);
  if (codePaths.length > 0 && tests.length === 0) blockers.push(`no_test_mapping:${codePaths.join(',')}`);
  const vitestRunner = resolve(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  /** @type {Array<{ path: string, runner: 'external-evidence'|'node-standalone'|'vitest', runnerPath: string|null, runnerSha256: string|null }>} */
  const plans = tests.map((pathValue) => {
    if (EXTERNAL_EVIDENCE_TESTS.has(pathValue)) return { path: pathValue, runner: 'external-evidence', runnerPath: null, runnerSha256: null };
    if (INTERNAL_TESTS.has(pathValue)) return { path: pathValue, runner: 'node-standalone', runnerPath: null, runnerSha256: null };
    if (!existsSync(vitestRunner)) return { path: pathValue, runner: 'vitest', runnerPath: vitestRunner, runnerSha256: null };
    assertNoSymlinkSegments(repoRoot, vitestRunner, 'Vitest runner');
    const stat = lstatSync(vitestRunner);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      blockers.push(`vitest_runner_not_regular:${vitestRunner}`);
      return { path: pathValue, runner: 'vitest', runnerPath: vitestRunner, runnerSha256: null };
    }
    return { path: pathValue, runner: 'vitest', runnerPath: vitestRunner, runnerSha256: hashBytes(readFileSync(vitestRunner)) };
  });
  if (plans.some((item) => item.runner === 'vitest' && !item.runnerSha256)) blockers.push('vitest_runner_missing_or_untrusted');
  return { tests, plans, codePaths, blockers, supplementalTests: supplemental, impactMap };
}

/**
 * Reconstruct the exact command sequence required for a successful gate.
 * @param {string} repoRoot
 * @param {string} runtimeRoot
 * @param {ReturnType<typeof collectChangeContext>} context
 * @param {ReturnType<typeof selectTests>} selection
 */
export function expectedCommandSpecs(repoRoot, runtimeRoot, context, selection) {
  const specs = context.paths
    .filter(isNodeSyntaxPath)
    .filter((pathValue) => existsSync(resolve(repoRoot, pathValue)))
    .map((pathValue) => ({ kind: 'syntax', path: pathValue, args: ['--check', resolve(repoRoot, pathValue)] }));
  for (const plan of selection.plans) {
    if (plan.runner === 'external-evidence') {
      continue;
    } else if (plan.runner === 'node-standalone') {
      specs.push({ kind: 'test', path: plan.path, args: [resolve(repoRoot, plan.path), runtimeRoot] });
    } else {
      specs.push({
        kind: 'test',
        path: plan.path,
        args: [
          String(plan.runnerPath),
          'run',
          '--pool=forks',
          '--maxWorkers=1',
          '--minWorkers=1',
          '--fileParallelism=false',
          resolve(repoRoot, plan.path),
        ],
      });
    }
  }
  return specs;
}
