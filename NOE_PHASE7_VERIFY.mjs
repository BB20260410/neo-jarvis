#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const checks = [];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
  console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  checks.push({ ok: false, label, detail });
  console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
}

function requireContains(file, snippets) {
  const abs = join(root, file);
  if (!existsSync(abs)) {
    fail(`file exists: ${file}`);
    return;
  }
  pass(`file exists: ${file}`);
  const source = readFileSync(abs, 'utf8');
  const missing = snippets.filter((snippet) => !source.includes(snippet));
  if (missing.length) fail(`content anchors: ${file}`, `missing ${missing.join(', ')}`);
  else pass(`content anchors: ${file}`, `${snippets.length} anchors`);
}

function run(label, args, { expectOutput } = {}) {
  console.log(`\n$ ${process.execPath} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', PANEL_NO_OPEN: '1' },
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

console.log('=== NOE Phase 7 Integration Verification ===');
console.log(`cwd=${root}`);
console.log(`node=${process.version}; modules=${process.versions.modules}`);

requireContains('NOE_PHASE7_INTEGRATION_TEST.mjs', [
  'server listens on',
  'Noe API rejects missing owner token',
  'Memory API writes through HTTP into SQLite',
  'Focus pop absorbs into Memory',
  'NoeLoop tick runs through HTTP and appends an event',
  'Disabled tool cannot invoke external action',
  'Frontend shell serves Brain UI markup',
  'unchanged while Noe test server runs',
]);
requireContains('NOE_PHASE7_INTEGRATION_TESTS.md', [
  '集成测试路径',
  '失败处理',
  '端到端证据',
  'NOE_PHASE7_VERIFY.mjs',
]);

run('phase2 secret gate', ['NOE_PHASE2_SECRET_GATE.mjs']);
run('phase6 unit verification', ['NOE_PHASE6_VERIFY.mjs'], {
  expectOutput: {
    'unit checks passed': /Result:\s+12\/12 checks passed/,
  },
});
run('phase7 integration path', ['NOE_PHASE7_INTEGRATION_TEST.mjs'], {
  expectOutput: {
    'integration checks passed': /Result:\s+21\/21 checks passed/,
    'server lifecycle checked': /server listens on 51835/,
    'frontend backend checked': /Frontend shell serves Brain UI markup/,
    'port isolation checked': /51735 unchanged after cleanup/,
  },
});

const failed = checks.filter((check) => !check.ok);
console.log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
