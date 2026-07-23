import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const NODE22 = '/Users/hxx/.nvm/versions/node/v22.22.2/bin/node';
const docPath = 'NOE_PHASE11_RETROSPECTIVE_GPT.md';
const auditPath = 'output/noe-phase11-open-source-audit.json';

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
  else fail(label, `missing: ${missing.join(', ')}`);
}

function runGate(label, script) {
  try {
    const out = execFileSync(NODE22, [script], { encoding: 'utf8', timeout: 120000 });
    pass(label, out.split('\n').filter(Boolean).slice(-2).join(' | '));
  } catch (error) {
    fail(label, `${script} failed: ${error.stdout || error.message}`);
  }
}

if (!existsSync(docPath)) {
  fail('C1 CE11 document exists', `${docPath} missing`);
} else {
  const doc = readFileSync(docPath, 'utf8');
  pass('C1 CE11 document exists', `${doc.split('\n').length} lines`);

  requireIncludes(doc, 'C2 required user sections present', [
    '为什么提前停止 / 提前交付的原因裁定',
    '错误经验清单',
    'Neo 产品级 Definition of Done',
    '开源候选矩阵',
    'P0 / P1 / P2 后续路线',
    '房间 / 阶段 / 交付状态闭环方案'
  ]);

  requireIncludes(doc, 'C3 product-vs-stage distinction is explicit', [
    '阶段验收可以作为当前原型证据链，但不能再被表述为完整 Jarvis 产品已交付',
    'Brain UI Lite 原型通过；完整 Jarvis 产品未完成'
  ]);

  requireIncludes(doc, 'C4 unfinished product capabilities are named', [
    'Voice',
    'Social I/O',
    'Act Pipeline',
    '真实工具 handler',
    '长期记忆策略',
    'Electron 正式化',
    'Observability'
  ]);

  const matrixRows = [...doc.matchAll(/^\| [^|]+ \| https:\/\/github\.com\/[^|]+ \|/gm)].length;
  if (matrixRows >= 15) pass('C5 open-source matrix has at least 15 rows', `${matrixRows} rows`);
  else fail('C5 open-source matrix has at least 15 rows', `${matrixRows} rows`);

  requireIncludes(doc, 'C6 governance correction is recorded', [
    '最多 3 轮',
    '不要因旧 CE05 返工文字回退',
    'Claude 不可用时 GPT/Codex + Gemini 继续'
  ]);

  requireIncludes(doc, 'C7 dangerous operation boundary is recorded', [
    '删除、外发、批量移动、真实工具执行、原项目写入必须等待用户明确确认'
  ]);
}

if (!existsSync(auditPath)) {
  fail('C8 open-source audit JSON exists', `${auditPath} missing`);
} else {
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  if (audit.rows?.length >= 15) pass('C8 open-source audit JSON exists', `${audit.rows.length} rows`);
  else fail('C8 open-source audit JSON exists', `rows=${audit.rows?.length || 0}`);

  const missingLicense = audit.rows.filter((row) => !row.license?.spdxId);
  if (missingLicense.length === 0) pass('C9 audit rows include license field');
  else fail('C9 audit rows include license field', missingLicense.map((row) => row.repo).join(', '));

  const requiredRepos = ['mem0ai/mem0', 'langchain-ai/langgraph', 'electron-userland/electron-builder', 'open-telemetry/opentelemetry-js'];
  const repos = new Set(audit.rows.map((row) => row.repo));
  const missingRepos = requiredRepos.filter((repo) => !repos.has(repo));
  if (missingRepos.length === 0) pass('C10 required candidate classes are covered');
  else fail('C10 required candidate classes are covered', missingRepos.join(', '));
}

try {
  const status = execFileSync('git', ['-C', 'BaiLongma-audit', 'status', '--short'], { encoding: 'utf8' }).trim();
  if (status === '') pass('C11 BaiLongma audit mirror remains read-only clean');
  else fail('C11 BaiLongma audit mirror remains read-only clean', status);
} catch (error) {
  fail('C11 BaiLongma audit mirror remains read-only clean', error.message);
}

runGate('C12 phase10 acceptance gate still passes', 'NOE_PHASE10_ACCEPTANCE_VERIFY.mjs');
runGate('C13 secret gate still passes', 'NOE_PHASE2_SECRET_GATE.mjs');

for (const check of checks) {
  console.log(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
}

const failed = checks.filter((check) => !check.ok);
console.log(`Result: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
