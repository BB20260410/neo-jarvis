import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const NODE22 = '/Users/hxx/.nvm/versions/node/v22.22.2/bin/node';
const DOC_PATH = 'NOE_PHASE11_RETROSPECTIVE_CANONICAL.md';
const AUDIT_PATH = 'output/noe-phase11-open-source-audit.json';

const checks = [];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
}

function fail(label, detail = '') {
  checks.push({ ok: false, label, detail });
}

function requireIncludes(text, label, needles) {
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length === 0) pass(label);
  else fail(label, `missing: ${missing.join(' / ')}`);
}

function requireRegex(text, label, pattern) {
  if (pattern.test(text)) pass(label);
  else fail(label, `pattern not found: ${pattern}`);
}

function runGate(label, script) {
  try {
    const out = execFileSync(NODE22, [script], {
      encoding: 'utf8',
      timeout: 240000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    pass(label, out.split('\n').filter(Boolean).slice(-2).join(' | '));
  } catch (error) {
    fail(label, `${script} failed: ${error.stdout || error.stderr || error.message}`);
  }
}

function readDoc() {
  if (!existsSync(DOC_PATH)) {
    fail('C1 canonical retrospective document exists', `${DOC_PATH} missing`);
    return '';
  }
  const doc = readFileSync(DOC_PATH, 'utf8');
  pass('C1 canonical retrospective document exists', `${doc.split('\n').length} lines`);
  return doc;
}

function verifyDocument(doc) {
  requireIncludes(doc, 'C2 required CE11 sections are present', [
    '## 1. 提前停止 / 提前交付原因裁定',
    '## 2. 错误经验清单',
    '## 3. Neo 产品级 Definition of Done',
    '## 4. 开源候选矩阵',
    '## 5. P0 / P1 / P2 下一步执行路线',
    '## 6. 房间 / 阶段 / 交付状态闭环方案',
    '## 7. 工程闭环 11 阶段衔接',
    '## 8. 本阶段已直接修复',
    '## 9. CE11 裁定'
  ]);

  requireIncludes(doc, 'C3 stage-vs-product distinction is explicit', [
    '不是完整产品交付',
    '完整 Jarvis 产品未完成',
    'Brain UI Lite 原型通过'
  ]);

  requireIncludes(doc, 'C4 unfinished product capabilities are named', [
    'Voice',
    'Social',
    'Act Pipeline',
    '真实工具 handler',
    '长期记忆策略',
    'Electron 正式化',
    '可观测性'
  ]);

  const dodRows = [...doc.matchAll(/^\| DOD-\d+ \|/gm)].length;
  if (dodRows >= 10) pass('C5 product-level DoD has at least 10 rows', `${dodRows} rows`);
  else fail('C5 product-level DoD has at least 10 rows', `${dodRows} rows`);

  const candidateRows = [...doc.matchAll(/^\| [^|]+ \| [^|]+ \| https:\/\/github\.com\/[^|]+ \|/gm)].length;
  if (candidateRows >= 21) pass('C6 open-source matrix has 21 auditable rows', `${candidateRows} rows`);
  else fail('C6 open-source matrix has 21 auditable rows', `${candidateRows} rows`);

  if (!/\bN\/A\b/.test(doc)) pass('C7 canonical matrix does not contain N/A placeholders');
  else fail('C7 canonical matrix does not contain N/A placeholders');

  requireIncludes(doc, 'C8 governance correction and failover rules are recorded', [
    '最多 3 轮',
    'Claude 不可用时 GPT/Codex + Gemini 继续',
    'solo takeover',
    '不再要求所有成员签字才能闭环'
  ]);

  requireIncludes(doc, 'C9 dangerous-operation boundary is recorded', [
    '删除、外发、批量移动、真实工具执行',
    '必须等待用户明确确认'
  ]);

  requireIncludes(doc, 'C10 P0/P1/P2 route covers requested surfaces', [
    '状态闭环',
    '执行可视化',
    'Act Pipeline',
    'Memory M1',
    'Electron smoke',
    'Observability local-only',
    'Voice 输入/输出',
    'Social I/O'
  ]);

  requireRegex(doc, 'C11 11-stage engineering loop is enumerated', /^1\. 用户想法[\s\S]*^11\. 复盘优化/m);
}

function verifyAuditJson() {
  if (!existsSync(AUDIT_PATH)) {
    fail('C12 open-source audit evidence JSON exists', `${AUDIT_PATH} missing`);
    return;
  }

  const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf8'));
  const rows = audit.rows || [];
  if (rows.length >= 21) pass('C12 open-source audit evidence JSON exists', `${rows.length} rows; auditedAt=${audit.auditedAt}`);
  else fail('C12 open-source audit evidence JSON exists', `rows=${rows.length}`);

  if (audit.auditCommand?.includes('gh repo view') && audit.auditCommand?.includes('gh api')) {
    pass('C13 audit command is recorded');
  } else {
    fail('C13 audit command is recorded', audit.auditCommand || 'missing');
  }

  const requiredCapabilities = [
    'Agent Memory',
    'RAG / Local File Index',
    'Local File Index',
    'Knowledge Graph',
    'Multi-Agent Orchestration',
    'Electron Packaging',
    'Observability',
    'Tool Marketplace'
  ];
  const capabilities = new Set(rows.map((row) => row.capability));
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missingCapabilities.length === 0) pass('C14 required candidate capability classes are covered');
  else fail('C14 required candidate capability classes are covered', missingCapabilities.join(', '));

  const incomplete = rows.filter((row) => {
    return !row.url
      || !row.url.startsWith('https://github.com/')
      || !row.license?.spdxId
      || row.license.spdxId === 'N/A'
      || typeof row.stargazerCount !== 'number'
      || !row.pushedAt;
  });
  if (incomplete.length === 0) pass('C15 every audit row has URL, SPDX, stars, and pushedAt');
  else fail('C15 every audit row has URL, SPDX, stars, and pushedAt', incomplete.map((row) => row.repo).join(', '));

  const repos = new Set(rows.map((row) => row.repo));
  const requiredRepos = [
    'mem0ai/mem0',
    'run-llama/llama_index',
    'Unstructured-IO/unstructured',
    'docling-project/docling',
    'getzep/graphiti',
    'langchain-ai/langgraph',
    'electron-userland/electron-builder',
    'open-telemetry/opentelemetry-js',
    'megahertz/electron-log',
    'modelcontextprotocol/servers'
  ];
  const missingRepos = requiredRepos.filter((repo) => !repos.has(repo));
  if (missingRepos.length === 0) pass('C16 required candidate repos are present');
  else fail('C16 required candidate repos are present', missingRepos.join(', '));
}

function verifyWorkspaceBoundaries() {
  try {
    const status = execFileSync('git', ['-C', 'BaiLongma-audit', 'status', '--short'], { encoding: 'utf8' }).trim();
    if (status === '') pass('C17 BaiLongma audit mirror remains clean/read-only');
    else fail('C17 BaiLongma audit mirror remains clean/read-only', status);
  } catch (error) {
    fail('C17 BaiLongma audit mirror remains clean/read-only', error.message);
  }

  runGate('C18 phase10 acceptance gate still passes', 'NOE_PHASE10_ACCEPTANCE_VERIFY.mjs');
  runGate('C19 secret gate still passes', 'NOE_PHASE2_SECRET_GATE.mjs');
}

const doc = readDoc();
if (doc) verifyDocument(doc);
verifyAuditJson();
verifyWorkspaceBoundaries();

for (const check of checks) {
  console.log(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
}

const failed = checks.filter((check) => !check.ok);
console.log(`Result: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
