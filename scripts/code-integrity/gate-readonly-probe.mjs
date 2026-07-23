#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGuardContext } from './lib/guard-context.mjs';

const ENTRYPOINT = fileURLToPath(import.meta.url);

function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode !== 'unguarded-gate-refusal') throw new Error(`unsupported probe mode: ${mode}`);
  /** @type {{ gate?: string, repoRoot?: string, runtimeRoot?: string, receipt?: string, test?: string }} */
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--gate') args.gate = value;
    else if (key === '--repo-root') args.repoRoot = value;
    else if (key === '--runtime-root') args.runtimeRoot = value;
    else if (key === '--receipt') args.receipt = value;
    else if (key === '--test') args.test = value;
    else throw new Error(`unknown option: ${key}`);
  }
  if (!args.gate || !args.repoRoot || !args.runtimeRoot || !args.receipt || !args.test) throw new Error('probe arguments are incomplete');
  const repoRoot = resolve(args.repoRoot);
  const runtimeRoot = resolve(args.runtimeRoot);
  const receipt = resolve(args.receipt);
  validateGuardContext({ runtimeRoot, repoRoot, entrypoint: ENTRYPOINT });
  const child = spawnSync(process.execPath, [
    resolve(args.gate),
    '--repo-root', repoRoot,
    '--runtime-root', runtimeRoot,
    '--receipt', receipt,
    '--test', args.test,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      CI: '1',
      NO_COLOR: '1',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=768',
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR,
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 2, `${child.stdout}\n${child.stderr}`);
  assert.equal(existsSync(receipt), false, 'unguarded gate unexpectedly wrote a receipt');
  assert.match(child.stderr || '', /sandbox_unproven/);
  process.stdout.write('unguarded gate refusal: PASS\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`gate readonly probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
