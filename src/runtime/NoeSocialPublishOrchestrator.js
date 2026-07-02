import { createHash } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { buildNoeAccountConnectionInventory } from './NoeAccountConnectionInventory.js';
import { buildNoeSocialDomRecipePack } from './NoeSocialDomRecipe.js';
import { buildNoeSocialFormFillPlan } from './NoeSocialFormFillPlan.js';
import { buildNoeSocialMediaUploadPlan } from './NoeSocialMediaUploadPlan.js';
import { runNoeSocialPublishPreflight } from './NoeSocialPublishPreflight.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  readNoeSocialDraft,
} from './NoeSocialPublishQueue.js';
import {
  NOE_SOCIAL_PLATFORM_PRESETS,
  prepareNoeSocialPublishWorkflow,
} from './NoeSocialPublishWorkflow.js';

export const NOE_SOCIAL_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION = 1;

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

function sanitizeBrowserState(value = {}) {
  if (Array.isArray(value)) return value.map(sanitizeBrowserState);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactBrowserUrl(value) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /url/i.test(key) && typeof item === 'string' ? redactBrowserUrl(item) : sanitizeBrowserState(item);
  }
  return out;
}

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function normalizeList(value, maxItems = 40) {
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clean(item, 2000)).filter(Boolean);
  const single = clean(value, 2000);
  return single ? [single] : [];
}

function platformPreset(platform = '') {
  return NOE_SOCIAL_PLATFORM_PRESETS[normalizePlatform(platform)] || {
    label: 'Generic Social Platform',
    creatorUrl: '',
    expectedHosts: [],
    tags: ['generic', 'social'],
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
    mediaFiles: normalizeList(out.record?.metadata?.mediaFiles),
    externalSideEffectPerformed: out.record?.publish?.externalSideEffectPerformed === true,
    sha256: clean(out.record?.sha256, 80),
  };
}

function step({
  stepId,
  actionId,
  purpose,
  args = {},
  required = true,
  externalSideEffectPerformed = false,
  publishPerformed = false,
}) {
  return {
    stepId,
    actionId,
    purpose,
    mode: 'developer_unrestricted',
    args,
    required,
    externalSideEffectPerformed,
    publishPerformed,
  };
}

function domRecipeHasRole(domRecipeAction, role) {
  return Array.isArray(domRecipeAction?.args?.actions) && domRecipeAction.args.actions.some((item) => item?.role === role);
}

function buildActionChain({ platform, creatorUrl, draftDir, draftId, title, content, tags, mediaFiles, browserState, browserApp, includeFinalPublish, domRecipeProbeAction, domRecipeAction }) {
  const domRecipeCanUpload = domRecipeHasRole(domRecipeAction, 'media_upload');
  const domRecipeCanPublish = domRecipeHasRole(domRecipeAction, 'final_publish');
  const base = [
    step({
      stepId: 'account_connection_inventory',
      actionId: 'noe.freedom.account.connection_inventory',
      purpose: 'map account platform surfaces and active browser state without reading cookies',
      args: { platforms: [platform], browserState },
      required: true,
    }),
    step({
      stepId: 'open_creator_console',
      actionId: 'noe.freedom.browser.open',
      purpose: 'open the creator surface with the owner browser session',
      args: { url: creatorUrl },
      required: Boolean(creatorUrl),
    }),
    step({
      stepId: 'create_or_refresh_local_draft',
      actionId: 'noe.freedom.social.workflow.prepare',
      purpose: 'create a local draft and rollback plan before platform interaction',
      args: { id: draftId, draftDir, platform, title, content, tags, mediaFiles },
      required: true,
    }),
    step({
      stepId: 'preflight_platform_and_media',
      actionId: 'noe.freedom.social.preflight.run',
      purpose: 'verify draft, media metadata, and browser host before automation',
      args: { draftDir, draftId, platform, mediaFiles, browserState },
      required: true,
    }),
    ...(domRecipeProbeAction ? [step({
      stepId: 'probe_dom_recipe_targets',
      actionId: domRecipeProbeAction.actionId,
      purpose: 'verify platform DOM recipe targets before writing fields, selecting media, or publishing',
      args: domRecipeProbeAction.args,
      required: true,
    })] : []),
    ...(domRecipeAction ? [step({
      stepId: 'execute_dom_recipe_fields',
      actionId: domRecipeAction.actionId,
      purpose: domRecipeCanPublish
        ? 'run platform DOM recipe including final publish click when executed'
        : domRecipeCanUpload
          ? 'run platform DOM recipe including media picker click when executed; do not publish'
          : 'fill title/body through platform DOM recipe; do not upload media or publish',
      args: domRecipeAction.args,
      required: true,
      externalSideEffectPerformed: domRecipeCanUpload || domRecipeCanPublish,
      publishPerformed: domRecipeCanPublish,
    })] : []),
    step({
      stepId: 'build_form_fill_plan',
      actionId: 'noe.freedom.social.form_fill.plan',
      purpose: 'generate controlled browser form-fill automation',
      args: { draftDir, draftId, platform, browserState, browserApp },
      required: true,
    }),
    step({
      stepId: 'execute_form_fill',
      actionId: 'noe.freedom.social.form_fill.execute',
      purpose: 'fill title/body only; do not upload media or publish',
      args: { draftDir, draftId, platform, browserState, browserApp },
      required: true,
    }),
  ];
  if (mediaFiles.length) {
    base.push(
      step({
        stepId: 'build_media_upload_plan',
        actionId: 'noe.freedom.social.media_upload.prepare',
        purpose: 'inspect media refs and locate upload controls without selecting files',
        args: { draftDir, draftId, platform, mediaFiles, browserState, browserApp },
        required: true,
      }),
      step({
        stepId: 'execute_media_upload',
        actionId: 'noe.freedom.social.media_upload.execute',
        purpose: 'select a local media file and start the platform upload queue; do not publish',
        args: { draftDir, draftId, platform, mediaFiles, browserState, browserApp },
        required: true,
        externalSideEffectPerformed: true,
      }),
    );
  }
  if (includeFinalPublish) {
    base.push(step({
      stepId: 'execute_final_publish',
      actionId: 'noe.freedom.social.final_publish.execute',
      purpose: 'press the platform final publish button and record rollback evidence',
      args: { draftDir, draftId, platform, browserState, browserApp, requirePriorStageEvidence: true },
      required: true,
      externalSideEffectPerformed: true,
      publishPerformed: true,
    }));
  }
  base.push(step({
    stepId: 'post_publish_state_probe',
    actionId: 'noe.freedom.browser.state_probe',
    purpose: 'record URL/title after publish or after upload/form-fill for rollback evidence',
    args: { includeAll: true },
    required: true,
  }));
  return base;
}

