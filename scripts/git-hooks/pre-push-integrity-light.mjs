#!/usr/bin/env node
// @ts-check
/**
 * Light integrity gate for pre-push: syntax-check staged/current code-integrity
 * entrypoints + multimodel-preflight machine facts. No sandbox full gate.
 *
 * Usage: node scripts/git-hooks/pre-push-integrity-light.mjs
 * Exit 0 ok; 2 on failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;

const entries = [
  'scripts/code-integrity/safe-run.mjs',
  'scripts/code-integrity/changed-gate.mjs',
  'scripts/code-integrity/verify-gate-receipt.mjs',
  'scripts/code-integrity/canary.mjs',
  'scripts/code-integrity/activity-scan.mjs',
  'scripts/code-integrity/multimodel-preflight.mjs',
  'scripts/code-integrity/mechanical-check.mjs',
];

/** @type {string[]} */
const failures = [];

for (const rel of entries) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    failures.push(`missing:${rel}`);
    continue;
  }
  const r = spawnSync(node, ['--check', abs], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) failures.push(`syntax:${rel}`);
}

const preflight = join(ROOT, 'scripts/code-integrity/multimodel-preflight.mjs');
if (existsSync(preflight)) {
  const r = spawnSync(node, [preflight, '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) failures.push('preflight_exit_nonzero');
  else {
    try {
      const payload = JSON.parse(r.stdout || '{}');
      if (payload.ok !== true) failures.push('preflight_ok_false');
    } catch {
      failures.push('preflight_json_invalid');
    }
  }
}

if (failures.length) {
  console.error('[pre-push-integrity-light] FAIL', failures.join(', '));
  process.exit(2);
}
console.log('[pre-push-integrity-light] OK syntax+preflight');
process.exit(0);
