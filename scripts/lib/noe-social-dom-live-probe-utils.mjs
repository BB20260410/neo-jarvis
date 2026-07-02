import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOwnerTokenAuthorization } from './noe-standing-autonomy-grant.mjs';

export const HOST = process.env.PANEL_HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 51835);

export const PLATFORM_EDITOR_URLS = {
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/post',
};

export function clean(value = '', max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function sha256Text(value = '') {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function hostFromUrl(value = '') {
  try {
    return new URL(clean(value, 2000)).host;
  } catch {
    return '';
  }
}

export function redactUrl(value = '') {
  const raw = clean(value, 2000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(url.hash)) url.hash = '#[redacted]';
    return clean(url.toString(), 2000);
  } catch {
    return raw.replace(/([?&#][^=]*?(token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  }
}

export function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: String(process.env.NOE_OWNER_TOKEN).trim(), source: 'env', policyBlocked: false, reason: '' };
  const tokenPath = join(homedir(), '.noe-panel', 'owner-token.txt');
  if (!existsSync(tokenPath)) return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  try { return { token: readFileSync(tokenPath, 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' }; } catch { return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not readable' }; }
}

export function parseArgs(argv = []) {
  const out = {
    platform: 'xiaohongshu',
    browserApp: 'Google Chrome',
    title: 'Noe live DOM probe title',
    content: 'Noe live DOM probe content',
    tags: ['NoeProbe'],
    execute: false,
    ackOwnerPresent: false,
    requireReady: false,
    requireMediaUploadReady: false,
    uploadAfterMediaReady: false,
    fillAfterUpload: false,
    ackUploadSideEffect: false,
    mediaFiles: [],
    openCreator: false,
    openWaitMs: 1500,
    enterEditor: false,
    enterWaitMs: 2500,
    includeMediaPickerProbe: false,
    includeFinalPublishProbe: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const next = argv[i + 1];
    if (item === '--platform' && next) { out.platform = clean(next, 80); i += 1; }
    else if (item === '--browser-app' && next) { out.browserApp = clean(next, 120); i += 1; }
    else if (item === '--title' && next) { out.title = clean(next, 300); i += 1; }
    else if (item === '--content' && next) { out.content = clean(next, 4000); i += 1; }
    else if (item === '--tags' && next) { out.tags = next.split(',').map((tag) => clean(tag, 120)).filter(Boolean); i += 1; }
    else if (item === '--execute') out.execute = true;
    else if (item === '--ack-owner-present') out.ackOwnerPresent = true;
    else if (item === '--require-ready') out.requireReady = true;
    else if (item === '--require-media-upload-ready') {
      out.requireMediaUploadReady = true;
      out.includeMediaPickerProbe = true;
    }
    else if (item === '--upload-after-media-ready') {
      out.uploadAfterMediaReady = true;
      out.requireMediaUploadReady = true;
      out.includeMediaPickerProbe = true;
    }
    else if (item === '--fill-after-upload') {
      out.fillAfterUpload = true;
      out.uploadAfterMediaReady = true;
      out.requireMediaUploadReady = true;
      out.includeMediaPickerProbe = true;
    }
    else if (item === '--ack-upload-side-effect') out.ackUploadSideEffect = true;
    else if ((item === '--media-file' || item === '--media-files') && next) {
      out.mediaFiles = next.split(',').map((file) => clean(file, 2000)).filter(Boolean);
      i += 1;
    }
    else if (item === '--open-creator') out.openCreator = true;
    else if (item === '--open-wait-ms' && next) { out.openWaitMs = Math.max(0, Math.min(10_000, Number(next) || 0)); i += 1; }
    else if (item === '--enter-editor') out.enterEditor = true;
    else if (item === '--enter-wait-ms' && next) { out.enterWaitMs = Math.max(0, Math.min(15_000, Number(next) || 0)); i += 1; }
    else if (item === '--probe-media-picker') out.includeMediaPickerProbe = true;
    else if (item === '--probe-final-publish') out.includeFinalPublishProbe = true;
    else if (item === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'social-dom-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function requestJson(path, { method = 'GET', body = null, requestImpl = http.request, ackReadOwnerToken = process.env.NOE_ACK_READ_OWNER_TOKEN === '1' } = {}) {
  const tokenPolicy = ownerToken({ ackReadOwnerToken });
  const token = tokenPolicy.token;
  return new Promise((resolve) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (token) headers['X-Panel-Owner-Token'] = token;
    const req = requestImpl({
      host: HOST,
      port: PORT,
      path,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, bodyPrefix: clean(text, 500) });
        }
      });
    });
    req.on('error', (error) => resolve({ error: clean(error?.message || error, 500) }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export function isReadOnlyProbeStep(step = {}) {
  const actions = Array.isArray(step.args?.actions) ? step.args.actions : [];
  return actions.length > 0 && actions.every((action) => {
    const type = clean(action.type, 80);
    return (type === 'read_title' || type === 'probe_by_hints')
      && !Object.hasOwn(action, 'value')
      && !Object.hasOwn(action, 'text')
      && !Object.hasOwn(action, 'content');
  });
}

export function summarizeProbeStep(step = {}) {
  const actions = Array.isArray(step.args?.actions) ? step.args.actions : [];
  return {
    stepId: clean(step.stepId, 120),
    actionId: clean(step.actionId, 180),
    browserApp: clean(step.args?.browserApp || '', 120),
    expectedHost: clean(step.args?.expectedHost || '', 240),
    expectedHosts: Array.isArray(step.args?.expectedHosts) ? step.args.expectedHosts.map((host) => clean(host, 240)).filter(Boolean) : [],
    actionTypes: actions.map((action) => clean(action.type, 80)),
    roles: actions.map((action) => clean(action.role || action.type, 80)).filter(Boolean),
    pageProbe: step.args?.pageProbe ? {
      targetSurface: clean(step.args.pageProbe.targetSurface, 120),
      requiresLoginSession: step.args.pageProbe.requiresLoginSession === true,
      requiredProbeRoles: Array.isArray(step.args.pageProbe.requiredProbeRoles)
        ? step.args.pageProbe.requiredProbeRoles.map((role) => clean(role, 80)).filter(Boolean)
        : [],
      expectedHosts: Array.isArray(step.args.pageProbe.expectedHosts)
        ? step.args.pageProbe.expectedHosts.map((host) => clean(host, 240)).filter(Boolean)
        : [],
    } : null,
    readOnly: isReadOnlyProbeStep(step),
  };
}

export function summarizeExecuteResult(result = {}) {
  const runtime = result.json?.runtime || {};
  const readiness = runtime.pageReadiness || null;
  const actions = Array.isArray(runtime.actions) ? runtime.actions : [];
  const redactedUrl = runtime.url ? redactUrl(runtime.url) : '';
  const title = clean(runtime.title, 500);
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    runtime: {
      adapter: clean(runtime.adapter, 120),
      host: clean(runtime.host, 240),
      urlPresent: runtime.urlPresent === true || Boolean(redactedUrl),
      urlSha256: clean(runtime.urlSha256 || (redactedUrl ? sha256Text(redactedUrl) : ''), 80),
      titlePresent: runtime.titlePresent === true || Boolean(title),
      titleSha256: clean(runtime.titleSha256 || (title ? sha256Text(title) : ''), 80),
      actionCount: Number(runtime.actionCount) || 0,
      actions: actions.map((action) => ({
        type: clean(action.type, 80),
        role: clean(action.role || action.type, 80),
        found: action.found === true,
        probed: action.probed === true,
        clicked: action.clicked === true,
      })),
      pageReadiness: readiness ? {
        ok: readiness.ok === true,
        hostMatched: readiness.hostMatched === true,
        targetSurface: clean(readiness.targetSurface, 120),
        targetSurfaceReady: readiness.targetSurfaceReady === true,
        loginSessionLikely: readiness.loginSessionLikely === true,
        foundRoles: Array.isArray(readiness.foundRoles) ? readiness.foundRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
        missingRoles: Array.isArray(readiness.missingRoles) ? readiness.missingRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
      } : null,
      secretValuesReturned: runtime.secretValuesReturned === true,
      cookiesReadByNoe: runtime.cookiesReadByNoe === true,
      passwordReadByNoe: runtime.passwordReadByNoe === true,
      pageContentReadByNoe: runtime.pageContentReadByNoe === true,
    },
    error: clean(result.error || result.json?.error || '', 500),
  };
}

export function summarizeOpenResult(result = {}) {
  const runtime = result.json?.runtime || {};
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    runtime: {
      adapter: clean(runtime.adapter, 120),
      host: clean(runtime.host, 240),
      browserApp: clean(runtime.browserApp, 120),
      browserOpenAttempted: runtime.browserOpenAttempted === true,
      cookiesReadByNoe: runtime.cookiesReadByNoe === true,
      passwordReadByNoe: runtime.passwordReadByNoe === true,
    },
    error: clean(result.error || result.json?.error || '', 500),
  };
}

export function summarizeMediaUploadResult(result = {}) {
  const runtime = result.json?.runtime || {};
  const execution = runtime.execution || {};
  const browser = execution.browser || {};
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    runtime: {
      adapter: runtime.adapter || '',
      plannedOnly: runtime.plannedOnly === true,
      mediaSelectionAttempted: runtime.mediaSelectionAttempted === true,
      externalSideEffectPerformed: runtime.externalSideEffectPerformed === true,
      publishPerformed: runtime.publishPerformed === true,
      fileContentRead: runtime.fileContentRead === true,
      selectedMedia: runtime.selectedMedia ? {
        ref: runtime.selectedMedia.ref || '',
        kind: runtime.selectedMedia.kind || '',
        contentRead: runtime.selectedMedia.contentRead === true,
      } : null,
      execution: {
        fileSelected: execution.fileSelected === true,
        uploadStarted: execution.uploadStarted === true,
        clipboardOverwritten: execution.clipboardOverwritten === true,
        finalButtonClicked: execution.finalButtonClicked === true,
        formSubmitted: execution.formSubmitted === true,
        browser: {
          targetType: browser.result?.targetType || '',
          clickedUploadControl: browser.result?.clickedUploadControl === true,
          clipboardOverwritten: browser.clipboardOverwritten === true,
          finalButtonClicked: browser.finalButtonClicked === true,
          formSubmitted: browser.formSubmitted === true,
        },
      },
    },
    error: result.error || result.json?.error || '',
  };
}

export function summarizeDraftCreateResult(result = {}) {
  const runtime = result.json?.runtime || {};
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    runtime: {
      adapter: clean(runtime.adapter, 120),
      id: clean(runtime.id, 180),
      ref: clean(runtime.ref, 240),
      platform: clean(runtime.platform, 80),
      externalSideEffectPerformed: runtime.externalSideEffectPerformed === true,
    },
    error: clean(result.error || result.json?.error || '', 500),
  };
}

export function summarizeFormFillResult(result = {}) {
  const runtime = result.json?.runtime || {};
  const execution = runtime.execution || {};
  const browser = execution.browser || {};
  const browserResult = browser.result || {};
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    runtime: {
      adapter: clean(runtime.adapter, 120),
      plannedOnly: runtime.plannedOnly === true,
      executionAttempted: runtime.executionAttempted === true,
      externalSideEffectPerformed: runtime.externalSideEffectPerformed === true,
      publishPerformed: runtime.publishPerformed === true,
      execution: {
        finalButtonClicked: execution.finalButtonClicked === true,
        formSubmitted: execution.formSubmitted === true,
        browser: {
          ok: browser.ok === true,
          app: clean(browser.app, 120),
          host: clean(browserResult.host, 240),
          titleFilled: browserResult.titleFilled === true,
          contentFilled: browserResult.contentFilled === true,
          titleEchoMatched: browserResult.titleEchoMatched === true,
          contentEchoMatched: browserResult.contentEchoMatched === true,
          titleTag: clean(browserResult.titleTag, 80),
          contentTag: clean(browserResult.contentTag, 80),
          sameField: browserResult.sameField === true,
          mediaHandled: browserResult.mediaHandled === true,
          finalButtonClicked: browser.finalButtonClicked === true || browserResult.finalButtonClicked === true,
          formSubmitted: browser.formSubmitted === true || browserResult.formSubmitted === true,
        },
      },
    },
    error: clean(result.error || result.json?.error || '', 500),
  };
}

