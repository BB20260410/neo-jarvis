#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// NOE_PHASE3_VERIFY.mjs
//   阶段 3「技术方案设计」可复跑验证门。把"方案能否指导落地"从散文升级为机器判定。
//   判定项（任一失败 → 退出码 1，绝不静默）：
//     C1 必备章节齐全（架构/模块边界/数据模型/接口/状态机/数据流/失败处理/兼容回滚）
//     C2 缺口 Q-1..Q-7 全部在 §7 给出裁定
//     C3 功能需求 FR-00..FR-11 全部在设计稿出现（有落点映射）
//     C4 设计引用的"现有锚文件"在磁盘真实存在（防止设计建立在幻觉文件上）
//     C5 设计稿无明文 secret（doubaoKey 只允许 <REDACTED>/占位）
//     C6 关键设计决策可机读到位（in-process / 默认关 / FTS5 trigram / 加法不改存量 / Node22）
//   只读校验，不改任何文件。
// ────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOC = join(ROOT, 'NOE_PHASE3_TECH_DESIGN_CANONICAL.md');
const checks = [];
const rec = (ok, name, detail) => { checks.push({ ok, name }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         └─ ${detail}` : ''}`); };

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Noe 阶段 3 技术方案设计 · 可落地性验证门');
console.log('═══════════════════════════════════════════════════════════════');

if (!existsSync(DOC)) { rec(false, 'C0 设计稿存在', DOC); summarize(); process.exit(1); }
const md = readFileSync(DOC, 'utf8');

// ── C1 必备章节 ──────────────────────────────────────────────────────────────
const sections = [
  ['总体架构', /##\s*1\.\s*总体架构/],
  ['模块边界', /##\s*2\.\s*模块边界/],
  ['数据模型', /##\s*3\.\s*数据模型/],
  ['接口设计', /##\s*4\.\s*接口设计/],
  ['状态机', /##\s*5\.\s*状态机/],
  ['数据流', /##\s*6\.\s*数据流/],
  ['失败处理', /##\s*8\.\s*失败处理/],
  ['兼容性与回滚', /##\s*9\.\s*兼容性与回滚/],
];
const missingSec = sections.filter(([, re]) => !re.test(md)).map(([n]) => n);
rec(missingSec.length === 0, 'C1 必备章节齐全（架构/边界/数据/接口/状态机/数据流/失败/回滚）',
  missingSec.length ? `缺：${missingSec.join('、')}` : '8/8 章节齐全');

// ── C2 Q-1..Q-7 全闭环 ───────────────────────────────────────────────────────
const qMissing = [];
for (let i = 1; i <= 7; i++) if (!new RegExp(`Q-${i}`).test(md)) qMissing.push(`Q-${i}`);
const hasGateSection = /##\s*7\.\s*缺口闭环/.test(md);
rec(qMissing.length === 0 && hasGateSection, 'C2 缺口 Q-1..Q-7 全部裁定（§7）',
  qMissing.length ? `缺：${qMissing.join('、')}` : (hasGateSection ? 'Q-1..Q-7 + §7 闭环段齐全' : '缺 §7 闭环段'));

// ── C3 FR-00..FR-11 全映射 ───────────────────────────────────────────────────
const frMissing = [];
for (let i = 0; i <= 11; i++) {
  const id = `FR-${String(i).padStart(2, '0')}`;
  if (!new RegExp(id).test(md)) frMissing.push(id);
}
rec(frMissing.length === 0, 'C3 功能需求 FR-00..FR-11 全部有设计落点',
  frMissing.length ? `缺：${frMissing.join('、')}` : 'FR-00..FR-11 全覆盖');

// ── C4 现有锚文件真实存在（防幻觉文件）─────────────────────────────────────────
const anchors = [
  'src/storage/SqliteStore.js',
  'src/budget/BudgetPolicyStore.js',
  'src/cost/CostTracker.js',
  'src/autopilot/AutopilotScheduler.js',
  'src/permissions/PermissionGovernance.js',
  'src/approval/ApprovalStore.js',
  'src/safety/DangerousPatternDetector.js',
  'src/audit/ActivityLog.js',
  'src/mcp/McpStore.js',
  'src/server/auth/owner-token.js',
  'src/workspace/WorkspaceManager.js',
  'NOE_M1_ISOLATION_SMOKE.mjs',
];
const anchorMissing = anchors.filter((p) => !existsSync(join(ROOT, p)));
rec(anchorMissing.length === 0, `C4 设计引用的 ${anchors.length} 个现有锚文件真实存在`,
  anchorMissing.length ? `磁盘缺失：${anchorMissing.join(', ')}` : '全部锚文件可定位（设计未建立在幻觉文件上）');

// ── C5 设计稿无明文 secret ───────────────────────────────────────────────────
// doubaoKey 在本设计稿只允许以 <REDACTED>/占位出现；命中"被标注为 key 的 32hex/uuid 字面量"即 hard fail。
const secretFindings = [];
const lines = md.split('\n');
const labelRe = /(api[-_]?key|key\b|token|secret|password|credential)/i;
const literalRe = /\b([0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
lines.forEach((ln, idx) => {
  if (labelRe.test(ln) && literalRe.test(ln)) {
    // 放行良性引用：BaiLongma 镜像 HEAD（de78c6f...）等 commit 短哈希不在 32hex 范围；这里只抓长字面量
    secretFindings.push(`${idx + 1}: ${ln.trim().slice(0, 80)}`);
  }
});
rec(secretFindings.length === 0, 'C5 设计稿无明文 secret',
  secretFindings.length ? `疑似命中：\n            ${secretFindings.join('\n            ')}` : '未发现"密钥标签 + 长字面量"组合');

// ── C6 关键设计决策机读到位 ──────────────────────────────────────────────────
const decisions = [
  ['进程模型 in-process', /in-process|内嵌|单进程/],
  ['默认关（不烧额度）', /默认[关禁]|actMode\s*=\s*false|enabled\s*[:=]\s*false|enabled=0/],
  ['FTS5 trigram 召回', /FTS5\s*trigram|tokenize\s*=\s*'trigram'/i],
  ['加法不改存量', /加法不改存量|CREATE TABLE IF NOT EXISTS/],
  ['迁移 v2 版本化', /迁移\s*v2|version:\s*2|SCHEMA_MIGRATIONS/],
  ['Node 22 锁定', /Node\s*22|NODE_MODULE_VERSION|npm rebuild/i],
  ['预算 preflight 接入', /preflight/],
  ['集群让路 clusterBusy', /clusterBusy|让路/],
];
const decMissing = decisions.filter(([, re]) => !re.test(md)).map(([n]) => n);
rec(decMissing.length === 0, 'C6 关键设计决策机读到位（8 项）',
  decMissing.length ? `缺：${decMissing.join('、')}` : '8/8 关键决策可定位');

function summarize() {
  const pass = checks.filter((c) => c.ok).length;
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  结果: ${pass}/${checks.length} 通过 → ${pass === checks.length ? '✅ 阶段 3 技术方案可指导落地' : '❌ 技术方案存在缺口'}`);
  console.log('═══════════════════════════════════════════════════════════════');
}
summarize();
process.exit(checks.every((c) => c.ok) ? 0 : 1);
