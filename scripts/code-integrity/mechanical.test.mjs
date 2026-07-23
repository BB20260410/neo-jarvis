#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectChangedFiles } from './lib/mechanical.mjs';

const runtimeInput = process.argv[2] || process.env.NOE_CODE_INTEGRITY_RUNTIME_ROOT;
if (!runtimeInput) throw new Error('runtime root argument is required');
const fixtureRoot = join(resolve(runtimeInput), 'mechanical-tests', randomUUID());
mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });

/** @param {string} name @param {string} content */
function put(name, content) {
  const pathValue = join(fixtureRoot, name);
  mkdirSync(resolve(pathValue, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(pathValue, content);
  return name;
}

put('good.mjs', '#!/usr/bin/env node\n// @ts-check\nexport const value = 1;\n');
assert.equal(inspectChangedFiles(fixtureRoot, ['good.mjs'], ['good.mjs']).passed, true);

put('missing.mjs', 'export const value = 1;\n');
assert.deepEqual(inspectChangedFiles(fixtureRoot, ['missing.mjs'], ['missing.mjs']).issues.map((item) => item.code), ['new_code_missing_ts_check']);

put('large.mjs', `// @ts-check\n${'export const value = 1;\n'.repeat(499)}`);
assert.ok(inspectChangedFiles(fixtureRoot, ['large.mjs'], ['large.mjs']).issues.some((item) => item.code === 'new_code_not_under_500_lines'));
assert.ok(!inspectChangedFiles(fixtureRoot, ['large.mjs'], []).issues.some((item) => item.code === 'new_code_not_under_500_lines'));

const skipToken = ['test', '.skip(() => {});'].join('');
const chainedSkipToken = ['test', '.skip.each([[1]])(() => {});'].join('');
const ignoreToken = ['// ', '@ts', '-ignore'].join('');
const blanketToken = ['/* eslint', '-disable */'].join('');
const conflictToken = `${'<'.repeat(7)} ours\n${'='.repeat(7)}\n${'>'.repeat(7)} theirs`;
put('tests/bad.test.mjs', `// @ts-check\n\texport const value = 1;  \n${skipToken}\n${ignoreToken}\n${blanketToken}\n${conflictToken}\n`);
const issueCodes = new Set(inspectChangedFiles(fixtureRoot, ['tests/bad.test.mjs'], ['tests/bad.test.mjs']).issues.map((item) => item.code));
for (const expected of ['tab_indentation', 'trailing_whitespace', 'focused_or_skipped_test', 'ts_ignore_forbidden', 'blanket_eslint_disable', 'merge_conflict_marker']) {
  assert.ok(issueCodes.has(expected), `expected ${expected}`);
}

put('tests/legacy.test.mjs', `// @ts-check\n${skipToken}\nexport const value = 1;\n`);
assert.ok(!inspectChangedFiles(fixtureRoot, ['tests/legacy.test.mjs'], [], {
  'tests/legacy.test.mjs': [{ line: 3, text: 'export const value = 2;' }],
}).issues.some((item) => item.code === 'focused_or_skipped_test'));
assert.ok(inspectChangedFiles(fixtureRoot, ['tests/legacy.test.mjs'], [], {
  'tests/legacy.test.mjs': [{ line: 4, text: skipToken }],
}).issues.some((item) => item.code === 'focused_or_skipped_test' && item.line === 4));
assert.ok(inspectChangedFiles(fixtureRoot, ['tests/legacy.test.mjs'], [], {
  'tests/legacy.test.mjs': [{ line: 5, text: chainedSkipToken }],
}).issues.some((item) => item.code === 'focused_or_skipped_test' && item.line === 5));

put('bad-ending.mjs', '// @ts-check\r\nexport const value = 1;');
const endingCodes = new Set(inspectChangedFiles(fixtureRoot, ['bad-ending.mjs'], ['bad-ending.mjs']).issues.map((item) => item.code));
assert.ok(endingCodes.has('crlf_line_endings'));
assert.ok(endingCodes.has('missing_final_newline'));

const symlinkTarget = put('symlink-target.txt', 'outside-like content\n');
symlinkSync(join(fixtureRoot, symlinkTarget), join(fixtureRoot, 'linked.mjs'));
assert.equal(inspectChangedFiles(fixtureRoot, ['linked.mjs'], ['linked.mjs']).issues[0].code, 'symlink_not_allowed');
symlinkSync(join(fixtureRoot, 'missing-target.mjs'), join(fixtureRoot, 'dangling.mjs'));
assert.equal(inspectChangedFiles(fixtureRoot, ['dangling.mjs'], ['dangling.mjs']).issues[0].code, 'symlink_not_allowed');

process.stdout.write('mechanical tests: PASS (incremental hygiene and anti-bypass rules)\n');
