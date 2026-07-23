#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const checks = [];

const unitFiles = [
  'tests/unit/schema-migrations.test.js',
  'tests/unit/server-route-wiring.test.js',
  'tests/unit/routes/noe-routes.test.js',
  'tests/unit/noe-memory-focus.test.js',
  'tests/unit/noe-loop-toolregistry.test.js',
];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
  console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  checks.push({ ok: false, label, detail });
  console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
}

function requireFile(file) {
  const ok = existsSync(join(root, file));
  if (ok) pass(`file exists: ${file}`);
  else fail(`file exists: ${file}`);
  return ok;
}

function requireContains(file, snippets) {
  if (!requireFile(file)) return;
  const source = readFileSync(join(root, file), 'utf8');
  const missing = snippets.filter((snippet) => !source.includes(snippet));
  if (missing.length) fail(`content check: ${file}`, `missing ${missing.join(', ')}`);
  else pass(`content check: ${file}`, `${snippets.length} anchors`);
}

function run(label, args, { expectOutput } = {}) {
  console.log(`\n$ ${process.execPath} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) pass(label, 'exit 0');
  else fail(label, `exit ${result.status}`);
  if (expectOutput) {
    for (const [name, pattern] of Object.entries(expectOutput)) {
      if (pattern.test(output)) pass(`${label}: ${name}`);
      else fail(`${label}: ${name}`, `missing ${pattern}`);
    }
  }
}

console.log('=== NOE Phase 6 Unit Test Verification ===');
console.log(`cwd=${root}`);
console.log(`node=${process.version}; modules=${process.versions.modules}`);

requireContains('tests/unit/noe-memory-focus.test.js', [
  'rejects empty memory bodies',
  'keeps hide scoped to the requested project',
  'clamps recall limits',
  'can pop without absorbing into memory',
]);
requireContains('tests/unit/noe-loop-toolregistry.test.js', [
  'skips acting when the cluster is busy',
  'auto-stops after three consecutive tick failures',
  'rejects invalid manifests',
  'tool handler not registered',
]);
requireContains('tests/unit/routes/noe-routes.test.js', [
  'maps route failures to deterministic status codes',
  'forwards approval ids from invoke headers',
  'owner token required',
]);
requireContains('NOE_PHASE6_UNIT_TESTS.md', [
  '单测清单',
  '22 passed',
  '未修改产品实现代码',
]);

run('phase2 secret gate', ['NOE_PHASE2_SECRET_GATE.mjs']);
run('Noe phase6 unit subset', [
  'node_modules/vitest/vitest.mjs',
  'run',
  ...unitFiles,
], {
  expectOutput: {
    '5 test files passed': /Test Files\s+5 passed \(5\)/,
    '22 tests passed': /Tests\s+22 passed \(22\)/,
  },
});

const failed = checks.filter((check) => !check.ok);
console.log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
