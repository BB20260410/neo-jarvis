import { redactSensitiveText } from './NoeContextScrubber.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';

export const NOE_SOCIAL_DOM_RECIPE_SCHEMA_VERSION = 1;

export const NOE_SOCIAL_DOM_RECIPES = {
  douyin: {
    creatorEntryHints: ['发布作品', '发布视频', '上传视频', '上传', '创作', '投稿'],
    titleHints: ['title', '标题', '作品标题'],
    contentHints: ['description', 'desc', '描述', '简介', '作品描述', '文案'],
    tagHints: ['tag', 'tags', '话题', '标签', '添加话题', '添加标签'],
    mediaHints: ['上传', '选择文件', '视频', '添加视频', 'upload'],
    finalPublishHints: ['发布', '立即发布', 'publish'],
  },
  xiaohongshu: {
    creatorEntryHints: ['发布笔记', '创建笔记', '发布作品', '去发布', '立即发布', '发布', '发表', '上传', '创作', '笔记'],
    titleHints: ['title', '标题'],
    contentHints: ['content', '正文', '描述', '笔记正文', '文案'],
    tagHints: ['tag', 'tags', '话题', '标签', '添加话题', '添加标签'],
    mediaHints: ['上传', '选择文件', '添加图片', '添加视频', 'upload'],
    finalPublishHints: ['发布', '立即发布', 'publish'],
  },
  bilibili: {
    creatorEntryHints: ['投稿', '上传', '发布视频', '创作'],
    titleHints: ['title', '标题'],
    contentHints: ['description', 'desc', '简介', '视频简介'],
    tagHints: ['tag', 'tags', '标签', '分区标签'],
    mediaHints: ['上传', '选择文件', '视频', 'upload'],
    finalPublishHints: ['投稿', '发布', '立即投稿', 'publish'],
  },
  wechat_channels: {
    creatorEntryHints: ['发表', '发布', '上传', '创作'],
    titleHints: ['title', '标题'],
    contentHints: ['description', 'desc', '简介', '文案'],
    tagHints: ['tag', 'tags', '话题', '标签'],
    mediaHints: ['上传', '选择文件', '视频', 'upload'],
    finalPublishHints: ['发表', '发布', 'publish'],
  },
  youtube: {
    creatorEntryHints: ['Create', 'Upload videos', 'Upload', '创建', '上传'],
    titleHints: ['title', 'Title'],
    contentHints: ['description', 'Description'],
    tagHints: ['tags', 'Tags'],
    mediaHints: ['upload', 'Select files', '选择文件'],
    finalPublishHints: ['Publish', '发布'],
  },
};

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function normalizeList(value, maxItems = 20) {
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clean(item, 300)).filter(Boolean);
  const single = clean(value, 300);
  return single ? [single] : [];
}

function presetForPlatform(platform = '') {
  const id = normalizePlatform(platform);
  return NOE_SOCIAL_PLATFORM_PRESETS[id] || {
    label: clean(platform || 'Generic Social Platform', 120),
    expectedHosts: [],
    creatorUrl: '',
    tags: ['custom', 'social'],
  };
}

export function socialDomRecipeForPlatform(platform = '') {
  const id = normalizePlatform(platform);
  const recipe = NOE_SOCIAL_DOM_RECIPES[id] || {
    titleHints: ['title', '标题'],
    creatorEntryHints: ['publish', '发布', 'upload', '上传', 'create', '创作'],
    contentHints: ['content', 'description', '正文', '描述'],
    tagHints: ['tag', 'tags', '标签', '话题'],
    mediaHints: ['upload', '上传', '选择文件'],
    finalPublishHints: ['publish', '发布'],
  };
  return {
    platform: id,
    creatorEntryHints: normalizeList(recipe.creatorEntryHints),
    titleHints: normalizeList(recipe.titleHints),
    contentHints: normalizeList(recipe.contentHints),
    tagHints: normalizeList(recipe.tagHints),
    mediaHints: normalizeList(recipe.mediaHints),
    finalPublishHints: normalizeList(recipe.finalPublishHints),
  };
}

