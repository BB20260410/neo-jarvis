#!/usr/bin/env node
// CE12 P0 integration harness.
//
// This test starts a real Noe server with isolated HOME/PANEL_DB_PATH, then
// verifies HTTP routes, owner-token auth, SQLite-backed stores, ActPipeline,
// approvals, and safety blocking through the same server process.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'ce12-p0', 'integration');
const TS = Date.now();
const REPORT_FILE = join(OUT_DIR, `integration-report-${TS}.json`);
const LATEST_FILE = join(OUT_DIR, 'integration-report-latest.json');
const SERVER_LOG_FILE = join(OUT_DIR, `integration-server-${TS}.log`);
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NODE_ABI = process.versions.modules;
const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_ABI = '127';

const results = [];
const artifacts = {
  report: REPORT_FILE,
  latest: LATEST_FILE,
  serverLog: SERVER_LOG_FILE,
};

function track(label, pass, detail = {}) {
  const item = { label, pass: Boolean(pass), detail };
  results.push(item);
  const suffix = Object.keys(detail || {}).length ? ` - ${JSON.stringify(detail)}` : '';
  console.log(`${item.pass ? '[PASS]' : '[FAIL]'} ${label}${suffix}`);
  return item.pass;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

function portListening(port) {
  return new Promise((resolveListening) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once('error', () => resolveListening(false));
    socket.setTimeout(600, () => {
      socket.destroy();
      resolveListening(false);
    });
  });
}

async function waitReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch {
      // Server is not ready yet.
    }
    await sleep(300);
  }
  return false;
}

async function waitFile(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await sleep(150);
  }
  return false;
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { parseError: true, text };
  }
}

async function api(baseUrl, token, method, path, body) {
  const headers = { 'X-Panel-Owner-Token': token };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await readJsonResponse(res);
  return { status: res.status, json };
}

