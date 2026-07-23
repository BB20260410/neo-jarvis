#!/usr/bin/env node
// CE12 P0 Brain UI e2e.
// Evidence target: Brain UI execution visualization + Act Pipeline dry-run.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOwnerTokenAuthorization } from '../../scripts/lib/noe-standing-autonomy-grant.mjs';

const BASE_URL = process.env.PANEL_URL || `http://127.0.0.1:${process.env.PORT || 51835}`;
const ARTIFACT_DIR = join(process.cwd(), 'output', 'playwright');
const OWNER_TOKEN_AUTHORIZATION = resolveOwnerTokenAuthorization({
  explicitAck: process.argv.includes('--ack-read-owner-token') || process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  scope: 'e2e-live:run',
});
const ACK_READ_OWNER_TOKEN = OWNER_TOKEN_AUTHORIZATION.authorized;
const results = [];
const consoleErrors = [];
const requestFailures = [];

function track(label, pass, detail = '') {
  results.push({ label, pass: Boolean(pass), detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${label}${detail ? ` - ${detail}` : ''}`);
}

function readOwnerToken() {
  if (process.env.OWNER_TOKEN) return process.env.OWNER_TOKEN;
  if (!ACK_READ_OWNER_TOKEN) return '';
  try {
    return readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function waitText(page, selector, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = ((await page.textContent(selector).catch(() => '')) || '').trim();
    if (predicate(text)) return text;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for ${selector}`);
}

async function visibleId(page, selector) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  return locator.count();
}

async function main() {
  console.log('=== Noe Brain UI CE12 P0 e2e ===');
  console.log(`base=${BASE_URL}`);
  console.log(`node=${process.version}; modules=${process.versions.modules}`);

  const resolvedPort = Number(new URL(BASE_URL).port) || 0;
  const reservedPortAllowed = process.env.NOE_E2E_ALLOW_RESERVED_PORT === '1' || OWNER_TOKEN_AUTHORIZATION.authorized;
  if ((resolvedPort === 51735 || resolvedPort === 51835) && !reservedPortAllowed) {
    console.error(`refusing to run raw e2e against reserved panel port ${resolvedPort}; use scripts/e2e-with-server.mjs, set NOE_E2E_ALLOW_RESERVED_PORT=1, or install standing autonomy grant with e2e-live:run`);
    process.exit(1);
  }

  const token = readOwnerToken();
  if (!token || token.length < 16) {
    console.error('owner token missing; start through scripts/e2e-with-server.mjs, set OWNER_TOKEN, pass --ack-read-owner-token, or install standing autonomy grant for an authorized live run');
    process.exit(1);
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('requestfailed', (req) => requestFailures.push({ url: req.url(), error: req.failure()?.errorText || '' }));
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort('connectionclosed'));

  try {
    await page.addInitScript((ownerToken) => {
      sessionStorage.setItem('panel-owner-token', ownerToken);
      localStorage.setItem('panel:telemetry:asked', '1');
      localStorage.setItem('panel:onboarding:v1', '1');
    }, token);

    await page.goto(`${BASE_URL}/?t=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    track('page title is Noe', /Noe/i.test(title), title);

    await page.locator('#settingsDd').evaluate((el) => { el.open = true; });
    await page.waitForSelector('#btnNoeBrain', { state: 'visible', timeout: 10000 });
    await page.click('#btnNoeBrain');
    await page.waitForFunction(() => {
      const el = document.querySelector('#noeBrainArea');
      return el && getComputedStyle(el).display !== 'none';
    }, { timeout: 10000 });
    track('Brain panel opens', true, '#noeBrainArea');

    const requiredIds = [
      '#noeActQueue',
      '#noeCurrentAct',
      '#noeApprovalStatus',
      '#noeToolPermissionStatus',
      '#noeFailureReason',
      '#noeBudgetStatus',
      '#noeEvidenceLogLink',
    ];
    for (const selector of requiredIds) {
      await visibleId(page, selector);
      track(`P0 execution DOM visible ${selector}`, true);
    }

    await waitText(page, '#noeHealthStatus', (text) => text === 'ok');
    track('health chip shows ok', true, '#noeHealthStatus');

    const marker = `E2E_NOE_P0_${Date.now()}`;
    await page.fill('#noeMemoryBody', `Noe CE12 P0 memory marker ${marker}`);
    await page.click('#btnNoeMemoryWrite');
    await page.fill('#noeMemoryQuery', marker);
    await page.click('#btnNoeMemorySearch');
    await waitText(page, '#noeMemoryList', (text) => text.includes('E2E_NOE_P0'));
    track('memory write and recall is visible', true, marker);

    await page.click('#btnNoeLoopActTick');
    await waitText(page, '#noeActQueue', (text) => /completed|dry_run|awaiting_approval|blocked_safety/i.test(text), 15000);
    const currentAct = await waitText(page, '#noeCurrentAct', (text) => text !== '-' && text.length > 4);
    track('act queue updates after Act Tick', true, currentAct);
    const budgetState = await waitText(page, '#noeBudgetStatus', (text) => /ok|warn|blocked|unknown/i.test(text));
    track('budget state rendered', true, budgetState);
    const permissionState = await waitText(page, '#noeToolPermissionStatus', (text) => /allow|approval|required|blocked|unknown/i.test(text));
    track('tool permission state rendered', true, permissionState);

    const logLinkText = await waitText(page, '#noeEvidenceLogLink', (text) => /sqlite:events|暂无可复现日志/.test(text));
    track('reproducible log link rendered', true, logLinkText);

    await page.locator('#settingsDd').evaluate((el) => { el.open = true; });
    await page.click('#btnTerminal');
    await page.waitForSelector('.plain-term-screen', { timeout: 10000 });
    const fallbackText = await page.locator('.plain-term-screen').innerText({ timeout: 5000 });
    track('terminal fallback works when optional CDN is unavailable', /纯文本终端/.test(fallbackText), fallbackText.slice(0, 80));
    await page.click('#btnTermClose');

    const screenshot = join(ARTIFACT_DIR, `noe-brain-ui-p0-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    track('P0 screenshot captured', true, screenshot);
  } catch (e) {
    track('e2e exception', false, e?.message || String(e));
    try {
      const screenshot = join(ARTIFACT_DIR, `noe-brain-ui-p0-failure-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(`failure screenshot: ${screenshot}`);
    } catch {}
  } finally {
    await browser.close();
  }

  const onlyOptionalCdnFailures = requestFailures.length > 0
    && requestFailures.every((item) => /cdn\.jsdelivr\.net/i.test(item.url));
  const relevantConsoleErrors = consoleErrors.filter((line) => {
    if (/favicon|ERR_ABORTED/i.test(line)) return false;
    if (onlyOptionalCdnFailures && /Failed to load resource/i.test(line)) return false;
    return true;
  });
  track('no relevant console errors', relevantConsoleErrors.length === 0, relevantConsoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((item) => !item.pass);
  console.log(`Result: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