export function buildNoeSocialDomRecipeAction({
  platform = 'generic',
  browserApp = 'Google Chrome',
  expectedHost = '',
  expectedHosts = [],
  title = '',
  content = '',
  tags = [],
  mediaFiles = [],
  includeMediaPicker = false,
  includeFinalPublishAction = false,
  includeCreatorEntryProbe = false,
  stepId = '',
} = {}) {
  void includeCreatorEntryProbe;   // 预留开关（声明未实现）；保留参数名维持调用方 API 兼容（2026-06-10 清 lint）
  const normalizedPlatform = normalizePlatform(platform);
  const recipe = socialDomRecipeForPlatform(normalizedPlatform);
  const hosts = normalizeList(expectedHosts);
  const host = clean(expectedHost || hosts[0] || '', 240);
  const mediaCount = Array.isArray(mediaFiles) ? mediaFiles.length : clean(mediaFiles, 2000) ? 1 : 0;
  const actions = [{ type: 'read_title' }];
  if (clean(title, 300)) {
    actions.push({
      type: 'set_by_hints',
      role: 'title',
      hints: recipe.titleHints,
      value: clean(title, 300),
    });
  }
  if (clean(content, 20_000)) {
    actions.push({
      type: 'set_by_hints',
      role: 'content',
      hints: recipe.contentHints,
      value: clean(content, 20_000),
    });
  }
  const tagList = normalizeList(tags, 30);
  if (tagList.length) {
    actions.push({
      type: 'set_by_hints',
      role: 'tags',
      hints: recipe.tagHints,
      value: tagList.join(' '),
    });
  }
  if (includeMediaPicker === true && mediaCount > 0) {
    actions.push({
      type: 'click_by_hints',
      role: 'media_upload',
      hints: recipe.mediaHints,
    });
  }
  if (includeFinalPublishAction === true) {
    actions.push({
      type: 'click_by_hints',
      role: 'final_publish',
      hints: recipe.finalPublishHints,
    });
  }
  return {
    stepId: clean(stepId || `dom_recipe_${normalizedPlatform}_active_page`, 160),
    actionId: 'noe.freedom.browser.dom.execute',
    mode: 'developer_unrestricted',
    args: {
      browserApp: clean(browserApp || 'Google Chrome', 120) || 'Google Chrome',
      ...(host ? { expectedHost: host } : {}),
      actions,
    },
    recipe: {
      schemaVersion: NOE_SOCIAL_DOM_RECIPE_SCHEMA_VERSION,
      platform: normalizedPlatform,
      mediaCount,
      tagCount: tagList.length,
      includeMediaPicker: includeMediaPicker === true,
      includeFinalPublishAction: includeFinalPublishAction === true,
    },
  };
}