export function foundRole(summary = {}, role = '') {
  const target = clean(role, 80);
  return Boolean(summary.runtime?.pageReadiness?.foundRoles?.includes(target))
    || Boolean(summary.runtime?.actions?.some((action) => action.role === target && action.found === true));
}

export function latestProbeSummaryWithReadiness(...summaries) {
  return summaries.filter((summary) => summary?.runtime?.pageReadiness).at(-1) || null;
}

export function bestProbeSummaryForRole(role = '', ...summaries) {
  const withReadiness = summaries.filter((summary) => summary?.runtime?.pageReadiness);
  return withReadiness.filter((summary) => foundRole(summary, role)).at(-1)
    || withReadiness.at(-1)
    || null;
}

export function buildCreatorEntryClickStep(probeStep = {}) {
  const entryProbe = (probeStep.args?.actions || []).find((action) => action.role === 'creator_publish_entry');
  if (!entryProbe) return null;
  return {
    stepId: 'click_creator_publish_entry',
    actionId: 'noe.freedom.browser.dom.execute',
    args: {
      browserApp: probeStep.args.browserApp || 'Google Chrome',
      expectedHost: probeStep.args.expectedHost || '',
      expectedHosts: Array.isArray(probeStep.args.expectedHosts) ? probeStep.args.expectedHosts : [],
      actions: [
        { type: 'read_title' },
        {
          type: 'click_by_hints',
          role: 'creator_publish_entry',
          hints: Array.isArray(entryProbe.hints) ? entryProbe.hints : [],
        },
      ],
    },
  };
}

export function buildEditorFieldProbeStep(probeStep = {}) {
  const actions = (probeStep.args?.actions || [])
    .filter((action) => action.role !== 'creator_publish_entry');
  const requiredProbeRoles = (probeStep.args?.pageProbe?.requiredProbeRoles || [])
    .filter((role) => role !== 'creator_publish_entry');
  return {
    ...probeStep,
    stepId: 'probe_editor_fields_after_entry',
    args: {
      ...probeStep.args,
      actions,
      pageProbe: probeStep.args?.pageProbe ? {
        ...probeStep.args.pageProbe,
        requiredProbeRoles,
        clickableRoles: (probeStep.args.pageProbe.clickableRoles || []).filter((role) => role !== 'creator_publish_entry'),
      } : null,
    },
  };
}
