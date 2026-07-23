import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = '/Users/hxx/Desktop/Neo 贾维斯';
const planPath = path.join(workspace, 'NOE_CE12_P0_TASK_PLAN_CANONICAL.md');
const requirementsPath = path.join(workspace, 'NOE_CE12_P0_REQUIREMENTS_CANONICAL.md');
const techPath = path.join(workspace, 'NOE_CE12_P0_TECH_DESIGN_GPT.md');
const packagePath = path.join(workspace, 'package.json');

const failures = [];

function pass(message, detail = '') {
  console.log(`[PASS] ${message}${detail ? ` - ${detail}` : ''}`);
}

function fail(message, detail = '') {
  failures.push(`${message}${detail ? ` - ${detail}` : ''}`);
  console.log(`[FAIL] ${message}${detail ? ` - ${detail}` : ''}`);
}

function expect(condition, message, detail = '') {
  if (condition) pass(message, detail);
  else fail(message, detail);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${path.basename(file)}`, error.message);
    return '';
  }
}

expect(process.cwd() === workspace, 'cwd is Noe workspace', process.cwd());
expect(fs.existsSync(planPath), 'task plan canonical exists', planPath);
expect(fs.existsSync(requirementsPath), 'requirements canonical exists', requirementsPath);
expect(fs.existsSync(techPath), 'CE03 GPT tech design exists', techPath);

const plan = readText(planPath);
const requirements = readText(requirementsPath);

const requiredMarkers = [
  'CE12 P0 任务分配与排期 CANONICAL',
  'signoff_incomplete=task_planning:1/2',
  'solo takeover',
  '完整 Jarvis 产品未完成',
  'NOE_CE12_P0_REQUIREMENTS_CANONICAL.md',
  'NOE_CE12_P0_TASK_PLAN_VERIFY.mjs',
  '/Users/hxx/Desktop/Neo 贾维斯',
  '/Users/hxx/Desktop/00_项目/05_Claude可视化面板',
  '不做 Voice、Social I/O、完整 Jarvis 全体验',
  'FR-P0-1',
  'FR-P0-2',
  'FR-P0-3',
  'FR-P0-4',
  'FR-P0-5',
  'FR-P0-6',
  'FR-P0-7',
  'T0',
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'T7',
  'CP0',
  'CP1',
  'CP2',
  'CP3',
  'CP4',
  'GPT-Codex',
  'Claude',
  'MiniMax M3',
  'blocked_safety',
  'Node22 gate',
  'tests/e2e/noe-brain-ui.e2e.mjs',
  '#noeActQueue',
  '#noeCurrentAct',
  '#noeApprovalStatus',
  '#noeToolPermissionStatus',
  '#noeFailureReason',
  '#noeBudgetStatus',
  '#noeEvidenceLogLink',
  'Electron smoke',
  'NOE_CE12_P0_EVIDENCE_INDEX.md',
  '工程闭环 11 阶段',
  'CE04 可推进 CE05'
];

for (const marker of requiredMarkers) {
  expect(plan.includes(marker), `plan marker present`, marker);
}

for (const section of [
  /^## 0\. 单模型接管裁定/m,
  /^## 1\. 当前实测基线/m,
  /^## 2\. 执行队列/m,
  /^## 3\. 执行顺序/m,
  /^## 4\. 小任务拆分/m,
  /^## 5\. 排期和检查点/m,
  /^## 6\. 阻塞点/m,
  /^## 7\. 角色分工/m,
  /^## 8\. 验证门/m,
  /^## 9\. 与工程闭环 11 阶段衔接/m,
  /^## 10\. CE04 裁定/m
]) {
  expect(section.test(plan), 'required section present', String(section));
}

for (const forbidden of [
  '完整 Jarvis 产品已完成',
  '完整 Jarvis 已交付',
  'Voice/Social/完整 Jarvis 全体验进入本轮',
  '直接复制 BaiLongma',
  '修改原项目目录'
]) {
  expect(!plan.includes(forbidden), 'forbidden completion or scope claim absent', forbidden);
}

expect(requirements.includes('Result: 60/60') || requirements.includes('FR-P0-7'), 'requirements source looks like CE12 P0 source');

if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};
  for (const scriptName of [
    'verify:node22',
    'test:p0:unit',
    'test:p0:integration',
    'test:e2e',
    'smoke:electron',
    'verify:p0:fast'
  ]) {
    expect(typeof scripts[scriptName] === 'string' && scripts[scriptName].length > 0, 'package script available for downstream gate', scriptName);
  }
}

const reqVerify = spawnSync(process.execPath, ['NOE_CE12_P0_REQUIREMENTS_VERIFY.mjs'], {
  cwd: workspace,
  encoding: 'utf8'
});
expect(reqVerify.status === 0, 'requirements verify passes', `exit=${reqVerify.status}`);
expect(reqVerify.stdout.includes('Result: 60/60 checks passed'), 'requirements verify output has 60/60');

if (failures.length > 0) {
  console.error(`Result: ${failures.length} checks failed`);
  process.exit(1);
}

console.log('Result: CE04 task plan checks passed');
