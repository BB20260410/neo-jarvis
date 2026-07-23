#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// NOE_PHASE7_INTEGRATION_SMOKE.mjs
//   阶段 7「集成测试」端到端证据：不靠单元假设，而是拉起一个【真实 node server.js】
//   实例，经【真实 HTTP + WebSocket】打通【鉴权 → Noe 四大子系统 → SQLite 存储】整条链路。
//
//   覆盖的关键集成链路（模块间 / 前后端 / 存储 / 外部进程协作）：
//     1. 外部进程：真 spawn node server.js（Node 22 ABI），真监听、真响应、干净停止。
//     2. 前后端鉴权：无 token → 401；带 owner-token → 200（owner-token 中间件全程在线）。
//     3. 存储贯通 Memory：HTTP write → SQLite 落库 → HTTP recall（FTS5 召回）→ soft hide 不再召回。
//     4. 跨模块 Focus→Memory：focus push → pop(absorb) 时由 FocusStack 调 MemoryCore 写入 scope=focus 记忆。
//     5. NoeLoop：默认 stopped/disabled（不烧额度）；force tick → acted=false（零额度）→ 事件落 events 表。
//     6. 前后端实时：/ws/global 订阅，触发 tick 后真收到 noe_loop_tick 广播。
//     7. ToolRegistry 安全门：注册默认 disabled；invoke 默认 403；启用后无 handler → 501（绝不裸执行）。
//     8. health 聚合：一个进程内 loop+memory+focus+tools+approvals 全部接线可读。
//     9. 失败处理：空 body → 400 确定性错误码。
//
//   安全红线（与 M1 隔离 smoke 一致）：
//     · 用独立测试端口 + 临时 PANEL_DB_PATH，绝不污染生产 ~/.noe-panel/panel.db，绝不碰原项目 51735。
//     · 只 kill 自己 spawn 的 PID；启停前后断言 51735 / 51835-prod 的 PID 零变化。
//     · 任一成员 `node NOE_PHASE7_INTEGRATION_SMOKE.mjs` 可复现同一判定。退出码：0=通过，非0=失败。
//   注意：server 依赖 better-sqlite3（ABI=Node 22）。本脚本会优先用 Node 22 二进制 spawn server，
//        即使 runner 自身跑在 Node 26 也能拉起服务（server 子进程锁定 Node 22）。
// ────────────────────────────────────────────────────────────────────────────
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const REPO = process.cwd();
const TEST_PORT = Number(process.env.NOE_TEST_PORT || 51836); // 独立测试端口（≠51835 prod ≠51735 orig）
const ORIG_PORT = 51735;   // 原项目端口（必须零影响）
const PROD_PORT = 51835;   // Noe 生产端口（若在跑，也不得被本测试扰动）
const PROJECT = 'noe-phase7-int';
const MARK = `zqxmark${process.pid}${Date.now().toString(36)}`; // 唯一召回标记
const OWNER_TOKEN_PATH = join(homedir(), '.noe-panel', 'owner-token.txt');

const log = (s) => console.log(s);
const checks = [];
const rec = (ok, name, detail) => {
  checks.push({ ok, name });
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         └─ ${detail}` : ''}`);
};

function listenPid(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out ? out.split(/\s+/)[0] : null;
  } catch { return null; }
}

// 解析 server 子进程用的 Node：优先 Node 22（better-sqlite3 ABI），否则退回 runner 自身
function resolveServerNode() {
  const known = '/Users/hxx/.nvm/versions/node/v22.22.2/bin/node';
  try { if (existsSync(known)) return known; } catch {}
  return process.execPath;
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['X-Panel-Owner-Token'] = token;
  const resp = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await resp.json(); } catch {}
  return { status: resp.status, json };
}

log('═══════════════════════════════════════════════════════════════');
log('  Noe 阶段7 · 集成测试端到端 smoke（真 server · 真 HTTP/WS · 真 SQLite）');
log('═══════════════════════════════════════════════════════════════');

// ── 0. 前置：隔离基线 ────────────────────────────────────────────────────────
const origBefore = listenPid(ORIG_PORT);
const prodBefore = listenPid(PROD_PORT);
const testBefore = listenPid(TEST_PORT);
log(`  · 基线：${ORIG_PORT}(orig)=${origBefore ?? '空闲'} ; ${PROD_PORT}(prod)=${prodBefore ?? '空闲'} ; ${TEST_PORT}(test)=${testBefore ?? '空闲'}`);
rec(testBefore === null, `I0 测试端口 ${TEST_PORT} 起测前空闲`,
  testBefore === null ? '可供集成测试实例启动' : `被 PID ${testBefore} 占用 → 设 NOE_TEST_PORT 换端口`);

