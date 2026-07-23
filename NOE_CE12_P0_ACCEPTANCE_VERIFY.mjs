#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const EXPECTED_ROOT = '/Users/hxx/Desktop/Neo 贾维斯';
const ACCEPTANCE_DOC = 'NOE_CE12_P0_ACCEPTANCE_CANONICAL.md';
const FULL_VERIFY_JSON = 'output/ce12-p0/p0-verify-all-1780387626311.json';
const FUNCVERIFY_JSON = 'output/ce12-p0/ce08/funcverify-report-1780387657176.json';
const ELECTRON_LOG = 'output/electron-smoke/electron-smoke-1780387632149.jsonl';
const BRAIN_SCREENSHOT = 'output/playwright/noe-brain-ui-p0-1780387649642.png';
const BRAIN_HTML = 'output/ce12-p0/ce08/brain-ui-page-1780387657176.html';

let passed = 0;
let failed = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
}

check(ROOT === EXPECTED_ROOT, 'cwd is Noe workspace', ROOT);

for (const rel of [
  ACCEPTANCE_DOC,
  FULL_VERIFY_JSON,
  FUNCVERIFY_JSON,
  ELECTRON_LOG,
  BRAIN_SCREENSHOT,
  BRAIN_HTML,
  'NOE_CE12_P0_EVIDENCE_INDEX.md',
  'NOE_CE12_P0_DOCS_CANONICAL.md',
  'NOE_CE12_P0_REQUIREMENTS_CANONICAL.md',
  'NOE_BAILONGMA_ARCH_AUDIT.md',
  'src/room/MiniMaxSpawnAdapter.js',
]) {
  check(exists(rel), `file exists: ${rel}`);
}

const doc = read(ACCEPTANCE_DOC);
for (const needle of [
  '验收表',
  '通过 / 未通过项',
  '剩余风险',
  '回滚方式',
  '旧阻断已关闭',
  'task_planning:1/2',
  '完整 Jarvis 产品未完成',
  '禁止把本结论改写为“完整 Jarvis 产品完成”',
]) {
  check(doc.includes(needle), `acceptance doc contains ${needle}`);
}
check(!doc.includes('完整 Jarvis 产品已完成'), 'acceptance doc avoids false product-complete claim');

const requiredRows = [
  'Node22 fail-fast',
  '旧 Brain UI e2e',
  'Brain UI 执行可视化增强',
  'NoeLoop 最小 Act Pipeline',
  '危险操作默认审批或阻断',
  'Electron smoke',
  '交付状态闭环',
  'MiniMaxSpawnAdapter patch-only',
  'Voice、Social I/O、完整 Jarvis 体验',
];
for (const row of requiredRows) {
  check(doc.includes(row), `explicit requirement covered: ${row}`);
}

const full = readJson(FULL_VERIFY_JSON);
check(full.allPass === true, 'full verify allPass=true', FULL_VERIFY_JSON);
check(full.runnerNode === 'v26.0.0' && full.runnerAbi === '147', 'full verify runner captured Node26/ABI147');

const expectedSteps = new Map([
  ['requirements_verify', 'Result: 60/60 checks passed'],
  ['node22_gate', 'selected=v22.22.2 ABI127'],
  ['p0_unit_tests', '40/40 tests passed'],
  ['act_pipeline_evidence', 'noRealExecution=true'],
  ['p0_integration', 'Result: 18/18 checks passed'],
  ['electron_smoke', 'electron-smoke PASS'],
  ['brain_ui_e2e', 'Result: 17/17 checks passed'],
]);

for (const [id, markerPart] of expectedSteps) {
  const step = full.steps?.find((item) => item.id === id);
  check(step?.status === 'pass' && step?.exitCode === 0 && String(step?.marker || '').includes(markerPart),
    `full verify step pass: ${id}`,
    step ? `${step.marker}` : 'missing');
}

const func = readJson(FUNCVERIFY_JSON);
check(func.allPass === true && func.passed === 14 && func.total === 14, 'funcverify 14/14 allPass=true');
check(func.noePort === 51835 && func.origPort === 51735, 'funcverify captures 51835/51735 ports');
const samePid = func.results?.find((item) => item.name.includes('同一 PID'))?.detail;
check(samePid?.before && samePid?.before === samePid?.after, 'original 51735 stayed same PID', JSON.stringify(samePid));
const noExec = func.results?.find((item) => item.name.includes('真实外发'))?.detail;
check(noExec?.realExecActs === 0, 'funcverify realExecActs=0');
const anchorCheck = func.results?.find((item) => item.name.includes('7 个 P0'))?.detail;
check(anchorCheck?.anchorsFound === 7 && Array.isArray(anchorCheck?.missing) && anchorCheck.missing.length === 0,
  'funcverify Brain UI anchors 7/7');

const brainHtml = read(BRAIN_HTML);
for (const id of ['noeActQueue', 'noeCurrentAct', 'noeApprovalStatus', 'noeToolPermissionStatus', 'noeFailureReason', 'noeBudgetStatus', 'noeEvidenceLogLink']) {
  check(brainHtml.includes(`id="${id}"`), `brain live HTML anchor: ${id}`);
}

const electronLog = read(ELECTRON_LOG);
for (const event of ['app_ready', 'menu_registered', 'server_ready', 'window_loaded', 'smoke_quit_requested']) {
  check(electronLog.includes(`"event":"${event}"`), `electron log event: ${event}`);
}

const docs = run('node', ['NOE_CE12_P0_DOCS_VERIFY.mjs']);
check(docs.status === 0 && /Result:\s*83\/83 CE12 docs checks passed/.test(docs.stdout),
  'docs verify 83/83 exit=0',
  `exit=${docs.status}`);

const taskPlan = run('node', ['NOE_CE12_P0_TASK_PLAN_VERIFY.mjs']);
check(taskPlan.status === 0 && /Result:\s*CE04 task plan checks passed/.test(taskPlan.stdout),
  'task plan verify closes stale signoff blocker',
  `exit=${taskPlan.status}`);

const pkg = JSON.parse(read('package.json'));
check(pkg.scripts?.['verify:p0:acceptance'] === 'node NOE_CE12_P0_ACCEPTANCE_VERIFY.mjs',
  'package script verify:p0:acceptance wired');

console.log(`Result: ${passed}/${passed + failed} CE12 P0 acceptance checks passed`);
if (failed > 0) process.exit(1);
