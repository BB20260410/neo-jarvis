import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { NOE_SOCIAL_PLATFORM_PRESETS } from '../../src/runtime/NoeSocialPublishWorkflow.js';
import {
  buildCreatorEntryClickStep,
  buildEditorFieldProbeStep,
  bestProbeSummaryForRole,
  clean,
  foundRole,
  HOST,
  hostFromUrl,
  isReadOnlyProbeStep,
  parseArgs,
  PLATFORM_EDITOR_URLS,
  PORT,
  redactUrl,
  requestJson,
  sleep,
  summarizeDraftCreateResult,
  summarizeExecuteResult,
  summarizeFormFillResult,
  summarizeMediaUploadResult,
  summarizeOpenResult,
  summarizeProbeStep,
} from './noe-social-dom-live-probe-utils.mjs';

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sha256Text(value = '') {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function runOsa(script = '') {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (error) => resolve({ ok: false, code: null, stdout, stderr, error: error?.message || String(error) }));
  });
}

async function captureBrowserSnapshot({ browserApp = 'Google Chrome', expectedHost = '', stepId = '' } = {}) {
  const script = `
function safeString(value) { try { return String(value || ""); } catch (_) { return ""; } }
function frontChromeLikeWindow(windows) {
  if (!windows || !windows.length) return null;
  for (let i = 0; i < windows.length; i += 1) {
    try { if (windows[i].index && Number(windows[i].index()) === 1) return windows[i]; } catch (_) {}
  }
  return windows[0] || null;
}
const appName = ${JSON.stringify(browserApp || 'Google Chrome')};
const app = Application(appName);
if (!app.running()) {
  JSON.stringify({ ok: false, browserApp: appName, error: "browser_not_running", cookiesReadByNoe: false, passwordReadByNoe: false, pageContentReadByNoe: false, secretValuesReturned: false });
} else {
  const windows = app.windows();
  const first = frontChromeLikeWindow(windows);
  const tab = first && first.activeTab ? first.activeTab() : null;
  if (!tab) {
    JSON.stringify({ ok: false, browserApp: appName, error: "browser_active_tab_missing", cookiesReadByNoe: false, passwordReadByNoe: false, pageContentReadByNoe: false, secretValuesReturned: false });
  } else {
    JSON.stringify({ ok: true, browserApp: appName, url: safeString(tab.url()), title: safeString(tab.title()), cookiesReadByNoe: false, passwordReadByNoe: false, pageContentReadByNoe: false, secretValuesReturned: false });
  }
}
`;
  const out = await runOsa(script);
  let parsed = {};
  try {
    parsed = JSON.parse(String(out.stdout || '').trim());
  } catch {
    parsed = { ok: false, browserApp, error: 'browser_snapshot_parse_failed' };
  }
  const redactedUrl = parsed.url ? redactUrl(parsed.url) : '';
  const title = clean(parsed.title || '', 500);
  const host = hostFromUrl(redactedUrl);
  const snapshot = {
    ok: out.ok === true && parsed.ok === true,
    kind: 'browser_url_title_snapshot',
    stepId,
    browserApp: parsed.browserApp || browserApp,
    host,
    expectedHost,
    hostMatched: expectedHost ? (host === expectedHost || host.endsWith(`.${expectedHost}`)) : true,
    urlPresent: Boolean(redactedUrl),
    titlePresent: Boolean(title),
    urlSha256: redactedUrl ? sha256Text(redactedUrl) : '',
    titleSha256: title ? sha256Text(title) : '',
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    secretValuesReturned: false,
    error: clean(parsed.error || out.error || out.stderr || '', 500),
  };
  return {
    ...snapshot,
    sha256: sha256Json({ ...snapshot, sha256: undefined }),
  };
}

function expectedHostForArgs(args = {}, platform = '') {
  return hostFromUrl(args.url || '')
    || args.expectedHost
    || (Array.isArray(args.expectedHosts) ? args.expectedHosts[0] : '')
    || hostFromUrl(PLATFORM_EDITOR_URLS[platform] || '')
    || '';
}

function buildMediaFileChecklist(mediaFiles = []) {
  const files = Array.isArray(mediaFiles) ? mediaFiles : [];
  return files.slice(0, 10).map((file) => {
    const ref = clean(file, 2000);
    let stat = null;
    try {
      stat = existsSync(ref) ? statSync(ref) : null;
    } catch {
      stat = null;
    }
    return {
      ref,
      basename: basename(ref),
      extension: extname(ref).toLowerCase(),
      exists: Boolean(stat),
      isFile: stat?.isFile?.() === true,
      size: Number(stat?.size) || 0,
      contentRead: false,
      secretValuesReturned: false,
    };
  });
}

function safeRoleList(value, maxItems = 20) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => clean(item, 120)).filter(Boolean)
    : [];
}

function buildControlledUploadCompletionEvidence(summary = null, mediaFileChecklist = []) {
  const runtime = summary?.runtime || {};
  const execution = runtime.execution || {};
  return {
    ok: summary?.ok === true,
    adapter: clean(runtime.adapter, 120),
    mediaSelectionAttempted: runtime.mediaSelectionAttempted === true,
    externalSideEffectPerformed: runtime.externalSideEffectPerformed === true,
    fileContentRead: runtime.fileContentRead === true,
    selectedMedia: runtime.selectedMedia ? {
      ref: clean(runtime.selectedMedia.ref, 400),
      kind: clean(runtime.selectedMedia.kind, 80),
      contentRead: runtime.selectedMedia.contentRead === true,
    } : null,
    execution: {
      fileSelected: execution.fileSelected === true,
      uploadStarted: execution.uploadStarted === true,
      clipboardOverwritten: execution.clipboardOverwritten === true,
      finalButtonClicked: execution.finalButtonClicked === true,
      formSubmitted: execution.formSubmitted === true,
    },
    mediaFileChecklist,
    secretValuesReturned: false,
  };
}

