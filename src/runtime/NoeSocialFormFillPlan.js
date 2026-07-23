import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  readNoeSocialDraft,
} from './NoeSocialPublishQueue.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';

export const NOE_SOCIAL_FORM_FILL_PLAN_SCHEMA_VERSION = 1;

const PLATFORM_FIELD_HINTS = {
  douyin: {
    title: ['title', '标题', '作品标题'],
    content: ['description', 'desc', '描述', '简介', '作品描述', '文案'],
  },
  xiaohongshu: {
    title: ['title', '标题'],
    content: ['content', '正文', '描述', '笔记正文', '文案'],
  },
  bilibili: {
    title: ['title', '标题'],
    content: ['description', 'desc', '简介', '视频简介'],
  },
  youtube: {
    title: ['title', 'Title'],
    content: ['description', 'Description'],
  },
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

function readDraftForFormFill({ draftId = '', draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR } = {}) {
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
    content: clean(out.record?.content, 20_000),
    title: clean(out.record?.metadata?.title || '', 300),
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

function buildBrowserFillJavascript({ platform, expectedHosts, title, content }) {
  const hints = PLATFORM_FIELD_HINTS[platform] || PLATFORM_FIELD_HINTS.douyin;
  const payload = {
    expectedHosts,
    title,
    content,
    titleHints: hints.title,
    contentHints: hints.content,
  };
  return `
(() => {
  const payload = ${JSON.stringify(payload)};
  const host = String(location.hostname || '').toLowerCase();
  if (payload.expectedHosts.length && !payload.expectedHosts.includes(host)) {
    return { ok: false, error: 'form_fill_host_mismatch', host, expectedHosts: payload.expectedHosts };
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
  const editable = (el) => visible(el) && el.disabled !== true && el.readOnly !== true;
  const fields = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(editable);
  const textOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.className, el.textContent].filter(Boolean).join(' ').toLowerCase();
  const findByHints = (hints, fallback, excluded = []) => {
    const found = fields.find((el) => !excluded.includes(el) && hints.some((hint) => textOf(el).includes(String(hint).toLowerCase())));
    if (found) return found;
    return fallback && !excluded.includes(fallback) ? fallback : null;
  };
  const setText = (el, value) => {
    if (!el || !value) return false;
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const readText = (el) => {
    if (!el) return '';
    return String(el.isContentEditable ? el.textContent : el.value || '');
  };
  const titleFallback = fields.find((el) => String(el.tagName || '').toLowerCase() === 'input') || null;
  const titleField = findByHints(payload.titleHints, titleFallback);
  const contentFallback = fields.find((el) => el !== titleField && String(el.tagName || '').toLowerCase() === 'textarea')
    || fields.find((el) => el !== titleField && el.isContentEditable)
    || null;
  const contentField = findByHints(payload.contentHints, contentFallback, [titleField].filter(Boolean));
  const titleFilled = setText(titleField, payload.title);
  const contentFilled = setText(contentField, payload.content);
  return {
    ok: true,
    host,
    titleFilled,
    contentFilled,
    titleEchoMatched: titleFilled ? readText(titleField).includes(payload.title) : false,
    contentEchoMatched: contentFilled ? readText(contentField).includes(payload.content) : false,
    titleSelector: cssPath(titleField),
    contentSelector: cssPath(contentField),
    titleTag: titleField ? String(titleField.tagName || '').toLowerCase() : '',
    contentTag: contentField ? String(contentField.tagName || '').toLowerCase() : '',
    sameField: Boolean(titleField && contentField && titleField === contentField),
    mediaHandled: false,
    finalButtonClicked: false,
    formSubmitted: false
  };
})();
`.trim();
}

function buildJxaScript({ browserApp, browserJavascript }) {
  return `
const appName = ${JSON.stringify(browserApp)};
const app = Application(appName);
app.activate();
const windows = app.windows();
if (!windows.length) throw new Error('browser_window_required');
function frontChromeLikeWindow(allWindows) {
  const indexed = allWindows.map((window) => {
    let index = 9999;
    try { index = Number(window.index()); } catch (_) {}
    return { window, index };
  }).sort((a, b) => a.index - b.index);
  return indexed[0].window;
}
const tab = frontChromeLikeWindow(windows).activeTab();
const result = tab.execute({ javascript: ${JSON.stringify(browserJavascript)} });
JSON.stringify({
  ok: true,
  app: appName,
  result,
  finalButtonClicked: false,
  formSubmitted: false
});
`.trim();
}

export function buildNoeSocialFormFillPlan({
  args = {},
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  realExecute = false,
} = {}) {
  const draft = readDraftForFormFill({ draftId: args.draftId || args.id, draftDir });
  const platform = normalizePlatform(args.platform || draft.platform || 'generic');
  const preset = platformPreset(platform);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts : [];
  const browserState = safeJson(args.browserState);
  const activeHost = browserHost(browserState);
  const browserMatches = Boolean(activeHost && expectedHosts.includes(activeHost));
  const title = clean(args.title || draft.title || '', 300);
  const content = clean(args.content || draft.content || '', 20_000);
  const mediaFiles = normalizeList(args.mediaFiles || draft.mediaFiles);
  const browserApp = clean(args.browserApp || 'Google Chrome', 120);
  const requireBrowserMatch = args.requireBrowserMatch !== false;
  const blockers = [];
  const warnings = [];

  if (!draft.ok) blockers.push(draft.error || 'social_draft_not_found');
  if (draft.externalSideEffectPerformed) blockers.push('draft_already_has_external_side_effect');
  if (!content) blockers.push('form_fill_content_required');
  if (!title) warnings.push('form_fill_title_missing');
  if (!activeHost) warnings.push('browser_state_not_provided');
  if (activeHost && expectedHosts.length && !browserMatches) {
    const issue = 'form_fill_browser_host_mismatch';
    if (requireBrowserMatch) blockers.push(issue);
    else warnings.push(issue);
  }

  const browserJavascript = buildBrowserFillJavascript({ platform, expectedHosts, title, content });
  const jxaScript = buildJxaScript({ browserApp, browserJavascript });
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
      stepId: 'run_form_fill_script',
      actionId: 'noe.freedom.macos.applescript.run',
      mode: 'developer_unrestricted',
      args: { language: 'jxa', script: jxaScript },
    });
  }

  return {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_FORM_FILL_PLAN_SCHEMA_VERSION,
    adapter: 'social-form-fill-plan',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    draft: draft.ok ? {
      id: draft.id,
      ref: draft.ref,
      platform: draft.platform,
      state: draft.state,
      contentPresent: Boolean(content),
      titlePresent: Boolean(title),
      mediaCount: mediaFiles.length,
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
    automation: {
      language: 'jxa',
      targetBrowser: browserApp,
      script: jxaScript,
      browserJavascript,
      scriptGenerated: true,
      mediaHandledByScript: false,
      finalButtonClicked: false,
      formSubmitted: false,
    },
    previews: {
      title,
      content,
      mediaFiles,
    },
    nextFreedomActions,
    blockers,
    warnings,
    externalSideEffectPerformed: false,
    publishPerformed: false,
    secretValuesReturned: false,
    authority: {
      canPublishExternally: false,
      canPressFinalPublish: false,
      bypassesNoeGovernance: false,
    },
  };
}
