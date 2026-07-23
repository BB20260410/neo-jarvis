import { spawn } from 'node:child_process';
import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  markNoeSocialDraftExternalSideEffect,
  markNoeSocialDraftExternalSideEffectAttempt,
  readNoeSocialDraft,
} from './NoeSocialPublishQueue.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';
import {
  buildFinalPublishRollbackEvidence,
  validateFinalPublishPostPublishProbe,
} from './NoeSocialFinalPublishRollback.js';

export const NOE_SOCIAL_FINAL_PUBLISH_EXECUTOR_SCHEMA_VERSION = 1;

const FINAL_PUBLISH_HINTS = {
  douyin: ['发布', '发布作品', '立即发布', 'publish'],
  xiaohongshu: ['发布', '发表', '发布笔记', 'publish', 'post'],
  bilibili: ['立即投稿', '投稿', '发布', 'publish'],
  wechat_channels: ['发表', '发布', 'publish'],
  youtube: ['publish', '发布'],
  generic: ['发布', '发表', 'publish', 'post'],
};

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function parseJson(value = '') {
  try {
    return JSON.parse(clean(value, 40_000));
  } catch {
    return null;
  }
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

function redactBrowserUrl(value = '') {
  const text = clean(value, 2000);
  if (!text) return '';
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    if (/token|key|secret|password|auth|session|credential|jwt/i.test(url.hash)) {
      url.hash = '#[redacted]';
    }
    return clean(url.toString(), 2000);
  } catch {
    return text.replace(/([?&#][^=]*?(?:token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  }
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function platformPreset(platform = '') {
  return NOE_SOCIAL_PLATFORM_PRESETS[normalizePlatform(platform)] || {
    label: 'Generic Social Platform',
    creatorUrl: '',
    expectedHosts: [],
    tags: ['generic', 'social'],
  };
}

function browserHost(browserState = {}) {
  const state = safeJson(browserState);
  try {
    return new URL(clean(state.activeBrowser?.url || state.url, 2000)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeStageList(value, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => clean(item, 180)).filter(Boolean);
}

function priorStageEvidenceFromArgs(args = {}) {
  const source = args.priorStageEvidence || args.socialPublishStageSummary || args.stageSummary;
  const evidence = safeJson(source);
  if (!evidence || !Object.keys(evidence).length) return null;
  const stageObjects = Array.isArray(evidence.stages) ? evidence.stages : [];
  const completedFromStages = stageObjects
    .filter((stage) => stage?.ok === true)
    .map((stage) => clean(stage.stage || stage.stepId, 180))
    .filter(Boolean);
  const failedFromStages = stageObjects
    .filter((stage) => stage?.ok !== true)
    .map((stage) => clean(stage.stage || stage.stepId, 180))
    .filter(Boolean);
  return {
    ok: evidence.ok === true,
    kind: clean(evidence.kind || 'social_publish_stage_summary', 120),
    stageCount: Number(evidence.stageCount) || stageObjects.length || 0,
    completedStages: [...new Set([
      ...normalizeStageList(evidence.completedStages),
      ...normalizeStageList(evidence.completedStepIds),
      ...completedFromStages,
    ])],
    failedStages: [...new Set([
      ...normalizeStageList(evidence.failedStages),
      ...normalizeStageList(evidence.failedStepIds),
      ...failedFromStages,
    ])],
    secretValuesReturned: evidence.secretValuesReturned === true,
  };
}

function evaluatePriorStageEvidence({ args = {}, draft = {} } = {}) {
  // Task 0.2 Step4: prior-stage evidence is required by DEFAULT. A caller must explicitly opt out
  // (requirePriorStageEvidence:false) — omitting the flag no longer silently disables the gate,
  // and requireDraft:false can no longer be used as an escape hatch around the chain.
  const required = args.requirePriorStageEvidence !== false && args.requireStageEvidence !== false;
  const requiredStages = Array.isArray(args.requiredPriorStages) && args.requiredPriorStages.length
    ? normalizeStageList(args.requiredPriorStages)
    : [
      'form_fill_execute',
      ...(draft.mediaCount > 0 ? ['media_upload_execute'] : []),
    ];
  const evidence = priorStageEvidenceFromArgs(args);
  const completed = new Set(evidence?.completedStages || []);
  const missingStages = required ? requiredStages.filter((stage) => !completed.has(stage)) : [];
  const errors = [
    ...(required && !evidence ? ['final_publish_prior_stage_evidence_required'] : []),
    ...(required && evidence && evidence.ok !== true ? ['final_publish_prior_stage_summary_not_ok'] : []),
    ...(required && evidence?.secretValuesReturned === true ? ['final_publish_prior_stage_secret_values_returned'] : []),
    ...missingStages.map((stage) => `final_publish_prior_stage_missing:${stage}`),
    ...(required && evidence?.failedStages?.length ? evidence.failedStages.map((stage) => `final_publish_prior_stage_failed:${stage}`) : []),
  ];
  return {
    required,
    ok: errors.length === 0,
    source: evidence ? 'social_publish_stage_summary' : '',
    requiredStages,
    completedStages: evidence?.completedStages || [],
    failedStages: evidence?.failedStages || [],
    missingStages,
    errors,
  };
}

function readDraftSummary({ draftId = '', draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR } = {}) {
  const id = clean(draftId, 180);
  if (!id) return { ok: false, error: 'draft_id_missing' };
  const out = readNoeSocialDraft({ dir: draftDir, id });
  if (!out.ok) return { ok: false, error: out.error || 'social_draft_not_found', id };
  return {
    ok: true,
    id: clean(out.record?.id, 180),
    ref: out.ref,
    platform: clean(out.record?.platform, 80),
    state: clean(out.record?.state, 40),
    titlePresent: Boolean(clean(out.record?.metadata?.title, 300)),
    contentPresent: Boolean(clean(out.record?.content, 20_000)),
    mediaCount: Array.isArray(out.record?.metadata?.mediaFiles) ? out.record.metadata.mediaFiles.length : 0,
    externalSideEffectPerformed: out.record?.publish?.externalSideEffectPerformed === true,
    externalSideEffectAttempted: out.record?.publish?.externalSideEffectAttempted === true,
    sha256: clean(out.record?.sha256, 80),
  };
}

export function finalPublishScriptContainsUnsafeAction(script = '') {
  const text = String(script || '');
  return /(\.submit\s*\(|requestSubmit\s*\(|KeyboardEvent\s*\(\s*['"]keydown|key\s*:\s*['"]Enter['"]\s*,\s*code\s*:\s*['"]Enter)/i.test(text);
}

function buildFinalPublishBrowserJavascript({ platform = 'generic', expectedHosts = [] } = {}) {
  const normalized = normalizePlatform(platform);
  const hints = FINAL_PUBLISH_HINTS[normalized] || FINAL_PUBLISH_HINTS.generic;
  const payload = { expectedHosts, hints, platform: normalized };
  return `
(() => {
  const payload = ${JSON.stringify(payload)};
  const host = String(location.hostname || '').toLowerCase();
  if (payload.expectedHosts.length && !payload.expectedHosts.includes(host)) {
    return { ok: false, error: 'final_publish_host_mismatch', host, expectedHosts: payload.expectedHosts };
  }
  const cssPath = (el) => {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = String(node.tagName || '').toLowerCase();
      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((item) => item.tagName === node.tagName) : [];
      const index = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '';
      parts.unshift(tag + index);
      node = parent;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.value, el.textContent].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
  const extendedTextOf = (el) => [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('submit-text'),
    el.value,
    el.textContent,
  ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
  const lowerText = (el) => textOf(el).toLowerCase();
  if (payload.platform === 'xiaohongshu') {
    Array.from(document.querySelectorAll('*')).forEach((el) => {
      try {
        if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100) el.scrollTop = el.scrollHeight;
      } catch (_) {}
    });
  }
  const before = { url: String(location.href || ''), title: String(document.title || '') };
  const disabled = (el) => el.disabled === true
    || el.getAttribute('aria-disabled') === 'true'
    || el.getAttribute('submit-disabled') === 'true'
    || /disabled/i.test(String(el.className || ''));
  const xhsPublishCandidate = payload.platform === 'xiaohongshu'
    ? Array.from(document.querySelectorAll('xhs-publish-btn'))
      .find((el) => visible(el) && !disabled(el) && /^(发布|发表)$/i.test(extendedTextOf(el)))
    : null;
  if (payload.platform === 'xiaohongshu' && !xhsPublishCandidate) {
    return { ok: false, error: 'final_publish_xhs_publish_button_not_ready', host, before, finalButtonClicked: false, formSubmitted: false };
  }
  const inSidebar = (el) => Boolean(el.closest('.menu-container, .menu-panel, nav, aside'));
  const scoreCandidate = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    const text = extendedTextOf(el);
    const lower = text.toLowerCase();
    const rect = el.getBoundingClientRect();
    let score = 0;
    if (tag === 'xhs-publish-btn') score += 1000;
    if (text === '发布' || text === '发表') score += 300;
    if (payload.hints.some((hint) => lower.includes(String(hint).toLowerCase()))) score += 80;
    if (rect.x > 220) score += 40;
    if (rect.y > Math.max(250, window.innerHeight * 0.55)) score += 40;
    if (inSidebar(el)) score -= 500;
    if (/发布笔记/.test(text)) score -= 250;
    if (disabled(el)) score -= 1000;
    return score;
  };
  const candidate = xhsPublishCandidate || Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, [class*="publish"], [class*="submit"]'))
    .filter((el) => visible(el) && !disabled(el))
    .map((el) => ({ el, score: scoreCandidate(el) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.el || null;
  if (!candidate) {
    return { ok: false, error: 'final_publish_button_not_found', host, before, finalButtonClicked: false, formSubmitted: false };
  }
  const rect = candidate.getBoundingClientRect();
  const xhsSplitButton = payload.platform === 'xiaohongshu'
    && String(candidate.tagName || '').toLowerCase() === 'xhs-publish-btn'
    && candidate.getAttribute('is-save-draft') === 'true';
  const clickOffsetX = xhsSplitButton
    ? Math.max(1, Math.round(Math.max(1, rect.width) * 0.593))
    : Math.max(1, Math.round(Math.max(1, rect.width) / 2));
  const clickOffsetY = Math.max(1, Math.round(Math.max(1, rect.height) / 2));
  const clickPoint = {
    x: Math.max(1, Math.round(rect.left + clickOffsetX)),
    y: Math.max(1, Math.round(rect.top + clickOffsetY)),
    screenX: Math.max(1, Math.round(window.screenX + ((window.outerWidth - window.innerWidth) / 2) + rect.left + clickOffsetX)),
    screenY: Math.max(1, Math.round(window.screenY + (window.outerHeight - window.innerHeight) + rect.top + clickOffsetY)),
    strategy: xhsSplitButton ? 'xhs_split_button_submit_region' : 'element_center',
  };
  if (payload.platform === 'xiaohongshu') {
    return {
      ok: true,
      host,
      before,
      clickedLabel: extendedTextOf(candidate).slice(0, 120),
      clickedTag: String(candidate.tagName || '').toLowerCase(),
      submitDisabled: candidate.getAttribute('submit-disabled') || '',
      selector: cssPath(candidate),
      nativeClickRequired: true,
      clickPoint,
      finalButtonClicked: false,
      formSubmitted: false,
      pageContentReadByNoe: false
    };
  }
  candidate.click();
  return {
    ok: true,
    host,
    before,
    clickedLabel: extendedTextOf(candidate).slice(0, 120),
    clickedTag: String(candidate.tagName || '').toLowerCase(),
    submitDisabled: candidate.getAttribute('submit-disabled') || '',
    selector: cssPath(candidate),
    nativeClickRequired: false,
    clickPoint,
    finalButtonClicked: true,
    formSubmitted: false,
    pageContentReadByNoe: false
  };
})();
`.trim();
}

export function buildNoeSocialFinalPublishExecuteScript({
  browserApp = 'Google Chrome',
  platform = 'generic',
  expectedHosts = [],
  postPublishProbeDelaySeconds = 0.8,
} = {}) {
  const browserJavascript = buildFinalPublishBrowserJavascript({ platform, expectedHosts });
  const probeDelaySeconds = Math.max(0.2, Math.min(30, Number(postPublishProbeDelaySeconds) || 0.8));
  return `
const appName = ${JSON.stringify(clean(browserApp, 120))};
const app = Application(appName);
app.activate();
const windows = app.windows();
if (!windows.length) throw new Error('browser_window_required');
const tab = windows[0].activeTab();
const result = tab.execute({ javascript: ${JSON.stringify(browserJavascript)} });
let parsed = typeof result === 'string' ? JSON.parse(result) : result;
let nativeClickPerformed = false;
if (parsed && parsed.nativeClickRequired === true) {
  const currentApp = Application.currentApplication();
  currentApp.includeStandardAdditions = true;
  const point = parsed.clickPoint || {};
  if (!point.screenX || !point.screenY) throw new Error('final_publish_native_click_point_missing');
  let cliclickPath = '';
  try {
    cliclickPath = currentApp.doShellScript('command -v cliclick || true');
  } catch (_) {
    cliclickPath = '';
  }
  if (!cliclickPath) throw new Error('cliclick_required_for_native_final_publish_click');
  currentApp.doShellScript(cliclickPath + ' c:' + Math.round(point.screenX) + ',' + Math.round(point.screenY));
  nativeClickPerformed = true;
  parsed = {
    ...parsed,
    nativeClickPerformed: true,
    finalButtonClicked: true
  };
}
delay(${probeDelaySeconds});
const afterRaw = tab.execute({ javascript: "(() => ({ ok: true, url: String(location.href || ''), title: String(document.title || ''), finalButtonClicked: false, formSubmitted: false }))()" });
const after = typeof afterRaw === 'string' ? JSON.parse(afterRaw) : afterRaw;
JSON.stringify({
  ok: parsed && parsed.ok !== false,
  app: appName,
  result: parsed,
  postPublishProbe: after,
  nativeClickPerformed,
  publishPerformed: parsed && parsed.finalButtonClicked === true,
  finalButtonClicked: parsed && parsed.finalButtonClicked === true,
  formSubmitted: false,
  pageContentReadByNoe: false
});
`.trim();
}

async function runProcess(command, args = [], { cwd = process.cwd(), spawnImpl = spawn } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk); if (stdout.length > 20_000) stdout = stdout.slice(-20_000); });
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on?.('error', rejectProcess);
    child.on?.('close', (code, signal) => {
      resolveProcess({
        ok: Number(code) === 0,
        exitCode: code,
        signal: signal || null,
        stdout: clean(stdout, 20_000),
        stderr: clean(stderr, 20_000),
      });
    });
  });
}

function processPreview(processResult = {}) {
  return {
    ok: processResult.ok === true,
    exitCode: Number.isFinite(Number(processResult.exitCode)) ? Number(processResult.exitCode) : null,
    signal: processResult.signal || null,
    stderrPreview: clean(processResult.stderr, 1000),
    stdoutReturned: false,
  };
}

function parsedPublishResult(stdout = '') {
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'final_publish_execution_output_parse_failed' };
  const nested = typeof parsed.result === 'string' ? parseJson(parsed.result) : parsed.result;
  const probe = typeof parsed.postPublishProbe === 'string' ? parseJson(parsed.postPublishProbe) : parsed.postPublishProbe;
  return {
    ok: parsed.ok !== false && (!nested || nested.ok !== false),
    app: clean(parsed.app, 120),
    result: nested && typeof nested === 'object' ? {
      ok: nested.ok !== false,
      host: clean(nested.host, 200),
      selector: clean(nested.selector, 500),
      clickedLabel: clean(nested.clickedLabel, 200),
      clickedTag: clean(nested.clickedTag, 120),
      submitDisabled: clean(nested.submitDisabled, 120),
      nativeClickRequired: nested.nativeClickRequired === true,
      nativeClickPerformed: nested.nativeClickPerformed === true,
      finalButtonClicked: nested.finalButtonClicked === true,
      formSubmitted: false,
      pageContentReadByNoe: false,
      error: clean(nested.error || '', 500),
    } : {},
    postPublishProbe: probe && typeof probe === 'object' ? {
      ok: probe.ok !== false,
      url: redactBrowserUrl(probe.url),
      title: clean(probe.title, 500),
      finalButtonClicked: false,
      formSubmitted: false,
    } : null,
    publishPerformed: parsed.publishPerformed === true,
    nativeClickPerformed: parsed.nativeClickPerformed === true,
    finalButtonClicked: parsed.finalButtonClicked === true,
    formSubmitted: false,
    pageContentReadByNoe: false,
  };
}

function finalPublishClickVerificationErrors({ platform = 'generic', browser = {} } = {}) {
  if (normalizePlatform(platform) !== 'xiaohongshu') return [];
  if (browser.finalButtonClicked !== true) return [];
  const result = browser.result && typeof browser.result === 'object' ? browser.result : {};
  const clickedTag = clean(result.clickedTag, 120);
  const clickedLabel = clean(result.clickedLabel, 200);
  const submitDisabled = clean(result.submitDisabled, 120);
  return [
    ...(clickedTag === 'xhs-publish-btn' ? [] : [`final_publish_xhs_clicked_tag_mismatch:${clickedTag || 'missing'}`]),
    ...(/^(发布|发表)$/i.test(clickedLabel) ? [] : [`final_publish_xhs_clicked_label_mismatch:${clickedLabel || 'missing'}`]),
    ...(submitDisabled !== 'true' ? [] : ['final_publish_xhs_clicked_button_disabled']),
    ...(result.nativeClickPerformed === true ? [] : ['final_publish_xhs_native_click_not_performed']),
  ];
}

export async function executeNoeSocialFinalPublish({
  args = {},
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  root = process.cwd(),
  realExecute = false,
  deps = {},
} = {}) {
  const draft = readDraftSummary({ draftId: args.draftId || args.id, draftDir });
  const platform = normalizePlatform(args.platform || draft.platform || 'generic');
  const preset = platformPreset(platform);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts : [];
  const browserState = safeJson(args.browserState);
  const activeHost = browserHost(browserState);
  const browserMatches = Boolean(activeHost && expectedHosts.includes(activeHost));
  const browserApp = clean(args.browserApp || 'Google Chrome', 120);
  const requireBrowserMatch = args.requireBrowserMatch !== false;
  const blockers = [];
  const warnings = [];
  const priorStageEvidence = evaluatePriorStageEvidence({ args, draft });

  if (!draft.ok && args.requireDraft !== false) blockers.push(draft.error || 'social_draft_not_found');
  blockers.push(...priorStageEvidence.errors);
  // R2-P0：已发布 **或** 已尝试发布（点击前预落的 attempt 标记）都阻断重复 final publish——上一轮点击后崩溃/
  //   落标失败时，attempt 痕迹是唯一能挡住重试穿透的凭据（externalSideEffectPerformed 那条只挡「确认发布过」的，
  //   挡不住「点了但没确认落标」的重复点击）。warnings 不挡 osascript，必须进 blockers。
  if (draft.externalSideEffectPerformed || draft.externalSideEffectAttempted) blockers.push('draft_already_has_external_side_effect');
  if (!activeHost) warnings.push('browser_state_not_provided');
  if (activeHost && expectedHosts.length && !browserMatches) {
    const issue = 'final_publish_browser_host_mismatch';
    if (requireBrowserMatch) blockers.push(issue);
    else warnings.push(issue);
  }

  const script = buildNoeSocialFinalPublishExecuteScript({
    browserApp,
    platform,
    expectedHosts,
    postPublishProbeDelaySeconds: args.postPublishProbeDelaySeconds || args.postPublishProbeDelaySec,
  });
  const base = {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_FINAL_PUBLISH_EXECUTOR_SCHEMA_VERSION,
    adapter: 'social-final-publish-execute',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    draft: draft.ok ? {
      id: draft.id,
      ref: draft.ref,
      platform: draft.platform,
      state: draft.state,
      titlePresent: draft.titlePresent,
      contentPresent: draft.contentPresent,
      mediaCount: draft.mediaCount,
      sha256: draft.sha256,
    } : { ok: false, error: draft.error || 'social_draft_not_found' },
    priorStageEvidence,
    browser: {
      app: browserApp,
      activeHost,
      expectedHosts,
      matchesPlatform: browserMatches,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    },
    finalPublishAutomation: {
      language: 'jxa',
      targetBrowser: browserApp,
      script,
      scriptGenerated: true,
      finalButtonClicked: false,
      formSubmitted: false,
      pageContentReadByNoe: false,
    },
    executionAttempted: false,
    execution: null,
    rollbackEvidence: buildFinalPublishRollbackEvidence({ platform, args }),
    blockers,
    warnings,
    externalSideEffectPerformed: false,
    publishPerformed: false,
    secretValuesReturned: false,
    authority: {
      canPublishExternally: true,
      canPressFinalPublish: true,
      canReadSecrets: false,
      bypassesNoeGovernance: false,
    },
  };

  if (blockers.length) return { ...base, ok: false };
  if (finalPublishScriptContainsUnsafeAction(script)) {
    return {
      ...base,
      ok: false,
      blockers: [...blockers, 'final_publish_script_contains_unsafe_form_submit_action'],
    };
  }
  if (realExecute !== true) {
    return {
      ...base,
      ok: true,
      nextFreedomActions: [
        {
          stepId: 'execute_controlled_final_publish',
          actionId: 'noe.freedom.social.final_publish.execute',
          mode: 'developer_unrestricted',
          args,
        },
      ],
    };
  }

  // R2-P0：**点击前**预落 attempt 标记。一旦 osascript 真点了发布按钮，副作用不可逆——必须保证磁盘先有痕迹，
  //   否则点击后崩溃/落标失败会让重试穿透去重闸重复发布。attempt 落盘失败 → 绝不点击（无痕迹下宁可这轮不发、
  //   诚实可重试，也不冒重复发布风险）。
  if (draft.ok && draft.id) {
    const markAttempt = deps.markAttempt || markNoeSocialDraftExternalSideEffectAttempt;
    let attemptMarked = false;
    try {
      const r = markAttempt({ dir: draftDir, id: draft.id });
      attemptMarked = r && r.ok === true;
    } catch { attemptMarked = false; }
    if (!attemptMarked) {
      return { ...base, ok: false, blockers: [...blockers, 'final_publish_side_effect_attempt_marker_failed'] };
    }
  }
  const processResult = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: root,
    spawnImpl: deps.spawn || spawn,
  });
  const browser = processResult.ok ? parsedPublishResult(processResult.stdout) : { ok: false, error: 'final_publish_osascript_failed' };
  const clickVerificationErrors = finalPublishClickVerificationErrors({ platform, browser });
  const clickConfirmed = processResult.ok === true
    && browser.ok === true
    && browser.finalButtonClicked === true
    && clickVerificationErrors.length === 0;
  const postPublishVerificationErrors = clickConfirmed
    ? validateFinalPublishPostPublishProbe({
      platform,
      postPublishProbe: browser.postPublishProbe,
      publishPerformed: browser.publishPerformed === true,
    }).errors.map((error) => `final_publish_${error}`)
    : [];
  const runtimeBlockers = [
    ...(processResult.ok ? [] : ['final_publish_osascript_failed']),
    ...(browser.ok ? [] : [browser.error || browser.result?.error || 'final_publish_browser_result_failed']),
    ...(browser.finalButtonClicked ? [] : ['final_publish_click_not_confirmed']),
    ...clickVerificationErrors,
    ...postPublishVerificationErrors,
  ].filter(Boolean);
  const publishConfirmed = runtimeBlockers.length === 0 && browser.publishPerformed === true;
  const rollback = buildFinalPublishRollbackEvidence({ platform, postPublishProbe: browser.postPublishProbe, publishPerformed: publishConfirmed, args });
  // Task 0.2 Step1: persist the external-side-effect flag back to the draft on disk so a later run
  // can detect this draft was already published and refuse a duplicate publish.
  let draftPersisted = false;
  if (clickConfirmed && draft.ok && draft.id) {
    try {
      const marked = markNoeSocialDraftExternalSideEffect({
        dir: draftDir,
        id: draft.id,
        publishRef: browser.postPublishProbe?.url || '',
        reason: publishConfirmed ? 'final_publish_confirmed' : 'final_publish_click_confirmed_verification_pending',
      });
      draftPersisted = marked.ok === true;
    } catch {
      draftPersisted = false;
    }
  }
  const sideEffectPersistenceErrors = clickConfirmed && draft.ok && draft.id && draftPersisted !== true
    ? ['final_publish_external_side_effect_marker_persist_failed']
    : [];
  const finalRuntimeBlockers = [
    ...runtimeBlockers,
    ...sideEffectPersistenceErrors,
  ];
  return {
    ...base,
    ok: finalRuntimeBlockers.length === 0,
    plannedOnly: false,
    executionAttempted: true,
    externalSideEffectPerformed: clickConfirmed,
    publishPerformed: publishConfirmed,
    publishAttempted: clickConfirmed,
    publishVerified: publishConfirmed,
    finalPublishAutomation: {
      ...base.finalPublishAutomation,
      script: '',
      finalButtonClicked: browser.finalButtonClicked === true,
      formSubmitted: false,
      pageContentReadByNoe: false,
    },
    execution: {
      command: 'osascript',
      language: 'JavaScript',
      process: processPreview(processResult),
      browser,
      stdoutReturned: false,
      publishPerformed: browser.publishPerformed === true,
      finalButtonClicked: browser.finalButtonClicked === true,
      formSubmitted: false,
      pageContentReadByNoe: false,
    },
    rollbackEvidence: rollback,
    draftExternalSideEffectPersisted: draftPersisted,
    blockers: finalRuntimeBlockers,
  };
}
