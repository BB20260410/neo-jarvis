#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertSafeRelativePath,
  canonicalJson,
  describePath,
  hashBytes,
  manifestDigest,
  splitNul,
} from './lib/artifacts.mjs';

assert.equal(assertSafeRelativePath('scripts/code-integrity/a.mjs'), 'scripts/code-integrity/a.mjs');
assert.throws(() => assertSafeRelativePath('../escape'), /escapes root/);
assert.throws(() => assertSafeRelativePath('.git/config'), /forbidden repository path/);
assert.throws(() => assertSafeRelativePath('.env.local'), /secret-like/);
assert.deepEqual(splitNul('a\0b\0'), ['a', 'b']);
assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.equal(hashBytes('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
assert.equal(
  manifestDigest([{ path: 'a', kind: 'file', sha256: '1' }]),
  manifestDigest([{ sha256: '1', kind: 'file', path: 'a' }]),
);

const runtimeRoot = resolve(process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT || '');
if (!runtimeRoot) throw new Error('runtime root argument is required');
const fixtureRoot = join(runtimeRoot, 'artifact-tests', randomUUID());
mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
symlinkSync(join(fixtureRoot, 'missing-target'), join(fixtureRoot, 'dangling.txt'));
assert.throws(() => describePath(fixtureRoot, 'dangling.txt'), /symlink path refused/);

process.stdout.write('artifact tests: PASS (path safety, digest and dangling symlink refusal)\n');
