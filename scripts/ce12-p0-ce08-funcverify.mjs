#!/usr/bin/env node
// CE12 P0 — CE08「功能验证」用户主路径 live 走查
// ---------------------------------------------------------------------------
// 与 CE07 集成测试（随机隔离端口）的区别：本脚本站在【用户真实场景】，把 Noe
// 起在【真实配置端口 51835】，驱动用户实际会点的整条主路径，并全程守护正在运行的
// 原项目（51735）不被触碰。隔离 HOME/PANEL_DB_PATH 只为不污染用户真实 Noe 状态，
// 端口仍是真 51835，证明「Noe 能在 51835 起且不影响原项目 51735」这一用户承诺。
//
// 主路径断言（站在用户视角）：
//   U1 原项目 51735 在启动前存活（基线）
//   U2 Noe 绑定真实 51835 并就绪 + 自动生成 owner-token（首次启动体验）
//   U3 缺 token 访问 /api/noe/health → 401（本机其他进程拿不到用户数据）
//   U4 GET /（Brain UI 页面）→ 200 且含 7 个 P0 执行可视化 DOM 锚点（用户能看见）
//   U5 带 token GET /api/noe/health → 200 ok=true（loop/memory/focus/tools/approvals 可见）
//   U6 低风险 act propose → 201 completed（dry-run，无真实执行）
//   U7 高风险 act propose → 202 awaiting_approval（默认审批，给出 approvalId + 失败/原因可读）
//   U8 危险 act propose（file.delete）→ 403 blocked_safety（绝不真实删除/外发）
//   U9 GET /api/noe/acts → act queue 渲染出上述 3 条（Brain UI 队列数据面）
//   U10 GET /api/noe/approvals → U7 的待审批可见
//   U11 关停 Noe 后 51835 释放
//   U12 原项目 51735 在全程后仍存活（零触碰）
//
// 退出码：0 = 全部主路径通过；非 0 = 有断言失败。
'use strict';

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const NOE_PORT = Number(process.env.CE08_PORT || 51835);
const ORIG_PORT = 51735; // 原项目端口（边界守护，只读探测）
const ORIG_PROJECT_DIR = '/Users/hxx/Desktop/00_项目/05_Claude可视化面板';
const TS = process.env.CE08_TS || String(Date.now());
const OUT_DIR = join(ROOT, 'output', 'ce12-p0', 'ce08');
const REPORT_FILE = join(OUT_DIR, `funcverify-report-${TS}.json`);
const PAGE_FILE = join(OUT_DIR, `brain-ui-page-${TS}.html`);

const P0_ANCHORS = [
  'noeActQueue', 'noeCurrentAct', 'noeApprovalStatus', 'noeToolPermissionStatus',
  'noeFailureReason', 'noeBudgetStatus', 'noeEvidenceLogLink',
];

