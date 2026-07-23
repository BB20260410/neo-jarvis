// @ts-check
// social 域适配器：social.publish 全家桶（publish / workflow / orchestrate / preflight / form_fill /
// media_upload / final_publish / rollback / draft）+ macos.applescript.run。
// 拆分自 NoeFreedomAdapters.js（纯搬运，行为零改变）。
import { spawn } from 'node:child_process';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  cancelNoeSocialDraft,
  createNoeSocialDraft,
  listNoeSocialDrafts,
} from '../NoeSocialPublishQueue.js';
import { executeNoeSocialFinalPublish } from '../NoeSocialFinalPublishExecutor.js';
import { executeNoeSocialFormFill } from '../NoeSocialFormFillExecutor.js';
import { buildNoeSocialFormFillPlan } from '../NoeSocialFormFillPlan.js';
import { executeNoeSocialMediaUpload } from '../NoeSocialMediaUploadExecutor.js';
import { buildNoeSocialMediaUploadPlan } from '../NoeSocialMediaUploadPlan.js';
import { orchestrateNoeSocialPublish } from '../NoeSocialPublishOrchestrator.js';
import { runNoeSocialPublishPreflight } from '../NoeSocialPublishPreflight.js';
import { prepareNoeSocialPublishWorkflow } from '../NoeSocialPublishWorkflow.js';
import {
  buildNoeSocialRollbackExecuteScript,
  parseNoeSocialRollbackExecuteOutput,
  planNoeSocialRollbackEvidenceGate,
} from '../NoeSocialRollbackEvidenceGate.js';
import { clean, dryRunPlan, hostFromUrl, redactDiagnosticText, runProcess, safeJson } from './common.js';

export function socialDryRun({ tool, args }) {
  const url = clean(args.webhookUrl || args.url, 2000);
  const content = clean(args.content || args.text || args.message, 8000);
  const warnings = [];
  if (!content) warnings.push('publish_content_required');
  if (!url) warnings.push('publish_endpoint_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-publish',
    extras: {
      valid: warnings.length === 0,
      method: 'POST',
      host: hostFromUrl(url),
      wouldPostBytes: Buffer.byteLength(content, 'utf8'),
      rollbackExpectation: 'platform_delete_or_correction',
    },
    warnings,
  });
}

function appleScriptLanguage(args = {}) {
  const language = clean(args.language || args.lang || 'AppleScript', 80).toLowerCase();
  return ['javascript', 'jxa'].includes(language) ? 'JavaScript' : 'AppleScript';
}

export function appleScriptDryRun({ tool, args }) {
  const script = clean(args.script || args.code, 20_000);
  const warnings = script ? [] : ['applescript_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'macos-applescript',
    extras: {
      valid: warnings.length === 0,
      language: appleScriptLanguage(args),
      scriptPreview: script.slice(0, 4000),
      wouldRunOsaScript: warnings.length === 0,
      desktopAutomationAttempted: false,
      secretValuesReturned: false,
    },
    warnings,
  });
}

export async function appleScriptExecute({ args, root, deps }) {
  const script = clean(args.script || args.code, 20_000);
  if (!script) return { ok: false, adapter: 'macos-applescript', error: 'applescript_required' };
  const language = appleScriptLanguage(args);
  return {
    adapter: 'macos-applescript',
    language,
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    ...(await runProcess('osascript', ['-l', language, '-e', script], { cwd: root, spawnImpl: deps.spawn || spawn })),
  };
}

export async function socialExecute({ args, deps }) {
  const target = clean(args.target || args.platform || 'webhook', 120);
  const url = clean(args.webhookUrl || args.url, 2000);
  const content = clean(args.content || args.text || args.message, 8000);
  if (!content) return { ok: false, adapter: 'social-publish', error: 'publish_content_required' };
  if (!url) return { ok: false, adapter: 'social-publish', error: 'publish_endpoint_required' };
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, adapter: 'social-publish', error: 'fetch_unavailable' };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, content, metadata: safeJson(args.metadata) }),
  });
  return {
    ok: response.ok,
    adapter: 'social-publish',
    target,
    status: response.status,
    host: hostFromUrl(url),
    responsePreview: clean(await response.text?.(), 1000),
  };
}

export function socialWorkflowDryRun({ tool, args, deps }) {
  const workflow = prepareNoeSocialPublishWorkflow({
    args,
    realExecute: false,
    draftDir: socialDraftDir(args, deps),
  });
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-workflow-prepare',
    extras: workflow,
    warnings: workflow.warnings || [],
  });
}

export function socialWorkflowExecute({ args, deps }) {
  return prepareNoeSocialPublishWorkflow({
    args,
    realExecute: true,
    draftDir: socialDraftDir(args, deps),
  });
}

