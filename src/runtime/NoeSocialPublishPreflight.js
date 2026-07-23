import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  readNoeSocialDraft,
} from './NoeSocialPublishQueue.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';

export const NOE_SOCIAL_PUBLISH_PREFLIGHT_SCHEMA_VERSION = 1;

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

function pathInside(base, target) {
  const root = resolve(base);
  const next = resolve(target);
  return next === root || next.startsWith(root + sep);
}

function resolveMediaPath(input = '', root = process.cwd()) {
  const text = clean(input, 2000);
  if (!text) return '';
  const expanded = text.startsWith('~/') ? resolve(homedir(), text.slice(2)) : text;
  return resolve(root, expanded);
}

function mediaKind(path = '') {
  const ext = extname(path).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].includes(ext)) return 'video';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return 'audio';
  if (['.txt', '.md', '.json', '.csv'].includes(ext)) return 'text-ref';
  return ext ? 'file' : 'unknown';
}

export function inspectNoeSocialMediaFiles({
  mediaFiles = [],
  root = process.cwd(),
  allowOutsideRoot = false,
} = {}) {
  const inputs = normalizeList(mediaFiles);
  const files = [];
  const errors = [];
  for (const input of inputs) {
    const absolutePath = resolveMediaPath(input, root);
    const insideRoot = pathInside(root, absolutePath);
    const item = {
      input,
      ref: insideRoot ? clean(relative(root, absolutePath), 2000) : clean(basename(absolutePath), 500),
      kind: mediaKind(absolutePath),
      exists: false,
      isFile: false,
      isSymlink: false,
      insideRoot,
      size: 0,
      contentRead: false,
    };
    if (!insideRoot && allowOutsideRoot !== true) {
      item.error = 'media_path_outside_root';
      errors.push(`media_path_outside_root:${input}`);
      files.push(item);
      continue;
    }
    if (!existsSync(absolutePath)) {
      item.error = 'media_file_not_found';
      errors.push(`media_file_not_found:${input}`);
      files.push(item);
      continue;
    }
    const lst = lstatSync(absolutePath);
    item.isSymlink = lst.isSymbolicLink();
    if (item.isSymlink) {
      item.error = 'media_path_symlink_denied';
      errors.push(`media_path_symlink_denied:${input}`);
      files.push(item);
      continue;
    }
    const stat = statSync(absolutePath);
    item.exists = true;
    item.isFile = stat.isFile();
    item.size = item.isFile ? stat.size : 0;
    if (!item.isFile) {
      item.error = 'media_path_not_file';
      errors.push(`media_path_not_file:${input}`);
    }
    files.push(item);
  }
  return {
    ok: errors.length === 0,
    files,
    errors,
    count: files.length,
    fileContentRead: false,
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

function readDraftSummary({ draftId = '', draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR } = {}) {
  const id = clean(draftId, 180);
  if (!id) return { ok: false, required: false, error: 'draft_id_missing' };
  const out = readNoeSocialDraft({ dir: draftDir, id });
  if (!out.ok) return { ok: false, required: true, error: out.error || 'social_draft_not_found', id };
  return {
    ok: true,
    id: clean(out.record?.id, 180),
    ref: out.ref,
    platform: clean(out.record?.platform, 80),
    state: clean(out.record?.state, 40),
    contentPresent: Boolean(clean(out.record?.content, 20_000)),
    title: clean(out.record?.metadata?.title || '', 300),
    mediaFiles: normalizeList(out.record?.metadata?.mediaFiles),
    externalSideEffectPerformed: out.record?.publish?.externalSideEffectPerformed === true,
    sha256: clean(out.record?.sha256, 80),
  };
}

export function runNoeSocialPublishPreflight({
  args = {},
  root = process.cwd(),
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  realExecute = false,
} = {}) {
  const draftId = clean(args.draftId || args.id || '', 180);
  const draft = readDraftSummary({ draftId, draftDir });
  const platform = normalizePlatform(args.platform || draft.platform || 'generic');
  const preset = platformPreset(platform);
  const browserState = safeJson(args.browserState);
  const activeHost = browserHost(browserState);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts : [];
  const browserMatches = Boolean(activeHost && expectedHosts.includes(activeHost));
  const mediaFiles = normalizeList(args.mediaFiles || draft.mediaFiles);
  const media = inspectNoeSocialMediaFiles({
    mediaFiles,
    root,
    allowOutsideRoot: args.allowOutsideRoot === true,
  });
  const contentPresent = Boolean(clean(args.content, 20_000)) || draft.contentPresent === true;
  const requireDraft = args.requireDraft !== false;
  const mediaRequired = args.mediaRequired === true;
  const blockers = [];
  const warnings = [];

  if (!contentPresent) blockers.push('preflight_content_required');
  if (requireDraft && !draft.ok) blockers.push(draft.error || 'social_draft_required');
  if (draft.externalSideEffectPerformed) blockers.push('draft_already_has_external_side_effect');
  if (media.errors.length) blockers.push(...media.errors);
  if (mediaRequired && media.count === 0) blockers.push('preflight_media_required');
  if (!browserState.activeBrowser && !browserState.url) warnings.push('browser_state_not_provided');
  if (activeHost && expectedHosts.length && !browserMatches) warnings.push('browser_host_mismatch');
  if (!preset.creatorUrl) warnings.push('creator_url_required_for_platform');

  const nextFreedomActions = [];
  if (!browserState.activeBrowser && !browserState.url) {
    nextFreedomActions.push({
      stepId: 'probe_browser_state',
      actionId: 'noe.freedom.browser.state_probe',
      mode: 'developer_unrestricted',
      args: { includeAll: true },
    });
  }
  if (!browserMatches && preset.creatorUrl) {
    nextFreedomActions.push({
      stepId: 'open_creator_console',
      actionId: 'noe.freedom.browser.open',
      mode: 'developer_unrestricted',
      args: { url: preset.creatorUrl },
    });
  }
  if (!draft.ok) {
    nextFreedomActions.push({
      stepId: 'prepare_publish_workflow',
      actionId: 'noe.freedom.social.workflow.prepare',
      mode: 'developer_unrestricted',
      args: {
        id: draftId || `${platform}-draft`,
        platform,
        content: clean(args.content || '', 20_000),
        title: clean(args.title || '', 300),
        mediaFiles,
      },
    });
  }
  if (blockers.length === 0 && browserMatches) {
    nextFreedomActions.push({
      stepId: 'fill_creator_form_after_owner_review',
      actionId: 'noe.freedom.macos.applescript.run',
      mode: 'developer_unrestricted',
      args: {
        language: 'jxa',
        script: '/* use owner-reviewed draft and media refs to fill the creator form; do not press final publish */',
      },
    });
  }

  const readyForAutomation = blockers.length === 0 && browserMatches;
  return {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_PUBLISH_PREFLIGHT_SCHEMA_VERSION,
    adapter: 'social-publish-preflight',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    creatorUrl: clean(preset.creatorUrl, 2000),
    browser: {
      stateProvided: Boolean(browserState.activeBrowser || browserState.url),
      activeHost,
      expectedHosts,
      matchesPlatform: browserMatches,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    },
    draft,
    media,
    readiness: {
      contentPresent,
      draftReady: requireDraft ? draft.ok === true : true,
      mediaReady: media.ok && (!mediaRequired || media.count > 0),
      browserReady: browserMatches,
      readyForAutomation,
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
      canPublishExternally: false,
      canPressFinalPublish: false,
      bypassesNoeGovernance: false,
    },
  };
}
