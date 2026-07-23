#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalJson, hashBytes } from './lib/artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCAN = join(SCRIPT_DIR, 'activity-scan.mjs');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const runtimeRoot = resolve(runtimeInput);
const fixtureRoot = join(runtimeRoot, 'activity-scan-tests', randomUUID());
const repoRoot = join(fixtureRoot, 'repo');
mkdirSync(repoRoot, { recursive: true, mode: 0o700 });

/** @param {string} executable @param {string[]} args @param {number} [expected] */
function run(executable, args, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      NOE_CODE_INTEGRITY_RUNTIME_ROOT: runtimeRoot,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return result;
}

run('/usr/bin/git', ['init', '--initial-branch=noe-main']);
run('/usr/bin/git', ['config', 'user.email', 'code-integrity@example.invalid']);
run('/usr/bin/git', ['config', 'user.name', 'Code Integrity Test']);
writeFileSync(join(repoRoot, 'core.mjs'), '// @ts-check\nexport const NoeSourceDigest = 1;\n');
run('/usr/bin/git', ['add', 'core.mjs']);
run('/usr/bin/git', ['commit', '-m', 'base']);
writeFileSync(join(repoRoot, 'core.mjs'), '// @ts-check\nexport const NoeSourceDigest = 2;\n');

const output = join(fixtureRoot, 'activity.json');
run(process.execPath, [
  SCAN,
  '--source-root', repoRoot,
  '--output', output,
  '--allowed-file', 'scripts/code-integrity/safe-run.mjs',
  '--responsibility-term', 'source-digest=NoeSourceDigest',
], 3);
const report = JSON.parse(readFileSync(output, 'utf8'));
const { metadataDigest, ...metadata } = report;
assert.equal(hashBytes(canonicalJson(metadata)), metadataDigest);
assert.deepEqual(report.blockedAllowedPaths, []);
assert.deepEqual(report.semanticConflictPaths, ['core.mjs']);
assert.equal(report.clearForSlice, false);

const clearOutput = join(fixtureRoot, 'clear.json');
run(process.execPath, [
  SCAN,
  '--source-root', repoRoot,
  '--output', clearOutput,
  '--allowed-file', 'scripts/code-integrity/safe-run.mjs',
], 0);
assert.equal(JSON.parse(readFileSync(clearOutput, 'utf8')).clearForSlice, true);
run(process.execPath, [SCAN, '--source-root', repoRoot, '--output', join(fixtureRoot, 'invalid.json')], 2);

process.stdout.write('activity scan tests: PASS (exact/semantic/empty-scope)\n');
