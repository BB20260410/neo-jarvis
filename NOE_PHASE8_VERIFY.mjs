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

console.log('=== NOE Phase 8 Functional Verification ===');
console.log(`cwd=${root}`);
console.log(`node=${process.version}; modules=${process.versions.modules}`);

requireContains('NOE_PHASE8_FUNCTIONAL_WALKTHROUGH.mjs', [
  'Brain UI health shows ok',
  'user can write a memory and see it in Brain UI',
  'user can search and recall the written memory',
  'user can push a focus item and see it in Focus Stack',
  'user can trigger a loop tick and see Thought Stream update',
  'tools stay disabled by default',
  'desktop screenshot captured',
  'mobile screenshot captured',
  'unchanged after cleanup',
]);

requireContains('NOE_PHASE8_FUNCTIONAL_VERIFICATION.md', [
  '功能验证步骤',
  '输入输出',
  '截图 / 日志 / 接口结果',
  '用户主路径',
  'NOE_PHASE8_VERIFY.mjs',
]);

run('phase2 secret gate', ['NOE_PHASE2_SECRET_GATE.mjs']);
run('phase8 functional walkthrough', ['NOE_PHASE8_FUNCTIONAL_WALKTHROUGH.mjs'], {
  expectOutput: {
    'functional path passed': /Result:\s+\d+\/\d+ checks passed/,
    'memory path checked': /user can write a memory and see it in Brain UI/,
    'loop path checked': /user can trigger a loop tick and see Thought Stream update/,
    'desktop screenshot checked': /desktop screenshot captured/,
    'mobile screenshot checked': /mobile screenshot captured/,
    'port isolation checked': /51735 unchanged after cleanup/,
  },
});

const failed = checks.filter((check) => !check.ok);
console.log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