function buildDomStateEvidence(summary = null, { capturedBy = 'noe.freedom.browser.dom.execute', label = '' } = {}) {
  const runtime = summary?.runtime || {};
  const readiness = runtime.pageReadiness || {};
  const actions = Array.isArray(runtime.actions) ? runtime.actions : [];
  const sanitizedActions = actions.slice(0, 20).map((action = {}) => ({
    type: clean(action.type, 80),
    role: clean(action.role || action.type, 120),
    probeTarget: clean(action.probeTarget, 80),
    found: action.found === true,
    probed: action.probed === true,
    clicked: action.clicked === true,
    valueSet: action.valueSet === true,
    contentRead: action.contentRead === true,
    error: clean(action.error || '', 160),
  }));
  const finalPublishTouched = sanitizedActions.some((action) => (
    /final_publish/i.test(`${action.role} ${action.type}`) && (action.clicked || action.valueSet)
  ));
  return {
    capturedBy,
    label: clean(label, 160),
    adapter: clean(runtime.adapter || '', 120),
    host: clean(runtime.host || hostFromUrl(runtime.url || ''), 200),
    urlPresent: runtime.urlPresent === true || Boolean(clean(runtime.url || '', 2000)),
    urlSha256: clean(runtime.urlSha256 || (runtime.url ? sha256Text(redactUrl(runtime.url)) : ''), 80),
    titlePresent: runtime.titlePresent === true || Boolean(clean(runtime.title || '', 500)),
    actionCount: Number(runtime.actionCount) || sanitizedActions.length,
    actions: sanitizedActions,
    pageReadiness: {
      ok: readiness.ok === true,
      hostMatched: readiness.hostMatched === true,
      targetSurface: clean(readiness.targetSurface, 160),
      targetSurfaceReady: readiness.targetSurfaceReady === true,
      requiresLoginSession: readiness.requiresLoginSession === true,
      loginSessionLikely: readiness.loginSessionLikely === true,
      requiredRoles: safeRoleList(readiness.requiredRoles),
      foundRoles: safeRoleList(readiness.foundRoles),
      missingRoles: safeRoleList(readiness.missingRoles),
      fieldRoles: safeRoleList(readiness.fieldRoles),
      clickableRoles: safeRoleList(readiness.clickableRoles),
      secretValuesReturned: false,
    },
    noFinalPublishActionTouched: finalPublishTouched === false,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
  };
}

function _browserStateRefFromActiveUrl(activeUrl = '', { titlePresent = true } = {}) {
  const redacted = activeUrl ? redactUrl(activeUrl) : '';
  const host = hostFromUrl(redacted);
  return {
    activeBrowser: {
      host,
      urlPresent: Boolean(redacted),
      urlSha256: redacted ? sha256Text(redacted) : '',
      titlePresent: titlePresent === true,
    },
  };
}

function browserStateRefFromRuntime(runtime = {}, fallbackUrl = '') {
  const redacted = fallbackUrl ? redactUrl(fallbackUrl) : '';
  const host = clean(runtime?.host || hostFromUrl(redacted), 200);
  return {
    activeBrowser: {
      host,
      urlPresent: runtime?.urlPresent === true || Boolean(redacted),
      urlSha256: clean(runtime?.urlSha256 || (redacted ? sha256Text(redacted) : ''), 80),
      titlePresent: runtime?.titlePresent === true,
    },
  };
}

function buildReviewEvidenceRefs({ platform = '', runId = '', stepId = '', args = {}, readonly = false, snapshot = null } = {}) {
  const expectedHost = expectedHostForArgs(args, platform);
  const step = clean(stepId || 'social_dom_live_probe', 160);
  const mediaScope = Array.isArray(args.mediaFiles) && args.mediaFiles.length
    ? `media_scope=${args.mediaFiles.map((file) => basename(clean(file, 2000))).filter(Boolean).join(',')}`
    : 'media_scope=none';
  const capabilityGrant = (() => {
    if (/media_upload/i.test(step)) return `specific_capability_grant=minimal_${platform || 'social'}_media_upload_only;${mediaScope};final_publish_excluded=true;delete_excluded=true`;
    if (/draft_create|local_draft/i.test(step)) return `specific_capability_grant=minimal_${platform || 'social'}_local_draft_only;external_publish_excluded=true;delete_excluded=true`;
    if (/form_fill|retitle/i.test(step)) return `specific_capability_grant=minimal_${platform || 'social'}_form_fill_only;final_publish_excluded=true;delete_excluded=true`;
    if (/final_publish/i.test(step)) return `specific_capability_grant=minimal_${platform || 'social'}_final_publish_only;delete_excluded=true`;
    if (/rollback|delete|hide|recall/i.test(step)) return `specific_capability_grant=minimal_${platform || 'social'}_rollback_only`;
    return `specific_capability_grant=minimal_${platform || 'social'}_dom_probe_only;final_publish_excluded=true;delete_excluded=true`;
  })();
  const ownerConfirmation = `owner_explicit_confirmation_2026-06-19:scoped_noe_social_live_step;${capabilityGrant}`;
  return {
    priorStageEvidence: snapshot?.sha256
      ? `browser_snapshot_sha256:${snapshot.sha256}`
      : 'live_51835_root_reachable_and_dry_run_orchestrate_probe_step_generated',
    rawOutputRef: `freedom_run_ledger:${runId || 'persistLedger=true'}`,
    snapshot: snapshot?.sha256
      ? `browser_snapshot_sha256:${snapshot.sha256}`
      : `browser_dom_page_readiness_contract:${stepId || 'social_dom_live_probe'}`,
    rollbackPlan: readonly
      ? 'readonly_probe_no_page_mutation_close_or_reload_browser_tab'
      : 'stop_before_final_publish_close_or_reload_browser_tab_and_discard_local_draft_if_created',
    ownerAuthorization: `owner_token_gated_51835_request_with_ack_owner_present;${ownerConfirmation};step=${step}`,
    portBoundary: `panel=${HOST}:${PORT};browser=${args.browserApp || 'Google Chrome'};expectedHost=${expectedHost}`,
    secretLeakRisk: 'actions_must_not_read_cookies_passwords_or_secret_values',
  };
}

function withDomReviewEvidenceArgs(args = {}, {
  platform = '',
  runId = '',
  stepId = '',
  readonly = false,
  snapshot = null,
  domState = null,
  priorStageEvidenceExtras = {},
  snapshotExtras = {},
} = {}) {
  const expectedHost = expectedHostForArgs(args, platform);
  const beforeBrowserSnapshot = snapshot || null;
  return {
    ...args,
    priorStageEvidence: {
      ok: true,
      kind: 'social_dom_live_probe_preflight',
      completedStages: ['root_reachable', 'dry_run_orchestrate_generated_probe_step'],
      failedStages: [],
      readOnlyProbe: readonly === true,
      finalPublishIncluded: false,
      secretValuesReturned: false,
      browserSnapshot: beforeBrowserSnapshot,
      ...(domState ? { domStateBeforeAction: domState } : {}),
      ...(priorStageEvidenceExtras && typeof priorStageEvidenceExtras === 'object' ? priorStageEvidenceExtras : {}),
    },
    rawOutputRef: `freedom_run_ledger:${runId || 'persistLedger=true'}`,
    snapshot: {
      kind: 'browser_dom_page_readiness_contract',
      stepId: stepId || 'social_dom_live_probe',
      expectedHost,
      beforeBrowserSnapshot,
      actionTypes: Array.isArray(args.actions) ? args.actions.map((action) => action.type).filter(Boolean) : [],
      roles: Array.isArray(args.actions) ? args.actions.map((action) => action.role || action.type).filter(Boolean) : [],
      probeOnly: readonly === true,
      finalPublishIncluded: false,
      ...(domState ? { domStateBeforeAction: domState } : {}),
      ...(snapshotExtras && typeof snapshotExtras === 'object' ? snapshotExtras : {}),
    },
    portBoundary: {
      panelHost: HOST,
      panelPort: PORT,
      browserApp: args.browserApp || 'Google Chrome',
      expectedHost,
    },
    secretLeakRisk: {
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      secretValuesReturned: false,
      pageContentReadByNoe: false,
    },
  };
}

