#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const checks = [];

function pass(label, detail = '') {
  checks.push({ label, ok: true, detail });
  console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  checks.push({ label, ok: false, detail });
  console.log(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
}

function requireIncludes(text, needle, label) {
  if (text.includes(needle)) pass(label, needle);
  else fail(label, `missing: ${needle}`);
}

const cwd = process.cwd();
const docPath = 'NOE_CE12_P0_REQUIREMENTS_CANONICAL.md';
const doc = readFileSync(docPath, 'utf8');
const pkg = readFileSync('package.json', 'utf8');

if (basename(cwd) === 'Neo 贾维斯') pass('cwd is Noe workspace', cwd);
else fail('cwd is Noe workspace', cwd);

for (const id of [
  'NG-1',
  'NG-2',
  'NG-3',
  'NG-4',
  'NG-5',
  'UR-CE12-1',
  'UR-CE12-2',
  'UR-CE12-3',
  'UR-CE12-4',
  'UR-CE12-5',
  'FR-P0-1',
  'FR-P0-2',
  'FR-P0-3',
  'FR-P0-4',
  'FR-P0-5',
  'FR-P0-6',
  'FR-P0-7',
  'NFR-P0-1',
  'NFR-P0-2',
  'NFR-P0-3',
  'NFR-P0-4',
  'NFR-P0-5',
  'NFR-P0-6',
  'NFR-P0-7',
]) {
  requireIncludes(doc, id, `requirement id present: ${id}`);
}

for (const marker of [
  '明确非目标',
  '可验证验收口径',
  '证据要求',
  '角色分工',
  'CE03 技术方案输入',
  'Node22 fail-fast',
  'tests/e2e/noe-brain-ui.e2e.mjs',
  'Brain UI 执行可视化增强',
  '最小 Act Pipeline',
  'electron-builder',
  'Source of truth',
  '完整 Jarvis 产品未完成',
  'Voice/Social/完整 Jarvis 全体验',
  'MiniMaxSpawnAdapter',
  'patch-only',
  'blocked_safety',
  'diffs=[]',
  'minimax session new',
  'minimax session messages',
  'minimax session diff',
]) {
  requireIncludes(doc, marker, `CE12 marker present: ${marker}`);
}

if (existsSync('.nvmrc')) pass('.nvmrc exists for Node runtime pin');
else fail('.nvmrc exists for Node runtime pin', 'missing .nvmrc');

if (existsSync('tests/e2e/noe-brain-ui.e2e.mjs')) pass('known e2e file exists and is explicitly governed');
else fail('known e2e file exists and is explicitly governed');

if (existsSync('electron-main.js')) pass('electron main exists');
else fail('electron main exists');

if (pkg.includes('"node": ">=22"')) pass('package declares Node >=22 engine');
else fail('package declares Node >=22 engine');

if (pkg.includes('"electron-builder"')) pass('electron-builder is available in project deps');
else fail('electron-builder is available in project deps');

const badCompletionClaims = [
  '完整 Jarvis 产品已完成',
  '完整Jarvis产品已完成',
  '产品已经完成',
];
const badHit = badCompletionClaims.find((claim) => doc.includes(claim));
if (!badHit) pass('doc does not claim full product completion');
else fail('doc does not claim full product completion', badHit);

const requiredSections = [
  /^## 1\. 明确非目标/m,
  /^## 2\. 用户需求/m,
  /^## 3\. 功能需求/m,
  /^## 4\. 非功能需求/m,
  /^## 5\. 证据要求/m,
  /^## 6\. 角色分工/m,
  /^## 8\. 缺口问题/m,
  /^## 9\. CE03 技术方案输入/m,
  /^## 10\. 工程闭环 11 阶段落地/m,
];

for (const pattern of requiredSections) {
  if (pattern.test(doc)) pass('required section present', String(pattern));
  else fail('required section present', String(pattern));
}

const failed = checks.filter((item) => !item.ok);
console.log(`Result: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
