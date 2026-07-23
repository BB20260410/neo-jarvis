#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertExecutableNameAllowed,
  assertNoSymlinkSegments,
  assertNoProtectedOverlap,
  buildSandboxProfile,
  isPathInside,
  quoteSbpl,
} from './lib/policy.mjs';

const root = resolve('/tmp/neo-code-integrity-root');
assert.equal(isPathInside(root, root), true);
assert.equal(isPathInside(root, resolve(root, 'child')), true);
assert.equal(isPathInside(root, resolve(root, '..', 'escape')), false);
assert.equal(quoteSbpl('a"b'), '"a\\"b"');

assert.throws(() => assertExecutableNameAllowed('/bin/launchctl'), /denied/);
assert.throws(
  () => assertNoProtectedOverlap(['/safe/runtime'], ['/safe']),
  /overlaps protected path/,
);

const profile = buildSandboxProfile({
  allowedExecutables: ['/usr/bin/node'],
  allowedWriteRoots: ['/safe/runtime'],
  protectedWriteRoots: ['/safe/runtime/control'],
  allowedReadRoots: ['/safe/task'],
  homeReadRoot: '/Users/test',
  protectedReadRoots: ['/protected'],
  allowNetwork: false,
});
for (const required of [
  '(deny signal)',
  '(deny process-exec)',
  '(deny file-write*)',
  '(deny network*)',
  '(subpath "/safe/runtime")',
  '(deny file-write* (subpath "/safe/runtime/control"))',
  '(subpath "/safe/task")',
  '(subpath "/Users/test")',
  '(subpath "/protected")',
]) {
  assert.equal(profile.includes(required), true, `profile missing ${required}`);
}

const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const fixtureRoot = join(resolve(runtimeInput), 'policy-tests', randomUUID());
const realDir = join(fixtureRoot, 'real');
mkdirSync(realDir, { recursive: true, mode: 0o700 });
const linkDir = join(fixtureRoot, 'link');
symlinkSync(realDir, linkDir);
assert.doesNotThrow(() => assertNoSymlinkSegments(fixtureRoot, realDir, 'real path'));
assert.throws(() => assertNoSymlinkSegments(fixtureRoot, join(linkDir, 'child'), 'linked path'), /symlink component/);

process.stdout.write('policy tests: PASS (profile + no-follow assertions)\n');
