#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const EXPECTED_ROOT = '/Users/hxx/Desktop/Neo 贾维斯';

const files = {
  readme: 'README.md',
  changelog: 'CHANGELOG.md',
  context: '上下文交接.md',
  task: '任务交接.md',
  docs: 'NOE_CE12_P0_DOCS_CANONICAL.md',
  ops: 'NOE_CE12_P0_OPERATIONS_MANUAL.md',
  handoff: 'NOE_CE12_P0_HANDOFF.md',
  evidence: 'NOE_CE12_P0_EVIDENCE_INDEX.md',
  retrospective: 'NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md',
  m3: 'NOE_M3_SUGGESTION_ONLY.md',
  nextPlan: 'NOE_PRODUCT_NEXT_PLAN.md',
  packageJson: 'package.json',
  routes: 'src/server/routes/noe.js',
  brainHtml: 'public/index.html',
  brainJs: 'public/src/web/brain-ui.js',
  oldPhase9: 'NOE_PHASE9_DOCS_CANONICAL.md',
};

const expectedEndpoints = [
  'GET /api/noe/loop/status',
  'POST /api/noe/loop/start',
  'POST /api/noe/loop/stop',
  'POST /api/noe/loop/pause',
  'POST /api/noe/loop/resume',
  'POST /api/noe/loop/tick',
  'GET /api/noe/memory',
  'POST /api/noe/memory',
  'DELETE /api/noe/memory/:id',
  'POST /api/noe/memory/:id/merge',
  'GET /api/noe/focus',
  'POST /api/noe/focus',
  'POST /api/noe/focus/:id/pop',
  'GET /api/noe/tools',
  'POST /api/noe/tools',
  'POST /api/noe/tools/:id/enable',
  'POST /api/noe/tools/:id/invoke',
  'GET /api/noe/approvals',
  'GET /api/noe/acts',
  'POST /api/noe/acts/propose',
  'POST /api/noe/acts/:id/cancel',
  'POST /api/noe/acts/:id/retry',
  'POST /api/noe/m3/suggest',
  'GET /api/noe/files/index',
  'POST /api/noe/files/index',
  'GET /api/noe/files/search',
  'GET /api/noe/health',
];

const brainAnchors = [
  'noeActQueue',
  'noeCurrentAct',
  'noeApprovalStatus',
  'noeToolPermissionStatus',
  'noeFailureReason',
  'noeBudgetStatus',
  'noeEvidenceLogLink',
];

let passed = 0;
let failed = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pass(label, detail = '') {
  passed += 1;
  console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
}

function check(condition, label, detail = '') {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

check(ROOT === EXPECTED_ROOT, 'cwd is Noe workspace', ROOT);

for (const [name, rel] of Object.entries(files)) {
  check(fs.existsSync(path.join(ROOT, rel)), `file exists: ${name}`, rel);
}

const docs = read(files.docs);
const ops = read(files.ops);
const handoff = read(files.handoff);
const readme = read(files.readme);
const changelog = read(files.changelog);
const context = read(files.context);
const task = read(files.task);
const evidence = read(files.evidence);
const retrospective = read(files.retrospective);
const m3 = read(files.m3);
const nextPlan = read(files.nextPlan);
const pkg = JSON.parse(read(files.packageJson));
const routes = read(files.routes);
const brainHtml = read(files.brainHtml);
const brainJs = read(files.brainJs);
const oldPhase9 = read(files.oldPhase9);

check(pkg.scripts?.['verify:p0:docs'] === 'node NOE_CE12_P0_DOCS_VERIFY.mjs', 'package script verify:p0:docs wired');
check(pkg.scripts?.['verify:p0:fast'] === 'node scripts/ce12-p0-verify-all.mjs --fast', 'package script verify:p0:fast wired');
check(pkg.scripts?.['m3:suggest'] === 'node scripts/m3-suggest.mjs', 'package script m3:suggest wired');
check(pkg.scripts?.['test:file-index']?.includes('tests/unit/noe-file-index.test.js'), 'package script test:file-index wired');
check(pkg.scripts?.['test:memory-m1']?.includes('tests/unit/noe-memory-m1.test.js'), 'package script test:memory-m1 wired');

for (const needle of [
  'CE12 P0 文档事实源',
  '完整 Jarvis 产品未完成',
  'npm run verify:p0',
  'npm run test:p0:funcverify',
  '/Users/hxx/Desktop/Neo 贾维斯',
  '/Users/hxx/Desktop/00_项目/05_Claude可视化面板',
  'MiniMax M3',
  'M3 suggestion-only',
  'Memory M1',
  '只读文件索引',
  'blocked_safety',
]) {
  check(docs.includes(needle), `canonical contains ${needle}`);
}

for (const endpoint of expectedEndpoints) {
  check(docs.includes(endpoint), `canonical endpoint documented: ${endpoint}`);
}

for (const anchor of brainAnchors) {
  check(docs.includes(`#${anchor}`), `canonical Brain UI anchor documented: #${anchor}`);
  check(brainHtml.includes(`id="${anchor}"`) || brainJs.includes(anchor), `Brain UI anchor exists on disk: ${anchor}`);
}

for (const routeNeedle of [
  "app.get('/api/noe/loop/status'",
  "for (const action of ['start', 'stop', 'pause', 'resume'])",
  "app.post('/api/noe/acts/:id/retry'",
  "app.post('/api/noe/m3/suggest'",
  "app.post('/api/noe/files/index'",
  "app.get('/api/noe/health'",
]) {
  check(routes.includes(routeNeedle), `route anchor exists: ${routeNeedle}`);
}

for (const [label, text] of [
  ['README', readme],
  ['CHANGELOG', changelog],
  ['上下文交接', context],
  ['任务交接', task],
  ['EVIDENCE_INDEX', evidence],
  ['RETROSPECTIVE', retrospective],
  ['M3_SUGGESTION_ONLY', m3],
  ['PRODUCT_NEXT_PLAN', nextPlan],
]) {
  check(text.includes('NOE_CE12_P0_DOCS_CANONICAL.md'), `${label} points to CE12 docs`);
  check(text.includes('完整 Jarvis 产品未完成') || text.includes('不是完整 Jarvis 产品完成'), `${label} preserves product-not-complete wording`);
}

for (const needle of [
  'p0-verify-all-full-latest.json',
  'p0-verify-all-fast-latest.json',
]) {
  check(evidence.includes(needle) || docs.includes(needle), `evidence latest split documented: ${needle}`);
}

for (const needle of [
  'Node22 与 ABI',
  '证据路径',
  '安全操作规则',
  '文档和代码不一致',
]) {
  check(ops.includes(needle), `operations manual contains ${needle}`);
}

for (const needle of [
  'copy-paste prompt',
  'not done until',
  'npm run verify:p0:docs',
]) {
  check(handoff.includes(needle), `handoff contains ${needle}`);
}

check(oldPhase9.includes('SUPERSEDED') && oldPhase9.includes('NOE_CE12_P0_DOCS_CANONICAL.md'), 'old Phase9 doc marked superseded');
check(!docs.includes('完整 Jarvis 产品已完成'), 'canonical avoids false product-complete claim');
check(!readme.includes('NOE_PHASE9_DOCS_CANONICAL.md` 获取所有详细文档'), 'README no longer promotes Phase9 as full authority');

console.log(`Result: ${passed}/${passed + failed} CE12 docs checks passed`);
if (failed > 0) process.exit(1);
