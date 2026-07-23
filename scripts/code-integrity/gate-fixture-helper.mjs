#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertNoSymlinkSegments, assertPathInside } from './lib/policy.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  const [action, ...rest] = argv;
  /** @type {{ action: string, repo?: string, path?: string, value?: number }} */
  const out = { action: action || '' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--repo') out.repo = value;
    else if (key === '--path') out.path = value;
    else if (key === '--value') out.value = Number(value);
    else throw new Error(`unknown option: ${key}`);
  }
  return out;
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      PATH: '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `git exit ${result.status}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeInput = process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
  if (!runtimeInput) throw new Error('guard runtime root is required');
  const runtimeRoot = resolve(runtimeInput);
  if (args.action === 'tamper-file') {
    if (!args.path) throw new Error('--path is required');
    const target = resolve(args.path);
    assertPathInside(runtimeRoot, target, 'tamper fixture');
    assertNoSymlinkSegments(runtimeRoot, target, 'tamper fixture');
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('tamper fixture must be a regular file');
    writeFileSync(target, 'tampered\n', { mode: 0o600 });
    return;
  }
  if (!args.repo) throw new Error('--repo is required');
  const repoRoot = resolve(args.repo);
  assertPathInside(runtimeRoot, repoRoot, 'fixture repository');
  assertNoSymlinkSegments(runtimeRoot, repoRoot, 'fixture repository');

  if (args.action === 'create') {
    if (existsSync(join(repoRoot, '.git'))) throw new Error('fixture repository already exists');
    mkdirSync(join(repoRoot, 'src'), { recursive: true, mode: 0o700 });
    mkdirSync(join(repoRoot, 'test'), { recursive: true, mode: 0o700 });
    git(repoRoot, ['init', '--initial-branch=noe-main']);
    git(repoRoot, ['config', 'user.email', 'code-integrity@example.invalid']);
    git(repoRoot, ['config', 'user.name', 'Code Integrity Test']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repoRoot, 'src', 'value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(repoRoot, 'test', 'value.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nassert.equal(typeof value, 'number');\n");
    writeFileSync(join(repoRoot, 'test', 'unrelated.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(true, true);\n");
    writeFileSync(join(repoRoot, '.neo-code-integrity-impact.json'), `${JSON.stringify({
      schema: 'neo.code-integrity.impact-map.v1',
      entries: [{
        source: 'src/value.mjs',
        invariants: [
          { id: 'value-number-success', polarity: 'success', test: 'test/value.test.mjs' },
          { id: 'value-regression-failure', polarity: 'failure', test: 'test/value.test.mjs' },
        ],
      }],
    }, null, 2)}\n`);
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n');
    git(repoRoot, ['add', '.gitignore', '.neo-code-integrity-impact.json', 'src/value.mjs', 'test/value.test.mjs', 'test/unrelated.test.mjs']);
    git(repoRoot, ['commit', '-m', 'fixture base']);
    const runnerRoot = join(repoRoot, 'node_modules', 'vitest');
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(runnerRoot, 'vitest.mjs'), "// @ts-check\nimport { pathToFileURL } from 'node:url';\nfor (const value of process.argv.slice(2).filter((item) => /\\.(?:spec|test)\\.(?:cjs|js|mjs)$/.test(item))) await import(pathToFileURL(value).href);\n");
    return;
  }

  if (!existsSync(join(repoRoot, '.git'))) throw new Error('fixture repository is not initialized');
  if (args.action === 'set-value') {
    if (![2, 3].includes(Number(args.value))) throw new Error('--value must be 2 or 3');
    writeFileSync(join(repoRoot, 'src', 'value.mjs'), `export const value = ${args.value};\n`);
  } else if (args.action === 'stage-value') {
    git(repoRoot, ['add', 'src/value.mjs']);
  } else if (args.action === 'add-package') {
    writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n');
  } else if (args.action === 'add-new-file') {
    writeFileSync(join(repoRoot, 'src', 'new-file.mjs'), 'export const value = 2;\n');
  } else if (args.action === 'change-test') {
    writeFileSync(join(repoRoot, 'test', 'value.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nassert.equal(typeof value, 'number');\n// changed test\n");
  } else if (args.action === 'fail-test') {
    writeFileSync(join(repoRoot, 'test', 'value.test.mjs'), "import assert from 'node:assert/strict';\nassert.fail('fixture failure');\n");
  } else if (args.action === 'commit-head') {
    writeFileSync(join(repoRoot, 'src', 'value.mjs'), 'export const value = 2;\n');
    git(repoRoot, ['add', 'src/value.mjs']);
    git(repoRoot, ['commit', '-m', 'fixture head']);
  } else if (args.action === 'add-dirty') {
    writeFileSync(join(repoRoot, 'dirty.txt'), 'dirty\n');
  } else if (args.action === 'remove-impact-map') {
    unlinkSync(join(repoRoot, '.neo-code-integrity-impact.json'));
  } else {
    throw new Error(`unknown fixture action: ${args.action}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`gate fixture helper refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