export function socialPublishOrchestratorRun({ args, root, deps, realExecute = false }) {
  return orchestrateNoeSocialPublish({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

export function socialPreflightRun({ args, root, deps, realExecute = false }) {
  return runNoeSocialPublishPreflight({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

export function socialFormFillPlanRun({ args, deps, realExecute = false }) {
  return buildNoeSocialFormFillPlan({
    args,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

export async function socialFormFillExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialFormFill({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

export function socialMediaUploadPrepareRun({ args, root, deps, realExecute = false }) {
  return buildNoeSocialMediaUploadPlan({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

export async function socialMediaUploadExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialMediaUpload({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

export async function socialFinalPublishExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialFinalPublish({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

// Pure evidence gate. dryRun and execute both run the same gate — it never performs a real
// rollback. Destructive authorization is derived from trusted route/session authorization or deps.
// `root` is threaded into deps so a consensusLedgerRef is verified against the real repo (Task 0.2 Step5).
export function socialRollbackEvidenceGateRun({ args, root, deps }) {
  return planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
}

export function socialRollbackExecuteDryRun({ tool, args, root, deps }) {
  const gate = planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-rollback-execute',
    extras: {
      valid: gate.ok === true,
      gateStatus: gate.gateStatus,
      blockers: Array.isArray(gate.blockers) ? gate.blockers : [],
      warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
      evidenceGate: gate,
      wouldExecuteRollback: gate.ok === true,
      executesRealRollback: false,
      externalSideEffectPerformed: false,
      destructionPerformed: false,
      secretValuesReturned: false,
    },
    warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
  });
}

export async function socialRollbackExecuteRun({ args, root, deps }) {
  const gate = planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
  if (gate.ok !== true) {
    return {
      ok: false,
      adapter: 'social-rollback-execute',
      gateStatus: gate.gateStatus,
      blockers: Array.isArray(gate.blockers) ? gate.blockers : ['rollback_evidence_gate_blocked'],
      warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
      evidenceGate: gate,
      executesRealRollback: false,
      externalSideEffectPerformed: false,
      destructionPerformed: false,
      secretValuesReturned: false,
    };
  }
  const script = buildNoeSocialRollbackExecuteScript({ args });
  const execution = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: root,
    spawnImpl: deps.spawn || spawn,
  });
  const parsed = parseNoeSocialRollbackExecuteOutput(execution.stdout || '');
  const executionSummary = {
    ok: execution.ok === true,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stderr: redactDiagnosticText(execution.stderr || '', 1000),
    stdoutReturned: false,
  };
  const destructiveRollbackNeedsVerification = ['delete', 'hide', 'recall'].includes(parsed.rollbackAction);
  const rollbackVerificationBlockers = destructiveRollbackNeedsVerification && parsed.rollbackVerified !== true
    ? ['rollback_verification_required']
    : [];
  return {
    ok: execution.ok === true && parsed.ok === true && rollbackVerificationBlockers.length === 0,
    adapter: 'social-rollback-execute',
    gateStatus: gate.gateStatus,
    evidenceGate: gate,
    executionAttempted: true,
    command: 'osascript',
    exitCode: executionSummary.exitCode,
    signal: executionSummary.signal,
    stderr: executionSummary.stderr,
    execution: executionSummary,
    rollbackExecution: parsed,
    executesRealRollback: parsed.rollbackClicked === true,
    rollbackClicked: parsed.rollbackClicked === true,
    confirmationClicked: parsed.confirmationClicked === true,
    externalSideEffectPerformed: parsed.externalSideEffectPerformed === true,
    destructionPerformed: parsed.destructionPerformed === true,
    pageContentReadByNoe: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    secretValuesReturned: false,
    stdoutReturned: false,
    blockers: parsed.ok === true ? rollbackVerificationBlockers : [parsed.error || 'rollback_execute_failed'],
  };
}

function socialDraftDir(args = {}, deps = {}) {
  return clean(args.draftDir || args.dir || deps.socialDraftDir || DEFAULT_NOE_SOCIAL_DRAFT_DIR, 2000);
}

export function socialDraftCreateDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  const content = clean(args.content || args.text || args.message, 20_000);
  const warnings = content ? [] : ['social_draft_content_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-create',
    extras: {
      valid: warnings.length === 0,
      draftDir: dir,
      platform: clean(args.platform || args.target || 'webhook', 80),
      wouldWriteDraft: warnings.length === 0,
      externalSideEffectPerformed: false,
      rollbackExpectation: 'cancel_draft',
    },
    warnings,
  });
}

export function socialDraftCreateExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-create',
    ...createNoeSocialDraft({ dir, draft: args }),
  };
}

export function socialDraftListDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-list',
    extras: {
      valid: true,
      draftDir: dir,
      wouldReadDrafts: true,
      externalSideEffectPerformed: false,
    },
  });
}

export function socialDraftListExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-list',
    ...listNoeSocialDrafts({ dir }),
  };
}

export function socialDraftCancelDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  const id = clean(args.id, 180);
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-cancel',
    extras: {
      valid: Boolean(id),
      id,
      draftDir: dir,
      wouldCancelDraft: Boolean(id),
      externalSideEffectPerformed: false,
      rollbackExpectation: 'recreate_draft',
    },
    warnings: id ? [] : ['social_draft_id_required'],
  });
}

export function socialDraftCancelExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-cancel',
    ...cancelNoeSocialDraft({ dir, id: args.id, reason: args.reason || 'owner_cancelled' }),
  };
}
