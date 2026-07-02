#!/usr/bin/env node
// @ts-check
// Read-only snapshot for the remaining public/social publish proof gate.
// It proves the pre-publication chain evidence and keeps the real public
// final-publish sample blocked until a publish URL plus rollback evidence exists.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeNoeSocialFinalPublish } from '../src/runtime/NoeSocialFinalPublishExecutor.js';
import { DEFAULT_NOE_SOCIAL_DRAFT_DIR } from '../src/runtime/NoeSocialPublishQueue.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNS_DIR = join(ROOT, 'output', 'noe-freedom-runs');
const OUT_DIR = join(ROOT, 'output', 'noe-social-public-readiness');
const DAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function clean(value, max = 1000) {
  return String(value ?? '')
    .replace(/([?&#][^=]*?(?:token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]+)\b/g, '[redacted]')
    .slice(0, max);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    runsDir: process.env.NOE_SOCIAL_PUBLIC_READINESS_RUNS_DIR || DEFAULT_RUNS_DIR,
    draftDir: process.env.NOE_SOCIAL_PUBLIC_READINESS_DRAFT_DIR || DEFAULT_NOE_SOCIAL_DRAFT_DIR,
    platform: process.env.NOE_SOCIAL_PUBLIC_READINESS_PLATFORM || 'douyin',
    writeReport: process.env.NOE_SOCIAL_PUBLIC_READINESS_NO_WRITE !== '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs-dir') out.runsDir = argv[++i] || out.runsDir;
    else if (arg.startsWith('--runs-dir=')) out.runsDir = arg.slice('--runs-dir='.length);
    else if (arg === '--draft-dir') out.draftDir = argv[++i] || out.draftDir;
    else if (arg.startsWith('--draft-dir=')) out.draftDir = arg.slice('--draft-dir='.length);
    else if (arg === '--platform') out.platform = argv[++i] || out.platform;
    else if (arg.startsWith('--platform=')) out.platform = arg.slice('--platform='.length);
    else if (arg === '--no-write') out.writeReport = false;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function walkJsonFiles(dir) {
  const files = [];
  const visit = (next) => {
    if (!existsSync(next)) return;
    const stat = statSync(next);
    if (stat.isDirectory()) {
      for (const name of readdirSync(next)) visit(join(next, name));
      return;
    }
    if (stat.isFile() && next.endsWith('.json')) files.push(next);
  };
  visit(dir);
  return files;
}

function ledgerOperation(ledger = {}) {
  return clean(ledger.action?.operation || ledger.action?.toolId || ledger.operation || '', 160);
}

function ledgerCreatedMs(file, ledger = {}) {
  const ts = Date.parse(ledger.createdAt || ledger.generatedAt || '');
  if (Number.isFinite(ts)) return ts;
  const stat = statSync(file);
  return stat.mtimeMs;
}

function latestLedger({ runsDir, operation, predicate = () => true } = {}) {
  let latest = null;
  for (const file of walkJsonFiles(runsDir)) {
    if (!file.endsWith('/ledger.json')) continue;
    const ledger = readJson(file);
    if (!ledger || ledgerOperation(ledger) !== operation || !predicate(ledger)) continue;
    const createdMs = ledgerCreatedMs(file, ledger);
    if (!latest || createdMs > latest.createdMs) latest = { file, ledger, createdMs };
  }
  return latest;
}

function ledgerRef(item) {
  if (!item) return null;
  return {
    file: rel(item.file),
    runId: clean(item.ledger.runId, 240),
    createdAt: clean(item.ledger.createdAt || '', 80),
    ok: item.ledger.ok === true,
    realExecute: item.ledger.realExecute === true,
  };
}

function browserStateFromLedger(item) {
  const activeBrowser = item?.ledger?.argsPreview?.browserState?.activeBrowser
    || item?.ledger?.runtime?.browser?.activeBrowser
    || null;
  if (activeBrowser?.url || activeBrowser?.title) {
    return {
      activeBrowser: {
        url: clean(activeBrowser.url, 2000),
        title: clean(activeBrowser.title, 500),
      },
    };
  }
  const url = item?.ledger?.runtime?.execution?.browser?.result?.url;
  if (url) return { activeBrowser: { url: clean(url, 2000), title: clean(item?.ledger?.runtime?.platformLabel || '', 500) } };
  return {};
}

function formFillReady(item) {
  const runtime = item?.ledger?.runtime || {};
  const result = runtime.execution?.browser?.result || {};
  const ok = item?.ledger?.ok === true
    && item?.ledger?.realExecute === true
    && runtime.ok === true
    && result.titleFilled === true
    && result.contentFilled === true
    && result.finalButtonClicked !== true
    && result.formSubmitted !== true
    && runtime.publishPerformed !== true
    && runtime.secretValuesReturned !== true;
  return {
    ok,
    evidence: ledgerRef(item),
    checks: {
      realExecute: item?.ledger?.realExecute === true,
      titleFilled: result.titleFilled === true,
      contentFilled: result.contentFilled === true,
      finalButtonClicked: result.finalButtonClicked === true,
      formSubmitted: result.formSubmitted === true,
      publishPerformed: runtime.publishPerformed === true,
      secretValuesReturned: runtime.secretValuesReturned === true,
    },
  };
}

function mediaUploadReady(item) {
  const runtime = item?.ledger?.runtime || {};
  const execution = runtime.execution || {};
  const browser = execution.browser || {};
  const ok = item?.ledger?.ok === true
    && item?.ledger?.realExecute === true
    && runtime.ok === true
    && runtime.media?.ok === true
    && browser.fileSelected === true
    && browser.uploadStarted === true
    && browser.finalButtonClicked !== true
    && browser.formSubmitted !== true
    && runtime.publishPerformed !== true
    && runtime.secretValuesReturned !== true;
  return {
    ok,
    evidence: ledgerRef(item),
    checks: {
      realExecute: item?.ledger?.realExecute === true,
      mediaReady: runtime.media?.ok === true,
      fileSelected: browser.fileSelected === true,
      uploadStarted: browser.uploadStarted === true,
      finalButtonClicked: browser.finalButtonClicked === true,
      formSubmitted: browser.formSubmitted === true,
      publishPerformed: runtime.publishPerformed === true,
      secretValuesReturned: runtime.secretValuesReturned === true,
    },
    selectedMedia: runtime.selectedMedia ? {
      ref: clean(runtime.selectedMedia.ref, 1000),
      kind: clean(runtime.selectedMedia.kind, 80),
      size: Number(runtime.selectedMedia.size) || 0,
      contentRead: runtime.selectedMedia.contentRead === true,
    } : null,
  };
}

function publicFinalPublishSampleReady(item) {
  const runtime = item?.ledger?.runtime || {};
  const rollback = runtime.rollbackEvidence || item?.ledger?.rollbackEvidence || {};
  const ok = item?.ledger?.ok === true
    && item?.ledger?.realExecute === true
    && runtime.publishPerformed === true
    && runtime.externalSideEffectPerformed === true
    && rollback.evidenceStatus === 'verified'
    && rollback.verifiedByNoe === true
    && rollback.postUrlRef;
  return {
    ok,
    evidence: ledgerRef(item),
    checks: {
      realExecute: item?.ledger?.realExecute === true,
      publishPerformed: runtime.publishPerformed === true,
      externalSideEffectPerformed: runtime.externalSideEffectPerformed === true,
      rollbackVerified: rollback.evidenceStatus === 'verified' && rollback.verifiedByNoe === true,
      postUrlCaptured: Boolean(rollback.postUrlRef),
    },
  };
}

function latestDraftId(formFill, mediaUpload) {
  return clean(
    formFill?.ledger?.argsPreview?.draftId
    || formFill?.ledger?.runtime?.draft?.id
    || mediaUpload?.ledger?.argsPreview?.draftId
    || mediaUpload?.ledger?.runtime?.draft?.id
    || '',
    240,
  );
}

async function finalPublishDryRunGate({ draftDir, platform, draftId, browserState, formOk, mediaOk }) {
  if (!draftId) {
    return { ok: false, blocker: 'social_draft_id_missing', dryRun: null };
  }
  const priorStageEvidence = {
    ok: formOk && mediaOk,
    kind: 'social_publish_stage_summary',
    completedStages: [
      ...(formOk ? ['form_fill_execute'] : []),
      ...(mediaOk ? ['media_upload_execute'] : []),
    ],
    failedStages: [],
    secretValuesReturned: false,
  };
  const dryRun = await executeNoeSocialFinalPublish({
    draftDir,
    realExecute: false,
    args: {
      draftId,
      platform,
      requirePriorStageEvidence: true,
      priorStageEvidence,
      browserState,
    },
  });
  return {
    ok: dryRun.ok === true
      && dryRun.plannedOnly === true
      && dryRun.executionAttempted === false
      && dryRun.externalSideEffectPerformed !== true
      && dryRun.publishPerformed !== true
      && dryRun.priorStageEvidence?.ok === true
      && dryRun.rollbackEvidence?.requiredAfterPublish === true,
    blocker: dryRun.ok === true ? '' : (dryRun.blockers || ['final_publish_dry_run_gate_failed']).join(','),
    dryRun: {
      ok: dryRun.ok === true,
      plannedOnly: dryRun.plannedOnly === true,
      executionAttempted: dryRun.executionAttempted === true,
      externalSideEffectPerformed: dryRun.externalSideEffectPerformed === true,
      publishPerformed: dryRun.publishPerformed === true,
      priorStageEvidence: dryRun.priorStageEvidence,
      rollbackEvidenceStatus: clean(dryRun.rollbackEvidence?.evidenceStatus || '', 80),
      rollbackMissingEvidence: Array.isArray(dryRun.rollbackEvidence?.missingEvidence)
        ? dryRun.rollbackEvidence.missingEvidence.map((item) => clean(item, 160))
        : [],
      nextActionIds: Array.isArray(dryRun.nextFreedomActions)
        ? dryRun.nextFreedomActions.map((item) => clean(item.actionId, 180)).filter(Boolean)
        : [],
      blockers: Array.isArray(dryRun.blockers) ? dryRun.blockers.map((item) => clean(item, 240)) : [],
      secretValuesReturned: dryRun.secretValuesReturned === true,
    },
  };
}

export async function buildSocialPublicReadinessReport({
  runsDir = DEFAULT_RUNS_DIR,
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  platform = 'douyin',
  generatedAt = new Date().toISOString(),
} = {}) {
  const formLedger = latestLedger({
    runsDir,
    operation: 'noe.freedom.social.form_fill.execute',
    predicate: (ledger) => ledger?.runtime?.platform === platform,
  });
  const mediaLedger = latestLedger({
    runsDir,
    operation: 'noe.freedom.social.media_upload.execute',
    predicate: (ledger) => ledger?.runtime?.platform === platform,
  });
  const finalLedger = latestLedger({
    runsDir,
    operation: 'noe.freedom.social.final_publish.execute',
    predicate: (ledger) => ledger?.runtime?.platform === platform && ledger?.runtime?.publishPerformed === true,
  });
  const form = formFillReady(formLedger);
  const media = mediaUploadReady(mediaLedger);
  const publicSample = publicFinalPublishSampleReady(finalLedger);
  const draftId = latestDraftId(formLedger, mediaLedger);
  const browserState = browserStateFromLedger(formLedger) || browserStateFromLedger(mediaLedger);
  const finalDryRun = await finalPublishDryRunGate({
    draftDir,
    platform,
    draftId,
    browserState,
    formOk: form.ok,
    mediaOk: media.ok,
  });
  const checks = {
    formFillStageReady: form,
    mediaUploadStageReady: media,
    priorStageEvidenceReady: {
      ok: form.ok && media.ok,
      requiredStages: ['form_fill_execute', 'media_upload_execute'],
      completedStages: [
        ...(form.ok ? ['form_fill_execute'] : []),
        ...(media.ok ? ['media_upload_execute'] : []),
      ],
    },
    finalPublishDryRunGateReady: finalDryRun,
    rollbackGateMechanismReady: {
      ok: finalDryRun.ok === true && finalDryRun.dryRun?.rollbackEvidenceStatus === 'pending_probe',
      evidence: 'final publish dry-run rollbackEvidence requires post-publish URL/title before rollback can verify',
    },
    realPublicFinalPublishSampleReady: publicSample,
  };
  const blockers = [
    ...(!form.ok ? ['form_fill_stage_not_verified'] : []),
    ...(!media.ok ? ['media_upload_stage_not_verified'] : []),
    ...(!finalDryRun.ok ? [`final_publish_dry_run_gate_not_ready:${finalDryRun.blocker}`] : []),
    ...(!publicSample.ok ? ['real_public_final_publish_sample_missing'] : []),
    ...(!publicSample.ok ? ['verified_post_publish_rollback_evidence_missing'] : []),
  ];
  return {
    ok: true,
    generatedAt,
    day: DAY,
    platform,
    status: {
      publicSampleReady: publicSample.ok,
      readyForOwnerAuthorizedPublicSample: form.ok && media.ok && finalDryRun.ok === true,
      blockers,
    },
    policy: {
      readOnly: true,
      noBrowserAutomation: true,
      noFinalPublishClick: true,
      noFormSubmit: true,
      noCookieRead: true,
      noPasswordRead: true,
      noSecretValuesReturned: true,
      noPortRestart: true,
      lmStudioLoadUnloadChanged: false,
    },
    source: {
      runsDir: rel(resolve(runsDir)),
      draftDir: clean(draftDir, 1000),
      draftId,
    },
    checks,
    evidenceRefs: [
      ...(form.evidence ? [{ file: form.evidence.file, note: 'latest real form-fill stage ledger' }] : []),
      ...(media.evidence ? [{ file: media.evidence.file, note: 'latest real media-upload stage ledger' }] : []),
      ...(publicSample.evidence ? [{ file: publicSample.evidence.file, note: 'latest verified real public final-publish ledger' }] : []),
    ],
    nextCommands: publicSample.ok ? [] : [
      'Keep using verify:noe:social-public-readiness to confirm form/media/prior-stage readiness before any public sample.',
      'For a real public sample, execute final publish only after owner selects target account/post and accepts that a public post will be created.',
      'Immediately capture post URL/title, then run rollback evidence gate before any delete/hide/correction.',
    ],
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildSocialPublicReadinessReport(args);
  if (args.writeReport) {
    const dayDir = join(OUT_DIR, DAY);
    mkdirSync(dayDir, { recursive: true, mode: 0o700 });
    const reportPath = join(dayDir, 'report.json');
    const latestPath = join(OUT_DIR, 'latest.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(latestPath, JSON.stringify({ ...report, reportPath: rel(reportPath), latestPath: rel(latestPath) }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, reportPath: rel(reportPath), latestPath: rel(latestPath) }, null, 2));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}

export { parseArgs };
