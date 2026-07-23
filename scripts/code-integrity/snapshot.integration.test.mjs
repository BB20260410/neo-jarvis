#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(SCRIPT_DIR, 'snapshot.mjs');
const VERIFY = join(SCRIPT_DIR, 'snapshot-verify.mjs');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const runtimeRoot = resolve(runtimeInput);
const fixtureRoot = join(runtimeRoot, 'snapshot-integration', randomUUID());
const repoRoot = join(fixtureRoot, 'repo');
mkdirSync(repoRoot, { recursive: true, mode: 0o700 });

/** @param {string} executable @param {string[]} args @param {number} [expected] @param {string} [cwd] */
function run(executable, args, expected = 0, cwd = repoRoot) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: {
      CI: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      NO_COLOR: '1',
      NOE_CODE_INTEGRITY_RUNTIME_ROOT: runtimeRoot,
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${executable} ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

run('/usr/bin/git', ['init', '--initial-branch=noe-main']);
run('/usr/bin/git', ['config', 'user.email', 'code-integrity@example.invalid']);
run('/usr/bin/git', ['config', 'user.name', 'Code Integrity Test']);
run('/usr/bin/git', ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n');
run('/usr/bin/git', ['add', 'tracked.txt']);
run('/usr/bin/git', ['commit', '-m', 'fixture base']);
writeFileSync(join(repoRoot, 'tracked.txt'), 'dirty\n');

const created = run(process.execPath, [SNAPSHOT, '--source-root', repoRoot, '--runtime-root', runtimeRoot, '--label', 'fixture']);
const artifactPath = JSON.parse(created.stdout).artifactPath;
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
run(process.execPath, [VERIFY, '--snapshot', artifactPath, '--source-root', repoRoot]);

const copied = join(artifact.overlayRoot, 'tracked.txt');
writeFileSync(copied, 'tampered\n');
run(process.execPath, [VERIFY, '--snapshot', artifactPath, '--source-root', repoRoot], 3);
writeFileSync(copied, 'dirty\n');
run(process.execPath, [VERIFY, '--snapshot', artifactPath, '--source-root', repoRoot]);

const tamperedMetadata = { ...artifact, label: 'tampered' };
writeFileSync(artifactPath, `${JSON.stringify(tamperedMetadata, null, 2)}\n`);
run(process.execPath, [VERIFY, '--snapshot', artifactPath, '--source-root', repoRoot], 2);

const symlinkRepo = join(fixtureRoot, 'symlink-repo');
mkdirSync(symlinkRepo, { recursive: true, mode: 0o700 });
run('/usr/bin/git', ['init', '--initial-branch=noe-main'], 0, symlinkRepo);
run('/usr/bin/git', ['config', 'user.email', 'code-integrity@example.invalid'], 0, symlinkRepo);
run('/usr/bin/git', ['config', 'user.name', 'Code Integrity Test'], 0, symlinkRepo);
run('/usr/bin/git', ['config', 'commit.gpgsign', 'false'], 0, symlinkRepo);
writeFileSync(join(symlinkRepo, 'target.txt'), 'target\n');
run('/usr/bin/git', ['add', 'target.txt'], 0, symlinkRepo);
run('/usr/bin/git', ['commit', '-m', 'base'], 0, symlinkRepo);
symlinkSync('target.txt', join(symlinkRepo, 'link.txt'));
run(process.execPath, [SNAPSHOT, '--source-root', symlinkRepo, '--runtime-root', runtimeRoot, '--label', 'symlink'], 2, symlinkRepo);

process.stdout.write('snapshot integration tests: PASS (overlay/metadata/symlink tamper)\n');
