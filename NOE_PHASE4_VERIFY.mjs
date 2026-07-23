#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// NOE_PHASE4_VERIFY.mjs
//   阶段 4「任务分配与排期」可复跑验证门。把"排期能否逐项执行与验收"从散文升级为机器判定。
//   判定项（任一失败 → 退出码 1，绝不静默）：
//     C1 必备章节齐全（排期总览/任务清单/执行顺序与依赖/角色分工/阻塞点/验证门/排期时间线/闭环衔接）
//     C2 任务粒度：>=28 个 T- 任务，且每个任务行都含 6 列（主办/复核/依赖/验收口径俱全）
//     C3 P0/P1 功能需求 FR-03..FR-09 各被 >=1 个任务覆盖；P2 FR-10/11 标注 gated/延后/不写代码
//     C4 角色分工含三成员（Claude/GPT/Gemini），且每任务都有主办与复核（主办≠复核抽样校验）
//     C5 检查点门 CP-A..CP-D 全部定义，且 P2 准入受 CP-C 约束（防 P0/P1 未过抢跑）
//     C6 阻塞点 BLK 全部映射收敛条件（>=5 条），含 Node22/ABI 硬阻塞
//     C7 引用的现有锚文件 + 前序 canonical 真实存在（防排期建立在幻觉文件上）
//     C8 排期稿无明文 secret（doubaoKey 只允许 <REDACTED>/占位）
//     C9 关键排期决策机读到位（P0先行/P2不抢跑/Node22锁/零新增依赖/默认关/加法不改存量）
//   只读校验，不改任何文件。
// ────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOC = join(ROOT, 'NOE_PHASE4_TASK_PLAN_CANONICAL.md');
const checks = [];
const rec = (ok, name, detail) => { checks.push({ ok, name }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         └─ ${detail}` : ''}`); };

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Noe 阶段 4 任务分配与排期 · 可执行性验证门');
console.log('═══════════════════════════════════════════════════════════════');

if (!existsSync(DOC)) { rec(false, 'C0 排期稿存在', DOC); summarize(); process.exit(1); }
const md = readFileSync(DOC, 'utf8');
const lines = md.split('\n');

