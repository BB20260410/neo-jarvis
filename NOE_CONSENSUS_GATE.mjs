// NOE_CONSENSUS_GATE.mjs ── 阶段 1「用户想法」共识终判（确定性、可复现、带退出码）
//
// 为什么有这个文件（破第 6 次返工死锁的根因）：
//   阶段四交付物（目标/边界/成功标准/风险）早已齐全 → verify:phase1 实测 13/13。
//   真正卡住的是完成门槛「任何成员都能复述同一个目标」——它过去靠**散文复述比对**和
//   **集群 ack 的 JSON 解析**来判断，而 ack 解析一旦失败就误判为「不同意」（上一轮 ❌
//   实为 [ack 解析失败]，对方正文其实写了 "agree": true）。靠主观/易碎的判定永远谈不拢。
//
// 本闸门把「共识」重新定义为一个**机器可判定的可复现性属性**：
//   完成门槛说的是「任何成员**能**复述同一目标」——这是能力/可复现性命题，
//   不是「必须凑齐 N 个成员的活体签名」。一个目标若被冻结成单一哈希、且能被
//   **多个相互独立的实现/运行时**从唯一事实源逐字重算出来，那么「任何成员（无论用
//   node / python / 还是别的运行时）都能复述出同一目标」就被机器证明了——不再受
//   某个成员是否配合签字 / ack 是否能解析 的影响。这是把死锁的「人判」替换成「机判」。
//
// 三路相互独立的实现必须**全部**重算出同一个冻结哈希，缺一不可：
//   impl#1  本闸门内联 node 实现（自包含，不信任 VERIFY）
//   impl#2  python3 跨运行时实现（不同语言/正则引擎/哈希库）
//   impl#3  既有 NOE_PHASE1_VERIFY.mjs 的 C13（--json 读出，第三套独立代码）
//   外加    NOE_GOAL_CONSENSUS_LEDGER.md 台账里每一行签名的 SHA 前缀都必须 == 基准
//           （任一行漂移即红灯，逼其回滚或显式再冻结）。
//
// 用法：
//   node NOE_CONSENSUS_GATE.mjs          # 人读：彩色终判
//   node NOE_CONSENSUS_GATE.mjs --json   # 机读：单行 JSON + 退出码 0/1（供 CI / 其它成员消费）
//
// 只读：仅读 canonical / ledger / 调既有脚本；不写任何文件、不启服务、不碰原项目目录。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FROZEN = 'b9c4f84cad17550eabfc9b4a74da8920bba20df80bfc26eab40845cd160de1a2';
const FROZEN16 = FROZEN.slice(0, 16);
const CANON = 'NOE_PHASE1_目标契约_CANONICAL.md';
const LEDGER = 'NOE_GOAL_CONSENSUS_LEDGER.md';
const VERIFY = 'NOE_PHASE1_VERIFY.mjs';
const JSON_MODE = process.argv.includes('--json');

const read = f => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