const results = [];
function track(name, pass, detail = {}) {
  results.push({ name, pass: !!pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${name}${Object.keys(detail).length ? '  ↳ ' + JSON.stringify(detail) : ''}`);
}

function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
  });
}

async function waitPort(port, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portListening(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitFile(p, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function api(token, method, path, body) {
  const headers = token ? { 'X-Panel-Owner-Token': token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${NOE_PORT}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; let text = '';
  text = await res.text();
  try { json = JSON.parse(text); } catch { /* page or non-json */ }
  return { status: res.status, json, text };
}

function origPortPid() {
  try {
    return execSync(`lsof -nP -iTCP:${ORIG_PORT} -sTCP:LISTEN -t 2>/dev/null || true`, { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function origDirMtime() {
  try { return statSync(ORIG_PROJECT_DIR).mtimeMs; } catch { return null; }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n=== CE12 P0 · CE08 功能验证 · 用户主路径 live 走查 (runner ${process.version}) ===\n`);

  // U1 基线：原项目 51735 必须在跑（这是用户当前真实状态）
  const origPidBefore = origPortPid();
  const origMtimeBefore = origDirMtime();
  track('U1 原项目 51735 启动前存活（基线）', !!origPidBefore, { pid: origPidBefore || '(无)' });

  // 51835 必须空闲（不抢用户已开的 Noe）
  const noeBusy = await portListening(NOE_PORT);
  if (noeBusy) {
    track(`U2 端口 ${NOE_PORT} 预检`, false, { error: `${NOE_PORT} 已被占用，跳过以免抢占用户进程` });
    finish();
    return;
  }

  // 隔离 HOME/DB —— 端口仍是真 51835
  const isolatedHome = join(tmpdir(), `noe-ce08-funcverify-${TS}`);
  const panelDir = join(isolatedHome, '.noe-panel');
  const dbPath = join(panelDir, 'panel.db');
  const ownerTokenPath = join(panelDir, 'owner-token.txt');
  mkdirSync(panelDir, { recursive: true, mode: 0o700 });

  let server = null;
  const serverLogFile = join(OUT_DIR, `noe-server-${TS}.log`);
  let serverLog = '';

  try {
    // 经 ensure-node22 re-exec 到 Node22，绕开 better-sqlite3 ABI147 崩溃（loop 卡死根因）。
    // detached:true 让 wrapper 成为进程组组长，关停时 kill(-pid) 连孙进程(真正绑端口的 Node22)一起带走。
    server = spawn(process.execPath, ['scripts/ensure-node22.mjs', '--require-22', '--exec', 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: isolatedHome, PANEL_DB_PATH: dbPath, PORT: String(NOE_PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    const ready = await waitPort(NOE_PORT, 30000);
    const tokenReady = await waitFile(ownerTokenPath, 30000);
    track(`U2 Noe 绑定真实 ${NOE_PORT} 就绪 + owner-token 自动生成`, ready && tokenReady, {
      port: NOE_PORT, listening: ready, ownerToken: tokenReady, home: isolatedHome,
    });
    if (!ready || !tokenReady) throw new Error('Noe server 未就绪');
    const token = readFileSync(ownerTokenPath, 'utf8').trim();

    // U3 缺 token → 401
    const unauth = await api(null, 'GET', '/api/noe/health');
    track('U3 缺 owner-token 访问被拒 401', unauth.status === 401, { status: unauth.status });

    // U4 Brain UI 页面 + 7 锚点
    const page = await api(null, 'GET', '/');
    writeFileSync(PAGE_FILE, page.text);
    const missing = P0_ANCHORS.filter((a) => !page.text.includes(`"${a}"`) && !page.text.includes(`'${a}'`) && !page.text.includes(a));
    track('U4 Brain UI 页面 200 且含 7 个 P0 执行可视化锚点', page.status === 200 && missing.length === 0, {
      status: page.status, anchorsFound: P0_ANCHORS.length - missing.length, missing,
    });

    // U5 带 token health
    const health = await api(token, 'GET', '/api/noe/health?project=noe');
    track('U5 带 token /api/noe/health 200 ok=true', health.status === 200 && health.json?.ok === true, {
      status: health.status, loop: !!health.json?.loop, tools: Array.isArray(health.json?.tools) || typeof health.json?.tools === 'object',
    });

    // U6 低风险 → completed (dry-run)
    const low = await api(token, 'POST', '/api/noe/acts/propose', {
      projectId: 'noe', action: 'noe.focus.review', title: 'CE08 低风险只读复盘', riskLevel: 'low',
    });
    const lowAct = low.json?.act;
    track('U6 低风险 act → 201 completed (dryRunOnly)', low.status === 201 && lowAct?.status === 'completed', {
      status: low.status, actStatus: lowAct?.status, dryRunOnly: lowAct?.payload?.dryRunOnly ?? low.json?.dryRunOnly,
    });

    // U7 高风险 → awaiting_approval (默认审批)
    const high = await api(token, 'POST', '/api/noe/acts/propose', {
      projectId: 'noe', action: 'data.upload.external', title: 'CE08 高风险外发（应进审批）', riskLevel: 'high',
    });
    const highAct = high.json?.act;
    track('U7 高风险 act → 202 awaiting_approval + approvalId', high.status === 202 && highAct?.status === 'awaiting_approval' && !!highAct?.approvalId, {
      status: high.status, actStatus: highAct?.status, approvalId: highAct?.approvalId || null, failureReason: highAct?.failureReason || null,
    });

    // U8 危险 → blocked_safety（绝不真实删除）
    const danger = await api(token, 'POST', '/api/noe/acts/propose', {
      projectId: 'noe', action: 'file.delete', title: 'CE08 危险删除（应被安全拦截）',
    });
    const dangerAct = danger.json?.act;
    track('U8 危险 act file.delete → 403 blocked_safety', danger.status === 403 && dangerAct?.status === 'blocked_safety', {
      status: danger.status, actStatus: dangerAct?.status, permissionState: dangerAct?.permissionState,
    });

    // U9 act queue 渲染数据面
    const acts = await api(token, 'GET', '/api/noe/acts?project=noe&limit=20');
    const statuses = (acts.json?.items || []).map((a) => a.status);
    const hasAll = ['completed', 'awaiting_approval', 'blocked_safety'].every((s) => statuses.includes(s));
    track('U9 GET /api/noe/acts queue 含 completed/awaiting_approval/blocked_safety 三态', acts.status === 200 && hasAll, {
      status: acts.status, count: acts.json?.count, statuses, summary: acts.json?.summary || null,
    });

    // U10 待审批可见
    const approvals = await api(token, 'GET', '/api/noe/approvals?status=pending&limit=20');
    const apprCount = (approvals.json?.items || approvals.json?.approvals || []).length;
    track('U10 GET /api/noe/approvals 待审批可见', approvals.status === 200 && apprCount >= 1, {
      status: approvals.status, pending: apprCount,
    });

    // 关键安全不变量：act 全程无真实 dry_run 之外的执行（dryRunOnly 恒为 true）
    const noReal = (acts.json?.items || []).every((a) => a.status !== 'executed_real');
    track('SAFE 无任何真实外发/删除/批量移动（仅 dry-run/审批/拦截）', noReal, { realExecActs: (acts.json?.items || []).filter((a) => a.status === 'executed_real').length });

  } finally {
    writeFileSync(serverLogFile, serverLog);
    if (server && server.pid) {
      // 先按进程组优雅终止（带走 ensure-node22 re-exec 出的 Node22 孙进程）
      try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* */ } }
      await new Promise((r) => setTimeout(r, 1500));
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // 兜底：精准清理仍占用【本测试端口 51835】的监听进程（绝不触碰 51735）
    try {
      const lingering = execSync(`lsof -ti:${NOE_PORT} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (lingering) {
        for (const pid of lingering.split(/\s+/).filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { /* */ }
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch { /* */ }
  }

  // U11 51835 释放（给 OS 回收 socket 一点时间后直接探测）
  await new Promise((r) => setTimeout(r, 1000));
  const stillListening = await portListening(NOE_PORT);
  track(`U11 关停后 ${NOE_PORT} 端口释放`, !stillListening, { stillListening });

  // U12 原项目 51735 仍存活 + 目录零写
  const origPidAfter = origPortPid();
  const origMtimeAfter = origDirMtime();
  track('U12 原项目 51735 全程后仍存活（同一 PID，零触碰）', !!origPidAfter && origPidAfter === origPidBefore, {
    before: origPidBefore || '(无)', after: origPidAfter || '(无)',
  });
  track('U12b 原项目目录 mtime 未变（CE08 零写原项目）', origMtimeBefore === origMtimeAfter, {
    before: origMtimeBefore, after: origMtimeAfter,
  });

  // 清理隔离 HOME
  try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* ignore */ }

  finish();
}

function finish() {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const allPass = passed === total && total > 0;
  const report = {
    stage: 'CE08 功能验证 · 用户主路径 live 走查',
    generatedAt: new Date(Number(TS)).toISOString(),
    noePort: NOE_PORT, origPort: ORIG_PORT,
    passed, total, allPass,
    pageArtifact: PAGE_FILE,
    results,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n  汇总: ${passed}/${total} 主路径断言通过`);
  console.log(`  页面证据: ${PAGE_FILE}`);
  console.log(`  报告: ${REPORT_FILE}`);
  console.log(`  结果: ${allPass ? 'ALL PASS ✅' : 'HAS FAIL ❌'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  track('walkthrough 异常', false, { error: String(e?.message || e) });
  finish();
});
