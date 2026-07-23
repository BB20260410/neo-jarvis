#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// NOE_M1_ISOLATION_SMOKE.mjs
//   阶段1→阶段2 边界验收（M1）：真实启停实测，而非"端口空闲"文档声明。
//   作用：把 canonical §4.2 / VERIFY C12 里 "M1: 51835 可启动且不影响 51735"
//        从文档门槛升级为一次可复现的 真启动 → 监听证明 → 零影响证明 → 干净停止。
//   设计原则（红线安全）：
//     1. 只 spawn 一个 `node server.js`（PORT=51835）并只 kill 它自己 spawn 的 PID；
//        启动前后都断言被杀 PID ≠ 原项目 PID，绝不误伤 51735。
//     2. 全程不写产品代码 / 不改 UI / 不改 schema / 不碰原项目目录 / 不碰只读镜像。
//     3. 数据落 ~/.noe-panel（与原项目物理隔离），脚本结束服务被停回，端口归还。
//     4. 任一成员跑 `node NOE_M1_ISOLATION_SMOKE.mjs` 可复现同一判定。
//   退出码：0=M1 通过；非 0=失败（并打印失败原因，绝不静默）。
// ────────────────────────────────────────────────────────────────────────────
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOE_PORT = 51835;       // Noe 自身端口（被测）
const ORIG_PORT = 51735;      // 原项目端口（必须零影响）
const REPO = process.cwd();   // 期望 = /Users/hxx/Desktop/Neo 贾维斯

const log = (s) => console.log(s);
const checks = [];
const rec = (ok, name, detail) => { checks.push({ ok, name }); log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         └─ ${detail}` : ''}`); };

// lsof：返回某端口 LISTEN 的 PID（无则 null）
function listenPid(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out ? out.split(/\s+/)[0] : null;
  } catch { return null; }
}
// 某 PID 的命令行（用于证据）
function pidCmd(pid) {
  if (!pid) return '(none)';
  try { return execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim() || '(gone)'; }
  catch { return '(gone)'; }
}

log('═══════════════════════════════════════════════════════════════');
log('  Noe M1 边界验收 · 51835 真实启停 + 对 51735 零影响实测');
log('═══════════════════════════════════════════════════════════════');

// ── 0. 前置：记录原项目基线，确认 51835 当前空闲 ──────────────────────────────
const origPidBefore = listenPid(ORIG_PORT);
const noePidBefore = listenPid(NOE_PORT);
log(`  · 基线：${ORIG_PORT}=${origPidBefore ? `PID ${origPidBefore} [${pidCmd(origPidBefore)}]` : '空闲'} ; ${NOE_PORT}=${noePidBefore ? `PID ${noePidBefore}` : '空闲'}`);
rec(noePidBefore === null, `M1.0 起测前 ${NOE_PORT} 空闲（可供 Noe 启动）`,
  noePidBefore === null ? `${NOE_PORT} 无监听者` : `占用者 PID ${noePidBefore} —— 终止，避免误判`);
if (noePidBefore !== null) { summarize(); process.exit(1); }

// ── 1. 真启动 Noe（node server.js，PORT 默认 51835）─────────────────────────
const logDir = mkdtempSync(join(tmpdir(), 'noe-m1-'));
const logFile = join(logDir, 'noe-server.log');
log(`  · 启动 \`node server.js\`（日志 → ${logFile}）…`);
const child = spawn('node', ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(NOE_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: false,
});
const spawnedPid = child.pid;
// 把子进程 stdout/stderr 同时也吞进文件以便取证（inherit 已打屏，这里再 tail 监听）
let exitedEarly = null;
child.on('exit', (code, sig) => { exitedEarly = { code, sig }; });

// ── 2. 轮询：51835 是否进入 LISTEN（最多 20s）────────────────────────────────
let noePid = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (exitedEarly) break;
  noePid = listenPid(NOE_PORT);
  if (noePid) break;
}
const listening = !!noePid && !exitedEarly;
rec(listening, `M1.1 Noe 在 ${NOE_PORT} 真实进入 LISTEN`,
  listening ? `PID ${noePid} [${pidCmd(noePid)}]（= 本脚本 spawn 的 ${spawnedPid}）`
            : exitedEarly ? `进程提前退出 code=${exitedEarly.code} sig=${exitedEarly.sig}` : `20s 内未监听 ${NOE_PORT}`);

