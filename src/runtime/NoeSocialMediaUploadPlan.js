import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  readNoeSocialDraft,
} from './NoeSocialPublishQueue.js';
import { inspectNoeSocialMediaFiles } from './NoeSocialPublishPreflight.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';

export const NOE_SOCIAL_MEDIA_UPLOAD_PLAN_SCHEMA_VERSION = 1;

const PLATFORM_UPLOAD_HINTS = {
  douyin: ['上传', '选择视频', '发布视频', '作品上传', 'upload', 'video'],
  xiaohongshu: ['上传', '选择图片', '选择视频', '笔记', 'upload', 'image', 'video'],
  bilibili: ['上传视频', '选择文件', 'video', 'upload'],
  youtube: ['select files', 'upload videos', 'upload', 'video'],
};

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
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

function normalizeList(value, maxItems = 40) {
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clean(item, 2000)).filter(Boolean);
  const single = clean(value, 2000);
  return single ? [single] : [];
}

function readDraftMedia({ draftId = '', draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR } = {}) {
  const id = clean(draftId, 180);
  if (!id) return { ok: false, error: 'draft_id_missing', mediaFiles: [] };
  const out = readNoeSocialDraft({ dir: draftDir, id });
  if (!out.ok) return { ok: false, error: out.error || 'social_draft_not_found', id, mediaFiles: [] };
  return {
    ok: true,
    id: clean(out.record?.id, 180),
    ref: out.ref,
    platform: clean(out.record?.platform, 80),
    state: clean(out.record?.state, 40),
    mediaFiles: normalizeList(out.record?.metadata?.mediaFiles),
    externalSideEffectPerformed: out.record?.publish?.externalSideEffectPerformed === true,
    sha256: clean(out.record?.sha256, 80),
  };
}

function browserHost(browserState = {}) {
  const state = safeJson(browserState);
  const explicitHost = clean(state.activeBrowser?.host || state.host, 200).toLowerCase();
  if (explicitHost) return explicitHost.replace(/^https?:\/\//, '').split('/')[0];
  try {
    return new URL(clean(state.activeBrowser?.url || state.url, 2000)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function buildSelectorProbeJavascript({ platform, expectedHosts }) {
  const hints = PLATFORM_UPLOAD_HINTS[platform] || ['upload', '上传', '选择文件', 'select file'];
  const payload = { expectedHosts, hints };
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
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 0 && rect.height >= 0;
  };
  const textOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.className, el.textContent].filter(Boolean).join(' ').toLowerCase();
  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
    selector: cssPath(el),
    accept: el.getAttribute('accept') || '',
    multiple: el.multiple === true,
    visible: visible(el),
    disabled: el.disabled === true
  })).slice(0, 20);
  const uploadZones = Array.from(document.querySelectorAll('button, [role="button"], label, div, section'))
    .filter((el) => payload.hints.some((hint) => textOf(el).includes(String(hint).toLowerCase())))
    .map((el) => ({ selector: cssPath(el), text: String(el.textContent || '').trim().slice(0, 120), visible: visible(el) }))
    .slice(0, 20);
  return {
    ok: true,
    host,
    fileInputs,
    uploadZones,
    finalButtonClicked: false,
    fileSelected: false,
    uploadStarted: false,
    formSubmitted: false
  };
})();
`.trim();
}

function buildJxaProbeScript({ browserApp, browserJavascript }) {
  return `
