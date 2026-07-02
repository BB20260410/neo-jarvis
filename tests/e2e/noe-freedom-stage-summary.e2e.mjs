#!/usr/bin/env node
// P2 续：Freedom 社交发布链「阶段摘要」真实浏览器渲染 e2e。
//
// 相对 jsdom 单测（tests/unit/noe-freedom-stage-summary-ui.test.js）的增量价值：
//   1. 验证真实服务器下发的 ES 模块链
//        /src/web/noe-freedom-stage-summary.js → ./noe-freedom-ui-utils.js
//      能在真实浏览器里被动态 import 成功（jsdom 不经过真实 HTTP/ESM 解析）。
//   2. 验证页面自身的模块图（main.js → noe-freedom-tools.js → 该模块）加载无误：
//      freedom 面板自挂载出真实容器 #noeFreedomStageSummary，且全程无 console error。
//   3. 验证渲染产物被真实 HTML 解析器解析进真实容器后，徽章 / 卡点高亮 class /
//      回滚门控中文标签 / 脱敏 / 转义 / 空态都正确落地。
//
// 安全边界：本测试只在浏览器内渲染本地样本，绝不触发任何 freedom dry-run/execute，
//   因此不会牵涉真实平台 DOM 探测、上传、发布等副作用。server 由 e2e-with-server.mjs
//   起在随机空闲端口（结构上拒用 51735/51835）。
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

// 故意嵌入一个 token 形态的敏感串，断言它在真实 DOM 里被脱敏、绝不泄漏。
const SECRET = 'SECRET-TOKEN-DO-NOT-LEAK';

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

// 代表性「被阻断」样本：覆盖徽章(✓/✗)、blockedAt 卡点高亮、回滚证据门控标签、
// warnings 计数、DOM readiness、rollback 平台/目标，以及两处 token 形态敏感串。
const BLOCKED_SAMPLE = {
  runtime: {
    socialPublishStageSummary: {
      ok: false,
      stageCount: 3,
      blockedAtStepId: 'final_publish',
      publishStepPresent: true,
      publishAttempted: false,
      externalSideEffectPlanned: true,
      externalSideEffectPerformed: false,
      domProbeSummary: { ok: false, foundRoles: ['media_upload'], missingRoles: ['title', 'content'] },
      rollbackEvidence: {
        evidenceStatus: 'pending_probe',
        verifiedByNoe: false,
        missingEvidence: ['post_publish_url'],
        platform: 'douyin',
        postUrlRef: `https://www.douyin.com/video/1?token=${SECRET}`,
      },
      stages: [
        { stage: 'rollback_evidence_gate', stepId: 'rollback_gate', ok: true, blockers: [], warnings: ['draft_already_has_external_side_effect'] },
        { stage: 'media_upload_execute', stepId: 'upload_media', ok: true, blockers: [], childLedgerRef: 'output/noe-freedom-runs/upload/ledger.json' },
        { stage: 'final_publish_execute', stepId: 'final_publish', ok: false, blockers: ['final_publish_prior_stage_evidence_required'], childLedgerRef: `output/noe-freedom-runs/final?token=${SECRET}` },
      ],
    },
  },
};