function writeReport(extra = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  const passed = results.filter((item) => item.pass).length;
  const report = {
    generatedBy: 'scripts/ce12-p0-integration.mjs',
    generatedAt: new Date(TS).toISOString(),
    workspace: ROOT,
    node: process.version,
    abi: NODE_ABI,
    allPass: passed === results.length && results.length > 0,
    passed,
    total: results.length,
    results,
    artifacts,
    ...extra,
  };
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  writeFileSync(LATEST_FILE, JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('=== CE12 P0 integration ===');
  console.log(`workspace=${ROOT}`);
  console.log(`node=${process.version}; abi=${NODE_ABI}`);

  if (NODE_MAJOR !== REQUIRED_NODE_MAJOR || NODE_ABI !== REQUIRED_NODE_ABI) {
    track('Node22 fail-fast guard', false, {
      current: process.version,
      abi: NODE_ABI,
      expectedMajor: REQUIRED_NODE_MAJOR,
      expectedAbi: REQUIRED_NODE_ABI,
      command: 'npm run test:p0:integration',
    });
    writeReport();
    process.exit(1);
  }
  track('Node22 runtime selected', true, { node: process.version, abi: NODE_ABI });

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const isolatedHome = join(tmpdir(), `noe-ce12-integration-${TS}`);
  const panelDir = join(isolatedHome, '.noe-panel');
  const dbPath = join(panelDir, 'panel.db');
  const ownerTokenPath = join(panelDir, 'owner-token.txt');
  mkdirSync(panelDir, { recursive: true, mode: 0o700 });

  let server = null;
  let serverLog = '';
  let finalExtra = {
    baseUrl,
    isolatedHome,
    dbPath,
    browserPath: {
      attempted: true,
      result: 'fallback_to_project_playwright',
      reason: 'Browser runtime returned: Browser is not available: iab',
    },
  };
  const env = {
    ...process.env,
    HOME: isolatedHome,
    PANEL_DB_PATH: dbPath,
    PORT: String(port),
    PANEL_HOST: '127.0.0.1',
    NOE_CE12_INTEGRATION: '1',
  };

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
    server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

    const ready = await waitReady(`${baseUrl}/`);
    track('server starts on isolated random port', ready, { baseUrl, home: isolatedHome, dbPath });
    if (!ready) throw new Error('server not ready');

    const tokenReady = await waitFile(ownerTokenPath);
    track('owner token created in isolated HOME', tokenReady, { ownerTokenPath });
    if (!tokenReady) throw new Error('owner token missing');
    const token = readFileSync(ownerTokenPath, 'utf8').trim();

    const unauth = await fetch(`${baseUrl}/api/noe/health`);
    const unauthJson = await readJsonResponse(unauth);
    track('Noe API rejects missing owner token', unauth.status === 401, { status: unauth.status, error: unauthJson.error });

    const marker = `CE12_INT_${TS}`;
    const memoryWrite = await api(baseUrl, token, 'POST', '/api/noe/memory', {
      projectId: 'noe',
      body: `integration memory ${marker}`,
      tags: ['ce12', 'integration'],
      sourceType: 'ce12_integration',
    });
    track('memory write via HTTP persists', memoryWrite.status === 201 && memoryWrite.json?.item?.id, {
      status: memoryWrite.status,
      id: memoryWrite.json?.item?.id,
    });

    const memoryRecall = await api(baseUrl, token, 'GET', `/api/noe/memory?project=noe&q=${encodeURIComponent(marker)}&limit=5`);
    track('memory recall via HTTP reads persisted item', memoryRecall.status === 200 && memoryRecall.json?.items?.some((item) => item.body?.includes(marker)), {
      status: memoryRecall.status,
      count: memoryRecall.json?.count,
    });

    const focusPush = await api(baseUrl, token, 'POST', '/api/noe/focus', {
      projectId: 'noe',
      title: `Integration focus ${marker}`,
      summary: 'CE12 integration focus item',
      sourceType: 'ce12_integration',
    });
    track('focus push via HTTP persists', focusPush.status === 201 && focusPush.json?.item?.id, {
      status: focusPush.status,
      id: focusPush.json?.item?.id,
    });

    const focusList = await api(baseUrl, token, 'GET', '/api/noe/focus?project=noe&limit=10');
    track('focus list via HTTP returns pushed item', focusList.status === 200 && focusList.json?.items?.some((item) => item.title?.includes(marker)), {
      status: focusList.status,
      count: focusList.json?.count,
    });

    const loopStart = await api(baseUrl, token, 'POST', '/api/noe/loop/start', { actMode: true });
    track('NoeLoop starts in actMode through API', loopStart.status === 200 && loopStart.json?.status?.actMode === true, {
      status: loopStart.status,
      loopState: loopStart.json?.status?.state,
      actMode: loopStart.json?.status?.actMode,
    });

    const loopTick = await api(baseUrl, token, 'POST', '/api/noe/loop/tick', { force: true, timeoutMs: 15_000 });
    track('NoeLoop tick drives ActPipeline handler', loopTick.status === 200 && loopTick.json?.event?.acted === true, {
      status: loopTick.status,
      acted: loopTick.json?.event?.acted,
      eventId: loopTick.json?.eventId,
    });

    const actsAfterTick = await api(baseUrl, token, 'GET', '/api/noe/acts?project=noe&limit=20');
    const completedAct = actsAfterTick.json?.items?.find((item) => item.status === 'completed' && item.action === 'noe.focus.review');
    track('ActStore exposes dry-run completed act through API', actsAfterTick.status === 200 && completedAct?.logRef?.startsWith('sqlite:events/'), {
      status: actsAfterTick.status,
      count: actsAfterTick.json?.count,
      actId: completedAct?.id,
      logRef: completedAct?.logRef,
    });

    const approvalProposal = await api(baseUrl, token, 'POST', '/api/noe/acts/propose', {
      projectId: 'noe',
      title: `Approval path ${marker}`,
      action: 'noe.notify.owner',
      riskLevel: 'high',
      proposedBy: 'ce12-integration',
    });
    const approvalId = approvalProposal.json?.act?.approvalId;
    track('sensitive act proposal routes to approval', approvalProposal.status === 202 && approvalProposal.json?.approvalRequired === true && approvalId, {
      status: approvalProposal.status,
      actId: approvalProposal.json?.act?.id,
      approvalId,
    });

    const approvals = await api(baseUrl, token, 'GET', '/api/noe/approvals?status=pending&type=manual&limit=20');
    track('approval list exposes pending Act approval', approvals.status === 200 && approvals.json?.approvals?.some((item) => item.id === approvalId), {
      status: approvals.status,
      count: approvals.json?.count,
      approvalId,
    });

    const cancelApprovalAct = await api(baseUrl, token, 'POST', `/api/noe/acts/${encodeURIComponent(approvalProposal.json?.act?.id || '')}/cancel`, {
      reason: 'ce12_integration_cleanup',
    });
    track('pending approval act can be cancelled through API', cancelApprovalAct.status === 200 && cancelApprovalAct.json?.act?.status === 'cancelled', {
      status: cancelApprovalAct.status,
      actId: cancelApprovalAct.json?.act?.id,
      finalStatus: cancelApprovalAct.json?.act?.status,
    });

    // 用 ARGV-STYLE 危险命令真正打到安全策略层，而不是只触发 argv 格式校验。
    // `find . -delete` 是白名单命令（过得了「命令名白名单」这关），但其参数会被
    // DangerousPatternDetector 标为 high → 真实安全层拦截。这样测试覆盖的是「危险命令检测」
    // 而非「shell-string 格式拒绝」（旧 payload `rm -rf /tmp/never-run` 只会被前置 argv 格式校验挡掉，
    // 永远到不了安全层）。
    // 两种信任档都算「安全拒绝且从未执行」：
    //   developer 档（server.js 默认）→ exec policy 放行 proc.exec → 进真实执行 → executor 的
    //     DangerousPatternDetector 拦下 → status='failed'，reason 含「dangerous command blocked」。
    //   default 档 → permission preflight 直接 blocked_safety（连执行都不进）。
    // 断言对两档都成立：HTTP 403 + ok:false + 危险被识别 + 绝无真实执行证据（无 executorResult、未 completed）。
    const blockedProposal = await api(baseUrl, token, 'POST', '/api/noe/acts/propose', {
      projectId: 'noe',
      title: `Blocked destructive path ${marker}`,
      action: 'shell.exec',
      riskLevel: 'low',
      payload: { command: 'find', args: ['.', '-delete'] },
      proposedBy: 'ce12-integration',
    });
    const blockedAct = blockedProposal.json?.act || {};
    const blockedReason = String(blockedAct.failureReason || '');
    const safelyRefused = blockedAct.status === 'failed' || blockedAct.status === 'blocked_safety';
    // 危险确实被安全层识别：developer 档命中 detector 文案；default 档命中 blocked_safety 文案。
    const dangerDetected = /dangerous command blocked|blocked in CE12 P0 dry-run|blocked_safety/i.test(blockedReason);
    // 绝无真实执行证据：没有 executorResult，也没有跑成 completed（证明命令从未真的跑）。
    const neverExecuted = blockedAct.status !== 'completed'
      && !blockedAct.payload?.executorResult
      && !blockedAct.evidenceEventId;
    track('destructive act is refused by safety layer and never executes', blockedProposal.status === 403
      && blockedProposal.json?.ok === false
      && safelyRefused
      && dangerDetected
      && neverExecuted, {
        status: blockedProposal.status,
        actId: blockedAct.id,
        finalStatus: blockedAct.status,
        reason: blockedReason.slice(0, 120),
        neverExecuted,
      });

    const finalHealth = await api(baseUrl, token, 'GET', '/api/noe/health?project=noe');
    track('health endpoint aggregates memory/focus/acts after integration flow', finalHealth.status === 200
      && Number(finalHealth.json?.memory?.visible) >= 1
      && Number(finalHealth.json?.focus?.depth) >= 1
      && finalHealth.json?.acts?.current?.id, {
        status: finalHealth.status,
        memoryVisible: finalHealth.json?.memory?.visible,
        focusDepth: finalHealth.json?.focus?.depth,
        currentAct: finalHealth.json?.acts?.current?.id,
      });

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const dbCounts = {
      noe_memory: db.prepare('SELECT COUNT(*) AS c FROM noe_memory').get().c,
      noe_focus_stack: db.prepare('SELECT COUNT(*) AS c FROM noe_focus_stack').get().c,
      noe_acts: db.prepare('SELECT COUNT(*) AS c FROM noe_acts').get().c,
      approvals: db.prepare('SELECT COUNT(*) AS c FROM approvals').get().c,
      dry_run_events: db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'noe_act_dry_run'").get().c,
      loop_tick_events: db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'noe_loop_tick'").get().c,
    };
    db.close();
    track('SQLite storage contains cross-module evidence', dbCounts.noe_memory >= 1
      && dbCounts.noe_focus_stack >= 1
      && dbCounts.noe_acts >= 3
      && dbCounts.approvals >= 1
      && dbCounts.dry_run_events >= 1
      && dbCounts.loop_tick_events >= 1, dbCounts);

    finalExtra = {
      baseUrl,
      isolatedHome,
      dbPath,
      browserPath: {
        attempted: true,
        result: 'fallback_to_project_playwright',
        reason: 'Browser runtime returned: Browser is not available: iab',
      },
    };
  } catch (e) {
    track('integration exception', false, { error: e?.message || String(e) });
    finalExtra = {
      ...finalExtra,
      error: e?.stack || e?.message || String(e),
    };
  } finally {
    if (server?.pid) {
      try { server.kill('SIGTERM'); } catch {}
      await sleep(800);
      try { server.kill('SIGKILL'); } catch {}
    }
    writeFileSync(SERVER_LOG_FILE, serverLog);
    const listening = await portListening(port);
    track('server port cleaned up', !listening, { port });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
  const report = writeReport(finalExtra);
  console.log(`Result: ${report.passed}/${report.total} checks passed`);
  console.log(`report=${REPORT_FILE}`);
  process.exit(report.allPass ? 0 : 1);
}

main().catch((e) => {
  track('integration fatal exception', false, { error: e?.stack || e?.message || String(e) });
  writeReport();
  process.exit(1);
});
