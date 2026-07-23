#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { codeIntegritySourceEvidence } from './lib/integration-evidence.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = resolve(SCRIPT_DIR, '../..');
const SAFE_RUN = join(SCRIPT_DIR, 'safe-run.mjs');
const CHANGED_GATE = join(SCRIPT_DIR, 'changed-gate.mjs');
const VERIFY_RECEIPT = join(SCRIPT_DIR, 'verify-gate-receipt.mjs');
const FIXTURE_HELPER = join(SCRIPT_DIR, 'gate-fixture-helper.mjs');
const SUMMARY_WRITER = join(SCRIPT_DIR, 'gate-integration-summary.mjs');
const READONLY_PROBE = join(SCRIPT_DIR, 'gate-readonly-probe.mjs');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const runtimeRoot = resolve(runtimeInput);
const roundId = randomUUID();
const fixtureRoot = join(runtimeRoot, 'gate-integration', roundId);
const initialSource = codeIntegritySourceEvidence(TASK_ROOT);
let safeRunIndex = 0;
/** @type {Array<{ scenarioId: string, receipt: string, entrypoint: string, cwd: string, args: string[], expectedExitCode: number }>} */
const safeScenarios = [];

/** @param {string} executable @param {string[]} args @param {string} cwd @param {number} expected */
function run(executable, args, cwd, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      CI: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      NO_COLOR: '1',
      NODE_OPTIONS: '--max-old-space-size=768',
      PATH: '/usr/bin:/bin',
      TMPDIR: join(runtimeRoot, 'tmp'),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${executable} ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return run('/usr/bin/git', args, cwd).stdout.trim();
}

/**
 * This driver is intentionally unsandboxed but performs no writes itself.
 * Every fixture mutation and every gate receipt is delegated to safe-run.
 * @param {string} entrypoint
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} expected
 * @param {string[]} boundOutputs
 * @param {string} scenarioId
 */
