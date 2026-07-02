#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-cognitive-verify');
const REPORT = join(OUT_DIR, `cognitive-verify-${Date.now()}.json`);
const DEFAULT_BASE = 'http://127.0.0.1:51835';

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.NOE_PANEL_URL || DEFAULT_BASE,
    timeoutMs: 20_000,
    query: 'Obsidian MCP 要不要接',
    headful: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || out.timeoutMs;
    else if (arg === '--query') out.query = argv[++i] || out.query;
    else if (arg.startsWith('--query=')) out.query = arg.slice('--query='.length);
    else if (arg === '--headful') out.headful = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'cognitive-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return out;
}

function liveOwnerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: process.env.NOE_OWNER_TOKEN.trim(), source: 'env', policyBlocked: false, reason: '' };
  try {
    return { token: readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  }
}

function pass(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body?.scrollWidth || 0,
    overflowing: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

async function runViewport({ browser, baseUrl, token, timeoutMs, query, viewport }) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const requestFailures = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 220)); });
  page.on('requestfailed', (req) => requestFailures.push({ url: req.url().replace(/\?t=[^&]+/, '?t=[redacted]'), error: req.failure()?.errorText || '' }));

  const checks = [];
  try {
    await page.route('**/api/noe/research/deep', async (route) => {
      const body = [
        'event: start',
        'data: {"question":"模拟研究"}',
        '',
        'event: progress',
        'data: {"phase":"plan","round":1}',
        '',
        'event: progress',
        'data: {"phase":"search","round":1}',
        '',
        'event: progress',
        'data: {"phase":"fetch","round":1}',
        '',
        'event: progress',
        'data: {"phase":"synthesize","round":1}',
        '',
        'event: result',
        'data: {"report":"## 模拟研究结果\\n我已按当前搜到的资料整理一版。"}',
        '',
        'event: done',
        'data: {"rounds":1}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    });
    const url = `${baseUrl}/cognitive.html?t=${encodeURIComponent(token)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#chat-input', { timeout: timeoutMs });
    // 认知动作按钮已收进 ⚙ 配置抽屉（cognitive-action-drawer.js）：验收口径改为「一次点击可达」——
    // 先开抽屉再断言入口可见；后续每次点动作按钮前确保抽屉处于打开态。
    const openDrawer = async () => {
      if (await page.locator('#btnLocalWiki').isVisible().catch(() => false)) return;
      await page.click('#cognitiveActionDrawerToggle');
      await page.waitForSelector('#btnLocalWiki', { timeout: timeoutMs });
    };
    await page.waitForSelector('#cognitiveActionDrawerToggle', { timeout: timeoutMs });
    await openDrawer();
    await page.waitForSelector('#btnLocalWiki', { timeout: timeoutMs });
    await page.waitForSelector('#btnWebSearch', { timeout: timeoutMs });
    await page.waitForSelector('#btnDeepResearch', { timeout: timeoutMs });

    pass(checks, 'entry_controls_present', true, { viewport, viaDrawer: true });
    const overflow = await noHorizontalOverflow(page);
    pass(checks, 'no_horizontal_overflow', !overflow.overflowing, overflow);

    await page.fill('#chat-input', query);
    await openDrawer();
    await page.click('#btnLocalWiki');
    await page.waitForFunction(() => {
      const text = document.querySelector('#chat-messages')?.textContent || '';
      return /本地 LLM Wiki|Obsidian|Wiki/i.test(text) && /NOE|本地/.test(text);
    }, null, { timeout: timeoutMs });
    const replyText = await page.locator('#chat-messages').innerText({ timeout: timeoutMs });
    pass(checks, 'local_wiki_button_returns_reply', /Obsidian|本地 LLM Wiki|Wiki/i.test(replyText), {
      replySnippet: replyText.slice(-900),
    });

    await page.fill('#chat-input', '测试研究进度文案');
    await openDrawer();
    await page.click('#btnDeepResearch');
    await page.waitForFunction(() => {
      const stream = document.querySelector('#streamHost')?.textContent || '';
      const chat = document.querySelector('#chat-messages')?.textContent || '';
      return /正在搜索资料/.test(stream) && /正在整理成报告/.test(stream) && /模拟研究结果/.test(chat);
    }, null, { timeout: timeoutMs });
    const streamText = await page.locator('#streamHost').innerText({ timeout: timeoutMs });
    pass(checks, 'deep_progress_uses_plain_user_copy', /正在搜索资料/.test(streamText) && /正在整理成报告/.test(streamText) && !/软超|超时阈值|timeout/i.test(streamText), {
      streamSnippet: streamText.slice(0, 900),
    });
    pass(checks, 'no_console_errors', consoleErrors.length === 0, { consoleErrors });
    pass(checks, 'no_request_failures', requestFailures.length === 0, { requestFailures });
  } catch (e) {
    pass(checks, 'viewport_run_completed', false, { viewport, error: e?.message || String(e), consoleErrors, requestFailures });
  } finally {
    await page.close().catch(() => {});
  }
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokenPolicy = liveOwnerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  const token = tokenPolicy.token;
  const checks = [];
  pass(checks, 'owner_token_loaded', Boolean(token), {
    source: tokenPolicy.source,
    policyBlocked: Boolean(tokenPolicy.policyBlocked),
    reason: tokenPolicy.reason || '',
  });
  if (!token) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT, JSON.stringify({
      ok: false,
      baseUrl: args.baseUrl,
      tokenPolicy: {
        source: tokenPolicy.source,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: Boolean(tokenPolicy.policyBlocked),
        reason: tokenPolicy.reason || '',
        secretValueReturned: false,
      },
      checks,
      passed: 0,
      failed: checks.length,
      note: 'Live cognitive verification requires explicit ack or standing autonomy grant; otherwise default mode does not read owner-token.',
    }, null, 2));
    console.log('FAIL owner_token_loaded');
    console.log(`report=${REPORT}`);
    process.exit(tokenPolicy.policyBlocked ? 2 : 1);
  }

  const browser = await chromium.launch({ headless: !args.headful });
  try {
    checks.push(...await runViewport({
      browser,
      baseUrl: args.baseUrl,
      token,
      timeoutMs: args.timeoutMs,
      query: args.query,
      viewport: { width: 390, height: 844 },
    }));
    checks.push(...await runViewport({
      browser,
      baseUrl: args.baseUrl,
      token,
      timeoutMs: args.timeoutMs,
      query: args.query,
      viewport: { width: 1280, height: 800 },
    }));
  } finally {
    await browser.close().catch(() => {});
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    ok: failed === 0,
    baseUrl: args.baseUrl,
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: false,
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    checks,
    passed,
    failed,
    note: 'Does not restart Noe, create rooms, approve jobs, or spawn Codex/Claude CLI. Reading live owner-token requires explicit ack or standing autonomy grant.',
  }, null, 2));

  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
  console.log(`report=${REPORT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  console.error(e?.stack || e?.message || e);
  console.error(`report=${REPORT}`);
  process.exit(1);
});