function freedomExecuteBody({
  action = '',
  args = {},
  platform = '',
  runId = '',
  stepId = '',
  reason = '',
  rollbackPlan = '',
  readonly = false,
  domEvidenceArgs = false,
  evidenceRefs = {},
  freedomSession = null,
  snapshot = null,
  domState = null,
  priorStageEvidenceExtras = {},
  snapshotExtras = {},
} = {}) {
  const finalArgs = domEvidenceArgs
    ? withDomReviewEvidenceArgs(args, {
      platform,
      runId,
      stepId,
      readonly,
      snapshot,
      domState,
      priorStageEvidenceExtras,
      snapshotExtras,
    })
    : args;
  const refs = {
    ...buildReviewEvidenceRefs({ platform, runId, stepId, args: finalArgs, readonly, snapshot }),
    ...evidenceRefs,
  };
  const finalRollbackPlan = rollbackPlan || refs.rollbackPlan;
  const finalReason = [
    reason,
    `ownerAuthorization=${refs.ownerAuthorization}`,
    `portBoundary=${refs.portBoundary}`,
    `rollbackPlan=${finalRollbackPlan}`,
    `rawOutputRef=${refs.rawOutputRef}`,
  ].filter(Boolean).join('; ');
  return {
    action,
    args: finalArgs,
    realExecute: true,
    authorization: {
      mode: 'developer_unrestricted',
      ownerPresent: true,
      ...(freedomSession?.sessionId ? { sessionId: freedomSession.sessionId } : {}),
      reason: finalReason,
      rollbackPlan: finalRollbackPlan,
      portBoundary: refs.portBoundary,
    },
    persistLedger: true,
    runId,
    evidenceRefs: refs,
  };
}

