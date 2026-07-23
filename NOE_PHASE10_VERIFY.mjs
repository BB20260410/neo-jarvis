#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const node22 = '/Users/hxx/.nvm/versions/node/v22.22.2/bin/node';
const checks = [];

function ok(label, pass, detail = '') {
  checks.push({ label, pass: Boolean(pass), detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function read(file) {
  return readFileSync(join(root, file), 'utf8');
}

function hasFile(file) {
  const pass = existsSync(join(root, file));
  ok(`文件存在: ${file}`, pass);
  return pass;
}

function contains(file, snippets) {
  if (!hasFile(file)) return;
  const text = read(file);
  const missing = snippets.filter((s) => !text.includes(s));
  ok(`内容锚点: ${file}`, missing.length === 0, missing.length ? `缺: ${missing.join(', ')}` : `${snippets.length} 项`);
}

function run(label, args, expect = []) {
  console.log(`\n$ ${node22} ${args.join(' ')}`);
  const result = spawnSync(node22, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', PANEL_NO_OPEN: '1' },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  ok(label, result.status === 0, `exit ${result.status}`);
  for (const [name, pattern] of expect) {
    ok(`${label}: ${name}`, pattern.test(output), pattern.toString());
  }
}

function gitCheck() {
  const head = spawnSync('git', ['-C', 'BaiLongma-audit', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['-C', 'BaiLongma-audit', 'status', '--short'], { cwd: root, encoding: 'utf8' });
  ok('BaiLongma 镜像 HEAD 锁定', head.stdout.trim() === 'de78c6f761bd98a0fe406f0e78da80199ddf8d45', head.stdout.trim());
  ok('BaiLongma 镜像未改动', status.stdout.trim() === '', status.stdout.trim() || 'clean');
  ok('.gitignore 隔离 BaiLongma-audit', read('.gitignore').includes('BaiLongma-audit'));
}

console.log('=== NOE Phase 10 Acceptance Verification ===');
console.log(`cwd=${root}`);
console.log(`node=${process.version}; modules=${process.versions.modules}`);

ok('运行在 Noe 工作区', root === '/Users/hxx/Desktop/Neo 贾维斯', root);
ok('使用 Node 22 运行验收门', process.version.startsWith('v22.'), process.version);

contains('NOE_ACCEPTANCE_PHASE10.md', [
  '验收结论：**通过',
  '显式需求验收表',
  '未通过项',
  '剩余风险',
  '回滚方式',
  '不要因旧 CE05',
  'GPT/Codex + Gemini',
]);

contains('NOE_BAILONGMA_ARCH_AUDIT.md', [
  'package.json',
  'src/index.js',
  'src/memory',
  'src/context',
  'src/ui/brain-ui',
  'src/voice',
  'src/social',
  'src/capabilities/marketplace',
  'config.json',
  'LICENSE',
  '数据库 Schema',
]);

for (const file of [
  'src/memory/MemoryCore.js',
  'src/memory/FocusStack.js',
  'src/loop/NoeLoop.js',
  'src/capabilities/ToolRegistry.js',
  'src/server/routes/noe.js',
  'public/src/web/brain-ui.js',
  'tests/unit/noe-memory-focus.test.js',
  'tests/unit/noe-loop-toolregistry.test.js',
  'tests/unit/routes/noe-routes.test.js',
  'NOE_PHASE9_DOCS_CANONICAL.md',
]) hasFile(file);

gitCheck();

run('阶段 1 用户想法门', ['NOE_PHASE1_VERIFY.mjs'], [['13/13', /13\/13 通过/]]);
run('阶段 2 secret 门', ['NOE_PHASE2_SECRET_GATE.mjs'], [['PASS', /结果:\s+PASS/]]);
run('阶段 3 技术方案门', ['NOE_PHASE3_VERIFY.mjs'], [['6/6', /结果:\s+6\/6 通过/]]);
run('阶段 4 排期门', ['NOE_PHASE4_VERIFY.mjs'], [['9/9', /结果:\s+9\/9 通过/]]);
run('阶段 5 代码开发门', ['NOE_PHASE5_VERIFY.mjs'], [['29/29', /Result:\s+29\/29 checks passed/]]);
run('阶段 6 单元测试门', ['NOE_PHASE6_VERIFY.mjs'], [['12/12', /Result:\s+12\/12 checks passed/]]);
run('阶段 7 集成测试门', ['NOE_PHASE7_VERIFY.mjs'], [['12/12', /Result:\s+12\/12 checks passed/], ['21/21', /Result:\s+21\/21 checks passed/]]);
run('阶段 8 功能验证门', ['NOE_PHASE8_FUNCTIONAL_VERIFY.mjs'], [['22/22', /22\/22 通过/]]);
run('阶段 9 文档门', ['NOE_PHASE9_DOCS_VERIFY.mjs'], [['9/9', /Result:\s+9\/9 checks passed/]]);

const failed = checks.filter((c) => !c.pass);
console.log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
