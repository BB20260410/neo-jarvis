#!/usr/bin/env node
// NOE_PHASE9_DOCS_VERIFY.mjs — 阶段 9「文档编写」机读门（Claude 独立交付）
// 配套文档：NOE_PHASE9_DOCS_CANONICAL.md
// 说明：本门与并行成员的 NOE_PHASE9_VERIFY.mjs 共存，互不覆盖（集群红线：不打覆盖战）。
// 把「下一位执行者无需猜测上下文」升级为机器判定：
//   C1 必备章节齐全
//   C2 文档 API 端点集合 == src/server/routes/noe.js 真实端点集合（双向防幻觉）
//   C3 引用的锚文件磁盘真实存在且被文档引用
//   C4 schema v2 四张表：文档与 SqliteStore.js 双侧对账
//   C5 已知限制 + 交接关键词齐全
//   C6 文档无明文密钥
//   C7 维护章节引用的验证脚本磁盘真实存在
//   C8 工程闭环 11 阶段标签齐全
//   C9 监督纠偏规则已写入文档入口与交接入口
// 运行：/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE9_DOCS_VERIFY.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/';
const DOC = 'NOE_PHASE9_DOCS_CANONICAL.md';
const SUPERVISOR = 'NOE_STAGE9_SUPERVISOR_CORRECTION.md';
const ROUTE = 'src/server/routes/noe.js';
const SCHEMA = 'src/storage/SqliteStore.js';

const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
const read = (p) => readFileSync(ROOT + p, 'utf8');

if (!existsSync(ROOT + DOC)) {
  console.error(`FATAL: ${DOC} 不存在`);
  process.exit(1);
}
const doc = read(DOC);

// ---- C1 必备章节 ----
const SECTIONS = [
  '## 0. 项目定位与边界',
  '## 1. 使用说明',
  '## 2. 系统架构与接线',
  '## 3. 数据模型',
  '## 4. API 参考',
  '## 5. 维护说明',
  '## 6. 已知限制',
  '## 7. 变更说明',
  '## 8. 交接信息',
  '## 9. 工程闭环 11 阶段衔接',
];
const missingSec = SECTIONS.filter((s) => !doc.includes(s));
ok('C1 必备章节 10/10', missingSec.length === 0, missingSec.length ? `缺: ${missingSec.join(' / ')}` : '全齐');