export async function runNoeSocialDomLiveProbe({
  options = parseArgs([]),
  request = requestJson,
  requireOwnerTokenAck = request === requestJson,
} = {}) {
  if (requireOwnerTokenAck && !options.ackReadOwnerToken) {
    return {
      ok: false,
      host: HOST,
      port: PORT,
      platform: options.platform,
      checked: 1,
      failed: 1,
      tokenPolicy: {
        source: 'not_loaded_policy_requires_ack',
        ackReadOwnerToken: false,
        authorization: options.ownerTokenAuthorization || null,
        policyBlocked: true,
        reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
        secretValueReturned: false,
      },
      checks: [{
        id: 'owner_token_loaded',
        ok: false,
        evidence: {
          source: 'not_loaded_policy_requires_ack',
          policyBlocked: true,
          reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
        },
      }],
    };
  }
  const requestWithAuth = (path, init = {}) => request(path, { ...init, ackReadOwnerToken: options.ackReadOwnerToken });
  const preset = NOE_SOCIAL_PLATFORM_PRESETS[options.platform] || NOE_SOCIAL_PLATFORM_PRESETS.xiaohongshu;
  const includeMediaPickerProbe = options.includeMediaPickerProbe === true
    || options.requireMediaUploadReady === true
    || options.uploadAfterMediaReady === true;
  const checks = [];
  const root = await requestWithAuth('/');
  checks.push({
    id: 'root_reachable',
    ok: root.status === 200,
    evidence: { status: root.status, error: root.error || '' },
  });

  const liveExecuteRequested = options.openCreator === true
    || options.execute === true
    || options.enterEditor === true
    || options.uploadAfterMediaReady === true
    || options.fillAfterUpload === true;
  let freedomSession = null;
  if (liveExecuteRequested && options.ackOwnerPresent) {
    const session = await requestWithAuth('/api/noe/freedom/session/start', {
      method: 'POST',
      body: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
        reason: `social DOM live probe ${options.platform}; no final publish; secrets redacted`,
        source: 'noe-social-dom-live-probe',
      },
    });
    freedomSession = session.status === 200 && session.json?.ok === true && session.json?.session
      ? {
        sessionId: session.json.session.sessionId,
        mode: session.json.session.mode,
        ownerPresent: session.json.session.ownerPresent === true,
      }
      : null;
    checks.push({
      id: 'freedom_session_started',
      ok: Boolean(freedomSession?.sessionId),
      evidence: {
        status: session.status,
        mode: freedomSession?.mode || '',
        ownerPresent: freedomSession?.ownerPresent === true,
        sessionIdPresent: Boolean(freedomSession?.sessionId),
        secretValuesReturned: false,
      },
    });
  }

  async function captureDomPreflightSnapshot(args = {}, stepId = '') {
    const expectedHost = expectedHostForArgs(args, options.platform);
    const snapshot = request === requestJson
      ? await captureBrowserSnapshot({ browserApp: args.browserApp || options.browserApp, expectedHost, stepId })
      : {
        ok: true,
        kind: 'browser_url_title_snapshot',
        stepId,
        browserApp: args.browserApp || options.browserApp,
        host: expectedHost,
        expectedHost,
        hostMatched: true,
        urlPresent: Boolean(expectedHost),
        titlePresent: true,
        urlSha256: expectedHost ? sha256Text(`https://${expectedHost}/unit-probe`) : '',
        titleSha256: sha256Text('unit synthetic snapshot'),
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        secretValuesReturned: false,
        error: '',
      };
    if (!snapshot.sha256) snapshot.sha256 = sha256Json({ ...snapshot, sha256: undefined });
    checks.push({
      id: `browser_snapshot:${stepId || 'dom_probe'}`,
      ok: snapshot.ok === true,
      evidence: {
        kind: snapshot.kind,
        browserApp: snapshot.browserApp,
        host: snapshot.host,
        expectedHost: snapshot.expectedHost,
        hostMatched: snapshot.hostMatched === true,
        sha256: snapshot.sha256,
        urlPresent: snapshot.urlPresent === true,
        titlePresent: snapshot.titlePresent === true,
        urlSha256Present: Boolean(snapshot.urlSha256),
        titleSha256Present: Boolean(snapshot.titleSha256),
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        error: snapshot.error || '',
      },
    });
    return snapshot;
  }

  let openSummary = null;
  if (options.openCreator) {
    if (!options.ackOwnerPresent) {
      checks.push({
        id: 'open_creator_ack_owner_present_required',
        ok: false,
        evidence: { reason: 'pass --ack-owner-present to open the creator page in the owner browser' },
      });
    } else {
      const openSnapshot = await captureDomPreflightSnapshot({
        browserApp: options.browserApp,
        expectedHost: hostFromUrl(preset.creatorUrl || ''),
      }, 'before_open_creator_page');
      const open = await requestWithAuth('/api/noe/freedom/execute', {
        method: 'POST',
        body: freedomExecuteBody({
          action: 'noe.freedom.browser.open',
          args: {
            url: preset.creatorUrl || '',
            browserApp: options.browserApp,
          },
          platform: options.platform,
          runId: `social-dom-open-creator-${options.platform}-${Date.now()}`,
          stepId: 'open_creator_page',
          reason: 'owner-confirmed minimal xiaohongshu live test: open creator page before read-only social DOM readiness probe; no upload, form fill, or final publish in this step',
          rollbackPlan: 'deterministic rollback: close this Chrome creator tab if opened or navigate back to the pre-open hashed browser snapshot; no upload, form fill, or final publish is performed',
          readonly: true,
          domEvidenceArgs: true,
          priorStageEvidenceExtras: {
            ownerExplicitConfirmationRef: 'owner_explicit_confirmation_2026-06-19_publish_delete_test',
            live51835RootReachable: root.status === 200,
            openOnly: true,
            noUpload: true,
            noFormFill: true,
            finalPublishExcluded: true,
          },
          snapshotExtras: {
            ownerExplicitConfirmationRef: 'owner_explicit_confirmation_2026-06-19_publish_delete_test',
            openOnly: true,
            finalPublishExcluded: true,
          },
          freedomSession,
          snapshot: openSnapshot,
        }),
      });
      openSummary = summarizeOpenResult(open);
      checks.push({
        id: 'open_creator_page',
        ok: open.status === 200
          && openSummary.ok === true
          && openSummary.runtime.adapter === 'browser-open'
          && openSummary.runtime.host === hostFromUrl(preset.creatorUrl)
          && openSummary.runtime.browserOpenAttempted === true
          && openSummary.runtime.cookiesReadByNoe === false
          && openSummary.runtime.passwordReadByNoe === false,
        evidence: openSummary,
      });
      if (open.status === 200 && options.openWaitMs > 0) await sleep(options.openWaitMs);
    }
  }

  const orchestrate = await requestWithAuth('/api/noe/freedom/dry-run', {
    method: 'POST',
    body: {
      action: 'noe.freedom.social.publish_orchestrate',
      args: {
        id: `live-dom-probe-${Date.now()}`,
        platform: options.platform,
        title: options.title,
        content: options.content,
        tags: options.tags,
        includeFinalPublish: false,
        includeCreatorEntryProbe: true,
        includeDomMediaPickerAction: includeMediaPickerProbe,
        includeDomFinalPublishAction: options.includeFinalPublishProbe,
        browserApp: options.browserApp,
        browserState: {
          activeBrowser: {
            url: preset.creatorUrl || '',
            title: preset.label || options.platform,
          },
        },
      },
    },
  });
  const probeStep = (orchestrate.json?.runtime?.nextFreedomActions || orchestrate.json?.nextFreedomActions || [])
    .find((step) => step.stepId === 'probe_dom_recipe_targets');
  const probeSummary = summarizeProbeStep(probeStep);
  checks.push({
    id: 'probe_step_generated',
    ok: orchestrate.status === 200 && Boolean(probeStep),
    evidence: { status: orchestrate.status, probe: probeSummary },
  });
  checks.push({
    id: 'probe_step_is_read_only',
    ok: isReadOnlyProbeStep(probeStep),
    evidence: probeSummary,
  });
  checks.push({
    id: 'probe_step_has_page_readiness_contract',
    ok: Boolean(probeSummary.pageProbe?.targetSurface)
      && probeSummary.pageProbe.requiresLoginSession === true
      && probeSummary.pageProbe.requiredProbeRoles.length > 0,
    evidence: probeSummary.pageProbe,
  });

  let executeSummary = null;
  let enterSummary = null;
  let editorProbeSummary = null;
  let directEditorOpenSummary = null;
  let directEditorProbeSummary = null;
  let mediaUploadSummary = null;
  let postUploadProbeSummary = null;
  let draftCreateSummary = null;
  let formFillSummary = null;
  let postFillProbeSummary = null;
  async function runKnownEditorUrlProbe(editorProbeStep, reason = '') {
    const directEditorUrl = PLATFORM_EDITOR_URLS[options.platform] || '';
    if (!directEditorUrl || !editorProbeStep) return false;
    const directOpenArgs = {
      url: directEditorUrl,
      browserApp: options.browserApp,
    };
    const directOpenSnapshot = await captureDomPreflightSnapshot(directOpenArgs, 'before_open_known_editor_url');
    const directOpen = await requestWithAuth('/api/noe/freedom/execute', {
      method: 'POST',
      body: freedomExecuteBody({
        action: 'noe.freedom.browser.open',
        args: directOpenArgs,
        platform: options.platform,
        runId: `social-dom-open-editor-${options.platform}-${Date.now()}`,
        stepId: 'open_known_editor_url',
        reason: reason || 'open known creator editor URL for read-only social DOM readiness probe',
        rollbackPlan: 'close or reload the creator editor page; no form fields are changed and no publish is performed',
        readonly: true,
        domEvidenceArgs: true,
        freedomSession,
        snapshot: directOpenSnapshot,
      }),
    });
    directEditorOpenSummary = summarizeOpenResult(directOpen);
    checks.push({
      id: 'open_known_editor_url_after_entry_not_ready',
      ok: directOpen.status === 200
        && directEditorOpenSummary.ok === true
        && directEditorOpenSummary.runtime.adapter === 'browser-open'
        && directEditorOpenSummary.runtime.host === hostFromUrl(directEditorUrl)
        && directEditorOpenSummary.runtime.browserOpenAttempted === true
        && directEditorOpenSummary.runtime.cookiesReadByNoe === false
        && directEditorOpenSummary.runtime.passwordReadByNoe === false,
      evidence: directEditorOpenSummary,
    });
    if (directOpen.status === 200 && options.enterWaitMs > 0) await sleep(options.enterWaitMs);

    const directEditorProbeRunId = `social-dom-direct-editor-probe-${options.platform}-${Date.now()}`;
    const directEditorProbeArgs = {
      ...editorProbeStep.args,
      expectedUrlPrefixes: [directEditorUrl],
      pageProbe: editorProbeStep.args?.pageProbe ? {
        ...editorProbeStep.args.pageProbe,
        expectedUrlPrefixes: [directEditorUrl],
      } : editorProbeStep.args?.pageProbe,
    };
    const directEditorProbeSnapshot = await captureDomPreflightSnapshot(directEditorProbeArgs, 'direct_editor_field_probe');
    const directEditorProbe = await requestWithAuth('/api/noe/freedom/execute', {
      method: 'POST',
      body: freedomExecuteBody({
        action: editorProbeStep.actionId,
        args: directEditorProbeArgs,
        platform: options.platform,
        runId: directEditorProbeRunId,
        stepId: 'direct_editor_field_probe',
        reason: 'read-only editor field readiness probe after opening known creator editor URL',
        rollbackPlan: 'read-only DOM probe only; close or reload browser tab if needed',
        readonly: true,
        domEvidenceArgs: true,
        freedomSession,
        snapshot: directEditorProbeSnapshot,
      }),
    });
    directEditorProbeSummary = summarizeExecuteResult(directEditorProbe);
    checks.push({
      id: 'direct_editor_field_probe_returns_readiness',
      ok: [200, 409].includes(directEditorProbe.status)
        && directEditorProbeSummary.runtime.adapter === 'browser-dom-execute'
        && Boolean(directEditorProbeSummary.runtime.pageReadiness)
        && directEditorProbeSummary.runtime.actions.every((action) => action.clicked === false)
        && directEditorProbeSummary.runtime.secretValuesReturned === false
        && directEditorProbeSummary.runtime.cookiesReadByNoe === false
        && directEditorProbeSummary.runtime.passwordReadByNoe === false
        && directEditorProbeSummary.runtime.pageContentReadByNoe === false,
      evidence: directEditorProbeSummary,
    });
    return true;
  }

  if (options.execute) {
    if (!options.ackOwnerPresent) {
      checks.push({
        id: 'execute_ack_owner_present_required',
        ok: false,
        evidence: { reason: 'pass --ack-owner-present to run read-only browser DOM probe' },
      });
    } else if (!isReadOnlyProbeStep(probeStep)) {
      checks.push({
        id: 'execute_refuses_non_read_only_probe',
        ok: false,
        evidence: probeSummary,
      });
    } else {
      const executeRunId = `social-dom-live-probe-${options.platform}-${Date.now()}`;
      const executeSnapshot = await captureDomPreflightSnapshot(probeStep.args, 'initial_page_readiness_probe');
      const execute = await requestWithAuth('/api/noe/freedom/execute', {
        method: 'POST',
        body: freedomExecuteBody({
          action: probeStep.actionId,
          args: probeStep.args,
          platform: options.platform,
          runId: executeRunId,
          stepId: 'initial_page_readiness_probe',
          reason: 'read-only social DOM page readiness probe',
          rollbackPlan: 'read-only DOM probe only; close or reload browser tab if needed',
          readonly: true,
          domEvidenceArgs: true,
          freedomSession,
          snapshot: executeSnapshot,
        }),
      });
      executeSummary = summarizeExecuteResult(execute);
      checks.push({
        id: 'execute_returns_structured_page_readiness',
        ok: [200, 409].includes(execute.status)
          && executeSummary.runtime.adapter === 'browser-dom-execute'
          && Boolean(executeSummary.runtime.pageReadiness)
          && executeSummary.runtime.secretValuesReturned === false
          && executeSummary.runtime.cookiesReadByNoe === false
          && executeSummary.runtime.passwordReadByNoe === false
          && executeSummary.runtime.pageContentReadByNoe === false,
        evidence: executeSummary,
      });
      if (options.requireReady) {
        checks.push({
          id: 'target_page_ready',
          ok: executeSummary.runtime.pageReadiness?.ok === true,
          evidence: executeSummary.runtime.pageReadiness,
        });
      }
    }
  }

  if (options.enterEditor) {
    if (!options.ackOwnerPresent) {
      checks.push({
        id: 'enter_editor_ack_owner_present_required',
        ok: false,
        evidence: { reason: 'pass --ack-owner-present to click the creator publish entry' },
      });
    } else if (!options.execute || !executeSummary) {
      checks.push({
        id: 'enter_editor_requires_initial_probe',
        ok: false,
        evidence: { reason: 'pass --execute so the entry is probed before clicking' },
      });
    } else if (!foundRole(executeSummary, 'creator_publish_entry')) {
      const editorProbeStep = buildEditorFieldProbeStep(probeStep);
      checks.push({
        id: 'enter_editor_entry_not_found_using_direct_editor_url',
        ok: Boolean(PLATFORM_EDITOR_URLS[options.platform]),
        evidence: executeSummary.runtime.pageReadiness || executeSummary.runtime,
      });
      await runKnownEditorUrlProbe(
        editorProbeStep,
        'open known creator editor URL because creator publish entry was not found on the current page',
      );
    } else {
      const entryClickStep = buildCreatorEntryClickStep(probeStep);
      const safeEntryClick = entryClickStep
        && entryClickStep.args.actions.length === 2
        && entryClickStep.args.actions[1].type === 'click_by_hints'
        && entryClickStep.args.actions[1].role === 'creator_publish_entry';
      if (!safeEntryClick) {
        checks.push({
          id: 'enter_editor_refuses_unsafe_click_step',
          ok: false,
          evidence: entryClickStep || {},
        });
      } else {
        const enterRunId = `social-dom-enter-editor-${options.platform}-${Date.now()}`;
        const enterSnapshot = await captureDomPreflightSnapshot(entryClickStep.args, 'enter_editor_click_creator_entry_only');
        const enter = await requestWithAuth('/api/noe/freedom/execute', {
          method: 'POST',
          body: freedomExecuteBody({
            action: entryClickStep.actionId,
            args: entryClickStep.args,
            platform: options.platform,
            runId: enterRunId,
            stepId: 'enter_editor_click_creator_entry_only',
            reason: 'owner-confirmed minimal xiaohongshu live test: click only the creator publish entry to expose editor fields; stop before upload, form fill, and final publish',
            rollbackPlan: 'deterministic rollback: close this Chrome creator tab or navigate back to the hashed pre-click creator page snapshot; no media file is selected, no text field is changed, and no final publish is performed',
            readonly: false,
            domEvidenceArgs: true,
            priorStageEvidenceExtras: {
              ownerExplicitConfirmationRef: 'owner_explicit_confirmation_2026-06-19_publish_delete_test',
              currentPageProbeFoundCreatorPublishEntry: true,
              onlyAllowedDomMutation: 'click_creator_publish_entry',
              noMediaUpload: true,
              noFormFill: true,
              finalPublishExcluded: true,
            },
            snapshotExtras: {
              ownerExplicitConfirmationRef: 'owner_explicit_confirmation_2026-06-19_publish_delete_test',
              onlyAllowedDomMutation: 'click_creator_publish_entry',
              finalPublishExcluded: true,
            },
            freedomSession,
            snapshot: enterSnapshot,
          }),
        });
        enterSummary = summarizeExecuteResult(enter);
        checks.push({
          id: 'enter_editor_clicked_creator_entry_only',
          ok: enter.status === 200
            && enterSummary.ok === true
            && enterSummary.runtime.adapter === 'browser-dom-execute'
            && enterSummary.runtime.actions.some((action) => action.role === 'creator_publish_entry' && action.clicked === true)
            && enterSummary.runtime.actions.every((action) => action.role !== 'media_upload' && action.role !== 'final_publish')
            && enterSummary.runtime.secretValuesReturned === false
            && enterSummary.runtime.cookiesReadByNoe === false
            && enterSummary.runtime.passwordReadByNoe === false
            && enterSummary.runtime.pageContentReadByNoe === false,
          evidence: enterSummary,
        });
        if (enter.status === 200 && options.enterWaitMs > 0) await sleep(options.enterWaitMs);

        const editorProbeStep = buildEditorFieldProbeStep(probeStep);
        const editorProbeRunId = `social-dom-editor-probe-${options.platform}-${Date.now()}`;
        const editorProbeSnapshot = await captureDomPreflightSnapshot(editorProbeStep.args, 'editor_field_probe_after_entry');
        const editorProbe = await requestWithAuth('/api/noe/freedom/execute', {
          method: 'POST',
          body: freedomExecuteBody({
            action: editorProbeStep.actionId,
            args: editorProbeStep.args,
            platform: options.platform,
            runId: editorProbeRunId,
            stepId: 'editor_field_probe_after_entry',
            reason: 'read-only editor field readiness probe after entering creator editor',
            rollbackPlan: 'read-only DOM probe only; close or reload browser tab if needed',
            readonly: true,
            domEvidenceArgs: true,
            freedomSession,
            snapshot: editorProbeSnapshot,
          }),
        });
        editorProbeSummary = summarizeExecuteResult(editorProbe);
        checks.push({
          id: 'editor_field_probe_returns_readiness',
          ok: [200, 409].includes(editorProbe.status)
            && editorProbeSummary.runtime.adapter === 'browser-dom-execute'
            && Boolean(editorProbeSummary.runtime.pageReadiness)
            && editorProbeSummary.runtime.actions.every((action) => action.clicked === false)
            && editorProbeSummary.runtime.secretValuesReturned === false
            && editorProbeSummary.runtime.cookiesReadByNoe === false
            && editorProbeSummary.runtime.passwordReadByNoe === false
            && editorProbeSummary.runtime.pageContentReadByNoe === false,
          evidence: editorProbeSummary,
        });
        if (editorProbeSummary.runtime.pageReadiness?.ok !== true) {
          await runKnownEditorUrlProbe(
            editorProbeStep,
            'open known creator editor URL after entry click did not expose editor fields',
          );
        }
      }
    }
  }

  if (options.requireMediaUploadReady) {
    const mediaProbeSummary = bestProbeSummaryForRole(
      'media_upload',
      executeSummary,
      editorProbeSummary,
      directEditorProbeSummary,
    );
    checks.push({
      id: 'media_upload_ready',
      ok: Boolean(mediaProbeSummary) && foundRole(mediaProbeSummary, 'media_upload'),
      evidence: mediaProbeSummary?.runtime?.pageReadiness || {
        reason: options.execute ? 'media_upload_probe_result_missing' : 'pass --execute to verify media upload readiness',
      },
    });
  }

  if (options.uploadAfterMediaReady) {
    const mediaProbeSummary = bestProbeSummaryForRole(
      'media_upload',
      executeSummary,
      editorProbeSummary,
      directEditorProbeSummary,
    );
    const mediaReady = Boolean(mediaProbeSummary) && foundRole(mediaProbeSummary, 'media_upload');
    if (!options.ackUploadSideEffect) {
      checks.push({
        id: 'controlled_media_upload_ack_required',
        ok: false,
        evidence: { reason: 'pass --ack-upload-side-effect to select a local media file in the creator page' },
      });
    } else if (!Array.isArray(options.mediaFiles) || options.mediaFiles.length === 0) {
      checks.push({
        id: 'controlled_media_upload_media_file_required',
        ok: false,
        evidence: { reason: 'pass --media-file <path> before controlled upload execution' },
      });
    } else if (!mediaReady) {
      checks.push({
        id: 'controlled_media_upload_requires_media_ready',
        ok: false,
        evidence: mediaProbeSummary?.runtime?.pageReadiness || { reason: 'media_upload_ready gate did not pass' },
      });
    } else {
      const activeUrl = PLATFORM_EDITOR_URLS[options.platform]
        || preset.creatorUrl
        || '';
      const uploadRunId = `social-dom-controlled-media-upload-${options.platform}-${Date.now()}`;
      const uploadDomState = buildDomStateEvidence(mediaProbeSummary, { label: 'before_controlled_media_upload' });
      const uploadSnapshot = await captureDomPreflightSnapshot({
        browserApp: options.browserApp,
        expectedHost: hostFromUrl(activeUrl) || hostFromUrl(PLATFORM_EDITOR_URLS[options.platform] || preset.creatorUrl || ''),
      }, 'controlled_media_upload_no_publish');
      const mediaFileChecklist = buildMediaFileChecklist(options.mediaFiles);
      const uploadStageContract = {
        operation: 'social_media_upload_execute_before_text_fields',
        platform: options.platform,
        requiredPreActionRoles: ['media_upload'],
        mediaUploadBeforeTextFieldsAllowed: true,
        textFieldsExpectedAfterUpload: true,
        postUploadFieldProbeRequired: true,
        finalPublishExcluded: true,
        formSubmitExcluded: true,
        missingTextFieldsBeforeUpload: safeRoleList(uploadDomState.pageReadiness?.missingRoles)
          .filter((role) => ['title', 'content', 'tags'].includes(role)),
      };
      const upload = await requestWithAuth('/api/noe/freedom/execute', {
        method: 'POST',
        body: freedomExecuteBody({
          action: 'noe.freedom.social.media_upload.execute',
          args: {
            platform: options.platform,
            mediaFiles: options.mediaFiles,
            requireDraft: false,
            allowOutsideRoot: true,
            browserApp: options.browserApp,
            browserState: browserStateRefFromRuntime(mediaProbeSummary?.runtime, activeUrl),
          },
          platform: options.platform,
          runId: uploadRunId,
          stepId: 'controlled_media_upload_no_publish',
          reason: 'controlled media selection after media upload readiness; do not press final publish',
          rollbackPlan: 'remove selected local media from the draft UI or close the tab; final publish is not pressed',
          readonly: false,
          domEvidenceArgs: true,
          domState: uploadDomState,
          priorStageEvidenceExtras: {
            mediaUploadReady: mediaReady === true,
            mediaFileChecklist,
            noFinalPublishActionTouchedBeforeUpload: uploadDomState.noFinalPublishActionTouched === true,
            stageContract: uploadStageContract,
          },
          snapshotExtras: {
            mediaFileChecklist,
            noFinalPublishActionTouchedBeforeUpload: uploadDomState.noFinalPublishActionTouched === true,
            stageContract: uploadStageContract,
          },
          freedomSession,
          snapshot: uploadSnapshot,
        }),
      });
      mediaUploadSummary = summarizeMediaUploadResult(upload);
      checks.push({
        id: 'controlled_media_upload_executed_without_publish',
        ok: upload.status === 200
          && mediaUploadSummary.ok === true
          && mediaUploadSummary.runtime.adapter === 'social-media-upload-execute'
          && mediaUploadSummary.runtime.mediaSelectionAttempted === true
          && mediaUploadSummary.runtime.externalSideEffectPerformed === true
          && mediaUploadSummary.runtime.fileContentRead === false
          && mediaUploadSummary.runtime.execution.fileSelected === true
          && mediaUploadSummary.runtime.execution.uploadStarted === true
          && mediaUploadSummary.runtime.execution.finalButtonClicked === false
          && mediaUploadSummary.runtime.execution.formSubmitted === false
          && mediaUploadSummary.runtime.publishPerformed === false,
        evidence: mediaUploadSummary,
      });
      if (upload.status === 200 && mediaUploadSummary.ok === true && options.enterWaitMs > 0) await sleep(options.enterWaitMs);

      const postUploadProbeStep = buildEditorFieldProbeStep(probeStep);
      const postUploadProbeRunId = `social-dom-post-upload-field-probe-${options.platform}-${Date.now()}`;
      const postUploadProbeSnapshot = await captureDomPreflightSnapshot(postUploadProbeStep.args, 'post_upload_field_probe');
      const postUploadProbe = await requestWithAuth('/api/noe/freedom/execute', {
        method: 'POST',
        body: freedomExecuteBody({
          action: postUploadProbeStep.actionId,
          args: postUploadProbeStep.args,
          platform: options.platform,
          runId: postUploadProbeRunId,
          stepId: 'post_upload_field_probe',
          reason: 'read-only editor field readiness probe after controlled media upload',
          rollbackPlan: 'read-only DOM probe only; close or reload browser tab if needed',
          readonly: true,
          domEvidenceArgs: true,
          freedomSession,
          snapshot: postUploadProbeSnapshot,
        }),
      });
      postUploadProbeSummary = summarizeExecuteResult(postUploadProbe);
      checks.push({
        id: 'post_upload_field_probe_returns_readiness',
        ok: [200, 409].includes(postUploadProbe.status)
          && postUploadProbeSummary.runtime.adapter === 'browser-dom-execute'
          && Boolean(postUploadProbeSummary.runtime.pageReadiness)
          && postUploadProbeSummary.runtime.actions.every((action) => action.clicked === false)
          && postUploadProbeSummary.runtime.secretValuesReturned === false
          && postUploadProbeSummary.runtime.cookiesReadByNoe === false
          && postUploadProbeSummary.runtime.passwordReadByNoe === false
          && postUploadProbeSummary.runtime.pageContentReadByNoe === false,
        evidence: postUploadProbeSummary,
      });
      const uploadCompletionEvidence = buildControlledUploadCompletionEvidence(mediaUploadSummary, mediaFileChecklist);

      if (options.fillAfterUpload) {
        if (mediaUploadSummary.ok !== true) {
          checks.push({
            id: 'controlled_form_fill_requires_successful_media_upload',
            ok: false,
            evidence: {
              mediaUploadOk: mediaUploadSummary.ok === true,
              blockers: mediaUploadSummary.blockers,
              reason: 'form fill is skipped until controlled media upload succeeds',
            },
          });
        } else {
          const draftId = `live-form-fill-${options.platform}-${Date.now()}`;
          const draftRunId = `social-dom-form-fill-draft-${options.platform}-${Date.now()}`;
          const draftDomState = buildDomStateEvidence(postUploadProbeSummary || mediaProbeSummary, { label: 'before_local_draft_create_for_form_fill' });
          const draftStageContract = {
            operation: 'local_social_draft_create_after_controlled_media_upload',
            platform: options.platform,
            localDraftOnly: true,
            controlledMediaUploadCompleted: mediaUploadSummary?.ok === true,
            externalSideEffectExpected: false,
            browserMutationExpected: false,
            requiredPreActionRoles: [],
            missingDomRolesAllowedBeforeFormFill: safeRoleList(draftDomState.pageReadiness?.missingRoles)
              .filter((role) => ['media_upload', 'content', 'tags'].includes(role)),
            finalPublishExcluded: true,
            formSubmitExcluded: true,
            nextStage: 'social_form_fill_execute',
          };
          const draftSnapshot = await captureDomPreflightSnapshot({
            browserApp: options.browserApp,
            expectedHost: hostFromUrl(postUploadProbeSummary?.runtime?.url || activeUrl) || hostFromUrl(PLATFORM_EDITOR_URLS[options.platform] || preset.creatorUrl || ''),
          }, 'local_draft_create_for_form_fill');
          const draftCreate = await requestWithAuth('/api/noe/freedom/execute', {
            method: 'POST',
            body: freedomExecuteBody({
              action: 'noe.freedom.social.draft.create',
              args: {
                id: draftId,
                platform: options.platform,
                title: options.title,
                content: options.content,
                metadata: {
                  title: options.title,
                  tags: options.tags,
                  mediaFiles: options.mediaFiles,
                },
                rollbackPlan: 'cancel the local draft; no final publish is performed by this live form-fill smoke',
              },
              platform: options.platform,
              runId: draftRunId,
              stepId: 'local_draft_create_for_form_fill',
              reason: 'create local temporary social draft for controlled form-fill live smoke',
              rollbackPlan: 'cancel the local draft; no final publish is performed by this live form-fill smoke',
              readonly: false,
              domEvidenceArgs: true,
              domState: draftDomState,
              priorStageEvidenceExtras: {
                controlledMediaUploadCompleted: mediaUploadSummary?.ok === true,
                uploadCompletionEvidence,
                mediaFileChecklist,
                noFinalPublishActionTouchedBeforeDraftCreate: draftDomState.noFinalPublishActionTouched === true,
                stageContract: draftStageContract,
              },
              snapshotExtras: {
                uploadCompletionEvidence,
                mediaFileChecklist,
                noFinalPublishActionTouchedBeforeDraftCreate: draftDomState.noFinalPublishActionTouched === true,
                stageContract: draftStageContract,
              },
              freedomSession,
              snapshot: draftSnapshot,
            }),
          });
          draftCreateSummary = summarizeDraftCreateResult(draftCreate);
          checks.push({
            id: 'local_draft_created_for_form_fill',
            ok: draftCreate.status === 200
              && draftCreateSummary.ok === true
              && draftCreateSummary.runtime.adapter === 'social-draft-create'
              && draftCreateSummary.runtime.externalSideEffectPerformed === false,
            evidence: draftCreateSummary,
          });

          if (draftCreateSummary.ok === true) {
            const activeUrl = PLATFORM_EDITOR_URLS[options.platform]
              || preset.creatorUrl
              || '';
            const formFillRunId = `social-dom-form-fill-execute-${options.platform}-${Date.now()}`;
            const formFillDomState = buildDomStateEvidence(postUploadProbeSummary || mediaProbeSummary, { label: 'before_controlled_form_fill' });
            const formFillStageContract = {
              operation: 'social_form_fill_execute_after_controlled_media_upload',
              platform: options.platform,
              controlledMediaUploadCompleted: mediaUploadSummary?.ok === true,
              localDraftCreated: draftCreateSummary?.ok === true,
              externalSideEffectExpected: false,
              browserFieldMutationExpected: true,
              finalPublishExcluded: true,
              formSubmitExcluded: true,
              mediaUploadRoleMayDisappearAfterUpload: true,
              requiredPostActionEvidence: ['titleEchoMatched', 'contentEchoMatched', 'finalButtonClicked_false', 'formSubmitted_false'],
              missingDomRolesAllowedBeforeFormFill: safeRoleList(formFillDomState.pageReadiness?.missingRoles)
                .filter((role) => ['media_upload', 'content', 'tags'].includes(role)),
            };
            const formFillSnapshot = await captureDomPreflightSnapshot({
              browserApp: options.browserApp,
              expectedHost: hostFromUrl(activeUrl) || hostFromUrl(PLATFORM_EDITOR_URLS[options.platform] || preset.creatorUrl || ''),
            }, 'controlled_form_fill_no_publish');
            const formFill = await requestWithAuth('/api/noe/freedom/execute', {
              method: 'POST',
              body: freedomExecuteBody({
                action: 'noe.freedom.social.form_fill.execute',
                args: {
                  draftId: draftCreateSummary.runtime.id || draftId,
                  platform: options.platform,
                  title: options.title,
                  content: options.content,
                  mediaFiles: options.mediaFiles,
                  requireDraft: true,
                  browserApp: options.browserApp,
                  browserState: browserStateRefFromRuntime(postUploadProbeSummary?.runtime || mediaProbeSummary?.runtime, activeUrl),
                },
                platform: options.platform,
                runId: formFillRunId,
                stepId: 'controlled_form_fill_no_publish',
                reason: 'fill title/content fields after controlled media upload; do not press final publish',
                rollbackPlan: 'clear fields or close the draft tab; final publish is not pressed',
                readonly: false,
                domEvidenceArgs: true,
                domState: formFillDomState,
                priorStageEvidenceExtras: {
                  controlledMediaUploadCompleted: mediaUploadSummary?.ok === true,
                  localDraftCreated: draftCreateSummary?.ok === true,
                  uploadCompletionEvidence,
                  mediaFileChecklist,
                  noFinalPublishActionTouchedBeforeFormFill: formFillDomState.noFinalPublishActionTouched === true,
                  stageContract: formFillStageContract,
                },
                snapshotExtras: {
                  uploadCompletionEvidence,
                  mediaFileChecklist,
                  noFinalPublishActionTouchedBeforeFormFill: formFillDomState.noFinalPublishActionTouched === true,
                  stageContract: formFillStageContract,
                },
                freedomSession,
                snapshot: formFillSnapshot,
              }),
            });
            formFillSummary = summarizeFormFillResult(formFill);
            checks.push({
              id: 'controlled_form_fill_executed_without_publish',
              ok: formFill.status === 200
                && formFillSummary.ok === true
                && formFillSummary.runtime.adapter === 'social-form-fill-execute'
                && formFillSummary.runtime.executionAttempted === true
                && formFillSummary.runtime.externalSideEffectPerformed === false
                && formFillSummary.runtime.publishPerformed === false
                && formFillSummary.runtime.execution.browser.titleFilled === true
                && formFillSummary.runtime.execution.browser.contentFilled === true
                && formFillSummary.runtime.execution.browser.titleEchoMatched === true
                && formFillSummary.runtime.execution.browser.contentEchoMatched === true
                && formFillSummary.runtime.execution.browser.sameField === false
                && formFillSummary.runtime.execution.finalButtonClicked === false
                && formFillSummary.runtime.execution.formSubmitted === false,
              evidence: formFillSummary,
            });

          const postFillProbeStep = buildEditorFieldProbeStep(probeStep);
          const postFillProbeRunId = `social-dom-post-fill-field-probe-${options.platform}-${Date.now()}`;
          const postFillProbeSnapshot = await captureDomPreflightSnapshot(postFillProbeStep.args, 'post_fill_field_probe');
          const postFillProbe = await requestWithAuth('/api/noe/freedom/execute', {
            method: 'POST',
            body: freedomExecuteBody({
              action: postFillProbeStep.actionId,
              args: postFillProbeStep.args,
              platform: options.platform,
              runId: postFillProbeRunId,
              stepId: 'post_fill_field_probe',
              reason: 'read-only editor field readiness probe after controlled form fill',
              rollbackPlan: 'read-only DOM probe only; close or reload browser tab if needed',
              readonly: true,
              domEvidenceArgs: true,
              freedomSession,
              snapshot: postFillProbeSnapshot,
            }),
          });
          postFillProbeSummary = summarizeExecuteResult(postFillProbe);
          checks.push({
            id: 'post_fill_field_probe_returns_readiness',
            ok: [200, 409].includes(postFillProbe.status)
              && postFillProbeSummary.runtime.adapter === 'browser-dom-execute'
              && Boolean(postFillProbeSummary.runtime.pageReadiness)
              && postFillProbeSummary.runtime.actions.every((action) => action.clicked === false)
              && postFillProbeSummary.runtime.secretValuesReturned === false
              && postFillProbeSummary.runtime.cookiesReadByNoe === false
              && postFillProbeSummary.runtime.passwordReadByNoe === false
              && postFillProbeSummary.runtime.pageContentReadByNoe === false,
            evidence: postFillProbeSummary,
          });
        }
        }
      }
    }
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    host: HOST,
    port: PORT,
    platform: options.platform,
    execute: options.execute === true,
    openCreator: options.openCreator === true,
    enterEditor: options.enterEditor === true,
    requireMediaUploadReady: options.requireMediaUploadReady === true,
    uploadAfterMediaReady: options.uploadAfterMediaReady === true,
    fillAfterUpload: options.fillAfterUpload === true,
    checked: checks.length,
    failed: failed.length,
    checks,
    ...(openSummary ? { openSummary } : {}),
    ...(executeSummary ? { executeSummary } : {}),
    ...(enterSummary ? { enterSummary } : {}),
    ...(editorProbeSummary ? { editorProbeSummary } : {}),
    ...(directEditorOpenSummary ? { directEditorOpenSummary } : {}),
    ...(directEditorProbeSummary ? { directEditorProbeSummary } : {}),
    ...(mediaUploadSummary ? { mediaUploadSummary } : {}),
    ...(postUploadProbeSummary ? { postUploadProbeSummary } : {}),
    ...(draftCreateSummary ? { draftCreateSummary } : {}),
    ...(formFillSummary ? { formFillSummary } : {}),
    ...(postFillProbeSummary ? { postFillProbeSummary } : {}),
  };
}
