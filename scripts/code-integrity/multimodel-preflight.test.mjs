#!/usr/bin/env node
// @ts-check
/**
 * Pure unit checks for multimodel-preflight.mjs (no network, no product server).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = resolve(SCRIPT_DIR, '../..');
const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
mkdirSync(resolve(runtimeInput), { recursive: true, mode: 0o700 });

const node = process.execPath;
const entry = join(SCRIPT_DIR, 'multimodel-preflight.mjs');

// success: repo with protocol files present
const ok = spawnSync(node, [entry, '--json', '--repo', TASK_ROOT], { encoding: 'utf8' });
assert.equal(ok.status, 0, `expected exit 0, got ${ok.status}: ${ok.stderr || ok.stdout}`);
const payload = JSON.parse(ok.stdout);
assert.equal(payload.kind, 'neo.code-integrity.multimodel-preflight.v1');
assert.equal(payload.ok, true);
assert.deepEqual(payload.missingRequiredFiles, []);
assert.ok(Array.isArray(payload.humanOrModelMustProvide));
assert.ok(payload.humanOrModelMustProvide.includes('allowedPaths'));

// failure: missing repo path → incomplete / non-zero when strict
const bad = spawnSync(node, [entry, '--json', '--strict', '--repo', '/tmp/noe-does-not-exist-preflight-xyz'], {
  encoding: 'utf8',
});
assert.notEqual(bad.status, 0, 'missing repo must not exit 0 under --strict');
const badPayload = JSON.parse(bad.stdout || '{}');
assert.equal(badPayload.ok, false);
assert.ok((badPayload.missingRequiredFiles || []).length > 0 || badPayload.git?.headOk === false);

process.stdout.write('multimodel-preflight tests: PASS (ok path + strict missing-repo failure)\n');