async function main() {
  console.log('=== Noe Freedom stage-summary 渲染 e2e ===');
  console.log(`base=${BASE_URL}`);
  console.log(`node=${process.version}; modules=${process.versions.modules}`);

  // 安全护栏：脱离 managed 启动器裸跑时，拒绝指向保留面板端口(51735/51835)——否则会打到
  // 真实运行中的面板。正路（npm run test:e2e:freedom-stage）由 e2e-with-server.mjs 注入随机空闲端口。
  const resolvedPort = Number(new URL(BASE_URL).port) || 0;
  const reservedPortAllowed = process.env.NOE_E2E_ALLOW_RESERVED_PORT === '1' || OWNER_TOKEN_AUTHORIZATION.authorized;
  if ((resolvedPort === 51735 || resolvedPort === 51835) && !reservedPortAllowed) {
    console.error(`拒绝在保留面板端口 ${resolvedPort} 上运行 e2e（会打到真实面板）。请经 npm run test:e2e:freedom-stage 启动，或显式设 NOE_E2E_ALLOW_RESERVED_PORT=1，或安装包含 e2e-live:run 的 standing autonomy grant。`);
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
  // 可选 CDN 不可用不应让测试失败（与 P0 e2e 一致）。
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

    // 1) 真实页面模块图加载后，freedom 面板自挂载出真实容器。
    await page.waitForSelector('#noeFreedomStageSummary', { state: 'attached', timeout: 15000 });
    track('freedom stage-summary container auto-mounts', true, '#noeFreedomStageSummary');

    // 2) 动态 import 真实服务器下发的 ES 模块，并把样本按生产路径
    //    (setStageSummary: el.innerHTML = renderFreedomStageSummary(result)) 渲染进真实容器。
    const moduleUrl = `${BASE_URL}/src/web/noe-freedom-stage-summary.js`;
    const rendered = await page.evaluate(async ({ url, sample }) => {
      const mod = await import(url);
      const el = document.querySelector('#noeFreedomStageSummary');
      el.innerHTML = mod.renderFreedomStageSummary(sample);
      const extracted = mod.extractFreedomStageSummary(sample);
      return {
        hasRender: typeof mod.renderFreedomStageSummary === 'function',
        hasExtract: typeof mod.extractFreedomStageSummary === 'function',
        html: el.innerHTML,
        hasBlockedHereNode: Boolean(el.querySelector('.noe-brain-row--blocked-here')),
        stageRowCount: el.querySelectorAll('.noe-brain-row--stage').length,
        extractedBlockedAt: extracted?.blockedAt || '',
        extractedStageCount: extracted?.stageCount ?? -1,
        extractedOk: extracted?.ok,
        // 空态：无 summary 时应渲染中文占位。
        emptyHtml: mod.renderFreedomStageSummary({}),
      };
    }, { url: moduleUrl, sample: BLOCKED_SAMPLE });

    track('module exposes render + extract', rendered.hasRender && rendered.hasExtract);

    // 3) 真实 DOM 断言：徽章 / 卡点高亮 / 回滚门控标签 / warnings / DOM readiness。
    track('renders the social publish chain header', rendered.html.includes('社交发布链'));
    track('renders the rollback-gate stage label', rendered.html.includes('回滚证据门控'), 'rollback_evidence_gate → 回滚证据门控');
    track('renders pass and fail badges', rendered.html.includes('✓') && rendered.html.includes('✗'));
    track('marks the blocked stage inline', rendered.html.includes('← 卡在这里'));
    track('applies the blocked-here CSS class as a real node', rendered.hasBlockedHereNode, '.noe-brain-row--blocked-here');
    track('renders the warning count', rendered.html.includes('⚠1'));
    track('renders three stage rows', rendered.stageRowCount === 3, `count=${rendered.stageRowCount}`);
    track('renders DOM readiness with found role', rendered.html.includes('DOM readiness') && rendered.html.includes('media_upload'));
    track('renders rollback evidence with platform/status', rendered.html.includes('Rollback evidence') && rendered.html.includes('douyin') && rendered.html.includes('pending_probe'));
    track('renders blocker text', rendered.html.includes('final_publish_prior_stage_evidence_required'));

    // 4) 脱敏：真实 DOM 绝不含原始 token（关键安全硬断言）；并存在脱敏标记（松断言，不锁死具体格式）。
    track('redacts secret token in real DOM', !rendered.html.includes(SECRET), rendered.html.includes(SECRET) ? 'LEAK!' : 'clean');
    track('shows a redaction marker', /redacted/i.test(rendered.html));

    // 5) extract 结果与样本一致。
    track('extract returns blockedAt', rendered.extractedBlockedAt === 'final_publish', rendered.extractedBlockedAt);
    track('extract returns stageCount + ok', rendered.extractedStageCount === 3 && rendered.extractedOk === false, `count=${rendered.extractedStageCount} ok=${rendered.extractedOk}`);

    // 6) 空态。
    track('renders empty-state placeholder', rendered.emptyHtml.includes('暂无社交发布阶段摘要。'));

    const screenshot = join(ARTIFACT_DIR, `noe-freedom-stage-summary-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    track('screenshot captured', true, screenshot);
  } catch (e) {
    track('e2e exception', false, e?.message || String(e));
    try {
      const screenshot = join(ARTIFACT_DIR, `noe-freedom-stage-summary-failure-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(`failure screenshot: ${screenshot}`);
    } catch {}
  } finally {
    await browser.close();
  }

  // 按行独立剔除可忽略噪声（favicon、被主动 abort 的可选 CDN 资源 ERR_CONNECTION_CLOSED/ERR_ABORTED、
  // 任何 jsdelivr 行）。不再用「全有或全无」的闸门——否则任一无关偶发失败会连带让 jsdelivr 报错重新计入，造成偶发误报。
  const relevantConsoleErrors = consoleErrors.filter((line) => {
    if (/favicon|ERR_ABORTED|ERR_CONNECTION_CLOSED/i.test(line)) return false;
    if (/cdn\.jsdelivr\.net/i.test(line)) return false;
    return true;
  });
  track('no relevant console errors', relevantConsoleErrors.length === 0, relevantConsoleErrors.slice(0, 3).join(' | '));
  // 非可选-CDN 的真实请求失败应让测试变红（与 console 过滤解耦，独立判定）。
  const relevantRequestFailures = requestFailures.filter((item) => !/cdn\.jsdelivr\.net|favicon/i.test(item.url));
  track('no relevant request failures', relevantRequestFailures.length === 0, relevantRequestFailures.slice(0, 3).map((r) => r.url).join(' | '));

  const failed = results.filter((item) => !item.pass);
  console.log(`Result: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