// 安全断言：被测 PID 必须就是我们 spawn 的，且绝不是原项目 PID
const safeOwn = listening && String(noePid) === String(spawnedPid) && String(noePid) !== String(origPidBefore);
rec(safeOwn, `M1.2 监听者身份安全（= 自己 spawn 的 PID，且 ≠ 原项目 PID ${origPidBefore || 'n/a'}）`,
  safeOwn ? `${noePid} === spawn ${spawnedPid} 且 ≠ ${origPidBefore}` : `身份核对失败 → 后续只停自己进程，绝不碰原项目`);

// ── 3. HTTP 活体：GET / 应有响应；受保护端点应 401（守卫在线）─────────────────
let rootCode = '000', healthCode = '000';
if (listening) {
  try { rootCode = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${NOE_PORT}/`, { encoding: 'utf8' }).trim(); } catch {}
  try { healthCode = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${NOE_PORT}/api/metrics/health`, { encoding: 'utf8' }).trim(); } catch {}
}
rec(listening && /^(200|30\d|40\d)$/.test(rootCode), `M1.3 HTTP 活体：GET / 有响应（服务器真在跑）`, `HTTP ${rootCode}`);
rec(listening && healthCode === '401', `M1.4 owner-token 守卫在线：受保护端点 /api/metrics/health = 401`, `HTTP ${healthCode}（401=守卫生效，非裸奔）`);

// ── 4. 零影响实测：原项目 51735 PID 在 Noe 运行期间不变 ───────────────────────
const origPidDuring = listenPid(ORIG_PORT);
const zeroImpactDuring = String(origPidDuring) === String(origPidBefore);
rec(zeroImpactDuring, `M1.5 零影响（运行期）：${ORIG_PORT} PID 不变`,
  `before=${origPidBefore || '空闲'} during=${origPidDuring || '空闲'} → ${zeroImpactDuring ? '原项目未受扰动' : '⚠ 原项目 PID 变化'}`);

// ── 5. 干净停止：只 kill 自己 spawn 的 PID，归还端口 ─────────────────────────
if (listening && safeOwn) {
  log(`  · 停止 Noe（仅 kill 自己 spawn 的 PID ${spawnedPid}，绝不碰 ${origPidBefore || 'n/a'}）…`);
  try { process.kill(spawnedPid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20; i++) { await sleep(300); if (!listenPid(NOE_PORT)) break; }
  if (listenPid(NOE_PORT)) { try { process.kill(spawnedPid, 'SIGKILL'); } catch {} await sleep(800); }
} else if (spawnedPid && String(spawnedPid) !== String(origPidBefore)) {
  // 即便没进入 LISTEN，也要回收我们 spawn 的进程，避免遗留
  try { process.kill(spawnedPid, 'SIGKILL'); } catch {}
}
const noePidAfter = listenPid(NOE_PORT);
rec(noePidAfter === null, `M1.6 干净停止：${NOE_PORT} 已归还（端口回到空闲）`,
  noePidAfter === null ? `${NOE_PORT} 无监听者` : `仍被 PID ${noePidAfter} 占用`);

// ── 6. 零影响实测：停止后原项目仍在、PID 不变 ────────────────────────────────
const origPidAfter = listenPid(ORIG_PORT);
const zeroImpactAfter = String(origPidAfter) === String(origPidBefore);
rec(zeroImpactAfter, `M1.7 零影响（停止后）：${ORIG_PORT} PID 仍 = 基线`,
  `before=${origPidBefore || '空闲'} after=${origPidAfter || '空闲'} → ${zeroImpactAfter ? '原项目全程未被影响' : '⚠ 原项目状态改变'}`);

function summarize() {
  const pass = checks.filter(c => c.ok).length;
  log('───────────────────────────────────────────────────────────────');
  log(`  结果: ${pass}/${checks.length} 通过  →  ${pass === checks.length ? '✅ M1 边界验收达标（51835 真可启停 · 51735 零影响）' : '❌ M1 未达标'}`);
  log('═══════════════════════════════════════════════════════════════');
}
summarize();
process.exit(checks.every(c => c.ok) ? 0 : 1);