export function orchestrateNoeSocialPublish({
  args = {},
  root = process.cwd(),
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  realExecute = false,
} = {}) {
  const platform = normalizePlatform(args.platform || args.target || 'douyin');
  const preset = platformPreset(platform);
  const draftId = clean(args.draftId || args.id || `${platform}-${Date.now()}`, 180);
  const title = clean(args.title || args.caption || '', 300);
  const content = clean(args.content || args.text || args.message || '', 20_000);
  const tags = normalizeList(args.tags || args.tag || args.topics || args.topic, 30);
  const mediaFiles = normalizeList(args.mediaFiles || args.mediaFile || args.filePath || args.path);
  const browserState = sanitizeBrowserState(safeJson(args.browserState));
  const browserApp = clean(args.browserApp || 'Google Chrome', 120);
  const includeFinalPublish = args.includeFinalPublish !== false;
  const includeDomMediaPickerAction = args.includeDomMediaPickerAction === true || args.includeMediaPickerAction === true;
  const includeDomFinalPublishAction = args.includeDomFinalPublishAction === true || args.includeFinalPublishDomAction === true;
  const includeCreatorEntryProbe = args.includeCreatorEntryProbe === true || args.includePublishEntryProbe === true;
  const includeSeparateFinalPublishAction = includeFinalPublish && !includeDomFinalPublishAction;
  const workflow = prepareNoeSocialPublishWorkflow({
    args: {
      id: draftId,
      platform,
      title,
      content,
      tags,
      mediaFiles,
      browserState,
      rollbackPlan: args.rollbackPlan || args.rollback,
    },
    draftDir,
    realExecute,
  });
  const effectiveDraftId = clean(workflow.draft?.id || draftId, 180);
  const draft = realExecute ? readDraftSummary({ draftId: effectiveDraftId, draftDir }) : {
    ok: false,
    id: effectiveDraftId,
    error: 'draft_not_written_in_dry_run',
  };
  const preflight = draft.ok ? runNoeSocialPublishPreflight({
    args: { draftId: effectiveDraftId, platform, mediaFiles, browserState },
    root,
    draftDir,
    realExecute: false,
  }) : null;
  const formFillPlan = draft.ok ? buildNoeSocialFormFillPlan({
    args: { draftId: effectiveDraftId, platform, browserState, browserApp },
    draftDir,
    realExecute: false,
  }) : null;
  const mediaUploadPlan = draft.ok && mediaFiles.length ? buildNoeSocialMediaUploadPlan({
    args: { draftId: effectiveDraftId, platform, mediaFiles, browserState, browserApp },
    root,
    draftDir,
    realExecute: false,
  }) : null;
  const accountInventory = buildNoeAccountConnectionInventory({
    args: { platforms: [platform], browserState },
    realExecute: false,
  });
  const domRecipe = buildNoeSocialDomRecipePack({
    platform,
    browserApp,
    expectedHosts: preset.expectedHosts || [],
    title,
    content,
    tags,
    mediaFiles,
    includeMediaPicker: includeDomMediaPickerAction,
    includeFinalPublishAction: includeDomFinalPublishAction,
    includeCreatorEntryProbe,
  });
  const shouldBuildDomRecipe = title || content || tags.length || includeDomMediaPickerAction || includeDomFinalPublishAction;
  const domRecipeProbeAction = shouldBuildDomRecipe ? domRecipe.actions.find((item) => item.recipe?.probeOnly === true) : null;
  const domRecipeAction = shouldBuildDomRecipe ? domRecipe.actions.find((item) => item.recipe?.probeOnly !== true) : null;
  const blockers = [
    ...(workflow.ok ? [] : (workflow.blockers || [workflow.error || 'social_workflow_failed'])),
    ...(preflight && !preflight.ok ? preflight.blockers : []),
    ...(formFillPlan && !formFillPlan.ok ? formFillPlan.blockers : []),
    ...(mediaUploadPlan && !mediaUploadPlan.ok ? mediaUploadPlan.blockers : []),
  ].filter(Boolean);
  const warnings = [
    ...(workflow.warnings || []),
    ...(preflight?.warnings || []),
    ...(formFillPlan?.warnings || []),
    ...(mediaUploadPlan?.warnings || []),
  ].filter(Boolean);
  const actionChain = buildActionChain({
    platform,
    creatorUrl: preset.creatorUrl,
    draftDir,
    draftId: effectiveDraftId,
    title,
    content,
    tags,
    mediaFiles,
    browserState,
    browserApp,
    includeFinalPublish: includeSeparateFinalPublishAction,
    domRecipeProbeAction,
    domRecipeAction,
  });
  const completedStepIds = new Set([
    'account_connection_inventory',
    ...(workflow.draftWritten === true ? ['create_or_refresh_local_draft'] : []),
    ...(preflight ? ['preflight_platform_and_media'] : []),
    ...(formFillPlan ? ['build_form_fill_plan'] : []),
    ...(mediaUploadPlan ? ['build_media_upload_plan'] : []),
  ]);
  const out = {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_PUBLISH_ORCHESTRATOR_SCHEMA_VERSION,
    adapter: 'social-publish-orchestrator',
    plannedOnly: realExecute !== true,
    platform,
    platformLabel: preset.label,
    creatorUrl: clean(preset.creatorUrl, 2000),
    draftDir,
    draftId: effectiveDraftId,
    workflow: {
      ok: workflow.ok,
      draftWritten: workflow.draftWritten === true,
      draft: workflow.draft || null,
      publishPerformed: false,
      externalSideEffectPerformed: workflow.externalSideEffectPerformed === true,
    },
    checks: {
      accountInventory: {
        ok: accountInventory.ok,
        matchedPlatforms: accountInventory.connections.filter((item) => item.status === 'active_browser_match').map((item) => item.platform),
      },
      preflight: preflight ? {
        ok: preflight.ok,
        readiness: preflight.readiness,
        blockers: preflight.blockers,
      } : null,
      formFillPlan: formFillPlan ? {
        ok: formFillPlan.ok,
        blockers: formFillPlan.blockers,
        scriptGenerated: formFillPlan.automation?.scriptGenerated === true,
      } : null,
      domRecipe: domRecipeAction ? {
        ok: true,
        platform: domRecipe.platform,
        probeActionCount: domRecipeProbeAction?.args?.actions?.length || 0,
        actionCount: domRecipeAction.args.actions.length,
        actionRoles: domRecipeAction.args.actions.map((item) => clean(item.role || item.type, 80)),
        expectedHost: clean(domRecipeAction.args.expectedHost || '', 240),
        requiredProbeRoles: domRecipe.requiredProbeRoles,
        pageProbe: domRecipe.pageProbe,
        includeCreatorEntryProbe,
        includeMediaPickerAction: includeDomMediaPickerAction,
        includeFinalPublishAction: includeDomFinalPublishAction,
        externalSideEffectPerformed: domRecipeHasRole(domRecipeAction, 'media_upload') || domRecipeHasRole(domRecipeAction, 'final_publish'),
        publishPerformed: domRecipeHasRole(domRecipeAction, 'final_publish'),
        generated: true,
      } : null,
      mediaUploadPlan: mediaUploadPlan ? {
        ok: mediaUploadPlan.ok,
        blockers: mediaUploadPlan.blockers,
        scriptGenerated: mediaUploadPlan.selectorProbe?.scriptGenerated === true,
      } : null,
    },
    actionChain,
    nextFreedomActions: actionChain
      .filter((item) => item.required && !(realExecute === true && completedStepIds.has(item.stepId)))
      .map((item) => ({
        stepId: item.stepId,
        actionId: item.actionId,
        mode: item.mode,
        args: item.args,
      })),
    blockers,
    warnings,
    externalSideEffectPerformed: workflow.draftWritten === true,
    publishPerformed: false,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    authority: {
      canUseLoggedInAccounts: true,
      canCreateLocalDraft: true,
      canFillForms: false,
      canUploadFiles: false,
      canPublishExternally: false,
      requiresSeparateFinalPublishAction: true,
      bypassesNoeGovernance: false,
    },
  };
  return {
    ...out,
    sha256: sha256(JSON.stringify({ ...out, sha256: undefined })),
  };
}
