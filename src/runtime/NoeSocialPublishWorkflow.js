import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  createNoeSocialDraft,
} from './NoeSocialPublishQueue.js';

export const NOE_SOCIAL_PUBLISH_WORKFLOW_SCHEMA_VERSION = 1;

export const NOE_SOCIAL_PLATFORM_PRESETS = {
  douyin: {
    label: 'Douyin Creator Center',
    creatorUrl: 'https://creator.douyin.com/',
    expectedHosts: ['creator.douyin.com'],
    tags: ['douyin', 'short-video', 'cn'],
  },
  xiaohongshu: {
    label: 'Xiaohongshu Creator Service',
    creatorUrl: 'https://creator.xiaohongshu.com/',
    expectedHosts: ['creator.xiaohongshu.com'],
    tags: ['xiaohongshu', 'note', 'cn'],
  },
  bilibili: {
    label: 'Bilibili Upload',
    creatorUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    expectedHosts: ['member.bilibili.com'],
    tags: ['bilibili', 'video', 'cn'],
  },
  wechat_channels: {
    label: 'WeChat Channels Platform',
    creatorUrl: 'https://channels.weixin.qq.com/platform',
    expectedHosts: ['channels.weixin.qq.com'],
    tags: ['wechat', 'channels', 'cn'],
  },
  youtube: {
    label: 'YouTube Studio',
    creatorUrl: 'https://studio.youtube.com/',
    expectedHosts: ['studio.youtube.com'],
    tags: ['youtube', 'video'],
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

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function normalizeStringList(value, maxItems = 20) {
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clean(item, 2000)).filter(Boolean);
  const single = clean(value, 2000);
  return single ? [single] : [];
}

function hostFromUrl(value = '') {
  try {
    return new URL(clean(value, 2000)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function platformPreset(platform = '') {
  return NOE_SOCIAL_PLATFORM_PRESETS[normalizePlatform(platform)] || {
    label: 'Generic Social Platform',
    creatorUrl: '',
    expectedHosts: [],
    tags: ['generic', 'social'],
  };
}

function activeBrowserHost(browserState = {}) {
  const state = safeJson(browserState);
  return hostFromUrl(state.activeBrowser?.url || state.url || '');
}

function buildWorkflowSteps({ platform, creatorUrl, draftId, mediaFiles, tags }) {
  return [
    {
      id: 'browser_state_probe',
      actionId: 'noe.freedom.browser.state_probe',
      purpose: 'confirm active browser/account surface before account automation',
      args: { includeAll: true },
      externalSideEffectPerformed: false,
    },
    {
      id: 'open_creator_console',
      actionId: 'noe.freedom.browser.open',
      purpose: 'open the creator console with the owner browser session',
      args: { url: creatorUrl },
      externalSideEffectPerformed: false,
    },
    {
      id: 'create_local_publish_draft',
      actionId: 'noe.freedom.social.draft.create',
      purpose: 'create local draft and rollback evidence before platform interaction',
      args: { id: draftId, platform },
      externalSideEffectPerformed: false,
    },
    {
      id: 'upload_media_or_fill_form',
      actionId: 'noe.freedom.macos.applescript.run',
      purpose: mediaFiles.length ? 'prepare UI automation for selected media files' : 'wait for media/text confirmation before UI automation',
      args: {
        language: 'jxa',
        script: tags.length
          ? '/* fill platform form and tags after owner review; do not press final publish */'
          : '/* fill platform form after owner review */',
      },
      externalSideEffectPerformed: false,
      requiresOwnerReview: true,
    },
    {
      id: 'pre_publish_check',
      purpose: 'verify title/content/media/account before pressing final publish',
      externalSideEffectPerformed: false,
      requiresOwnerReview: true,
    },
    {
      id: 'rollback_plan',
      purpose: 'record platform-side delete/edit/correction plan before any external publish',
      externalSideEffectPerformed: false,
      requiresOwnerReview: true,
    },
  ];
}

export function prepareNoeSocialPublishWorkflow({
  args = {},
  realExecute = false,
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
} = {}) {
  const platform = normalizePlatform(args.platform || args.target || 'generic');
  const preset = platformPreset(platform);
  const creatorUrl = clean(args.creatorUrl || args.targetUrl || args.url || preset.creatorUrl, 2000);
  const content = clean(args.content || args.text || args.message, 20_000);
  const title = clean(args.title || args.caption || '', 300);
  const tags = normalizeStringList(args.tags || args.tag || args.topics || args.topic, 30);
  const mediaFiles = normalizeStringList(args.mediaFiles || args.mediaFile || args.filePath || args.path);
  const draftId = clean(args.id || `${platform}-${Date.now()}`, 180);
  const browserState = safeJson(args.browserState);
  const activeHost = activeBrowserHost(browserState);
  const expectedHosts = Array.isArray(preset.expectedHosts) ? preset.expectedHosts : [];
  const warnings = [];

  if (!content) warnings.push('social_workflow_content_required');
  if (!creatorUrl) warnings.push('social_workflow_creator_url_required');
  if (activeHost && expectedHosts.length && !expectedHosts.includes(activeHost)) warnings.push('social_workflow_browser_host_mismatch');

  const steps = buildWorkflowSteps({ platform, creatorUrl, draftId, mediaFiles, tags });
  const nextFreedomActions = steps
    .filter((step) => step.actionId)
    .map((step) => ({
      stepId: step.id,
      actionId: step.actionId,
      mode: 'developer_unrestricted',
      args: step.id === 'create_local_publish_draft'
        ? { id: draftId, draftDir, platform, content, title, tags, mediaFiles }
        : step.args,
    }));
  const base = {
    ok: true,
    schemaVersion: NOE_SOCIAL_PUBLISH_WORKFLOW_SCHEMA_VERSION,
    adapter: 'social-workflow-prepare',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    creatorUrl,
    creatorHost: hostFromUrl(creatorUrl),
    tags: preset.tags,
    contentPreview: clean(content, 500),
    title,
    postTags: tags,
    mediaFiles,
    browserState: browserState.activeBrowser || browserState.url ? {
      activeHost,
      activeTitle: clean(browserState.activeBrowser?.title || browserState.title, 500),
    } : null,
    steps,
    nextFreedomActions,
    rollback: {
      requiredBeforePublish: true,
      plan: clean(args.rollbackPlan || args.rollback || 'cancel local draft before publish; edit/delete/correct post from platform console after publish', 2000),
    },
    warnings,
    draft: null,
    externalSideEffectPerformed: false,
    secretValuesReturned: false,
    publishPerformed: false,
    authority: {
      canPublishExternally: false,
      requiresSeparateFinalPublishAction: true,
      bypassesNoeGovernance: false,
    },
  };

  if (!realExecute) {
    return {
      ...base,
      valid: warnings.length === 0,
      wouldWriteDraft: warnings.length === 0,
      sha256: sha256(JSON.stringify({ ...base, sha256: undefined })),
    };
  }

  if (!content) {
    const failed = {
      ...base,
      ok: false,
      error: 'social_workflow_content_required',
      wouldWriteDraft: false,
      blockers: ['social_workflow_content_required'],
    };
    return { ...failed, sha256: sha256(JSON.stringify({ ...failed, sha256: undefined })) };
  }

  const created = createNoeSocialDraft({
    dir: draftDir,
    draft: {
      id: draftId,
      platform,
      content,
      scheduledFor: args.scheduledFor || args.scheduled_at || '',
      rollbackPlan: base.rollback.plan,
      metadata: {
        title,
        tags,
        mediaFiles,
        creatorUrl,
        workflow: 'noe.freedom.social.workflow.prepare',
      },
    },
  });
  const result = {
    ...base,
    ok: created.ok === true,
    plannedOnly: false,
    draft: created.ok ? {
      id: created.id,
      ref: created.ref,
      file: basename(created.path || ''),
      state: created.state,
      platform: created.platform,
      sha256: created.sha256,
      externalSideEffectPerformed: false,
    } : null,
    draftDir,
    wouldWriteDraft: false,
    draftWritten: created.ok === true,
    error: created.ok ? '' : clean(created.error || 'social_workflow_draft_create_failed', 500),
    blockers: created.ok ? [] : [clean(created.error || 'social_workflow_draft_create_failed', 500)],
  };
  return { ...result, sha256: sha256(JSON.stringify({ ...result, sha256: undefined })) };
}