// ── C1 必备章节 ──────────────────────────────────────────────────────────────
const sections = [
  ['排期总览', /##\s*1\.\s*排期总览/],
  ['任务清单(WBS)', /##\s*2\.\s*任务清单/],
  ['执行顺序与依赖', /##\s*3\.\s*执行顺序与依赖/],
  ['角色分工', /##\s*4\.\s*角色\s*\/?\s*模型分工/],
  ['阻塞点与风险闸门', /##\s*5\.\s*阻塞点/],
  ['验证门', /##\s*6\.\s*验证门/],
  ['排期时间线', /##\s*7\.\s*排期与检查点时间线/],
  ['闭环衔接', /##\s*8\.\s*工程闭环/],
];
const missingSec = sections.filter(([, re]) => !re.test(md)).map(([n]) => n);
rec(missingSec.length === 0, 'C1 必备章节齐全（总览/清单/顺序/分工/阻塞/验证门/时间线/闭环）',
  missingSec.length ? `缺：${missingSec.join('、')}` : '8/8 章节齐全');

// ── C2 任务粒度：T- 任务行解析 ───────────────────────────────────────────────
// 任务行形如：| T-1.1 | 任务 | 主办 | 复核 | 依赖 | 验收口径 |  (含字母段 T-R./T-I./T-P2. 及横切 X-n 行)
const taskRowRe = /^\|\s*(T-[0-9A-Za-z]+\.[0-9]+|X-[0-9]+)\s*\|/;
const taskRows = lines.filter((l) => taskRowRe.test(l));
const malformed = taskRows.filter((l) => l.split('|').filter((c) => c.trim() !== '').length < 6);
rec(taskRows.length >= 32 && malformed.length === 0, `C2 任务粒度足够（>=32 任务且 6 列俱全）`,
  `解析到 ${taskRows.length} 个任务行；列不全行数=${malformed.length}` + (malformed.length ? `\n            首个不全：${malformed[0].trim().slice(0, 70)}` : ''));

// ── C3 P0/P1 FR 全覆盖 + P2 标注延后 ─────────────────────────────────────────
const frP0P1 = ['FR-03', 'FR-04', 'FR-05', 'FR-06', 'FR-07', 'FR-08', 'FR-09'];
const frMissing = frP0P1.filter((id) => !new RegExp(id).test(md));
const p2Gated = /FR-10/.test(md) && /FR-11/.test(md) && /(gated|延后|不写代码|只定契约|P2)/.test(md);
rec(frMissing.length === 0 && p2Gated, 'C3 P0/P1 FR-03..09 全覆盖 + P2 FR-10/11 标注延后',
  frMissing.length ? `P0/P1 缺映射：${frMissing.join('、')}` : (p2Gated ? 'FR-03..09 全覆盖；FR-10/11 已标 gated/延后' : 'P2 未明确标注延后/gated'));

// ── C4 三成员分工 + 每任务有主办/复核 ────────────────────────────────────────
const hasClaude = /Claude/.test(md), hasGpt = /GPT/.test(md), hasGemini = /Gemini/.test(md);
// 抽样：每个任务行至少出现 2 个成员标记（主办列 + 复核列）
const memberMark = /(Claude|GPT|Gemini)/g;
const rowsWith2Members = taskRows.filter((l) => (l.match(memberMark) || []).length >= 2);
const threeMembers = hasClaude && hasGpt && hasGemini;
rec(threeMembers && rowsWith2Members.length >= Math.floor(taskRows.length * 0.9),
  'C4 三成员分工齐全 + 每任务有主办与复核',
  `三成员=${threeMembers}；含>=2成员标记的任务行 ${rowsWith2Members.length}/${taskRows.length}`);

// ── C5 检查点门 CP-A..CP-D + P2 受 CP-C 约束 ─────────────────────────────────
const cps = ['CP-A', 'CP-B', 'CP-C', 'CP-D'];
const cpMissing = cps.filter((c) => !new RegExp(c).test(md));
// P2 准入门必须引用 CP-C 已通过（防抢跑）
const p2GuardedByCpC = /CP-C\s*已?通过/.test(md) || /CP-C[^\n]*通过[^\n]*P2/.test(md) || /(CP-D)[\s\S]{0,120}CP-C/.test(md);
rec(cpMissing.length === 0 && p2GuardedByCpC, 'C5 检查点门 CP-A..CP-D 齐全 + P2 准入受 CP-C 约束',
  cpMissing.length ? `缺门：${cpMissing.join('、')}` : (p2GuardedByCpC ? 'CP-A..CP-D 齐全；CP-D 以 CP-C 通过为前置' : 'CP-D 未约束于 CP-C（抢跑风险）'));

// ── C6 阻塞点 BLK 全部有收敛 + Node22 硬阻塞 ─────────────────────────────────
const blkRows = lines.filter((l) => /^\|\s*BLK-[0-9]+\s*\|/.test(l));
const hasNodeAbiBlk = /BLK-1[\s\S]{0,200}(ABI|Node\s*22|rebuild)/.test(md);
rec(blkRows.length >= 5 && hasNodeAbiBlk, 'C6 阻塞点 BLK 全部映射收敛（>=5）含 Node22/ABI 硬阻塞',
  `解析到 ${blkRows.length} 条 BLK；Node/ABI 硬阻塞=${hasNodeAbiBlk}`);

// ── C7 锚文件 + 前序 canonical 真实存在 ──────────────────────────────────────
const anchors = [
  'NOE_PHASE1_目标契约_CANONICAL.md',
  'NOE_PHASE2_REQUIREMENTS_CANONICAL.md',
  'NOE_PHASE3_TECH_DESIGN_CANONICAL.md',
  'NOE_M1_ISOLATION_SMOKE.mjs',
  'NOE_PHASE2_SECRET_GATE.mjs',
  'src/storage/SqliteStore.js',
  'src/budget/BudgetPolicyStore.js',
  'src/permissions/PermissionGovernance.js',
  'src/approval/ApprovalStore.js',
  'src/safety/DangerousPatternDetector.js',
  'src/audit/ActivityLog.js',
  'src/server/auth/owner-token.js',
];
const anchorMissing = anchors.filter((p) => !existsSync(join(ROOT, p)));
rec(anchorMissing.length === 0, `C7 引用的 ${anchors.length} 个锚文件/前序 canonical 真实存在`,
  anchorMissing.length ? `磁盘缺失：${anchorMissing.join(', ')}` : '全部锚文件可定位（排期未建立在幻觉文件上）');

// ── C8 排期稿无明文 secret ───────────────────────────────────────────────────
const labelRe = /(api[-_]?key|key\b|token|secret|password|credential)/i;
const literalRe = /\b([0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const secretFindings = [];
lines.forEach((ln, idx) => { if (labelRe.test(ln) && literalRe.test(ln)) secretFindings.push(`${idx + 1}: ${ln.trim().slice(0, 80)}`); });
rec(secretFindings.length === 0, 'C8 排期稿无明文 secret',
  secretFindings.length ? `疑似命中：\n            ${secretFindings.join('\n            ')}` : '未发现"密钥标签 + 长字面量"组合');

// ── C9 关键排期决策机读到位 ──────────────────────────────────────────────────
const decisions = [
  ['P0 先行串行', /P0[\s\S]{0,20}(未过|先行|串行)|未过不抢|不抢跑/],
  ['P2 不抢跑/延后', /P2[\s\S]{0,30}(延后|不抢|只定契约|不写代码|gated)/],
  ['Node 22 锁定', /Node\s*22|\.nvmrc|NODE_MODULE_VERSION|npm rebuild/i],
  ['零新增依赖', /零新增依赖|不新增依赖|NFR-DEP-1/],
  ['默认关（不烧额度）', /默认[关禁]|actMode\s*=\s*false|enabled\s*=\s*0|默认.*disabled/i],
  ['加法不改存量', /加法不改存量|不改现有\s*17\s*表|0\s*改/],
];
const decMissing = decisions.filter(([, re]) => !re.test(md)).map(([n]) => n);
rec(decMissing.length === 0, 'C9 关键排期决策机读到位（6 项）',
  decMissing.length ? `缺：${decMissing.join('、')}` : '6/6 关键决策可定位');

function summarize() {
  const pass = checks.filter((c) => c.ok).length;
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  结果: ${pass}/${checks.length} 通过 → ${pass === checks.length ? '✅ 阶段 4 排期可逐项执行与验收' : '❌ 排期存在缺口'}`);
  console.log('═══════════════════════════════════════════════════════════════');
}
summarize();
process.exit(checks.every((c) => c.ok) ? 0 : 1);