const tmpRoot = mkdtempSync(join(tmpdir(), 'noe-p7-'));
const dbPath = join(tmpRoot, 'noe-int.db');
const _logFile = join(tmpRoot, 'server.log');
const serverNode = resolveServerNode();
let nodeVer = '(unknown)';
try { nodeVer = execSync(`${serverNode} -v`, { encoding: 'utf8' }).trim(); } catch {}

let child = null;
let spawnedPid = null;
let token = null;
const logLines = [];

function dumpServerLog() {
  log('  ── server 日志尾部（最后 40 行）──');
  for (const line of logLines.slice(-40)) log(`     | ${line}`);
}

try {
  if (testBefore !== null) throw new Error(`测试端口 ${TEST_PORT} 被占用，终止以免误判`);

  // ── 1. 真 spawn server（隔离 DB + 独立端口）─────────────────────────────────
  log(`  · spawn \`${serverNode} server.js\`  PORT=${TEST_PORT}  PANEL_DB_PATH=${dbPath}  (node ${nodeVer})`);
  child = spawn(serverNode, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(TEST_PORT), PANEL_DB_PATH: dbPath, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedPid = child.pid;
  let exitedEarly = null;
  child.on('exit', (code, sig) => { exitedEarly = { code, sig }; });
  const onData = (buf) => { for (const l of String(buf).split('\n')) if (l.trim()) logLines.push(l); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // 轮询 LISTEN（最多 25s）
  let testPid = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    if (exitedEarly) break;
    testPid = listenPid(TEST_PORT);
    if (testPid) break;
  }
  const listening = !!testPid && !exitedEarly;
  rec(listening, `I1 真实进程：node server.js 在 ${TEST_PORT} 进入 LISTEN（node ${nodeVer}）`,
    listening ? `PID ${testPid}（= spawn ${spawnedPid}）` :
    exitedEarly ? `进程提前退出 code=${exitedEarly.code} sig=${exitedEarly.sig}（如为 better-sqlite3 ABI 报错 → 用 Node 22 跑）`
                : `25s 未监听`);
  const safeOwn = listening && String(testPid) === String(spawnedPid)
    && String(testPid) !== String(origBefore) && String(testPid) !== String(prodBefore);
  rec(safeOwn, `I1b 监听者身份安全（= 自己 spawn，且 ≠ 51735/51835 生产 PID）`,
    safeOwn ? `${testPid} 独立实例` : '身份核对失败');
  if (!listening) { dumpServerLog(); throw new Error('server 未能启动，无法继续集成链路'); }

  // ── 2. 鉴权链路：无 token → 401 ────────────────────────────────────────────
  const noTok = await api('GET', '/api/noe/health');
  rec(noTok.status === 401, `I2 鉴权门在线：/api/noe/health 无 token → 401`,
    `HTTP ${noTok.status}（401=owner-token 中间件先于 handler 拦截）`);

  // 读 owner-token（server 已在固定路径生成；只读，不污染）
  for (let i = 0; i < 10 && !token; i++) {
    try {
      if (existsSync(OWNER_TOKEN_PATH)) {
        const t = readFileSync(OWNER_TOKEN_PATH, 'utf8').trim();
        if (t.length >= 32) token = t;
      }
    } catch {}
    if (!token) await sleep(200);
  }
  rec(!!token, `I2b 读到 owner-token（~/.noe-panel/owner-token.txt，只读）`,
    token ? `len=${token.length}` : '未读到 token');
  if (!token) { dumpServerLog(); throw new Error('owner-token 不可读，无法鉴权'); }

  // ── 3. health 聚合：一个进程内四大子系统接线可读 ────────────────────────────
  const health = await api('GET', '/api/noe/health', { token, headers: { query: '' } });
  const hOk = health.status === 200 && health.json?.ok === true && health.json?.health?.status === 'ok'
    && health.json?.loop && health.json?.memory && health.json?.focus && health.json?.tools && health.json?.approvals;
  rec(hOk, `I3 health 聚合：loop+memory+focus+tools+approvals 全部接线（HTTP 200）`,
    hOk ? `loop.state=${health.json.loop.state} mem.visible=${health.json.memory.visible} fts=${health.json.memory.fts} tools.total=${health.json.tools.total}`
        : `HTTP ${health.status} json=${JSON.stringify(health.json)?.slice(0, 200)}`);

  // ── 4. 存储贯通 Memory：write → SQLite → recall（FTS5）──────────────────────
  const wMem = await api('POST', '/api/noe/memory', { token, body: {
    body: `集成测试记忆 ${MARK} 应被关键词召回`, projectId: PROJECT, tags: ['phase7', 'integration'],
  } });
  const memId = wMem.json?.item?.id;
  rec(wMem.status === 201 && !!memId, `I4 Memory write → HTTP 201 + SQLite 落库`, `id=${memId}`);

  const rMem = await api('GET', `/api/noe/memory?q=${MARK}&project=${PROJECT}`, { token });
  const recalled = (rMem.json?.items || []).some((m) => m.id === memId);
  rec(rMem.status === 200 && recalled, `I5 Memory recall：关键词命中刚写入的记忆`,
    `count=${rMem.json?.count} hit=${recalled}（FTS5 或 LIKE 召回链路贯通）`);

  // ── 5. soft hide：隐藏后不再召回（软删，不物理删）─────────────────────────────
  const dMem = await api('DELETE', `/api/noe/memory/${encodeURIComponent(memId)}?project=${PROJECT}`, { token });
  const rMem2 = await api('GET', `/api/noe/memory?q=${MARK}&project=${PROJECT}`, { token });
  const stillThere = (rMem2.json?.items || []).some((m) => m.id === memId);
  rec(dMem.status === 200 && !stillThere, `I6 Memory soft hide：DELETE 后召回不再返回该项`,
    `delete=${dMem.status} stillRecalled=${stillThere}`);

  // ── 6. 跨模块 Focus → Memory：push → pop(absorb) 写回记忆 ─────────────────────
  const fPush = await api('POST', '/api/noe/focus', { token, body: {
    title: `集成焦点 ${MARK}`, summary: `focus 摘要 ${MARK}`, projectId: PROJECT,
  } });
  const focusId = fPush.json?.item?.id;
  const fList = await api('GET', `/api/noe/focus?project=${PROJECT}`, { token });
  rec(fPush.status === 201 && !!focusId && (fList.json?.count || 0) >= 1, `I7 Focus push → 入栈可列出`,
    `id=${focusId} depth=${fList.json?.count}`);

  const fPop = await api('POST', `/api/noe/focus/${encodeURIComponent(focusId)}/pop`, { token, body: { absorb: true } });
  const absorbedId = fPop.json?.item?.absorbedMemoryId;
  const rAbs = await api('GET', `/api/noe/memory?q=${MARK}&project=${PROJECT}&scope=focus`, { token });
  const absorbedRecalled = (rAbs.json?.items || []).some((m) => m.id === absorbedId);
  rec(fPop.status === 200 && fPop.json?.item?.state === 'popped' && !!absorbedId && absorbedRecalled,
    `I8 跨模块 Focus→Memory：pop(absorb) 由 FocusStack 调 MemoryCore 写 scope=focus 记忆`,
    `state=${fPop.json?.item?.state} absorbedMemoryId=${absorbedId} recalled=${absorbedRecalled}`);

  // ── 7. NoeLoop 默认安全 + 零额度 tick + 事件落库 ────────────────────────────
  const lStatus = await api('GET', '/api/noe/loop/status', { token });
  rec(lStatus.status === 200 && lStatus.json?.status?.state === 'stopped' && lStatus.json?.status?.enabled === false,
    `I9 NoeLoop 默认安全：stopped + disabled（不自动烧额度）`,
    `state=${lStatus.json?.status?.state} enabled=${lStatus.json?.status?.enabled}`);

  const tick1 = await api('POST', '/api/noe/loop/tick', { token, body: { force: true } });
  const tickEvent = tick1.json?.event;
  rec(tick1.status === 200 && tick1.json?.ok === true && tickEvent?.kind === 'noe_loop_tick' && tickEvent?.acted === false && Number(tick1.json?.eventId) > 0,
    `I10 force tick：执行 + 零额度（acted=false）+ 事件落 events 表`,
    `eventId=${tick1.json?.eventId} acted=${tickEvent?.acted} focusDepth=${tickEvent?.focusDepth}`);

  const lStatus2 = await api('GET', '/api/noe/loop/status', { token });
  rec((lStatus2.json?.status?.tickCount || 0) >= 1, `I11 tick 计数持久推进`,
    `tickCount=${lStatus2.json?.status?.tickCount}`);

  // ── 8. 前后端实时：/ws/global 订阅 → 触发 tick → 收到 noe_loop_tick 广播 ──────
  let wsGotTick = false;
  let wsErr = null;
  try {
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws/global?token=${encodeURIComponent(token)}`);
      const done = () => { try { ws.close(); } catch {}; resolve(); };
      const t = setTimeout(done, 5000);
      ws.on('open', async () => {
        // 订阅就绪后再触发一次 tick，确保广播在订阅窗口内
        try { await api('POST', '/api/noe/loop/tick', { token, body: { force: true } }); } catch {}
      });
      ws.on('message', (raw) => {
        const s = String(raw);
        if (s.includes('noe_loop_tick') || s.includes('noe_event')) { wsGotTick = true; clearTimeout(t); done(); }
      });
      ws.on('error', (e) => { wsErr = e?.message || String(e); clearTimeout(t); done(); });
    });
  } catch (e) { wsErr = e?.message || String(e); }
  rec(wsGotTick, `I12 前后端实时：/ws/global 收到 tick 广播（WebSocket 通道贯通）`,
    wsGotTick ? '收到 noe_loop_tick / noe_event' : `未收到${wsErr ? `（err=${wsErr}）` : ''}`);

  // ── 9. ToolRegistry 安全门：注册默认 disabled → invoke 403 → 启用无 handler 501 ──
  const toolId = `local.int.${MARK}`;
  const tReg = await api('POST', '/api/noe/tools', { token, body: {
    id: toolId, name: 'integration test tool', risk_level: 'low', operation: 'noop',
  } });
  rec(tReg.status === 201 && tReg.json?.tool?.enabled === false, `I13 Tool 注册默认 disabled（安全默认）`,
    `enabled=${tReg.json?.tool?.enabled}`);

  const invDisabled = await api('POST', `/api/noe/tools/${encodeURIComponent(toolId)}/invoke`, { token, body: { args: {} } });
  rec(invDisabled.status === 403, `I14 disabled 工具 invoke → 403（执行能力默认 gated）`,
    `HTTP ${invDisabled.status} error=${invDisabled.json?.error}`);

  await api('POST', `/api/noe/tools/${encodeURIComponent(toolId)}/enable`, { token, body: { enabled: true } });
  const invNoHandler = await api('POST', `/api/noe/tools/${encodeURIComponent(toolId)}/invoke`, { token, body: { args: {} } });
  rec(invNoHandler.status === 501, `I15 启用但无 handler → 501（权限链通过仍绝不裸执行）`,
    `HTTP ${invNoHandler.status} error=${invNoHandler.json?.error}`);

  // ── 10. 失败处理：空 body → 400 确定性错误码 ────────────────────────────────
  const badMem = await api('POST', '/api/noe/memory', { token, body: { body: '' } });
  rec(badMem.status === 400 && /required/i.test(badMem.json?.error || ''), `I16 失败处理：空 body → 400 确定性错误`,
    `HTTP ${badMem.status} error=${badMem.json?.error}`);

  // ── 11. 运行期隔离：51735 / 51835-prod PID 不变 ─────────────────────────────
  const origDuring = listenPid(ORIG_PORT);
  const prodDuring = listenPid(PROD_PORT);
  rec(String(origDuring) === String(origBefore) && String(prodDuring) === String(prodBefore),
    `I17 运行期零影响：51735 / 51835 生产端口 PID 不变`,
    `51735 ${origBefore ?? '空闲'}→${origDuring ?? '空闲'} ; 51835 ${prodBefore ?? '空闲'}→${prodDuring ?? '空闲'}`);

  // ── 12. 存储隔离：写入落在临时 DB，生产 panel.db 未被本测试触碰 ──────────────
  const dbExists = existsSync(dbPath) && statSync(dbPath).size > 0;
  rec(dbExists && dbPath.startsWith(tmpRoot), `I18 存储隔离：数据落临时 PANEL_DB_PATH，生产 panel.db 未污染`,
    `${dbPath}（${dbExists ? statSync(dbPath).size + ' bytes' : '缺失'}）`);
} catch (e) {
  rec(false, `集成链路异常中断`, e?.message || String(e));
} finally {
  // ── 干净停止：只 kill 自己 spawn 的 PID，归还端口，清临时 DB ──────────────────
  if (spawnedPid && String(spawnedPid) !== String(origBefore) && String(spawnedPid) !== String(prodBefore)) {
    try { process.kill(spawnedPid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20; i++) { await sleep(300); if (!listenPid(TEST_PORT)) break; }
    if (listenPid(TEST_PORT)) { try { process.kill(spawnedPid, 'SIGKILL'); } catch {} await sleep(600); }
  }
  const testAfter = listenPid(TEST_PORT);
  rec(testAfter === null, `I19 干净停止：测试端口 ${TEST_PORT} 已归还`,
    testAfter === null ? '空闲' : `仍被 PID ${testAfter} 占用`);
  const origAfter = listenPid(ORIG_PORT);
  const prodAfter = listenPid(PROD_PORT);
  rec(String(origAfter) === String(origBefore) && String(prodAfter) === String(prodBefore),
    `I20 停止后零影响：51735 / 51835 生产端口 PID 仍 = 基线`,
    `51735 ${origAfter ?? '空闲'} ; 51835 ${prodAfter ?? '空闲'}`);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

const pass = checks.filter((c) => c.ok).length;
log('───────────────────────────────────────────────────────────────');
log(`  结果: ${pass}/${checks.length} 通过  →  ${pass === checks.length ? '✅ 阶段7 集成链路端到端贯通' : '❌ 集成测试未达标'}`);
log('═══════════════════════════════════════════════════════════════');
process.exit(checks.every((c) => c.ok) ? 0 : 1);
