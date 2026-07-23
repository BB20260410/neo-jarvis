#!/usr/bin/env node
// NOE_PHASE8_FUNCTIONAL_VERIFY.mjs — 阶段 8「功能验证」用户主路径端到端复现
//
// 与阶段 7「集成测试」的区别：阶段 7 用 HTTP 断言模块协作；阶段 8 站在【用户视角】，
// 用真实浏览器（Playwright/Chromium）点 Brain UI 上真实存在的按钮，走完一条
// Jarvis 主路径，断言用户【肉眼可见】的 DOM 输出，并截图留证。
//
// 用户主路径（Jarvis 体验）：
//   打开面板 → 进入 Noe Brain → 看到 health=ok
//   → 写一条记忆 → 关键词召回命中（Memory Core）
//   → 推一个焦点 → 焦点入栈（Focus Stack）
//   → Pop 焦点 → 焦点吸收为记忆（absorb）
//   → 触发一次 loop tick → Thought Stream 出现 manual_tick，且零额度（acted=false）
//   → 工具默认 disabled，不会裸执行
//   全程：原项目 51735 端口 PID 零变化、临时库隔离、不污染生产 ~/.noe-panel
//
// 用法：/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE8_FUNCTIONAL_VERIFY.mjs
// 退出码：全部用户主路径步骤通过=0；任一失败=1。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE22 = '/Users/hxx/.nvm/versions/node/v22.22.2/bin/node';
const ORIG_PORT = 51735;       // 原项目，必须全程不受影响
const NOE_PORT_PREFERRED = 51835; // Noe 指定端口（用户主路径要求“能在 51835 启动”）

