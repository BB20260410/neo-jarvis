import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { DEFAULT_NOE_SOCIAL_DRAFT_DIR } from './NoeSocialPublishQueue.js';
import { buildNoeSocialMediaUploadPlan } from './NoeSocialMediaUploadPlan.js';

export const NOE_SOCIAL_MEDIA_UPLOAD_EXECUTOR_SCHEMA_VERSION = 1;

const CONTROLLED_UPLOAD_HINTS = [
  '上传',
  '选择文件',
  '选择视频',
  '选择图片',
  'select file',
  'select files',
  'upload',
  'video',
  'image',
];

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

function sha256Text(value = '') {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
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

function mediaUploadFilePath(plan = {}, root = process.cwd()) {
  const files = Array.isArray(plan.media?.files) ? plan.media.files : [];
  if (files.length !== 1) return { ok: false, error: 'media_upload_single_file_required' };
  const file = files[0];
  if (file.exists !== true || file.isFile !== true) return { ok: false, error: file.error || 'media_upload_file_not_ready' };
  return {
    ok: true,
    input: clean(file.input, 2000),
    ref: clean(file.ref, 2000),
    absolutePath: resolve(root, clean(file.input, 2000)),
    kind: clean(file.kind, 80),
    size: Number(file.size) || 0,
  };
}

export function mediaUploadScriptContainsFinalPublishAction(script = '') {
  const text = String(script || '');
  return /(\.submit\s*\(|requestSubmit\s*\(|new\s+MouseEvent\s*\(\s*['"]click|KeyboardEvent\s*\(\s*['"]keydown|key\s*:\s*['"]Enter['"]\s*,\s*code\s*:\s*['"]Enter)/i.test(text);
}

function buildControlledUploadBrowserJavascript({ expectedHosts = [] } = {}) {
  const payload = {
    expectedHosts,
    hints: CONTROLLED_UPLOAD_HINTS,
    forbiddenHints: ['发布', 'publish', 'post', 'submit'],
  };
  return `
(() => {
  const payload = ${JSON.stringify(payload)};
  const host = String(location.hostname || '').toLowerCase();
  if (payload.expectedHosts.length && !payload.expectedHosts.includes(host)) {
    return { ok: false, error: 'media_upload_host_mismatch', host, expectedHosts: payload.expectedHosts };
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
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0.01
      && rect.width >= 4
      && rect.height >= 4;
  };
  const ownTextOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.className].filter(Boolean).join(' ').toLowerCase();
  const textOf = (el) => [ownTextOf(el), el.textContent].filter(Boolean).join(' ').toLowerCase();
  const forbiddenHits = (el) => {
    const text = textOf(el);
    return payload.forbiddenHints.filter((hint) => text.includes(String(hint).toLowerCase()));
  };
  const uploadHits = (el, { ownOnly = false } = {}) => {
    const text = ownOnly ? ownTextOf(el) : textOf(el);
    return payload.hints.filter((hint) => text.includes(String(hint).toLowerCase()));
  };
  const fileInputAcceptable = (el) => el && el.disabled !== true && visible(el) && forbiddenHits(el).length === 0;
  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const fileInput = fileInputs.find((el) => fileInputAcceptable(el));
  const fileInputIds = new Set(fileInputs
    .map((el) => String(el.id || '')).filter(Boolean));
  const fileInputProxy = fileInput ? null : fileInputs.map((input) => {
    let node = input.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      if (visible(node)
        && forbiddenHits(node).length === 0
        && (uploadHits(node, { ownOnly: true }).length > 0 || (depth <= 4 && uploadHits(node).length > 0))) {
        return node;
      }
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }).find(Boolean);
  const labelForFileInput = Array.from(document.querySelectorAll('label'))
    .find((el) => visible(el)
      && forbiddenHits(el).length === 0
      && (
        (el.htmlFor && fileInputIds.has(String(el.htmlFor)))
        || el.querySelector('input[type="file"]')
        || uploadHits(el).length > 0
      ));
  const uploadZoneCandidates = Array.from(document.querySelectorAll('button, [role="button"], div, section'))
    .filter((el) => visible(el) && forbiddenHits(el).length === 0 && uploadHits(el).length > 0)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const ownHitCount = uploadHits(el, { ownOnly: true }).length;
      const area = Math.max(1, rect.width * rect.height);
      return {
        el,
        score: ownHitCount > 0 ? 100 : 10,
        area,
      };
    })
    .sort((a, b) => (b.score - a.score) || (a.area - b.area));
  const uploadZone = uploadZoneCandidates[0]?.el || null;
  const target = fileInput || labelForFileInput || fileInputProxy || uploadZone;
  if (!target) {
    return { ok: false, error: 'media_upload_selector_not_found', host };
  }
  const targetForbiddenHits = forbiddenHits(target);
  if (targetForbiddenHits.length) {
    return { ok: false, error: 'media_upload_target_forbidden_publish_semantics', host, targetForbidden: true, forbiddenHits: targetForbiddenHits };
  }
  const rect = target.getBoundingClientRect();
  const clickPoint = {
    x: Math.max(1, Math.round(rect.left + Math.max(1, rect.width) / 2)),
    y: Math.max(1, Math.round(rect.top + Math.max(1, rect.height) / 2)),
    screenX: Math.max(1, Math.round(window.screenX + ((window.outerWidth - window.innerWidth) / 2) + rect.left + Math.max(1, rect.width) / 2)),
    screenY: Math.max(1, Math.round(window.screenY + (window.outerHeight - window.innerHeight) + rect.top + Math.max(1, rect.height) / 2))
  };
  return {
    ok: true,
    host,
    url: String(location.href || ''),
    targetType: fileInput ? 'file_input' : labelForFileInput ? 'file_input_label' : fileInputProxy ? 'file_input_proxy' : 'upload_zone',
    selector: cssPath(target),
    targetForbidden: false,
    forbiddenHits: [],
    uploadHintMatched: uploadHits(target).length > 0 || Boolean(fileInput || labelForFileInput || fileInputProxy),
    clickPoint,
    clickedUploadControl: false,
    finalButtonClicked: false,
    formSubmitted: false
  };
})();
`.trim();
}

export function buildNoeSocialMediaUploadExecuteScript({
  browserApp = 'Google Chrome',
  expectedHosts = [],
  mediaFilePath = '',
} = {}) {
  const browserJavascript = buildControlledUploadBrowserJavascript({ expectedHosts });
  const mediaName = basename(clean(mediaFilePath, 4000));
  const verificationJavascript = `
(() => {
  const mediaName = ${JSON.stringify(mediaName)};
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const selectedFileCount = inputs.reduce((sum, el) => sum + (el.files ? el.files.length : 0), 0);
  const url = String(location.href || '');
  const uploadPageReached = /\\/content\\/post\\/video|\\/publish\\/publish|\\/publish\\/post/i.test(url);
  const bodyText = String(document.body?.innerText || '');
  const fileNameVisible = Boolean(mediaName) && bodyText.includes(mediaName);
  const videoCount = Array.from(document.querySelectorAll('video')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }).length;
  const visibleImageCount = Array.from(document.images || []).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }).length;
  const publishSurfaceReady = uploadPageReached && /发布|暂存|封面|标题|publish/i.test(bodyText);
  const uploadedMediaDetected = fileNameVisible || videoCount > 0 || (publishSurfaceReady && visibleImageCount > 0);
  return {
    ok: true,
    url,
    fileSelected: selectedFileCount > 0 || uploadedMediaDetected,
    selectedFileCount,
    uploadPageReached,
    uploadedMediaDetected,
    fileNameVisible,
    videoCount,
    visibleImageCount,
    publishSurfaceReady,
    finalButtonClicked: false,
    formSubmitted: false
  };
})()
`.trim();
  return `
const appName = ${JSON.stringify(clean(browserApp, 120))};
const mediaFilePath = ${JSON.stringify(clean(mediaFilePath, 4000))};
const mediaName = ${JSON.stringify(mediaName)};
const app = Application(appName);
app.activate();
const windows = app.windows();
if (!windows.length) throw new Error('browser_window_required');
function frontChromeLikeWindow(windows) {
  for (let i = 0; i < windows.length; i += 1) {
    try {
      if (Number(windows[i].index()) === 1) return windows[i];
    } catch (_) {
      // fall through to first window
    }
  }
  return windows[0];
}
const tab = frontChromeLikeWindow(windows).activeTab();
const result = tab.execute({ javascript: ${JSON.stringify(browserJavascript)} });
const parsed = typeof result === 'string' ? JSON.parse(result) : result;
if (!parsed || parsed.ok === false) {
  JSON.stringify({
    ok: false,
    app: appName,
    result: parsed || { ok: false, error: 'media_upload_browser_result_missing' },
    mediaDialogAttempted: false,
    clipboardOverwritten: false,
    permissionPromptDismissedCount: 0,
    clickRetriedAfterPermissionPrompt: false,
    fileSelected: false,
    uploadStarted: false,
    finalButtonClicked: false,
    formSubmitted: false
  });
} else {
  delay(0.3);
  const currentApp = Application.currentApplication();
  currentApp.includeStandardAdditions = true;
  const point = parsed.clickPoint || {};
  if (!point.screenX || !point.screenY) throw new Error('media_upload_click_point_missing');
  let cliclickPath = '';
  try {
    cliclickPath = currentApp.doShellScript('command -v cliclick || true');
  } catch (_) {
    cliclickPath = '';
  }
  if (!cliclickPath) throw new Error('cliclick_required_for_native_file_chooser');
  const events = Application('System Events');
  function dismissBrowserPermissionPrompt() {
    try {
      const proc = events.processes.byName(appName);
      const names = proc.windows().map((win) => String(win.name() || ''));
      const matched = names.filter((name) => /权限|位置|permission|location|想获得|wants.*access/i.test(name));
      if (matched.length) {
        events.keyCode(53);
        delay(0.4);
      }
      return matched.length;
    } catch (_) {
      return 0;
    }
  }
  let permissionPromptDismissedCount = dismissBrowserPermissionPrompt();
  let geolocationShimInstalled = false;
  let geolocationShimError = '';
  try {
    const geoRaw = tab.execute({ javascript: "(() => { try { const blocked = { getCurrentPosition: (success, error) => { if (typeof error === 'function') error({ code: 1, message: 'blocked_by_noe_upload_automation' }); }, watchPosition: (success, error) => { if (typeof error === 'function') error({ code: 1, message: 'blocked_by_noe_upload_automation' }); return 0; }, clearWatch: () => {} }; Object.defineProperty(navigator, 'geolocation', { configurable: true, value: blocked }); return { ok: true, geolocationShimInstalled: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()" });
    const geo = typeof geoRaw === 'string' ? JSON.parse(geoRaw) : geoRaw;
    geolocationShimInstalled = geo?.geolocationShimInstalled === true;
    geolocationShimError = geo?.error || '';
  } catch (e) {
    geolocationShimError = String(e && e.message || e);
  }
  currentApp.doShellScript(cliclickPath + ' c:' + Math.round(point.screenX) + ',' + Math.round(point.screenY));
  parsed.clickedUploadControl = true;
  delay(0.8);
  const afterClickPermissionPromptCount = dismissBrowserPermissionPrompt();
  permissionPromptDismissedCount += afterClickPermissionPromptCount;
  const clickRetriedAfterPermissionPrompt = afterClickPermissionPromptCount > 0;
  if (clickRetriedAfterPermissionPrompt) {
    currentApp.doShellScript(cliclickPath + ' c:' + Math.round(point.screenX) + ',' + Math.round(point.screenY));
    delay(0.8);
  }
  events.keystroke('g', { using: ['command down', 'shift down'] });
  delay(0.5);
  currentApp.setTheClipboardTo(mediaFilePath);
  events.keystroke('v', { using: ['command down'] });
  delay(0.3);
  events.keyCode(36);
  delay(1.0);
  events.keyCode(36);
  delay(4);
  const verificationRaw = tab.execute({ javascript: ${JSON.stringify(verificationJavascript)} });
  const verification = typeof verificationRaw === 'string' ? JSON.parse(verificationRaw) : verificationRaw;
  const fileSelected = verification && verification.fileSelected === true;
  JSON.stringify({
    ok: fileSelected,
    app: appName,
    result: parsed,
    verification,
    mediaDialogAttempted: true,
    clipboardOverwritten: true,
    permissionPromptDismissedCount,
    clickRetriedAfterPermissionPrompt,
    geolocationShimInstalled,
    geolocationShimError,
    fileSelected,
    uploadStarted: fileSelected,
    finalButtonClicked: false,
    formSubmitted: false
  });
}
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

function parsedUploadResult(stdout = '') {
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'media_upload_execution_output_parse_failed' };
  const nested = typeof parsed.result === 'string' ? parseJson(parsed.result) : parsed.result;
  return {
    ok: parsed.ok !== false && (!nested || nested.ok !== false),
    app: clean(parsed.app, 120),
    result: nested && typeof nested === 'object' ? {
      ok: nested.ok !== false,
      host: clean(nested.host, 200),
      urlPresent: Boolean(clean(nested.url, 2000)),
      urlSha256: nested.url ? sha256Text(redactBrowserUrl(nested.url)) : '',
      targetType: clean(nested.targetType, 80),
      selector: clean(nested.selector, 500),
      targetForbidden: nested.targetForbidden === true,
      forbiddenHits: Array.isArray(nested.forbiddenHits) ? nested.forbiddenHits.map((item) => clean(item, 80)).filter(Boolean) : [],
      uploadHintMatched: nested.uploadHintMatched === true,
      clickedUploadControl: nested.clickedUploadControl === true,
      finalButtonClicked: nested.finalButtonClicked === true,
      formSubmitted: nested.formSubmitted === true,
      error: clean(nested.error || '', 500),
    } : {},
    mediaDialogAttempted: parsed.mediaDialogAttempted === true,
    clipboardOverwritten: parsed.clipboardOverwritten === true,
    permissionPromptDismissedCount: Number(parsed.permissionPromptDismissedCount) || 0,
    clickRetriedAfterPermissionPrompt: parsed.clickRetriedAfterPermissionPrompt === true,
    geolocationShimInstalled: parsed.geolocationShimInstalled === true,
    geolocationShimError: clean(parsed.geolocationShimError || '', 300),
    verification: parsed.verification && typeof parsed.verification === 'object' ? {
      ok: parsed.verification.ok !== false,
      fileSelected: parsed.verification.fileSelected === true,
      selectedFileCount: Number(parsed.verification.selectedFileCount) || 0,
      uploadPageReached: parsed.verification.uploadPageReached === true,
      uploadedMediaDetected: parsed.verification.uploadedMediaDetected === true,
      fileNameVisible: parsed.verification.fileNameVisible === true,
      videoCount: Number(parsed.verification.videoCount) || 0,
      visibleImageCount: Number(parsed.verification.visibleImageCount) || 0,
      publishSurfaceReady: parsed.verification.publishSurfaceReady === true,
      finalButtonClicked: false,
      formSubmitted: false,
    } : null,
    fileSelected: parsed.fileSelected === true,
    uploadStarted: parsed.uploadStarted === true,
    finalButtonClicked: parsed.finalButtonClicked === true || nested?.finalButtonClicked === true,
    formSubmitted: parsed.formSubmitted === true || nested?.formSubmitted === true,
  };
}

export async function executeNoeSocialMediaUpload({
  args = {},
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  root = process.cwd(),
  realExecute = false,
  deps = {},
} = {}) {
  const plan = buildNoeSocialMediaUploadPlan({ args, root, draftDir, realExecute });
  const file = mediaUploadFilePath(plan, root);
  const blockers = [...(plan.blockers || [])];
  if (!file.ok) blockers.push(file.error);
  const script = file.ok ? buildNoeSocialMediaUploadExecuteScript({
    browserApp: plan.browser?.app || args.browserApp || 'Google Chrome',
    expectedHosts: plan.browser?.expectedHosts || [],
    mediaFilePath: file.absolutePath,
  }) : '';
  const base = {
    ...plan,
    schemaVersion: NOE_SOCIAL_MEDIA_UPLOAD_EXECUTOR_SCHEMA_VERSION,
    adapter: 'social-media-upload-execute',
    plannedOnly: realExecute !== true,
    mediaSelectionAttempted: false,
    execution: null,
    selectedMedia: file.ok ? {
      ref: file.ref,
      kind: file.kind,
      size: file.size,
      contentRead: false,
    } : null,
    selectorProbe: {
      ...(plan.selectorProbe || {}),
      script: '',
      browserJavascript: '',
      fileSelected: false,
      uploadStarted: false,
      finalButtonClicked: false,
      formSubmitted: false,
    },
    uploadAutomation: file.ok ? {
      language: 'jxa',
      targetBrowser: plan.browser?.app || args.browserApp || 'Google Chrome',
      script,
      scriptGenerated: true,
      finalButtonClicked: false,
      formSubmitted: false,
    } : null,
    blockers,
    externalSideEffectPerformed: false,
    publishPerformed: false,
    fileContentRead: false,
    authority: {
      canSelectFiles: true,
      canStartUpload: true,
      canPublishExternally: false,
      canPressFinalPublish: false,
      bypassesNoeGovernance: false,
    },
  };
  if (blockers.length) return { ...base, ok: false };
  if (mediaUploadScriptContainsFinalPublishAction(script)) {
    return {
      ...base,
      ok: false,
      blockers: [...blockers, 'media_upload_script_contains_final_publish_action'],
    };
  }
  if (realExecute !== true) {
    return {
      ...base,
      ok: true,
      nextFreedomActions: [
        {
          stepId: 'execute_controlled_media_upload',
          actionId: 'noe.freedom.social.media_upload.execute',
          mode: 'developer_unrestricted',
          args,
        },
      ],
    };
  }

  const processResult = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: root,
    spawnImpl: deps.spawn || spawn,
  });
  const browser = processResult.ok ? parsedUploadResult(processResult.stdout) : { ok: false, error: 'media_upload_osascript_failed' };
  // Task 0.2 Step3: input.files may be cleared after a site consumes the file.
  // Accept either a live selected-file count or post-upload media evidence from the editor page.
  const verifiedFileCount = Number(browser.verification?.selectedFileCount) || 0;
  const uploadedMediaDetected = browser.verification?.uploadedMediaDetected === true;
  const realFileSelected = browser.fileSelected === true && (verifiedFileCount > 0 || uploadedMediaDetected);
  const runtimeBlockers = [
    ...(processResult.ok ? [] : ['media_upload_osascript_failed']),
    ...(browser.ok ? [] : [browser.error || browser.result?.error || 'media_upload_browser_result_failed']),
    ...(browser.result?.targetForbidden === true ? ['media_upload_target_forbidden_publish_semantics'] : []),
    ...(browser.finalButtonClicked === true ? ['media_upload_final_publish_click_detected'] : []),
    ...(browser.formSubmitted === true ? ['media_upload_form_submit_detected'] : []),
    ...(realFileSelected ? [] : ['media_upload_file_selection_not_confirmed']),
  ].filter(Boolean);
  return {
    ...base,
    ok: runtimeBlockers.length === 0,
    plannedOnly: false,
    mediaSelectionAttempted: true,
    externalSideEffectPerformed: runtimeBlockers.length === 0,
    execution: {
      command: 'osascript',
      language: 'JavaScript',
      process: processPreview(processResult),
      browser,
      stdoutReturned: false,
      fileSelected: realFileSelected,
      uploadStarted: realFileSelected && browser.uploadStarted === true,
      clipboardOverwritten: browser.clipboardOverwritten === true,
      finalButtonClicked: browser.finalButtonClicked === true,
      formSubmitted: browser.formSubmitted === true,
    },
    selectorProbe: {
      ...(base.selectorProbe || {}),
      fileSelected: realFileSelected,
      uploadStarted: realFileSelected && browser.uploadStarted === true,
      finalButtonClicked: browser.finalButtonClicked === true,
      formSubmitted: browser.formSubmitted === true,
    },
    blockers: runtimeBlockers,
  };
}
