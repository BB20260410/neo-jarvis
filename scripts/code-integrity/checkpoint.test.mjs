#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, hashBytes } from './lib/artifacts.mjs';
import { computeCandidateCheckpoint, verifyCandidateCheckpoint } from './lib/checkpoint.mjs';

const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const fixtureRoot = join(resolve(runtimeInput), 'checkpoint-tests', randomUUID());
const repoRoot = join(fixtureRoot, 'repo');
mkdirSync(repoRoot, { recursive: true, mode: 0o700 });

/** @param {string[]} args */
function git(args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, result.stderr);
}

git(['init', '--initial-branch=noe-main']);
git(['config', 'user.email', 'code-integrity@example.invalid']);
git(['config', 'user.name', 'Code Integrity Test']);
writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n');
git(['add', 'tracked.txt']);
git(['commit', '-m', 'base']);
const current = computeCandidateCheckpoint(repoRoot);
assert.match(current.sourceDigest, /^sha256:[a-f0-9]{64}$/);
assert.match(current.checkpointId, /^sha256:[a-f0-9]{64}$/);
const metadata = {
  schema: 'neo.code-integrity.candidate-checkpoint.v1',
  state: 'candidate',
  productionReady: false,
  createdAt: new Date().toISOString(),
  label: 'fixture-candidate',
  repoRoot,
  ...current,
  authority: { status: 'fixture', canonicalSourceDigest: null },
};
const checkpointPath = join(fixtureRoot, 'checkpoint.json');
writeFileSync(checkpointPath, `${JSON.stringify({ ...metadata, metadataDigest: hashBytes(canonicalJson(metadata)) }, null, 2)}\n`);
assert.equal(verifyCandidateCheckpoint(checkpointPath, repoRoot).value.checkpointId, current.checkpointId);
writeFileSync(join(repoRoot, 'tracked.txt'), 'dirty but same HEAD\n');
assert.equal(verifyCandidateCheckpoint(checkpointPath, repoRoot).value.baseSha, current.baseSha);
git(['add', 'tracked.txt']);
git(['commit', '-m', 'new head']);
assert.throws(() => verifyCandidateCheckpoint(checkpointPath, repoRoot), /stale/);

process.stdout.write('checkpoint tests: PASS (derived identity/current base/stale head)\n');