// ---- C2 API 端点双向防幻觉 ----
const routeSrc = read(ROUTE);
const ACTIONS = (() => {
  const m = routeSrc.match(/for \(const action of \[([^\]]+)\]/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean);
})();
const realSet = new Set();
const routeRe = /app\.(get|post|delete|put|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
let rm;
while ((rm = routeRe.exec(routeSrc))) {
  const method = rm[1].toUpperCase();
  const p = rm[2];
  if (!p.startsWith('/api/noe/')) continue;
  if (p.includes('${action}')) {
    for (const a of ACTIONS) realSet.add(`${method} ${p.replace('${action}', a)}`);
  } else {
    realSet.add(`${method} ${p}`);
  }
}
const docSet = new Set();
const docRe = /\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*(\/api\/noe\/\S+?)\s*\|/g;
let dm;
while ((dm = docRe.exec(doc))) docSet.add(`${dm[1]} ${dm[2]}`);
const missingInDoc = [...realSet].filter((e) => !docSet.has(e));
const extraInDoc = [...docSet].filter((e) => !realSet.has(e));
ok(
  `C2 API 端点对账 (real=${realSet.size} doc=${docSet.size})`,
  realSet.size > 0 && missingInDoc.length === 0 && extraInDoc.length === 0,
  [missingInDoc.length ? `文档漏: ${missingInDoc.join(', ')}` : '', extraInDoc.length ? `文档幻觉: ${extraInDoc.join(', ')}` : ''].filter(Boolean).join(' | ') || '集合完全一致'
);

// ---- C3 锚文件磁盘真实存在且被引用 ----
const ANCHORS = [
  'src/memory/MemoryCore.js',
  'src/memory/FocusStack.js',
  'src/loop/NoeLoop.js',
  'src/capabilities/ToolRegistry.js',
  'src/server/routes/noe.js',
  'src/server/auth/owner-token.js',
  'src/storage/SqliteStore.js',
  'public/src/web/brain-ui.js',
  'public/index.html',
  'public/main.js',
  'NOE_NODE_VERSION_RUNBOOK.md',
  'NOE_BAILONGMA_ARCH_AUDIT.md',
];
const anchorBad = ANCHORS.filter((f) => !existsSync(ROOT + f) || !doc.includes(f));
ok(`C3 锚文件存在且被引用 (${ANCHORS.length})`, anchorBad.length === 0, anchorBad.length ? `问题: ${anchorBad.join(', ')}` : '全部真实且被引用');

// ---- C4 schema v2 四表双侧对账 ----
const schemaSrc = read(SCHEMA);
const TABLES = ['noe_memory', 'noe_memory_fts', 'noe_focus_stack', 'noe_tools'];
const tableBad = TABLES.filter((t) => !doc.includes(t) || !schemaSrc.includes(t));
ok('C4 schema v2 四表对账', tableBad.length === 0, tableBad.length ? `问题: ${tableBad.join(', ')}` : '文档与 SqliteStore.js 一致');

// ---- C5 已知限制 + 交接关键词 ----
const C5_KEYS = ['Voice', 'P2', 'Node 22', '51735', 'handler'];
const c5Missing = C5_KEYS.filter((k) => !doc.includes(k));
ok('C5 约束关键词齐全', c5Missing.length === 0, c5Missing.length ? `缺: ${c5Missing.join(', ')}` : '齐全');

// ---- C6 无明文密钥 ----
const secretRe = /(api[-_]?key|secret|password|token)["']?\s*[:=]\s*["']([^"'<>\s]{20,})["']/gi;
const secretHits = [];
let sm;
while ((sm = secretRe.exec(doc))) {
  const val = sm[2];
  if (/^(REDACTED|owner-token|your-|placeholder|example)/i.test(val)) continue;
  secretHits.push(`${sm[1]}=${val.slice(0, 6)}…`);
}
ok('C6 文档无明文密钥', secretHits.length === 0, secretHits.length ? `命中: ${secretHits.join(', ')}` : '无');

// ---- C7 维护章节引用的验证脚本真实存在 ----
const GATES = [
  'NOE_PHASE2_SECRET_GATE.mjs',
  'NOE_PHASE6_VERIFY.mjs',
  'NOE_M1_ISOLATION_SMOKE.mjs',
  'NOE_PHASE7_INTEGRATION_SMOKE.mjs',
  'NOE_PHASE8_FUNCTIONAL_VERIFY.mjs',
  'NOE_PHASE9_DOCS_VERIFY.mjs',
];
const gateBad = GATES.filter((g) => !existsSync(ROOT + g) || !doc.includes(g));
ok(`C7 验证脚本存在且被引用 (${GATES.length})`, gateBad.length === 0, gateBad.length ? `问题: ${gateBad.join(', ')}` : '全部真实且被引用');

// ---- C8 11 阶段标签 ----
const STAGES = ['用户想法', '需求分析', '技术方案设计', '任务分配', '代码开发', '单元测试', '集成测试', '功能验证', '文档编写', '交付验收', '复盘优化'];
const stageMissing = STAGES.filter((s) => !doc.includes(s));
ok('C8 工程闭环 11 阶段', stageMissing.length === 0, stageMissing.length ? `缺: ${stageMissing.join(', ')}` : '11/11 齐全');

// ---- C9 监督纠偏规则落账 ----
const correctionFiles = [
  DOC,
  SUPERVISOR,
  'README.md',
  'CHANGELOG.md',
  '上下文交接.md',
  '任务交接.md',
];
const correctionSnippets = [
  '最多讨论 3 轮',
  'GPT/Codex + Gemini',
  '不要因旧 CE05',
];
const correctionBad = [];
for (const file of correctionFiles) {
  if (!existsSync(ROOT + file)) {
    correctionBad.push(`${file}:missing`);
    continue;
  }
  const source = read(file);
  for (const snippet of correctionSnippets) {
    if (!source.includes(snippet)) correctionBad.push(`${file}:缺 ${snippet}`);
  }
}
const supervisor = existsSync(ROOT + SUPERVISOR) ? read(SUPERVISOR) : '';
const supervisorMust = [
  '不要沿用旧的“不允许因轮数/输出上限停止”文案',
  'Claude 掉线、没额度、限流或 CLI 不可用后，由 GPT/Codex + Gemini 有效成员共识推进',
  'Gemini 在 Claude 可用时是审计辅助',
  '/Users/hxx/Desktop/Neo 贾维斯',
  '/Users/hxx/Desktop/00_项目/05_Claude可视化面板',
];
for (const snippet of supervisorMust) {
  if (!supervisor.includes(snippet)) correctionBad.push(`${SUPERVISOR}:缺 ${snippet}`);
}
ok('C9 监督纠偏规则落账', correctionBad.length === 0, correctionBad.length ? `问题: ${correctionBad.join(' | ')}` : '阶段 9 推进规则已固化');

// ---- 输出 ----
let passed = 0;
console.log('=== NOE_PHASE9_DOCS_VERIFY 文档编写阶段门 (Claude) ===');
for (const c of checks) {
  console.log(`${c.pass ? '[PASS]' : '[FAIL]'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  if (c.pass) passed += 1;
}
console.log(`\nResult: ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
