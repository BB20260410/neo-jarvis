import { createHash } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { buildNoeSocialDomRecipeAction } from './NoeSocialDomRecipe.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';

export const NOE_ACCOUNT_CONNECTION_INVENTORY_SCHEMA_VERSION = 1;

const SOCIAL_ACTION_CHAIN = [
  'noe.freedom.browser.state_probe',
  'noe.freedom.browser.open',
  'noe.freedom.browser.dom.execute',
  'noe.freedom.social.workflow.prepare',
  'noe.freedom.social.preflight.run',
  'noe.freedom.social.form_fill.plan',
  'noe.freedom.social.form_fill.execute',
  'noe.freedom.social.media_upload.prepare',
  'noe.freedom.social.media_upload.execute',
  'noe.freedom.social.final_publish.execute',
];

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

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hostFromUrl(value = '') {
  try {
    return new URL(clean(value, 2000)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function originFromUrl(value = '') {
  try {
    return new URL(clean(value, 2000)).origin;
  } catch {
    return '';
  }
}

function slug(value = '', fallback = 'account') {
  return clean(value || fallback, 180).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function redactBrowserUrl(value = '') {
  const raw = clean(value, 2000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
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
    return raw.replace(/([?&#][^=]*?(?:token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#]+/gi, '$1[redacted]');
  }
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function normalizeStringList(value, fallback = []) {
  const input = Array.isArray(value) ? value : clean(value, 1000) ? [value] : fallback;
  return [...new Set(input.map((item) => normalizePlatform(item)).filter(Boolean))];
}

function normalizePlainList(value, maxItems = 20) {
  const input = Array.isArray(value) ? value : clean(value, 2000) ? [value] : [];
  return input.slice(0, maxItems).map((item) => clean(item, 2000)).filter(Boolean);
}

function activeBrowsers(browserState = {}) {
  const state = safeJson(browserState);
  const out = [];
  const push = (item = {}) => {
    const rawUrl = clean(item.url || item.activeUrl || '', 2000);
    const host = hostFromUrl(rawUrl);
    if (!host) return;
    out.push({
      app: clean(item.app || item.browser || state.frontmostApp || '', 120),
      host,
      url: redactBrowserUrl(rawUrl),
      title: clean(item.title || '', 500),
      frontmost: item.frontmost === true || out.length === 0,
    });
  };
  push(state.activeBrowser || state);
  for (const item of Array.isArray(state.browsers) ? state.browsers : []) push(item);
  return out.filter((item, index, arr) => arr.findIndex((next) => next.host === item.host && next.url === item.url) === index);
}

function presetFor(platform = '') {
  const id = normalizePlatform(platform);
  const preset = NOE_SOCIAL_PLATFORM_PRESETS[id];
  if (preset) return { id, ...preset };
  return {
    id,
    label: clean(platform || 'Generic Social Platform', 120),
    creatorUrl: '',
    expectedHosts: [],
    tags: ['custom', 'social'],
  };
}

function inferPageStage(browser = {}, platform = '') {
  if (!browser?.host) return { stage: 'not_active', confidence: 0, reasons: [] };
  const text = `${browser.url || ''} ${browser.title || ''} ${platform || ''}`.toLowerCase();
  const reasons = [];
  if (/upload|publish|post|create|editor|studio|video|note|content|发布|上传|投稿|作品|笔记/.test(text)) reasons.push('publish_surface_keyword');
  if (/draft|草稿/.test(text)) reasons.push('draft_surface_keyword');
  if (/dashboard|home|platform|creator|studio|console|工作台|首页/.test(text)) reasons.push('creator_console_keyword');
  if (reasons.includes('publish_surface_keyword')) return { stage: 'publish_editor', confidence: 0.86, reasons };
  if (reasons.includes('draft_surface_keyword')) return { stage: 'draft_list', confidence: 0.78, reasons };
  if (reasons.includes('creator_console_keyword')) return { stage: 'creator_console', confidence: 0.68, reasons };
  return { stage: 'active_creator_host', confidence: 0.55, reasons: ['host_match'] };
}

function activeBrowserState(browser = {}) {
  if (!browser) return {};
  return {
    activeBrowser: {
      app: browser.app,
      url: browser.url,
      title: browser.title,
      frontmost: browser.frontmost === true,
    },
  };
}

function socialDomFillActionForConnection({
  platform,
  browser,
  title = '',
  content = '',
  mediaFiles = [],
  browserApp = 'Google Chrome',
  includeMediaPicker = false,
  includeFinalPublishAction = false,
} = {}) {
  if (!browser?.host) return null;
  if (!clean(title, 300) && !clean(content, 20_000) && includeMediaPicker !== true && includeFinalPublishAction !== true) return null;
  return buildNoeSocialDomRecipeAction({
    platform,
    browserApp,
    expectedHost: browser.host,
    title,
    content,
    mediaFiles,
    includeMediaPicker,
    includeFinalPublishAction,
    stepId: `dom_fill_${platform}_fields_from_active_page`,
  });
}

function ownerAuthorizedAccountTargets({
  browsers = [],
  connections = [],
  args = {},
} = {}) {
  const maxTargets = Math.max(1, Math.min(20, Number(args.maxOwnerAccountTargets) || 8));
  const socialByHost = new Map();
  for (const connection of connections) {
    for (const host of Array.isArray(connection.expectedHosts) ? connection.expectedHosts : []) {
      socialByHost.set(host, connection.platform);
    }
  }
  return browsers.slice(0, maxTargets).map((browser, index) => {
    const socialPlatform = socialByHost.get(browser.host) || '';
    const origin = originFromUrl(browser.url);
    const targetId = `owner_account_${slug(socialPlatform || browser.host || `target_${index + 1}`)}`;
    return {
      targetId,
      kind: 'browser_logged_in_account',
      app: browser.app,
      host: browser.host,
      origin,
      urlPreview: browser.url,
      title: browser.title,
      frontmost: browser.frontmost === true,
      socialPlatform: socialPlatform || null,
      accountAccess: {
        usesExistingLoginSession: true,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        secretValuesReturned: false,
      },
      authority: {
        developerModeCanControl: true,
        canUseBrowserAutomation: true,
        canUseLoggedInAccount: true,
        canReadSecrets: false,
        canBypassPlatform2faOrRiskControls: false,
      },
      nextFreedomActions: [
        {
          stepId: `probe_${slug(browser.host, 'account')}_state`,
          actionId: 'noe.freedom.browser.state_probe',
          mode: 'developer_unrestricted',
          args: { includeAll: true },
        },
        {
          stepId: `dom_probe_${slug(browser.host, 'account')}_read_title`,
          actionId: 'noe.freedom.browser.dom.execute',
          mode: 'developer_unrestricted',
          args: {
            browserApp: browser.app || 'Google Chrome',
            expectedHost: browser.host,
            actions: [{ type: 'read_title' }],
          },
        },
        ...(origin ? [{
          stepId: `open_${slug(browser.host, 'account')}_account_origin`,
          actionId: 'noe.freedom.browser.open',
          mode: 'developer_unrestricted',
          args: { url: origin },
        }] : []),
      ],
    };
  });
}

function inferredActionsForConnection({
  connection,
  browser,
  args = {},
} = {}) {
  if (!connection || !browser) return [];
  const platform = connection.platform;
  const draftId = clean(args.draftId || args.id || '', 180);
  const title = clean(args.title || args.caption || '', 300);
  const content = clean(args.content || args.text || args.message || '', 20_000);
  const mediaFiles = normalizePlainList(args.mediaFiles || args.mediaFile || args.filePath || args.path);
  const browserState = activeBrowserState(browser);
  const browserApp = clean(args.browserApp || browser.app || 'Google Chrome', 120);
  const actions = [
    {
      stepId: `orchestrate_${platform}_from_active_page`,
      actionId: 'noe.freedom.social.publish_orchestrate',
      mode: 'developer_unrestricted',
      args: {
        platform,
        title,
        content,
        mediaFiles,
        browserState,
        browserApp,
        includeFinalPublish: args.includeFinalPublishAction === true,
      },
    },
    {
      stepId: `prepare_${platform}_workflow_from_active_page`,
      actionId: 'noe.freedom.social.workflow.prepare',
      mode: 'developer_unrestricted',
      args: {
        platform,
        title,
        content,
        mediaFiles,
        browserState,
      },
    },
  ];
  const domFill = socialDomFillActionForConnection({
    platform,
    browser,
    title,
    content,
    mediaFiles,
    browserApp,
    includeMediaPicker: args.includeMediaPickerAction === true,
    includeFinalPublishAction: args.includeFinalPublishAction === true,
  });
  if (domFill) actions.push(domFill);
  if (draftId) {
    actions.push(
      {
        stepId: `preflight_${platform}_draft_from_active_page`,
        actionId: 'noe.freedom.social.preflight.run',
        mode: 'developer_unrestricted',
        args: {
          platform,
          draftId,
          mediaFiles,
          browserState,
        },
      },
      {
        stepId: `build_${platform}_form_fill_plan_from_active_page`,
        actionId: 'noe.freedom.social.form_fill.plan',
        mode: 'developer_unrestricted',
        args: {
          platform,
          draftId,
          browserState,
          browserApp,
        },
      },
    );
    if (mediaFiles.length) {
      actions.push({
        stepId: `build_${platform}_media_upload_plan_from_active_page`,
        actionId: 'noe.freedom.social.media_upload.prepare',
        mode: 'developer_unrestricted',
        args: {
          platform,
          draftId,
          mediaFiles,
          browserState,
          browserApp,
        },
      });
    }
    if (args.includeFinalPublishAction === true) {
      actions.push({
        stepId: `execute_${platform}_final_publish_from_active_page`,
        actionId: 'noe.freedom.social.final_publish.execute',
        mode: 'developer_unrestricted',
        args: {
          platform,
          draftId,
          browserState,
          browserApp,
        },
      });
    }
  }
  return actions;
}

function platformConnection({ platform, browsers = [], args = {} } = {}) {
  const preset = presetFor(platform);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts.map((host) => clean(host, 200).toLowerCase()).filter(Boolean) : [];
  const matched = browsers.find((browser) => expectedHosts.includes(browser.host));
  const pageState = matched ? inferPageStage(matched, preset.id) : { stage: 'not_active', confidence: 0, reasons: [] };
  const connection = {
    platform: preset.id,
    label: clean(preset.label, 160),
    creatorUrl: clean(preset.creatorUrl, 2000),
    expectedHosts,
    tags: Array.isArray(preset.tags) ? preset.tags.map((tag) => clean(tag, 80)).filter(Boolean) : [],
    status: matched ? 'active_browser_match' : 'known_platform',
    browser: matched ? {
      app: matched.app,
      host: matched.host,
      url: matched.url,
      title: matched.title,
      frontmost: matched.frontmost,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    } : null,
    activePage: matched ? {
      platform: preset.id,
      host: matched.host,
      stage: pageState.stage,
      confidence: pageState.confidence,
      reasons: pageState.reasons,
      browserState: activeBrowserState(matched),
      inferredOnly: true,
    } : null,
    actionChain: SOCIAL_ACTION_CHAIN.map((actionId) => ({
      actionId,
      mode: 'developer_unrestricted',
      canUseLoggedInAccount: actionId !== 'noe.freedom.social.workflow.prepare',
      canPublishExternally: actionId === 'noe.freedom.social.final_publish.execute',
    })),
    requiredBeforePublish: [
      'browser_state_probe',
      'local_draft',
      'platform_preflight',
      'form_fill_verification',
      'media_upload_verification_if_needed',
      'rollback_plan',
    ],
    requiredAfterPublish: [
      'post_url_or_title_ref',
      'browser_state_probe',
      'platform_delete_hide_or_correction_path',
    ],
    sensitiveCapabilities: [
      'logged_in_account_session',
      'file_upload',
      'external_publish',
    ],
  };
  return {
    ...connection,
    inferredNextFreedomActions: inferredActionsForConnection({ connection, browser: matched, args }),
  };
}

export function buildNoeAccountConnectionInventory({
  args = {},
  realExecute = false,
} = {}) {
  const browsers = activeBrowsers(args.browserState);
  const requestedPlatforms = normalizeStringList(
    args.platforms || args.platform,
    Object.keys(NOE_SOCIAL_PLATFORM_PRESETS),
  );
  const connections = requestedPlatforms.map((platform) => platformConnection({ platform, browsers, args }));
  const inferredNextActions = connections.flatMap((connection) => connection.inferredNextFreedomActions || []);
  const ownerTargets = ownerAuthorizedAccountTargets({ browsers, connections, args });
  const ownerTargetActions = ownerTargets.flatMap((target) => target.nextFreedomActions || []);
  const out = {
    ok: true,
    schemaVersion: NOE_ACCOUNT_CONNECTION_INVENTORY_SCHEMA_VERSION,
    adapter: 'account-connection-inventory',
    plannedOnly: realExecute !== true,
    realExecute: realExecute === true,
    platformsChecked: requestedPlatforms,
    activeBrowserHosts: browsers.map((browser) => ({
      app: browser.app,
      host: browser.host,
      url: browser.url,
      title: browser.title,
      frontmost: browser.frontmost,
    })),
    ownerAuthorizedAccountTargets: ownerTargets,
    connections,
    recommendedNextFreedomActions: [
      {
        stepId: 'refresh_browser_state',
        actionId: 'noe.freedom.browser.state_probe',
        mode: 'developer_unrestricted',
        args: { includeAll: true },
      },
      ...ownerTargetActions,
      ...inferredNextActions,
      ...connections.map((connection) => ({
        stepId: `open_${connection.platform}_creator`,
        actionId: 'noe.freedom.browser.open',
        mode: 'developer_unrestricted',
        args: { url: connection.creatorUrl },
      })).filter((item) => item.args.url),
    ],
    externalSideEffectPerformed: false,
    publishPerformed: false,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    authority: {
      canUseLoggedInAccounts: true,
      canControlOwnerAuthorizedAccounts: true,
      canPublishExternally: false,
      canReadSecrets: false,
      bypassesNoeGovernance: false,
      inventoryOnly: true,
    },
  };
  return {
    ...out,
    sha256: sha256(JSON.stringify({ ...out, sha256: undefined })),
  };
}
