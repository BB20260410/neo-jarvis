#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// NOE_PHASE1_GATE.mjs  ——  阶段1「单一收口闸门」
//
//   为什么要这个文件（4 轮返工的真因，本轮的策略改动）：
//   目标内容 3 轮前就已逐字收敛（canonical 复述卡 8 条 + C13 SHA-256 冻结锁）。
//   真正卡死闭环的不是分歧，而是【裁决通道有噪声】——成员正文写 "agree": true，
//   但 ack 解析器被运行时前缀噪声（"MCP issues detected…" / "True color…" /
//   "UNDICI…" / 插件加载日志）污染，误判成"❌ 不同意"，于是阶段反复返工。
//
//   本闸门把两套既有验证合成一条【无噪声、单行、机器可判定】的终判：
//     ① verify:phase1（13/13 = 目标四交付物 + 唯一性 + 密钥门 + 端口隔离 + C13 锁）
//     ② M1 启停实测（8/8 = 51835 真启停 · 51735 零影响）
//   全部中间输出（含子进程噪声）被吞进缓冲，stdout 最后一行永远是干净 sentinel：
//     NOE_PHASE1_GATE {"verdict":"PASS","phase1":"13/13","m1":"8/8","sha256":"…"}
//   任一成员跑 `node NOE_PHASE1_GATE.mjs --json` 只拿这一行 → ack 解析器不再被噪声卡。
//
//   退出码：0=PASS（阶段1完成门槛达标），非0=FAIL（并保留失败子进程输出可回看）。
//   红线安全：本脚本只 spawn 既有只读/可逆验证脚本，不写产品代码/不改 UI/schema/
//             不碰原项目目录/不碰只读镜像；M1 的启停隔离安全性由其自身断言保证。
// ────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';

const jsonOnly = process.argv.includes('--json'); // 机读模式：只打印最后那行 sentinel
const emit = (s) => { if (!jsonOnly) console.log(s); };

function run(args) {
  try {
    const out = execFileSync('node', args, {
      cwd: process.cwd(), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
// 从子脚本输出抓 "结果: N/M 通过"，返回 {ratio, ok}
function tally(out, code) {
  const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)\s*通过/);
  if (!m) return { ratio: 'n/a', ok: false };
  const ok = code === 0 && m[1] === m[2];
  return { ratio: `${m[1]}/${m[2]}`, ok };
}

emit('═══════════════════════════════════════════════════════════════');
emit('  Noe 阶段1 收口闸门 · 合成单一机器可判定终判');
emit('═══════════════════════════════════════════════════════════════');

// ① 目标契约硬门 13 项
emit('▶ [1/2] verify:phase1（目标/边界/成功标准/风险 + 唯一性 + 密钥门 + 端口隔离 + C13 锁）…');
const r1 = run(['NOE_PHASE1_VERIFY.mjs']);
const t1 = tally(r1.out, r1.code);
const sha = (r1.out.match(/SHA-256=([0-9a-f]{8,})/) || [])[1] || 'n/a';
emit(`   → verify:phase1 = ${t1.ratio}  (exit ${r1.code}; C13 SHA-256=${sha})`);

// ② M1 启停隔离实测 8 项
emit('▶ [2/2] M1 启停隔离实测（51835 真启停 · 51735 零影响）…');
const r2 = run(['NOE_M1_ISOLATION_SMOKE.mjs']);
const t2 = tally(r2.out, r2.code);
emit(`   → M1 smoke   = ${t2.ratio}  (exit ${r2.code})`);

const verdict = t1.ok && t2.ok ? 'PASS' : 'FAIL';
if (verdict === 'FAIL') {
  // 失败时把失败子进程的尾部输出回显，绝不静默
  emit('─── 失败诊断（子进程尾部输出）───');
  if (!t1.ok) emit(r1.out.split('\n').slice(-12).join('\n'));
  if (!t2.ok) emit(r2.out.split('\n').slice(-12).join('\n'));
}
emit('───────────────────────────────────────────────────────────────');
emit(`  合成终判: ${verdict}  (phase1=${t1.ratio} · m1=${t2.ratio})`);
emit('═══════════════════════════════════════════════════════════════');

// 唯一保证：stdout 的最后一行永远是这条无中文/无噪声的 sentinel
const sentinel = `NOE_PHASE1_GATE ${JSON.stringify({
  verdict, phase1: t1.ratio, m1: t2.ratio, sha256: sha,
  exit: { verify: r1.code, m1: r2.code },
})}`;
console.log(sentinel);
process.exit(verdict === 'PASS' ? 0 : 1);