const appName = ${JSON.stringify(browserApp)};
const app = Application(appName);
app.activate();
const windows = app.windows();
if (!windows.length) throw new Error('browser_window_required');
const tab = windows[0].activeTab();
const result = tab.execute({ javascript: ${JSON.stringify(browserJavascript)} });
JSON.stringify({
  ok: true,
  app: appName,
  result,
  finalButtonClicked: false,
  fileSelected: false,
  uploadStarted: false,
  formSubmitted: false
});
`.trim();
}

export function buildNoeSocialMediaUploadPlan({
  args = {},
  root = process.cwd(),
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  realExecute = false,
} = {}) {
  const draft = readDraftMedia({ draftId: args.draftId || args.id, draftDir });
  const platform = normalizePlatform(args.platform || draft.platform || 'generic');
  const preset = platformPreset(platform);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts : [];
  const browserState = safeJson(args.browserState);
  const activeHost = browserHost(browserState);
  const browserMatches = Boolean(activeHost && expectedHosts.includes(activeHost));
  const mediaRefs = normalizeList(args.mediaFiles || draft.mediaFiles);
  const media = inspectNoeSocialMediaFiles({
    mediaFiles: mediaRefs,
    root,
    allowOutsideRoot: args.allowOutsideRoot === true,
  });
  const browserApp = clean(args.browserApp || 'Google Chrome', 120);
  const browserJavascript = buildSelectorProbeJavascript({ platform, expectedHosts });
  const jxaScript = buildJxaProbeScript({ browserApp, browserJavascript });
  const requireBrowserMatch = args.requireBrowserMatch !== false;
  const blockers = [];
  const warnings = [];

  if (!draft.ok && args.requireDraft !== false) blockers.push(draft.error || 'social_draft_not_found');
  if (draft.externalSideEffectPerformed) blockers.push('draft_already_has_external_side_effect');
  if (media.errors.length) blockers.push(...media.errors);
  if (media.count === 0) blockers.push('media_upload_media_required');
  if (!activeHost) warnings.push('browser_state_not_provided');
  if (activeHost && expectedHosts.length && !browserMatches) {
    const issue = 'media_upload_browser_host_mismatch';
    if (requireBrowserMatch) blockers.push(issue);
    else warnings.push(issue);
  }

  const nextFreedomActions = [];
  if (!browserMatches && preset.creatorUrl) {
    nextFreedomActions.push({
      stepId: 'open_creator_console',
      actionId: 'noe.freedom.browser.open',
      mode: 'developer_unrestricted',
      args: { url: preset.creatorUrl },
    });
  }
  if (!activeHost) {
    nextFreedomActions.push({
      stepId: 'probe_browser_state',
      actionId: 'noe.freedom.browser.state_probe',
      mode: 'developer_unrestricted',
      args: { includeAll: true },
    });
  }
  if (blockers.length === 0) {
    nextFreedomActions.push({
      stepId: 'probe_upload_selectors',
      actionId: 'noe.freedom.macos.applescript.run',
      mode: 'developer_unrestricted',
      args: { language: 'jxa', script: jxaScript },
    });
  }

  return {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_MEDIA_UPLOAD_PLAN_SCHEMA_VERSION,
    adapter: 'social-media-upload-plan',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    draft: draft.ok ? {
      id: draft.id,
      ref: draft.ref,
      platform: draft.platform,
      state: draft.state,
      mediaCount: draft.mediaFiles.length,
      sha256: draft.sha256,
      externalSideEffectPerformed: false,
    } : { ok: false, error: draft.error || 'social_draft_not_found' },
    browser: {
      app: browserApp,
      activeHost,
      expectedHosts,
      matchesPlatform: browserMatches,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    },
    media,
    selectorProbe: {
      language: 'jxa',
      targetBrowser: browserApp,
      script: jxaScript,
      browserJavascript,
      scriptGenerated: true,
      fileSelected: false,
      uploadStarted: false,
      finalButtonClicked: false,
      formSubmitted: false,
    },
    readiness: {
      mediaReady: media.ok && media.count > 0,
      browserReady: browserMatches,
      readyForSelectorProbe: blockers.length === 0,
      finalPublishAllowedByThisTool: false,
    },
    nextFreedomActions,
    blockers,
    warnings,
    externalSideEffectPerformed: false,
    publishPerformed: false,
    fileContentRead: false,
    secretValuesReturned: false,
    authority: {
      canSelectFiles: false,
      canStartUpload: false,
      canPublishExternally: false,
      canPressFinalPublish: false,
      bypassesNoeGovernance: false,
    },
  };
}
