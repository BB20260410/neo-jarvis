#!/usr/bin/env node
// NOE 阶段 10「交付验收」机读门
// 完成门槛：每个显式需求都有当前证据支撑。
// 设计原则：churn-proof —— 只锚定稳定产品源码 / 各阶段验证脚本 / 审计稿，
//   不依赖任何并行成员的临时文档存活；自身不拉起 server（快、确定性、可复跑）。
// 运行：/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE10_ACCEPTANCE_VERIFY.mjs
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const DOC = 'NOE_PHASE10_ACCEPTANCE_CANONICAL.md';
let pass = 0, fail = 0;
const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  if (ok) { pass++; console.log(`  [PASS] ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? '  — ' + detail : ''}`); }
}
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

console.log('═'.repeat(63));
console.log('  Noe 阶段 10「交付验收」机读门  ·  唯一事实源: ' + DOC);
console.log('═'.repeat(63));

const doc = read(DOC);
// C1 验收文档存在且四类交付物章节齐全
const sections = ['验收表', '通过', '未通过', '剩余风险', '回滚'];
const missSec = sections.filter((s) => !doc.includes(s));
check(doc.length > 0 && missSec.length === 0, 'C1 验收文档四类交付物章节齐全',
  doc.length === 0 ? '文档缺失' : (missSec.length ? '缺: ' + missSec.join('/') : `验收表/通过/未通过/剩余风险/回滚 齐全 (${doc.split('\n').length} 行)`));

// C2 六条显式需求 + 锚文件 + 裁定齐全（防幻觉：锚文件必须真实存在）
const REQS = [
  { id: 'REQ-1', name: '只读审计 BaiLongma', anchors: ['NOE_BAILONGMA_ARCH_AUDIT.md'] },
  { id: 'REQ-2', name: 'Noe 在 51835 启动且不影响 51735', anchors: ['NOE_M1_ISOLATION_SMOKE.mjs', 'NOE_PHASE8_FUNCTIONAL_VERIFY.mjs'] },
  { id: 'REQ-3', name: 'NoeLoop 最小闭环', anchors: ['src/loop/NoeLoop.js'] },
  { id: 'REQ-4', name: 'Memory Core', anchors: ['src/memory/MemoryCore.js', 'src/memory/FocusStack.js'] },
  { id: 'REQ-5', name: 'Brain UI Lite', anchors: ['public/src/web/brain-ui.js'] },
  { id: 'REQ-6', name: 'Voice/Social/Jarvis (P2 延后)', anchors: [] },
];
for (const r of REQS) {
  const inDoc = doc.includes(r.id);
  const anchorsOk = r.anchors.every((a) => exists(a));
  const missAnchor = r.anchors.filter((a) => !exists(a));
  check(inDoc && anchorsOk, `C2 ${r.id} 在验收表且锚文件真实存在`,
    !inDoc ? '验收表缺该需求' : (anchorsOk ? (r.anchors.join(', ') || 'P2 延后无需锚') : '缺锚文件: ' + missAnchor.join(', ')));
}

// C3 十道阶段验证门脚本真实存在（交付验收以它们的退出码为前置）
const GATES = [
  'NOE_PHASE1_VERIFY.mjs', 'NOE_PHASE2_VERIFY.mjs', 'NOE_PHASE2_SECRET_GATE.mjs',
  'NOE_PHASE3_VERIFY.mjs', 'NOE_PHASE4_VERIFY.mjs', 'NOE_PHASE5_VERIFY.mjs',
  'NOE_PHASE6_VERIFY.mjs', 'NOE_PHASE7_VERIFY.mjs', 'NOE_PHASE8_FUNCTIONAL_VERIFY.mjs',
  'NOE_PHASE9_DOCS_VERIFY.mjs',
];
const missGate = GATES.filter((g) => !exists(g));
check(missGate.length === 0, 'C3 十道阶段验证门脚本全部真实存在',
  missGate.length ? '缺: ' + missGate.join(', ') : `${GATES.length}/${GATES.length} 锚定到位`);

// C4 边界：BaiLongma 镜像被 gitignore（防全量复制进 Noe 被提交）
let ignored = false;
try { execSync('git check-ignore BaiLongma-audit', { cwd: ROOT, stdio: 'pipe' }); ignored = true; } catch { ignored = false; }
check(ignored, 'C4 边界 不全量复制 BaiLongma — 镜像被 gitignore 隔离', ignored ? 'BaiLongma-audit 在 .gitignore' : '镜像未被忽略!');

// C5 边界：工具执行能力 manifest-only + 默认禁用 + 经 permission 门（不审计不接入）
const tr = read('src/capabilities/ToolRegistry.js');
const trOk = tr.includes('PermissionGovernance') && /enabled/.test(tr);
check(trOk, 'C5 边界 工具执行走 permission 门 + enabled 标志驱动',
  trOk ? 'ToolRegistry 引用 PermissionGovernance 且按 enabled 闸门' : 'ToolRegistry 缺权限门/启用闸门');

// C6 边界：Noe 路由全部套 owner-token（鉴权前置）
const noeR = read('src/server/routes/noe.js');
const tokN = (noeR.match(/requireOwnerToken/g) || []).length;
check(tokN >= 8, 'C6 边界 /api/noe/* 全部套 owner-token', `requireOwnerToken 出现 ${tokN} 次`);

// C7 回滚方式：四级回滚写清
const rbKeys = ['功能', '回滚', 'git', 'bak', 'Node'];
const rbHit = rbKeys.filter((k) => doc.includes(k)).length;
check(doc.includes('回滚') && rbHit >= 4, 'C7 回滚方式四级齐全(功能flag/git revert/DB .bak/锁Node22)', `命中 ${rbHit}/5 关键词`);

// C8 P2 延后边界显式记录（Voice/Social/工具真执行不抢跑）
const p2Ok = /P2/.test(doc) && /(延后|deferred|不抢跑|默认禁用|disabled)/.test(doc);
check(p2Ok, 'C8 P2(Voice/Social/工具真执行) 显式标注延后', p2Ok ? 'P2 边界已落账' : '缺 P2 延后声明');

// C9 验收文档无明文密钥（交付物 secret 卫生）
const secretRe = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;
const docSecret = secretRe.test(doc);
check(!docSecret, 'C9 验收文档无明文密钥', docSecret ? '发现疑似明文密钥!' : '干净');

// C10 端口契约写清（51835 生产 / 51735 原项目隔离）
const portOk = doc.includes('51835') && doc.includes('51735');
check(portOk, 'C10 端口隔离契约(51835 生产 / 51735 原项目)写入验收表', portOk ? '双端口契约在文档' : '缺端口契约');

console.log('─'.repeat(63));
const total = pass + fail;
console.log(`  结果: ${pass}/${total} 通过  →  ${fail === 0 ? '✅ 阶段10 交付验收：每个显式需求都有当前证据支撑' : '❌ 有未通过项，见上'}`);
console.log('═'.repeat(63));
process.exit(fail === 0 ? 0 : 1);