const results = [];
function record(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? '  — ' + detail : ''}`);
}
function must(cond, label, detail = '') {
  record(Boolean(cond), label, detail);
  if (!cond) throw new Error(`step failed: ${label}${detail ? ' (' + detail + ')' : ''}`);
}

function portPid(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}
function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
async function waitHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return true; }
    catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function waitFile(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (existsSync(path)) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

let server = null;
let browser = null;
let tmpHome = null;

async function main() {
  console.log('=== NOE 阶段 8 功能验证：用户 Jarvis 主路径端到端复现 ===\n');

  // ---- 基线：原项目端口 PID 必须存在且全程不变 ----
  const origBaseline = portPid(ORIG_PORT);
  console.log(`基线：51735(原项目) PID=${origBaseline || '空'} ; 51835(Noe) 空闲=${await isFree(NOE_PORT_PREFERRED)}`);

  // 选端口：优先 51835（用户主路径明确要求），被占则退到随机空闲口
  let port = NOE_PORT_PREFERRED;
  if (!(await isFree(NOE_PORT_PREFERRED))) port = await findFreePort();
  must(port !== ORIG_PORT, '测试端口与原项目端口隔离', `test=${port} orig=${ORIG_PORT}`);

  // ---- 隔离 HOME，使 server DATA_DIR(~/.noe-panel) 与 owner-token 落临时目录 ----
  tmpHome = mkdtempSync(join(tmpdir(), 'noe-phase8-'));
  const tokenPath = join(tmpHome, '.noe-panel', 'owner-token.txt');
  const env = { ...process.env, HOME: tmpHome, PORT: String(port), PANEL_NO_OPEN: '1', E2E_REAL_HOME: '0' };

  // ---- 真启动 server.js（Node 22 ABI）----
  console.log(`\n启动 Noe server：${NODE22} server.js (PORT=${port}, HOME=${tmpHome})`);
  server = spawn(NODE22, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let _serverLog = '';
  server.stdout.on('data', (d) => { _serverLog += d.toString(); });
  server.stderr.on('data', (d) => { _serverLog += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  must(await waitHttp(base + '/', 30000), 'server 在指定端口就绪（HTTP 可达）', base);
  must(await waitFile(tokenPath, 15000), 'owner-token 落隔离目录（不污染真实 ~/.noe-panel）', tokenPath);
  const token = readFileSync(tokenPath, 'utf8').trim();
  must(token.length >= 16, 'owner-token 已生成', `len=${token.length}`);

  const livePid = portPid(port);
  must(livePid && livePid === String(server.pid), '监听 PID = spawn 的 server 进程', `pid=${livePid}`);

  // ---- 启动真实浏览器 ----
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const consoleErrors = [];
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ========== 用户主路径开始 ==========
  console.log('\n--- 用户旅程（真实点击 Brain UI 按钮）---');

  // [U1] 用户带 owner-token 打开面板
  await page.goto(`${base}/?t=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  must(/Noe/i.test(title), 'U1 打开面板，标题为 Noe', `title=${title}`);

  // [U1b] 首次运行：关闭遥测同意弹窗 + 跳过新手引导（真实首启用户动作）
  let dismissedConsent = false;
  try {
    await page.waitForSelector('.telemetry-consent [data-act="decline"]', { timeout: 5000 });
    await page.click('.telemetry-consent [data-act="decline"]');
    await page.waitForSelector('.telemetry-consent', { state: 'detached', timeout: 5000 });
    dismissedConsent = true;
  } catch { /* 弹窗未出现（非首启）时跳过 */ }
  // 跳过新手引导 tooltip（若存在）
  try { await page.click('.onboarding-tooltip [data-act="skip"]', { timeout: 1500 }); } catch {}
  record(true, 'U1b 处理首启弹窗（遥测同意/新手引导）', `consentDismissed=${dismissedConsent}`);

  // [U2] 用户点击「Noe Brain」进入大脑面板
  await page.waitForSelector('#btnNoeBrain', { timeout: 10000 });
  await page.click('#btnNoeBrain');
  await page.waitForFunction(() => {
    const el = document.querySelector('#noeBrainArea');
    return el && getComputedStyle(el).display !== 'none';
  }, { timeout: 10000 });
  must(true, 'U2 点击 Noe Brain，大脑面板可见（#noeBrainArea 显示）');

  // [U3] health 聚合显示 ok
  await page.waitForFunction(() => {
    const t = document.querySelector('#noeHealthStatus')?.textContent?.trim();
    return t === 'ok';
  }, { timeout: 10000 });
  const loopState0 = (await page.textContent('#noeLoopState'))?.trim();
  must(true, 'U3 health 状态显示 ok', `loopState=${loopState0}`);
  must(['stopped', 'idle', 'unknown'].includes(loopState0), 'U3b loop 默认未自动运行（不烧额度）', `state=${loopState0}`);

  // [U4] 写一条记忆 → 关键词召回命中（Memory Core）
  const marker = `JARVIS_PHASE8_${port}`;
  const memoText = `记住一件事：${marker} 是阶段8功能验证的唯一记忆标记`;
  await page.fill('#noeMemoryBody', memoText);
  await page.click('#btnNoeMemoryWrite');
  // 用关键词召回（证明 recall，而不仅是写入回显）
  await page.fill('#noeMemoryQuery', marker);
  await page.click('#btnNoeMemorySearch');
  await page.waitForFunction((mk) => {
    const list = document.querySelector('#noeMemoryList')?.textContent || '';
    return list.includes(mk);
  }, marker, { timeout: 10000 });
  const memCount = (await page.textContent('#noeMemoryCount'))?.trim();
  must(true, 'U4 写记忆后关键词召回命中（Memory Core FTS）', `marker=${marker}`);
  must(Number(memCount) >= 1, 'U4b 记忆计数 ≥ 1', `count=${memCount}`);

  // [U5] 推一个焦点 → 焦点入栈（Focus Stack）
  const focusTitle = `FOCUS_${marker}`;
  const depthBefore = Number((await page.textContent('#noeFocusDepth'))?.trim()) || 0;
  await page.fill('#noeFocusTitle', focusTitle);
  await page.click('#btnNoeFocusPush');
  await page.waitForFunction((ft) => {
    const list = document.querySelector('#noeFocusList')?.textContent || '';
    return list.includes(ft);
  }, focusTitle, { timeout: 10000 });
  const depthAfterPush = Number((await page.textContent('#noeFocusDepth'))?.trim()) || 0;
  must(depthAfterPush === depthBefore + 1, 'U5 推焦点后焦点深度 +1（Focus Stack）', `${depthBefore}→${depthAfterPush}`);

  // [U6] Pop 焦点 → 吸收为记忆（absorb），焦点深度回落、记忆计数上升
  const memBeforePop = Number((await page.textContent('#noeMemoryCount'))?.trim()) || 0;
  await page.click('#noeFocusList [data-noe-pop-focus]');
  await page.waitForFunction((d) => {
    const cur = Number(document.querySelector('#noeFocusDepth')?.textContent?.trim()) || 0;
    return cur === d;
  }, depthBefore, { timeout: 10000 });
  // pop 触发 refreshBrain，health.memory.visible 应 +1（absorb 写入 scope=focus 记忆）
  await page.waitForFunction((n) => {
    const cur = Number(document.querySelector('#noeMemoryCount')?.textContent?.trim()) || 0;
    return cur >= n + 1;
  }, memBeforePop, { timeout: 10000 });
  const memAfterPop = Number((await page.textContent('#noeMemoryCount'))?.trim()) || 0;
  must(memAfterPop >= memBeforePop + 1, 'U6 Pop 焦点吸收为记忆（记忆计数上升）', `${memBeforePop}→${memAfterPop}`);

  // [U7] 触发 loop tick → Thought Stream 出现 manual_tick，且零额度（acted=false）
  const tickResp = await page.evaluate(async (tk) => {
    const r = await fetch('/api/noe/loop/tick', { method: 'POST', headers: { 'X-Owner-Token': tk, 'Content-Type': 'application/json' }, body: '{"force":true}' });
    return r.json();
  }, token);
  must(tickResp?.ok === true, 'U7 tick 调用成功', `eventId=${tickResp?.eventId}`);
  must(tickResp?.event?.acted === false, 'U7b tick 默认不行动（acted=false，零额度）', `acted=${tickResp?.event?.acted}`);
  // UI 点真实 Tick 按钮，验证 Thought Stream 肉眼可见更新
  await page.click('#btnNoeLoopTick');
  await page.waitForFunction(() => {
    const s = document.querySelector('#noeThoughtStream')?.textContent || '';
    const c = Number(document.querySelector('#noeThoughtCount')?.textContent?.trim()) || 0;
    return c >= 1 && /manual_tick|noe/i.test(s);
  }, { timeout: 10000 });
  const thoughtCount = (await page.textContent('#noeThoughtCount'))?.trim();
  must(true, 'U7c Thought Stream 出现 tick 事件（用户可见）', `thoughtCount=${thoughtCount}`);

  // [U8] 工具默认 disabled / 空 manifest，不会裸执行
  const toolCount = (await page.textContent('#noeToolCount'))?.trim();
  const _toolsListText = (await page.textContent('#noeToolsList'))?.trim();
  must(/^0\//.test(toolCount) || /^0\/0$/.test(toolCount), 'U8 工具默认 0 启用（不会裸执行）', `enabled/total=${toolCount}`);

  // ---- 截图留证 ----
  const shotDir = join(ROOT, 'output', 'playwright');
  mkdirSync(shotDir, { recursive: true });
  const shotPath = join(shotDir, `noe-phase8-functional-${Date.now()}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  must(existsSync(shotPath), 'U9 截图已生成（用户界面证据）', shotPath);

  // ---- 控制台无相关错误 ----
  const relevantErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  record(relevantErrors.length === 0, 'U10 浏览器控制台无相关错误', `errors=${relevantErrors.length}`);

  // ---- 隔离硬证据：原项目 51735 全程不变 ----
  const origDuring = portPid(ORIG_PORT);
  must(origDuring === origBaseline, '隔离：51735 原项目 PID 运行期零变化', `${origBaseline}→${origDuring}`);

  await browser.close(); browser = null;
}

let exitCode = 0;
main().catch((e) => { exitCode = 1; console.error('\n[ERROR]', e?.message || e); }).finally(async () => {
  try { if (browser) await browser.close(); } catch {}
  // 停 server，归还端口
  try { if (server && server.pid) { server.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 800)); if (!server.killed) server.kill('SIGKILL'); } } catch {}
  // 停止后再校验隔离
  const origAfter = portPid(ORIG_PORT);
  record(true, '隔离：51735 停测后 PID', `${origAfter || '空'}`);
  // 清临时 HOME
  try { if (tmpHome) rmSync(tmpHome, { recursive: true, force: true }); } catch {}

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n=== 结果：${passed}/${total} 通过 ===`);
  if (passed !== total) {
    console.log('未通过项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label} ${r.detail}`);
    exitCode = 1;
  }
  process.exit(exitCode);
});