function safeRun(entrypoint, cwd, args, expected = 0, boundOutputs = [], scenarioId = '') {
  safeRunIndex += 1;
  const safeReceipt = join(fixtureRoot, 'safe-receipts', `${String(safeRunIndex).padStart(3, '0')}-${basename(entrypoint)}.json`);
  const command = [
    SAFE_RUN,
    '--task-root', TASK_ROOT,
    '--runtime-root', runtimeRoot,
    '--cwd', cwd,
    '--receipt', safeReceipt,
    '--allow-exec', '/usr/bin/git',
    '--allow-exec', '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  ];
  for (const output of boundOutputs) command.push('--bind-output', output);
  command.push('--', process.execPath, entrypoint, ...args);
  const result = run(process.execPath, command, TASK_ROOT, expected);
  safeScenarios.push({
    scenarioId: scenarioId || `safe:${String(safeRunIndex).padStart(3, '0')}:${basename(entrypoint)}:${expected}`,
    receipt: safeReceipt,
    entrypoint,
    cwd,
    args,
    expectedExitCode: expected,
  });
  return { result, safeReceipt };
}

/** @param {string} action @param {string|null} repoRoot @param {string[]} extra @param {string[]} boundOutputs */
function fixture(action, repoRoot = null, extra = [], boundOutputs = []) {
  const args = [action];
  if (repoRoot) args.push('--repo', repoRoot);
  args.push(...extra);
  const identity = repoRoot ? basename(repoRoot) : basename(extra.at(1) || 'runtime');
  return safeRun(FIXTURE_HELPER, TASK_ROOT, args, 0, boundOutputs, `fixture:${identity}:${action}:${safeRunIndex + 1}`);
}

/** @param {string} name */
function createRepo(name) {
  const repoRoot = join(fixtureRoot, name);
  fixture('create', repoRoot);
  return { repoRoot, baseSha: git(repoRoot, ['rev-parse', 'HEAD']) };
}

/** @param {string} repoRoot @param {string} receipt @param {string[]} extra @param {number} expected */
function gate(repoRoot, receipt, extra = [], expected = 0) {
  return safeRun(CHANGED_GATE, repoRoot, [
    '--repo-root', repoRoot,
    '--runtime-root', runtimeRoot,
    '--receipt', receipt,
    ...extra,
  ], expected, [receipt], `gate:${basename(receipt, '.json')}:${expected}`);
}

/** @param {string} repoRoot @param {string} receipt @param {string} safeReceipt @param {number} expected @param {string} scenarioId */
function verify(repoRoot, receipt, safeReceipt, expected = 0, scenarioId = '') {
  const output = join(fixtureRoot, 'verification-results', `${String(safeRunIndex + 1).padStart(3, '0')}-${basename(repoRoot)}-${expected}.json`);
  return safeRun(VERIFY_RECEIPT, repoRoot, [
    '--receipt', receipt,
    '--repo-root', repoRoot,
    '--safe-run-receipt', safeReceipt,
    '--output', output,
    '--expected-task-root', TASK_ROOT,
  ], expected, [output], scenarioId || `verify:${basename(repoRoot)}:${expected}`);
}

// Direct changed-gate execution has no one-run guard context and cannot write a
// PASS receipt.
{
  const { repoRoot } = createRepo('unguarded-refusal');
  fixture('set-value', repoRoot, ['--value', '2']);
  const receipt = join(fixtureRoot, 'unguarded-refusal.json');
  safeRun(READONLY_PROBE, repoRoot, [
    'unguarded-gate-refusal',
    '--gate', CHANGED_GATE,
    '--repo-root', repoRoot,
    '--runtime-root', runtimeRoot,
    '--receipt', receipt,
    '--test', 'test/value.test.mjs',
  ], 0, [], 'guard:unguarded-gate-refusal:0');
  assert.equal(existsSync(receipt), false);
}

// Worktree PASS is bound to Vitest, command logs and outer safe-run output; it
// becomes stale after source drift.
{
  const { repoRoot } = createRepo('worktree-current');
  fixture('set-value', repoRoot, ['--value', '2']);
  const receipt = join(fixtureRoot, 'worktree-current.json');
  const gated = gate(repoRoot, receipt, ['--test', 'test/value.test.mjs']);
  const accepted = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(accepted.status, 'pass');
  assert.equal(accepted.selection.plans[0].runner, 'vitest');
  assert.ok(accepted.commands.every((item) => item.stdoutLog && item.stderrLog));
  verify(repoRoot, receipt, gated.safeReceipt, 0, 'verify:worktree-current:current:0');
  fixture('set-value', repoRoot, ['--value', '3']);
  verify(repoRoot, receipt, gated.safeReceipt, 3, 'verify:worktree-current:stale:3');
}

// A changed test is auto-selected, and a genuinely failing test fails the gate.
{
  const passing = createRepo('changed-test-auto');
  fixture('change-test', passing.repoRoot);
  const passingReceipt = join(fixtureRoot, 'changed-test-auto.json');
  gate(passing.repoRoot, passingReceipt);
  assert.deepEqual(JSON.parse(readFileSync(passingReceipt, 'utf8')).selection.tests, ['test/value.test.mjs']);

  const failing = createRepo('changed-test-fails');
  fixture('fail-test', failing.repoRoot);
  const failingReceipt = join(fixtureRoot, 'changed-test-fails.json');
  gate(failing.repoRoot, failingReceipt, [], 3);
  assert.equal(JSON.parse(readFileSync(failingReceipt, 'utf8')).status, 'fail_closed');
}

// Code without a test mapping and arbitrary non-test evidence are refused.
{
  const noMap = createRepo('no-test-map');
  fixture('set-value', noMap.repoRoot, ['--value', '2']);
  fixture('remove-impact-map', noMap.repoRoot);
  const noMapReceipt = join(fixtureRoot, 'no-test-map.json');
  gate(noMap.repoRoot, noMapReceipt, ['--test', 'test/value.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(noMapReceipt, 'utf8')).blockers.some((item) => item.startsWith('impact_map_missing_or_invalid:')));

  const unrelated = createRepo('unrelated-test-map');
  fixture('set-value', unrelated.repoRoot, ['--value', '2']);
  const unrelatedReceipt = join(fixtureRoot, 'unrelated-test-map.json');
  gate(unrelated.repoRoot, unrelatedReceipt, ['--test', 'test/unrelated.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(unrelatedReceipt, 'utf8')).blockers.some((item) => item.startsWith('supplemental_test_not_in_impact_map:')));

  const arbitrary = createRepo('arbitrary-evidence');
  fixture('set-value', arbitrary.repoRoot, ['--value', '2']);
  const arbitraryReceipt = join(fixtureRoot, 'arbitrary-evidence.json');
  gate(arbitrary.repoRoot, arbitraryReceipt, ['--test', 'src/value.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(arbitraryReceipt, 'utf8')).blockers.some((item) => item.startsWith('explicit_test_not_test_file:')));
}

// Critical configuration and mechanically invalid new code escalate/refuse.
{
  const critical = createRepo('critical-config');
  fixture('add-package', critical.repoRoot);
  const criticalReceipt = join(fixtureRoot, 'critical-config.json');
  gate(critical.repoRoot, criticalReceipt, ['--test', 'test/value.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(criticalReceipt, 'utf8')).blockers.some((item) => item.startsWith('full_gate_required:')));

  const mechanical = createRepo('mechanical-new-file');
  fixture('add-new-file', mechanical.repoRoot);
  const mechanicalReceipt = join(fixtureRoot, 'mechanical-new-file.json');
  gate(mechanical.repoRoot, mechanicalReceipt, ['--test', 'test/value.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(mechanicalReceipt, 'utf8')).mechanical.issues.some((item) => item.code === 'new_code_missing_ts_check'));
}

// Staged mode accepts an index-clean tree and rejects index/worktree drift.
{
  const clean = createRepo('staged-clean');
  fixture('set-value', clean.repoRoot, ['--value', '2']);
  fixture('stage-value', clean.repoRoot);
  gate(clean.repoRoot, join(fixtureRoot, 'staged-clean.json'), ['--mode', 'staged', '--test', 'test/value.test.mjs']);

  const mismatch = createRepo('staged-mismatch');
  fixture('set-value', mismatch.repoRoot, ['--value', '2']);
  fixture('stage-value', mismatch.repoRoot);
  fixture('set-value', mismatch.repoRoot, ['--value', '3']);
  const mismatchReceipt = join(fixtureRoot, 'staged-mismatch.json');
  gate(mismatch.repoRoot, mismatchReceipt, ['--mode', 'staged', '--test', 'test/value.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(mismatchReceipt, 'utf8')).blockers.some((item) => item.startsWith('staged_worktree_mismatch:')));
}

// Commit-range mode requires the requested head to be checked out and clean.
{
  const rangeFixture = createRepo('commit-range');
  fixture('commit-head', rangeFixture.repoRoot);
  const headSha = git(rangeFixture.repoRoot, ['rev-parse', 'HEAD']);
  const range = `${rangeFixture.baseSha}..${headSha}`;
  gate(rangeFixture.repoRoot, join(fixtureRoot, 'commit-range-clean.json'), ['--mode', 'commit-range', '--range', range, '--test', 'test/value.test.mjs']);
  fixture('add-dirty', rangeFixture.repoRoot);
  const dirtyReceipt = join(fixtureRoot, 'commit-range-dirty.json');
  gate(rangeFixture.repoRoot, dirtyReceipt, ['--mode', 'commit-range', '--range', range, '--test', 'test/value.test.mjs'], 3);
  assert.ok(JSON.parse(readFileSync(dirtyReceipt, 'utf8')).blockers.some((item) => item.startsWith('range_worktree_not_clean:')));
}

// Required artifacts and command logs are bound and tamper-evident.
{
  const missing = createRepo('missing-artifact');
  fixture('set-value', missing.repoRoot, ['--value', '2']);
  gate(missing.repoRoot, join(fixtureRoot, 'missing-artifact.json'), [
    '--test', 'test/value.test.mjs',
    '--require-artifact', join(fixtureRoot, 'does-not-exist.json'),
  ], 3);

  const logs = createRepo('log-tamper');
  fixture('set-value', logs.repoRoot, ['--value', '2']);
  const receipt = join(fixtureRoot, 'log-tamper.json');
  const gated = gate(logs.repoRoot, receipt, ['--test', 'test/value.test.mjs']);
  const accepted = JSON.parse(readFileSync(receipt, 'utf8'));
  fixture('tamper-file', null, ['--path', accepted.commands[0].stdoutLog]);
  verify(logs.repoRoot, receipt, gated.safeReceipt, 3, 'verify:log-tamper:stale:3');
}

const summaryPath = join(fixtureRoot, 'summary.json');
const summaryArgs = [
  '--task-root', TASK_ROOT,
  '--runtime-root', runtimeRoot,
  '--output', summaryPath,
  '--round-id', roundId,
  '--expected-source-digest', initialSource.sourceDigest,
];
for (const scenario of [...safeScenarios]) summaryArgs.push('--scenario', JSON.stringify(scenario));
const summaryRun = safeRun(SUMMARY_WRITER, TASK_ROOT, summaryArgs, 0, [summaryPath], 'summary-writer');
process.stdout.write(`${JSON.stringify({ status: 'pass', summaryPath, safeRunReceipt: summaryRun.safeReceipt })}\n`);
