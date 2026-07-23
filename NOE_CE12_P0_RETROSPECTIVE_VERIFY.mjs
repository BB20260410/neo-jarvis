#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const EXPECTED_ROOT = '/Users/hxx/Desktop/Neo 贾维斯';
const DOC = 'NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md';
const AUDIT_JSON = 'output/noe-phase11-open-source-audit.json';

let passed = 0;
let failed = 0;

function file(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(file(rel));
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
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

check(ROOT === EXPECTED_ROOT, 'cwd is Noe workspace', ROOT);
check(exists(DOC), `file exists: ${DOC}`);
check(exists(AUDIT_JSON), `file exists: ${AUDIT_JSON}`);

const doc = exists(DOC) ? read(DOC) : '';

for (const section of [
  '取舍裁定',
  '提前停止 / 提前交付原因裁定',
  '错误经验清单',
  'Neo 产品级 Definition of Done',
  '开源候选矩阵',
  'P0 / P1 / P2 后续优先级',
  '房间 / 阶段 / 交付状态闭环',
  '11 阶段工程闭环衔接',
  'CE11 裁定',
]) {
  check(doc.includes(section), `retrospective contains section: ${section}`);
}

for (const phrase of [
  '完整 Jarvis 产品未完成',
  '不回退 CE01-CE10',
  '不新建项目',
  '不触碰原项目',
  '真实危险工具',
  'solo takeover',
  'GitHub GraphQL 返回 EOF',
  '阶段状态',
  '产品状态',
]) {
  check(doc.includes(phrase), `retrospective records required phrase: ${phrase}`);
}

check(!doc.includes('完整 Jarvis 产品已完成'), 'retrospective avoids false product-complete claim');

const dodRows = (doc.match(/\| DOD-/g) || []).length;
check(dodRows >= 12, 'product DoD has at least 12 rows', `${dodRows} rows`);

const matrixRows = [
  'mem0',
  'Letta',
  'LlamaIndex',
  'Unstructured',
  'Docling',
  'Qdrant',
  'Chroma',
  'LanceDB',
  'Meilisearch',
  'GraphRAG',
  'Graphiti',
  'FalkorDB',
  'LangGraph',
  'AutoGen',
  'CrewAI',
  'electron-builder',
  'Electron Forge',
  'OpenTelemetry JS',
  'electron-log',
  'Sentry JS',
  'MCP servers',
];

for (const row of matrixRows) {
  check(doc.includes(row), `open-source matrix includes: ${row}`);
}

const actionIds = [
  'P0-01',
  'P0-02',
  'P0-03',
  'P0-04',
  'P0-05',
  'P1-01',
  'P1-02',
  'P1-03',
  'P1-04',
  'P1-05',
  'P2-01',
  'P2-02',
  'P2-03',
  'P2-04',
  'P2-05',
];
for (const id of actionIds) {
  check(doc.includes(id), `action item present: ${id}`);
}

const audit = exists(AUDIT_JSON) ? readJson(AUDIT_JSON) : { rows: [] };
check(Array.isArray(audit.rows) && audit.rows.length >= 21, 'open-source audit has at least 21 rows', `${audit.rows?.length || 0} rows`);
check(String(audit.source || '').includes('GitHub'), 'open-source audit records GitHub metadata source');
for (const repo of ['mem0ai/mem0', 'langchain-ai/langgraph', 'electron-userland/electron-builder', 'modelcontextprotocol/servers']) {
  const found = audit.rows?.some((row) => row.repo === repo || row.nameWithOwner === repo);
  check(found, `audit JSON includes repo: ${repo}`);
}

const pkg = readJson('package.json');
check(pkg.scripts?.['verify:p0:retro'] === 'node NOE_CE12_P0_RETROSPECTIVE_VERIFY.mjs', 'package script verify:p0:retro wired');

const evidence = read('NOE_CE12_P0_EVIDENCE_INDEX.md');
check(evidence.includes('CE11 复盘优化刷新'), 'evidence index records CE11 refresh');

const docs = run('node', ['NOE_CE12_P0_DOCS_VERIFY.mjs']);
check(docs.status === 0 && /\d+\/\d+ CE12 docs checks passed/.test(docs.stdout), 'docs verify still passes', `exit=${docs.status}`);

const acceptance = run('node', ['NOE_CE12_P0_ACCEPTANCE_VERIFY.mjs']);
check(acceptance.status === 0 && /\d+\/\d+ CE12 P0 acceptance checks passed/.test(acceptance.stdout), 'acceptance verify still passes', `exit=${acceptance.status}`);

console.log(`Result: ${passed}/${passed + failed} CE12 retrospective checks passed`);
if (failed > 0) process.exit(1);