export function buildNoeSocialDomRecipeProbeAction({
  platform = 'generic',
  browserApp = 'Google Chrome',
  expectedHost = '',
  expectedHosts = [],
  title = '',
  content = '',
  tags = [],
  mediaFiles = [],
  includeMediaPicker = false,
  includeFinalPublishAction = false,
  includeCreatorEntryProbe = false,
  stepId = '',
} = {}) {
  const action = buildNoeSocialDomRecipeAction({
    platform,
    browserApp,
    expectedHost,
    expectedHosts,
    title,
    content,
    tags,
    mediaFiles,
    includeMediaPicker,
    includeFinalPublishAction,
    stepId: stepId || '',
  });
  const probeActions = action.args.actions.map((item) => {
    if (item.type === 'read_title') return item;
    if (item.type === 'click_by_hints') {
      return {
        type: 'probe_by_hints',
        role: item.role,
        probeTarget: 'clickable',
        hints: item.hints,
      };
    }
    return {
      type: 'probe_by_hints',
      role: item.role,
      probeTarget: 'field',
      hints: item.hints,
    };
  });
  if (includeMediaPicker === true && !probeActions.some((item) => item.role === 'media_upload')) {
    probeActions.push({
      type: 'probe_by_hints',
      role: 'media_upload',
      probeTarget: 'clickable',
      hints: action.recipe.platform ? socialDomRecipeForPlatform(action.recipe.platform).mediaHints : [],
    });
  }
  if (includeCreatorEntryProbe === true) {
    probeActions.push({
      type: 'probe_by_hints',
      role: 'creator_publish_entry',
      probeTarget: 'clickable',
      hints: action.recipe.platform ? socialDomRecipeForPlatform(action.recipe.platform).creatorEntryHints : [],
    });
  }
  return {
    ...action,
    stepId: clean(stepId || `dom_probe_${action.recipe.platform}_targets_from_active_page`, 160),
    args: {
      ...action.args,
      actions: probeActions,
    },
    recipe: {
      ...action.recipe,
      probeOnly: true,
      includeCreatorEntryProbe: includeCreatorEntryProbe === true,
    },
  };
}

export function buildNoeSocialDomRecipePack({
  platform = 'generic',
  browserApp = 'Google Chrome',
  expectedHost = '',
  expectedHosts = [],
  title = '',
  content = '',
  tags = [],
  mediaFiles = [],
  includeMediaPicker = false,
  includeFinalPublishAction = false,
  includeCreatorEntryProbe = false,
} = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const preset = presetForPlatform(normalizedPlatform);
  const hosts = normalizeList(expectedHosts.length ? expectedHosts : preset.expectedHosts);
  const host = clean(expectedHost || hosts[0] || '', 240);
  const fillAction = buildNoeSocialDomRecipeAction({
    platform: normalizedPlatform,
    browserApp,
    expectedHost: host,
    expectedHosts: hosts,
    title,
    content,
    tags,
    mediaFiles,
    includeMediaPicker,
    includeFinalPublishAction,
    stepId: `dom_fill_${normalizedPlatform}_fields_from_active_page`,
  });
  const probeAction = buildNoeSocialDomRecipeProbeAction({
    platform: normalizedPlatform,
    browserApp,
    expectedHost: host,
    expectedHosts: hosts,
    title,
    content,
    tags,
    mediaFiles,
    includeMediaPicker,
    includeFinalPublishAction,
    includeCreatorEntryProbe,
    stepId: `dom_probe_${normalizedPlatform}_targets_from_active_page`,
  });
  const requiredProbeRoles = probeAction.args.actions.map((item) => clean(item.role || item.type, 80));
  const pageProbe = {
    expectedHosts: hosts,
    expectedHost: host,
    requiresLoginSession: true,
    targetSurface: 'creator_publish_editor',
    titleRead: true,
    requiredProbeRoles,
    fieldRoles: probeAction.args.actions
      .filter((item) => item.probeTarget === 'field')
      .map((item) => clean(item.role, 80)),
    clickableRoles: probeAction.args.actions
      .filter((item) => item.probeTarget === 'clickable')
      .map((item) => clean(item.role, 80)),
  };
  const probeActionWithPageProbe = {
    ...probeAction,
    args: {
      ...probeAction.args,
      expectedHosts: hosts,
      pageProbe,
    },
  };
  const fillActionWithPageProbe = {
    ...fillAction,
    args: {
      ...fillAction.args,
      expectedHosts: hosts,
      pageProbe: {
        ...pageProbe,
        probeOnly: false,
      },
    },
  };
  return {
    schemaVersion: NOE_SOCIAL_DOM_RECIPE_SCHEMA_VERSION,
    platform: normalizedPlatform,
    platformLabel: clean(preset.label, 160),
    expectedHosts: hosts,
    requiredProbeRoles,
    actions: [probeActionWithPageProbe, fillActionWithPageProbe],
    pageProbe,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    publishPerformed: includeFinalPublishAction === true,
  };
}