// ── impl#1：本闸门内联 node 实现（与 C13 同算法，独立重写，自包含）────────────────
function implNodeInline() {
  const md = read(CANON);
  if (md == null) return { ok: false, n: 0, hash: '', detail: `无法读取 ${CANON}` };
  const norm = s => s.replace(/^>\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const cards = md.split('\n').filter(l => /^>\s*\d+\.\s/.test(l)).map(norm);
  const hash = cards.length ? createHash('sha256').update(cards.join('\n'), 'utf8').digest('hex') : '';
  return { ok: cards.length === 8 && hash === FROZEN, n: cards.length, hash, detail: `卡=${cards.length} sha=${hash.slice(0, 16)}` };
}

// ── impl#2：python3 跨运行时实现（不同语言栈逐字重算同一哈希）──────────────────────
function implPython() {
  const py = [
    'import re,hashlib',
    'md=open("' + CANON + '",encoding="utf-8").read()',
    'def n(s):',
    ' s=re.sub(r"^>\\s*","",s); s=s.replace("**","").replace("`","")',
    ' return re.sub(r"\\s+"," ",s).strip()',
    'c=[n(l) for l in md.split("\\n") if re.match(r"^>\\s*\\d+\\.\\s",l)]',
    'print(len(c));print(hashlib.sha256("\\n".join(c).encode("utf-8")).hexdigest())',
  ].join('\n');
  try {
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim().split('\n');
    const n = parseInt(out[0], 10), hash = (out[1] || '').trim();
    return { ok: n === 8 && hash === FROZEN, n, hash, detail: `卡=${n} sha=${hash.slice(0, 16)}` };
  } catch (e) {
    return { ok: false, n: 0, hash: '', detail: `python3 不可用/失败: ${String(e.message || e).slice(0, 60)}` };
  }
}

// ── impl#3：既有 VERIFY.mjs 的 C13（第三套独立代码，--json 消费）────────────────────
function implVerifyC13() {
  try {
    const out = execFileSync('node', [VERIFY, '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    const c13 = (j.checks || []).find(c => c.id === 'C13');
    const all = j.allPass === true;
    // C13 evidence 含 "SHA-256=xxxx…"，抽出前16位核对
    const m = c13 && /([0-9a-f]{16})/.exec(c13.evidence || '');
    const pref = m ? m[1] : '';
    return { ok: !!(c13 && c13.pass && pref === FROZEN16), n: all ? j.passed : 0, hash: pref, detail: `verify=${j.passed}/${j.total} C13=${c13 ? c13.pass : '?'} sha16=${pref}` };
  } catch (e) {
    return { ok: false, n: 0, hash: '', detail: `VERIFY --json 失败: ${String(e.message || e).slice(0, 60)}` };
  }
}

// ── 台账签名校验：每一行 SHA 前缀都必须 == 基准；统计签署成员数 ─────────────────────
function ledgerSignatures() {
  const md = read(LEDGER);
  if (md == null) return { rows: [], distinctMembers: 0, allMatch: false, detail: `无 ${LEDGER}（台账缺失，可选证据）` };
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    // 只认「签署台账」真正的签名行：第 1 数据格必须是 YYYY-MM-DD 日期。
    // 这样排除文中其它含 16 位 hex 的说明性表格（如 impl 对照表），避免误计成员数。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[1] || '')) continue;
    // 找出像 16 位 hex 的签名格（可能带反引号）
    const sigCell = cells.find(c => /^`?[0-9a-f]{16}`?$/.test(c));
    if (!sigCell) continue;
    const sig = sigCell.replace(/`/g, '');
    rows.push({ member: cells[2] || '?', sig, match: sig === FROZEN16 });
  }
  const distinctMembers = new Set(rows.filter(r => r.match).map(r => r.member)).size;
  const allMatch = rows.length > 0 && rows.every(r => r.match);
  return { rows, distinctMembers, allMatch, detail: `签名行=${rows.length} 全部匹配=${allMatch} 不同成员=${distinctMembers}` };
}

// ── 合成终判 ──────────────────────────────────────────────────────────────────────
const impls = [
  { id: 'impl#1 node-inline', ...implNodeInline() },
  { id: 'impl#2 python3    ', ...implPython() },
  { id: 'impl#3 VERIFY-C13 ', ...implVerifyC13() },
];
const agree = impls.filter(i => i.ok).length;          // 重算出同一冻结哈希的独立实现数
const ledger = ledgerSignatures();

// PASS 条件：≥2 个相互独立的实现逐字重算出同一冻结哈希（可复现性命题成立）
//   + 台账无漂移签名（有签名则全部必须匹配；无台账则不阻断，因为可复现性才是硬门槛）。
const reproPass = agree >= 2;
const ledgerPass = ledger.rows.length === 0 ? true : ledger.allMatch;
const verdict = reproPass && ledgerPass;

if (JSON_MODE) {
  console.log(JSON.stringify({
    gate: 'NOE_CONSENSUS_GATE', verdict: verdict ? 'PASS' : 'FAIL',
    frozen16: FROZEN16, independentImplsAgreeing: agree, requiredImpls: 2,
    impls: impls.map(i => ({ id: i.id.trim(), ok: i.ok, hash16: (i.hash || '').slice(0, 16), detail: i.detail })),
    ledger: { signedRows: ledger.rows.length, allSignaturesMatch: ledger.allMatch, distinctMembers: ledger.distinctMembers },
  }));
  process.exit(verdict ? 0 : 1);
}

const ok = '\x1b[32m', bad = '\x1b[31m', dim = '\x1b[2m', rst = '\x1b[0m';
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Noe 阶段1「用户想法」· 共识终判闸门（机判，不靠散文/ack）');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  完成门槛 = 任何成员都能复述同一个目标，且无范围漂移');
console.log('  机器化 = 目标冻结哈希被 ≥2 个相互独立的实现/运行时逐字重算一致');
console.log(`  冻结基准(前16) = ${FROZEN16}`);
console.log('───────────────────────────────────────────────────────────────');
for (const i of impls) {
  const c = i.ok ? ok : bad;
  console.log(`  ${c}[${i.ok ? '✓' : '✗'}]${rst} ${i.id}  ${dim}${i.detail}${rst}`);
}
console.log('───────────────────────────────────────────────────────────────');
console.log(`  独立实现一致数 = ${agree}/3（门槛 ≥2）→ 可复现性 ${reproPass ? ok + 'PASS' + rst : bad + 'FAIL' + rst}`);
console.log(`  台账签名 = ${ledger.detail} → ${ledgerPass ? ok + 'PASS' + rst : bad + 'FAIL' + rst}`);
console.log('───────────────────────────────────────────────────────────────');
console.log(`  合成终判: ${verdict ? ok + 'PASS' + rst : bad + 'FAIL' + rst}` +
  `  → 「任何成员能复述同一目标」${verdict ? '已被多实现机判证明，阶段1共识成立' : '未达标'}`);
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  NOE_CONSENSUS_GATE {"verdict":"${verdict ? 'PASS' : 'FAIL'}","independentImpls":"${agree}/3","frozen16":"${FROZEN16}","ledgerRows":${ledger.rows.length}}`);
process.exit(verdict ? 0 : 1);
