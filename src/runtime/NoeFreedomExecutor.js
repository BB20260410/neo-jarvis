import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNoeActionEvidence } from './NoeActionEvidence.js';
import { commandDeletesProtectedPath } from './_protectedPathGuard.js';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { runNoeFreedomAdapter } from './NoeFreedomAdapters.js';
import { readNoeFreedomRunLedgerFile, writeNoeFreedomRunLedgerFile } from './NoeFreedomRunLedger.js';
import {
  NOE_FREEDOM_DEVELOPER_MODE_PROFILE,
  NOE_FREEDOM_AUTH_MODES,
  findNoeFreedomTool,
  listNoeFreedomQuickStarts,
  listNoeFreedomTools,
  redactNoeFreedomPayload,
  validateNoeFreedomAuthorization,
} from '../capabilities/NoeFreedomManifest.js';
import { validateNoeFreedomTrustManifest } from '../capabilities/NoeFreedomTrustManifest.js';
import { evaluateNoeFreedomAllowlist } from '../capabilities/NoeFreedomAllowlist.js';
import { buildNoeReviewBrainPreflight, isNoeHighRiskTask } from '../model/NoeLocalBrainRouter.js';

export const NOE_FREEDOM_EXECUTION_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_FREEDOM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NOE_FREEDOM_CHAIN_OPERATION = 'noe.freedom.chain.execute';
export const NOE_FREEDOM_RESUME_NEXT_ACTIONS_OPERATION = 'noe.freedom.run.resume_next_actions';
const MAX_NOE_FREEDOM_CHAIN_STEPS = 12;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isDeveloperUnrestricted({ authorization = {}, realExecute = false } = {}) {
  return realExecute === true && clean(authorization.mode, 80) === 'developer_unrestricted';
}

function normalizedCommandText({ tool, args = {} } = {}) {
  if (tool?.capability === 'shell.exec') return clean(args.command, 20_000);
  if (tool?.capability === 'ssh.exec') return clean(args.command, 20_000);
  if (tool?.capability === 'automation.applescript') return clean(args.script || args.code, 20_000);
  return '';
}

function evaluateDeveloperHardVeto({ tool, args = {} } = {}) {
  const errors = [];
  const command = normalizedCommandText({ tool, args });
  const protectedDelete = commandDeletesProtectedPath(command);
  if (protectedDelete) errors.push(`developer_hard_veto_protected_delete:${protectedDelete}`);
  return errors;
}

const REVIEW_VERDICT_DECISIONS = new Set(['approve', 'block', 'revise']);

// 把 Review Brain 的输出归一成结构化 verdict。容忍三种形态：
// 1) 直接返回 { verdict, blockers, ... } 对象；
// 2) brainChat 形态 { reply: '<json string>' }；
// 3) 直接返回 JSON 字符串。
// 解析不出合法 verdict 时返回 null，让调用方 fail-closed（绝不当作 approve）。
function parseReviewVerdict(raw) {
  if (raw == null) return null;
  let value = raw;
  if (typeof value === 'string') {
    value = tryParseVerdictJson(value);
  } else if (typeof value === 'object' && typeof value.verdict !== 'string' && typeof value.reply === 'string') {
    value = tryParseVerdictJson(value.reply);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const verdict = clean(value.verdict, 40).toLowerCase();
  if (!REVIEW_VERDICT_DECISIONS.has(verdict)) return null;
  return {
    verdict,
    blockers: Array.isArray(value.blockers) ? value.blockers.map((item) => clean(item, 1000)).filter(Boolean).slice(0, 40) : [],
    risks: Array.isArray(value.risks) ? value.risks.map((item) => clean(item, 1000)).filter(Boolean).slice(0, 40) : [],
    missingEvidence: Array.isArray(value.missingEvidence) ? value.missingEvidence.map((item) => clean(item, 1000)).filter(Boolean).slice(0, 40) : [],
    secretLeakRisk: value.secretLeakRisk === true,
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
  };
}

function tryParseVerdictJson(text = '') {
  const str = String(text || '').trim();
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    // 容忍模型在 JSON 外包裹少量散文：截取第一个完整的 {...} 块再试一次。
    const start = str.indexOf('{');
    const end = str.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(str.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// 高风险/critical real execute 的强制复核闸：真实调用 Review Brain 并等待 verdict。
// 返回 { blockers, verdict, skippedReason }：blockers 非空即必须阻断且不得继续 runtime。
//
// 安全契约（修"声称的复核没生效"，绝不引入比现状更宽松的放行/绕过路径）：
// - 注入了 review brain → 必须真实调用并按 verdict 决策：approve 放行；block/revise 阻断；
//   调用抛错或 verdict 解析不出 → fail-closed 阻断（绝不把无法复核当 approve）。
// - 未注入 review brain → 这是"复核能力尚未接线"的已知降级，不阻断（与历史现状一致，
//   不是新增绕过），但在 preflight 上显式标记 skippedReason 供审计，绝不静默伪装成 approved。
//   生产接线 review brain client 后此分支不再触发。
async function runReviewBrainGate({ preflight, deps = {} } = {}) {
  const reviewBrain = typeof deps.reviewBrain === 'function' ? deps.reviewBrain : null;
  if (!reviewBrain) {
    return { blockers: [], verdict: null, skippedReason: 'review_brain_not_wired' };
  }
  let raw;
  try {
    raw = await reviewBrain({ request: preflight.request, preflight });
  } catch (error) {
    return {
      blockers: [
        'review_brain_unavailable_for_high_risk_real_execute',
        `review_brain_call_failed:${clean(error?.message || error, 500)}`,
      ],
      verdict: null,
    };
  }
  const verdict = parseReviewVerdict(raw);
  if (!verdict) {
    return { blockers: ['review_brain_verdict_unparseable'], verdict: null };
  }
  if (verdict.verdict === 'approve') {
    return { blockers: [], verdict };
  }
  if (verdict.verdict === 'revise') {
    return {
      blockers: ['review_brain_revise_required', ...verdict.blockers.map((item) => `review_brain_blocker:${item}`)],
      verdict,
    };
  }
  return {
    blockers: ['review_brain_blocked', ...verdict.blockers.map((item) => `review_brain_blocker:${item}`)],
    verdict,
  };
}

function makeBaseResult({ tool, args, realExecute, authorization, authz, trust, allowlist }) {
  const rollbackPlan = authorization?.rollbackPlan || authorization?.rollbackRef || args?.rollbackPlan || args?.rollbackRef || '';
  return {
    schemaVersion: NOE_FREEDOM_EXECUTION_SCHEMA_VERSION,
    id: `freedom-${randomUUID().slice(0, 12)}`,
    ok: false,
    dryRunOnly: realExecute !== true,
    realExecute: realExecute === true,
    tool: tool ? {
      id: tool.id,
      operation: tool.operation,
      capability: tool.capability,
      riskLevel: tool.riskLevel,
    } : null,
    authorization: {
      mode: authz?.mode || clean(authorization?.mode || '', 80),
      ownerPresent: authorization?.ownerPresent === true,
      sessionId: clean(authorization?.sessionId || authorization?.session_id || '', 180),
      allowlistAccepted: authorization?.allowlistAccepted === true,
      rollbackPlanPresent: Boolean(clean(rollbackPlan, 1000)),
    },
    trust: trust?.manifest ? {
      id: trust.manifest.id,
      operation: trust.manifest.operation,
      source: trust.manifest.source,
      sha256: trust.manifest.sha256,
      errors: trust.errors || [],
    } : null,
    allowlist: allowlist?.allowlist ? {
      id: allowlist.allowlist.id,
      source: allowlist.allowlist.source,
      errors: allowlist.errors || [],
    } : null,
    argsPreview: redactNoeFreedomPayload(args),
    blockers: [],
    warnings: [],
    runtime: null,
    rollback: {
      strategy: tool?.rollback?.strategy || 'unknown',
      plan: clean(rollbackPlan, 1000),
    },
    evidence: null,
    reviewBrainPreflight: null,
  };
}

function safePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

const FREEDOM_EVIDENCE_CONTEXT_KEY_ALIASES = new Map([
  ['goal', 'goal'],
  ['goal_title', 'goalTitle'],
  ['goaltitle', 'goalTitle'],
  ['mission', 'goal'],
  ['mission_title', 'goalTitle'],
  ['missiontitle', 'goalTitle'],
  ['expectation', 'expectation'],
  ['expected_claim', 'expectedClaim'],
  ['expectedclaim', 'expectedClaim'],
  ['claim', 'claim'],
  ['checkpoint', 'checkpoint'],
  ['checkpoint_title', 'checkpoint'],
  ['checkpointtitle', 'checkpoint'],
  ['step', 'step'],
  ['step_text', 'stepText'],
  ['steptext', 'stepText'],
  ['task', 'task'],
  ['task_title', 'task'],
  ['tasktitle', 'task'],
  ['intent', 'intent'],
  ['plan', 'plan'],
  ['title', 'title'],
]);

function normalizedEvidenceContextKey(key = '') {
  return String(key || '').replace(/[-\s]+/g, '_').toLowerCase();
}

function pushEvidenceContextValue(out, key = '', value = '') {
  const canonical = FREEDOM_EVIDENCE_CONTEXT_KEY_ALIASES.get(normalizedEvidenceContextKey(key));
  if (!canonical || value == null || typeof value === 'object') return;
  const text = clean(value, 500).replace(/\s+/g, ' ').trim();
  if (!text || text === '[REDACTED]') return;
  if (!out[canonical]) out[canonical] = text;
}

function collectFreedomEvidenceInput(value, out = {}, depth = 0, key = '') {
  if (depth > 4 || value == null) return out;
  if (/(?:api[_-]?key|token|secret|password|passwd|cookie|authorization|oauth|credential|private[_-]?key|refresh[_-]?token|session[_-]?token)/i.test(String(key || ''))) {
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    pushEvidenceContextValue(out, key, value);
    return out;
  }
  if (typeof value === 'boolean' || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectFreedomEvidenceInput(item, out, depth + 1, key);
    return out;
  }
  for (const [childKey, childValue] of Object.entries(value).slice(0, 60)) {
    collectFreedomEvidenceInput(childValue, out, depth + 1, childKey);
  }
  return out;
}

function buildFreedomActionEvidenceInput({
  args = {},
  evidenceInput = null,
  authorization = {},
} = {}) {
  const out = {};
  collectFreedomEvidenceInput(args, out);
  collectFreedomEvidenceInput(evidenceInput, out);
  if (!out.intent && authorization?.reason) pushEvidenceContextValue(out, 'intent', authorization.reason);
  return out;
}

function normalizeChainSteps(args = {}) {
  const source = Array.isArray(args.steps)
    ? args.steps
    : Array.isArray(args.nextFreedomActions)
      ? args.nextFreedomActions
      : Array.isArray(args.actionChain)
        ? args.actionChain
        : [];
  return source.slice(0, MAX_NOE_FREEDOM_CHAIN_STEPS).map((step, index) => ({
    index,
    stepId: clean(step?.stepId || step?.id || `step-${index + 1}`, 140),
    actionId: clean(step?.actionId || step?.toolId || step?.operation || '', 180),
    mode: clean(step?.mode || step?.authorization?.mode || '', 80),
    args: safePlainObject(step?.args),
    authorization: safePlainObject(step?.authorization),
    declaredExternalSideEffectPerformed: step?.externalSideEffectPerformed === true,
    declaredPublishPerformed: step?.publishPerformed === true,
  }));
}

function childChainAuthorization(parentAuthorization = {}, step = {}) {
  const child = {
    ...safePlainObject(parentAuthorization),
    ...safePlainObject(step.authorization),
  };
  child.mode = clean(step.mode || child.mode || parentAuthorization.mode || '', 80);
  child.ownerPresent = parentAuthorization.ownerPresent === true || child.ownerPresent === true;
  return child;
}

function summarizeChainChild(step = {}, out = {}) {
  return {
    stepId: step.stepId,
    actionId: step.actionId,
    ok: out.ok === true,
    dryRunOnly: out.dryRunOnly !== false,
    realExecute: out.realExecute === true,
    blockers: Array.isArray(out.blockers) ? out.blockers.map((item) => clean(item, 1000)) : [],
    warnings: Array.isArray(out.warnings) ? out.warnings.map((item) => clean(item, 1000)) : [],
    runLedger: out.runLedger ? {
      ref: clean(out.runLedger.ref, 1000),
      sha256: clean(out.runLedger.sha256, 80),
    } : null,
    authorization: out.authorization ? {
      mode: clean(out.authorization.mode, 80),
      ownerPresent: out.authorization.ownerPresent === true,
      sessionId: clean(out.authorization.sessionId || '', 180),
    } : null,
    declaredExternalSideEffectPerformed: step.declaredExternalSideEffectPerformed === true,
    declaredPublishPerformed: step.declaredPublishPerformed === true,
    evidence: out.evidence ? {
      sha256: clean(out.evidence.sha256, 80),
      refs: redactNoeFreedomPayload(out.evidence.refs || {}),
    } : null,
    runtime: redactNoeFreedomPayload(out.runtime || {}),
  };
}

function socialPublishStageForChild(child = {}) {
  const actionId = clean(child.actionId || '', 180);
  const stepId = clean(child.stepId || '', 140);
  if (actionId === 'noe.freedom.account.connection_inventory') return 'account_inventory';
  if (actionId === 'noe.freedom.browser.open') return 'open_creator_console';
  if (actionId === 'noe.freedom.social.workflow.prepare') return 'local_draft';
  if (actionId === 'noe.freedom.social.preflight.run') return 'preflight';
  if (actionId === 'noe.freedom.social.form_fill.plan') return 'form_fill_plan';
  if (actionId === 'noe.freedom.social.form_fill.execute') return 'form_fill_execute';
  if (actionId === 'noe.freedom.social.media_upload.prepare') return 'media_upload_plan';
  if (actionId === 'noe.freedom.social.media_upload.execute') return 'media_upload_execute';
  if (actionId === 'noe.freedom.social.final_publish.execute') return 'final_publish_execute';
  if (actionId === 'noe.freedom.social.rollback.evidence_gate') return 'rollback_evidence_gate';
  if (actionId === 'noe.freedom.social.rollback.execute') return 'rollback_execute';
  if (actionId === 'noe.freedom.browser.state_probe') return 'post_publish_state_probe';
  if (actionId === 'noe.freedom.browser.dom.execute' && /probe/i.test(stepId)) return 'dom_recipe_probe';
  if (actionId === 'noe.freedom.browser.dom.execute') return 'dom_recipe_execute';
  return '';
}

function summarizeSocialRuntime(runtime = {}) {
  const rollback = runtime?.rollbackEvidence && typeof runtime.rollbackEvidence === 'object'
    ? runtime.rollbackEvidence
    : null;
  const priorStageEvidence = runtime?.priorStageEvidence && typeof runtime.priorStageEvidence === 'object'
    ? runtime.priorStageEvidence
    : null;
  const domProbe = summarizeDomRecipeProbeRuntime(runtime);
  return {
    adapter: clean(runtime?.adapter || '', 120),
    plannedOnly: runtime?.plannedOnly === true,
    executionAttempted: runtime?.executionAttempted === true,
    externalSideEffectPerformed: runtime?.externalSideEffectPerformed === true || runtime?.sideEffectPerformed === true,
    publishPerformed: runtime?.publishPerformed === true,
    priorStageEvidence: priorStageEvidence ? {
      required: priorStageEvidence.required === true,
      ok: priorStageEvidence.ok === true,
      source: clean(priorStageEvidence.source || '', 120),
      requiredStages: Array.isArray(priorStageEvidence.requiredStages) ? priorStageEvidence.requiredStages.map((item) => clean(item, 180)) : [],
      completedStages: Array.isArray(priorStageEvidence.completedStages) ? priorStageEvidence.completedStages.map((item) => clean(item, 180)) : [],
      missingStages: Array.isArray(priorStageEvidence.missingStages) ? priorStageEvidence.missingStages.map((item) => clean(item, 180)) : [],
      failedStages: Array.isArray(priorStageEvidence.failedStages) ? priorStageEvidence.failedStages.map((item) => clean(item, 180)) : [],
    } : null,
    domProbe,
    rollbackEvidence: rollback ? {
      evidenceStatus: clean(rollback.evidenceStatus || '', 80),
      verifiedByNoe: rollback.verifiedByNoe === true,
      missingEvidence: Array.isArray(rollback.missingEvidence) ? rollback.missingEvidence.map((item) => clean(item, 200)) : [],
      platform: clean(rollback.platform || '', 80),
      postUrlRef: clean(rollback.postUrlRef || '', 2000),
      postTitleRef: clean(rollback.postTitleRef || '', 500),
    } : null,
  };
}

function summarizeDomRecipeProbeRuntime(runtime = {}) {
  if (runtime?.adapter !== 'browser-dom-execute') return null;
  const actions = Array.isArray(runtime.actions) ? runtime.actions : [];
  if (!actions.length) return null;
  const probeActions = actions.filter((action) => action?.type === 'probe_by_hints' || action?.type === 'read_title');
  if (!probeActions.length) return null;
  const requiredRoles = [...new Set(probeActions.map((action) => clean(action.role || action.type, 80)).filter(Boolean))];
  const foundRoles = [...new Set(probeActions
    .filter((action) => action.found === true && action.ok !== false)
    .map((action) => clean(action.role || action.type, 80))
    .filter(Boolean))];
  const missingRoles = requiredRoles.filter((role) => !foundRoles.includes(role));
  const pageReadiness = runtime.pageReadiness && typeof runtime.pageReadiness === 'object' ? runtime.pageReadiness : null;
  const readinessErrors = [
    ...(pageReadiness && pageReadiness.hostMatched === false ? ['browser_dom_host_mismatch'] : []),
    ...(pageReadiness && pageReadiness.loginSessionLikely === false ? ['browser_dom_login_session_required'] : []),
    ...(pageReadiness && pageReadiness.targetSurfaceReady === false ? ['browser_dom_target_surface_not_ready'] : []),
  ];
  return {
    ok: runtime.ok !== false && missingRoles.length === 0 && (!pageReadiness || pageReadiness.ok === true),
    host: clean(runtime.host || '', 240),
    titlePresent: runtime.titlePresent === true || Boolean(clean(runtime.title || '', 500)),
    titleSha256: clean(runtime.titleSha256 || (runtime.title ? sha256(clean(runtime.title, 500)) : ''), 80),
    actionCount: actions.length,
    requiredRoles,
    foundRoles,
    missingRoles,
    pageReadiness: pageReadiness ? {
      ok: pageReadiness.ok === true,
      hostMatched: pageReadiness.hostMatched === true,
      targetSurface: clean(pageReadiness.targetSurface || '', 120),
      targetSurfaceReady: pageReadiness.targetSurfaceReady === true,
      requiresLoginSession: pageReadiness.requiresLoginSession === true,
      loginSessionLikely: pageReadiness.loginSessionLikely === true,
      requiredRoles: Array.isArray(pageReadiness.requiredRoles) ? pageReadiness.requiredRoles.map((item) => clean(item, 80)) : [],
      foundRoles: Array.isArray(pageReadiness.foundRoles) ? pageReadiness.foundRoles.map((item) => clean(item, 80)) : [],
      missingRoles: Array.isArray(pageReadiness.missingRoles) ? pageReadiness.missingRoles.map((item) => clean(item, 80)) : [],
    } : null,
    matchedByHints: probeActions.filter((action) => action.matchedByHints === true).map((action) => clean(action.role || action.type, 80)),
    errors: [
      ...actions.filter((action) => action.ok === false || action.error).map((action) => clean(action.error || `${action.role || action.type || 'action'}_not_found`, 300)),
      ...readinessErrors,
    ],
    secretValuesReturned: false,
  };
}

function buildSocialPublishChainSummary(childResults = []) {
  const stages = childResults
    .map((child) => {
      const stage = socialPublishStageForChild(child);
      if (!stage) return null;
      return {
        stepId: clean(child.stepId, 140),
        stage,
        actionId: clean(child.actionId, 180),
        ok: child.ok === true,
        dryRunOnly: child.dryRunOnly !== false,
        realExecute: child.realExecute === true,
        declaredExternalSideEffectPerformed: child.declaredExternalSideEffectPerformed === true,
        declaredPublishPerformed: child.declaredPublishPerformed === true,
        blockers: Array.isArray(child.blockers) ? child.blockers.map((item) => clean(item, 1000)) : [],
        warnings: Array.isArray(child.warnings) ? child.warnings.map((item) => clean(item, 1000)) : [],
        runLedger: child.runLedger ? {
          ref: clean(child.runLedger.ref, 1000),
          sha256: clean(child.runLedger.sha256, 80),
        } : null,
        runtime: summarizeSocialRuntime(child.runtime || {}),
      };
    })
    .filter(Boolean);
  if (!stages.length) return null;

  const failed = stages.find((stage) => stage.ok !== true);
  const finalPublishStage = stages.find((stage) => stage.stage === 'final_publish_execute')
    || stages.find((stage) => stage.declaredPublishPerformed === true)
    || stages.find((stage) => stage.runtime.publishPerformed === true);
  const rollback = finalPublishStage?.runtime?.rollbackEvidence || null;
  const domProbeStages = stages.filter((stage) => stage.stage === 'dom_recipe_probe' && stage.runtime?.domProbe);
  const domProbe = domProbeStages.length ? {
    ok: domProbeStages.every((stage) => stage.runtime.domProbe.ok === true),
    stageCount: domProbeStages.length,
    requiredRoles: [...new Set(domProbeStages.flatMap((stage) => stage.runtime.domProbe.requiredRoles || []))],
    foundRoles: [...new Set(domProbeStages.flatMap((stage) => stage.runtime.domProbe.foundRoles || []))],
    missingRoles: [...new Set(domProbeStages.flatMap((stage) => stage.runtime.domProbe.missingRoles || []))],
    hosts: [...new Set(domProbeStages.map((stage) => stage.runtime.domProbe.host).filter(Boolean))],
    titleSha256s: [...new Set(domProbeStages.map((stage) => stage.runtime.domProbe.titleSha256).filter(Boolean))],
    pageReadiness: {
      ok: domProbeStages.every((stage) => stage.runtime.domProbe.pageReadiness?.ok === true),
      targetSurfaces: [...new Set(domProbeStages.map((stage) => stage.runtime.domProbe.pageReadiness?.targetSurface).filter(Boolean))],
      hostMatched: domProbeStages.every((stage) => stage.runtime.domProbe.pageReadiness?.hostMatched !== false),
      targetSurfaceReady: domProbeStages.every((stage) => stage.runtime.domProbe.pageReadiness?.targetSurfaceReady !== false),
      loginSessionLikely: domProbeStages.every((stage) => stage.runtime.domProbe.pageReadiness?.loginSessionLikely !== false),
    },
    errors: [...new Set(domProbeStages.flatMap((stage) => stage.runtime.domProbe.errors || []))],
    secretValuesReturned: false,
  } : null;
  const publishAttempted = finalPublishStage?.runtime?.executionAttempted === true
    || (
      finalPublishStage?.realExecute === true
      && finalPublishStage?.declaredPublishPerformed === true
      && Boolean(finalPublishStage?.runtime?.adapter)
    );
  return {
    kind: 'social_publish_stage_summary',
    ok: !failed,
    stageCount: stages.length,
    completedStepIds: stages.filter((stage) => stage.ok === true).map((stage) => stage.stepId),
    failedStepIds: stages.filter((stage) => stage.ok !== true).map((stage) => stage.stepId),
    blockedAtStepId: failed?.stepId || '',
    publishStepPresent: Boolean(finalPublishStage),
    publishAttempted,
    publishConfirmed: finalPublishStage?.runtime?.publishPerformed === true,
    domRecipeProbe: domProbe,
    externalSideEffectPlanned: stages.some((stage) => stage.declaredExternalSideEffectPerformed === true),
    externalSideEffectPerformed: stages.some((stage) => stage.runtime.externalSideEffectPerformed === true),
    rollbackEvidence: rollback,
    stages,
    secretValuesReturned: false,
  };
}

async function runNoeFreedomChain({
  args = {},
  authorization = {},
  realExecute = false,
  root = DEFAULT_NOE_FREEDOM_ROOT,
  deps = {},
  evidenceRefs = {},
  runLedgerOutDir,
} = {}) {
  const steps = normalizeChainSteps(args);
  const stopOnError = args.stopOnError !== false;
  const persistChildLedgers = args.persistChildLedgers === true;
  const runIdPrefix = clean(args.runIdPrefix || 'freedom-chain-step', 80) || 'freedom-chain-step';
  const childResults = [];
  let stoppedEarly = false;
  let error = '';

  if (!steps.length) {
    return {
      ok: false,
      adapter: 'freedom-chain',
      error: 'freedom_chain_steps_required',
      plannedOnly: realExecute !== true,
      sideEffectPerformed: false,
      childResults,
      secretValuesReturned: false,
    };
  }

  for (const step of steps) {
    let childOut;
    if (!step.actionId) {
      childOut = {
        ok: false,
        dryRunOnly: realExecute !== true,
        realExecute: realExecute === true,
        blockers: ['freedom_chain_step_action_required'],
        runtime: null,
      };
    } else if (step.actionId === NOE_FREEDOM_CHAIN_OPERATION) {
      childOut = {
        ok: false,
        dryRunOnly: realExecute !== true,
        realExecute: realExecute === true,
        blockers: ['freedom_chain_recursion_denied'],
        runtime: null,
      };
    } else {
      const childArgs = safePlainObject(step.args);
      if (
        step.actionId === 'noe.freedom.social.final_publish.execute'
        && childArgs.requirePriorStageEvidence === true
        && !childArgs.priorStageEvidence
        && !childArgs.socialPublishStageSummary
        && !childArgs.stageSummary
      ) {
        const priorStageEvidence = buildSocialPublishChainSummary(childResults);
        if (priorStageEvidence) childArgs.priorStageEvidence = priorStageEvidence;
      }
      childOut = await runNoeFreedomAction({
        actionId: step.actionId,
        args: childArgs,
        authorization: childChainAuthorization(authorization, step),
        realExecute,
        persistLedger: persistChildLedgers,
        runLedgerOutDir,
        runId: `${runIdPrefix}-${String(step.index + 1).padStart(2, '0')}-${step.stepId}`,
        root,
        evidenceRefs: {
          ...safePlainObject(evidenceRefs),
          chainStep: step.stepId,
        },
        deps,
      });
    }

    const summary = summarizeChainChild(step, childOut);
    childResults.push(summary);
    if (!summary.ok) {
      error = `freedom_chain_step_failed:${step.stepId}`;
      if (stopOnError) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const ok = childResults.length > 0 && childResults.every((item) => item.ok);
  const socialPublishStageSummary = buildSocialPublishChainSummary(childResults);
  return {
    ok,
    adapter: 'freedom-chain',
    error: ok ? '' : (error || 'freedom_chain_failed'),
    plannedOnly: realExecute !== true,
    sideEffectPerformed: realExecute === true && childResults.some((item) => item.realExecute),
    stopOnError,
    stoppedEarly,
    stepCount: steps.length,
    executedSteps: childResults.length,
    maxSteps: MAX_NOE_FREEDOM_CHAIN_STEPS,
    persistChildLedgers,
    childResults,
    ...(socialPublishStageSummary ? { socialPublishStageSummary } : {}),
    secretValuesReturned: false,
  };
}

function ledgerNextFreedomActions(ledger = {}) {
  const runtime = ledger.runtime && typeof ledger.runtime === 'object' ? ledger.runtime : {};
  return Array.isArray(runtime.nextFreedomActions) ? runtime.nextFreedomActions : [];
}

async function runNoeFreedomResumeNextActions({
  args = {},
  authorization = {},
  realExecute = false,
  root = DEFAULT_NOE_FREEDOM_ROOT,
  deps = {},
  evidenceRefs = {},
  runLedgerOutDir,
} = {}) {
  const ledgerRef = clean(args.ledgerRef || args.runLedgerRef || args.ref, 1000);
  let source;
  try {
    source = readNoeFreedomRunLedgerFile(ledgerRef, { root });
  } catch (error) {
    return {
      ok: false,
      adapter: 'freedom-ledger-resume-next-actions',
      error: `freedom_resume_ledger_read_failed:${clean(error?.message || error, 500)}`,
      sourceLedgerRef: ledgerRef,
      plannedOnly: realExecute !== true,
      sideEffectPerformed: false,
      secretValuesReturned: false,
    };
  }
  if (!source.ok) {
    return {
      ok: false,
      adapter: 'freedom-ledger-resume-next-actions',
      error: `freedom_resume_ledger_invalid:${source.errors.join(',')}`,
      sourceLedgerRef: source.ref,
      sourceRunId: clean(source.ledger?.runId, 180),
      plannedOnly: realExecute !== true,
      sideEffectPerformed: false,
      secretValuesReturned: false,
    };
  }
  if (source.ledger.ok !== true) {
    return {
      ok: false,
      adapter: 'freedom-ledger-resume-next-actions',
      error: 'freedom_resume_source_ledger_not_ok',
      sourceLedgerRef: source.ref,
      sourceRunId: clean(source.ledger?.runId, 180),
      plannedOnly: realExecute !== true,
      sideEffectPerformed: false,
      secretValuesReturned: false,
    };
  }

  const steps = ledgerNextFreedomActions(source.ledger);
  if (!steps.length) {
    return {
      ok: false,
      adapter: 'freedom-ledger-resume-next-actions',
      error: 'freedom_resume_next_actions_missing',
      sourceLedgerRef: source.ref,
      sourceRunId: clean(source.ledger?.runId, 180),
      plannedOnly: realExecute !== true,
      sideEffectPerformed: false,
      secretValuesReturned: false,
    };
  }

  const runIdPrefix = clean(args.runIdPrefix || `${source.ledger.runId || 'resume'}-resume`, 100) || 'freedom-resume-step';
  const chainOut = await runNoeFreedomAction({
    actionId: NOE_FREEDOM_CHAIN_OPERATION,
    args: {
      stopOnError: args.stopOnError !== false,
      persistChildLedgers: args.persistChildLedgers === true,
      runIdPrefix,
      steps,
    },
    authorization,
    realExecute,
    persistLedger: false,
    runLedgerOutDir,
    root,
    evidenceRefs: {
      ...safePlainObject(evidenceRefs),
      sourceFreedomRunLedger: source.ref,
    },
    deps,
  });

  return {
    ok: chainOut.ok === true,
    adapter: 'freedom-ledger-resume-next-actions',
    error: chainOut.ok === true ? '' : (chainOut.blockers?.join(',') || chainOut.runtime?.error || 'freedom_resume_chain_failed'),
    sourceLedgerRef: source.ref,
    sourceRunId: clean(source.ledger.runId, 180),
    sourceAction: clean(source.ledger.action?.operation, 180),
    plannedOnly: realExecute !== true,
    sideEffectPerformed: realExecute === true && chainOut.runtime?.sideEffectPerformed === true,
    resumedStepCount: steps.length,
    chain: summarizeChainChild({ stepId: 'resume_chain', actionId: NOE_FREEDOM_CHAIN_OPERATION }, chainOut),
    secretValuesReturned: false,
  };
}

async function runSpecialFreedomRuntime({ tool, args, authorization, realExecute, root, deps, evidenceRefs, runLedgerOutDir }) {
  if (tool.operation === NOE_FREEDOM_CHAIN_OPERATION) {
    return runNoeFreedomChain({ args, authorization, realExecute, root, deps, evidenceRefs, runLedgerOutDir });
  }
  if (tool.operation === NOE_FREEDOM_RESUME_NEXT_ACTIONS_OPERATION) {
    return runNoeFreedomResumeNextActions({ args, authorization, realExecute, root, deps, evidenceRefs, runLedgerOutDir });
  }
  return runNoeFreedomAdapter({
    tool,
    args,
    root,
    deps: {
      ...deps,
      freedomAuthorization: authorization,
    },
    realExecute,
  });
}

function finalize(result, { evidenceRefs = {}, notes = '', evidenceInput = {} } = {}) {
  const ok = result.blockers.length === 0 && (result.runtime?.ok !== false);
  const evidence = buildNoeActionEvidence({
    act: {
      id: result.id,
      action: result.tool?.operation,
      title: result.tool?.id,
      riskLevel: result.tool?.riskLevel || 'critical',
    },
    input: evidenceInput,
    permissionResult: {
      decision: ok ? 'allow' : 'deny',
      reason: ok ? 'freedom action completed or dry-run planned' : result.blockers.join(', '),
    },
    dryRunOnly: result.dryRunOnly,
    executorResult: result.runtime,
    refs: evidenceRefs,
    rollbackRef: result.rollback.plan,
    notes: notes || 'Noe Freedom execution evidence.',
  });
  return {
    ...result,
    ok,
    evidence,
    sha256: sha256(JSON.stringify({ ...result, evidence: evidence.sha256 })),
  };
}

function collectRuntimeBlockers(runtime = {}) {
  const blockers = [
    ...(Array.isArray(runtime?.blockers) ? runtime.blockers : []),
    ...(Array.isArray(runtime?.priorStageEvidence?.errors) ? runtime.priorStageEvidence.errors : []),
  ].map((item) => clean(item, 1000)).filter(Boolean);
  if (blockers.length) return [...new Set(blockers)];
  return [clean(runtime?.error || 'freedom_runtime_failed', 1000)];
}

function finalizeWithRunLedger(result, {
  root = DEFAULT_NOE_FREEDOM_ROOT,
  persistLedger = false,
  runLedgerOutDir,
  runId = '',
  evidenceRefs = {},
  evidenceInput = {},
  notes = '',
} = {}) {
  const final = finalize(result, { evidenceRefs, notes, evidenceInput });
  if (persistLedger !== true) return final;
  try {
    const written = writeNoeFreedomRunLedgerFile({
      result: final,
      root,
      outDir: runLedgerOutDir,
      runId,
    });
    return {
      ...final,
      runLedger: {
        ref: written.ref,
        sha256: written.sha256,
      },
    };
  } catch (error) {
    const failed = {
      ...result,
      blockers: [
        ...(Array.isArray(result.blockers) ? result.blockers : []),
        `freedom_run_ledger_write_failed:${clean(error?.message || error, 500)}`,
      ],
    };
    return finalize(failed, { evidenceRefs, notes, evidenceInput });
  }
}

export async function runNoeFreedomAction({
  actionId = '',
  args = {},
  authorization = {},
  evidenceInput = null,
  trustManifest = null,
  allowlist = null,
  realExecute = false,
  persistLedger = false,
  runLedgerOutDir,
  runId = '',
  root = DEFAULT_NOE_FREEDOM_ROOT,
  evidenceRefs = {},
  deps = {},
} = {}) {
  const tool = findNoeFreedomTool(actionId);
  const authz = validateNoeFreedomAuthorization({ tool, authorization, realExecute });
  const developerMode = isDeveloperUnrestricted({ authorization, realExecute });
  const trust = developerMode
    ? { ok: true, errors: [], manifest: null, developerUnrestricted: true }
    : validateNoeFreedomTrustManifest({
      manifest: trustManifest || authorization.trustManifest || args.trustManifest,
      tool,
      realExecute,
    });
  const allow = developerMode
    ? { ok: true, errors: [], allowlist: null, developerUnrestricted: true }
    : evaluateNoeFreedomAllowlist({
      tool,
      args,
      trustManifest: trust.manifest,
      allowlist: allowlist || authorization.allowlist || args.allowlist,
      root,
      realExecute,
    });
  const result = makeBaseResult({ tool, args, realExecute, authorization, authz, trust, allowlist: allow });
  const actionEvidenceInput = buildFreedomActionEvidenceInput({ args, evidenceInput, authorization });
  if (!tool) {
    result.blockers.push('freedom_tool_not_found');
    return finalizeWithRunLedger(result, { root, persistLedger, runLedgerOutDir, runId, evidenceRefs, evidenceInput: actionEvidenceInput });
  }
  const reviewPreflight = tool ? buildNoeReviewBrainPreflight({
    actionId,
    operation: tool.operation,
    tool,
    args,
    realExecute,
    evidenceRefs,
    authorization,
    reason: authorization?.reason || '',
  }) : null;
  if (reviewPreflight?.required || (tool && isNoeHighRiskTask({ actionId, operation: tool.operation, risk: tool.riskLevel, tags: tool.tags }))) {
    result.reviewBrainPreflight = reviewPreflight;
  }
  if (!authz.ok) {
    result.blockers.push(...authz.errors);
  }
  if (!trust.ok) {
    result.blockers.push(...trust.errors);
  }
  if (!allow.ok) {
    result.blockers.push(...allow.errors);
  }
  if (developerMode) {
    result.warnings.push('developer_unrestricted_mode_active');
    result.blockers.push(...evaluateDeveloperHardVeto({ tool, args }));
  }
  if (result.blockers.length) {
    return finalizeWithRunLedger(result, { root, persistLedger, runLedgerOutDir, runId, evidenceRefs, evidenceInput: actionEvidenceInput });
  }
  // B1.3 强制复核闸：高风险/critical real execute 必须真实调用 Review Brain 并等待 verdict；
  // block/revise/无法复核 → fail-closed 阻断，不得继续 runtime。dry-run 无副作用不在此拦。
  if (realExecute === true && reviewPreflight?.required === true) {
    result.reviewBrainPreflight = reviewPreflight;
    const gate = await runReviewBrainGate({ preflight: reviewPreflight, deps });
    reviewPreflight.verdict = gate.verdict;
    if (gate.skippedReason) reviewPreflight.skippedReason = gate.skippedReason;
    if (gate.blockers.length) {
      result.blockers.push(...gate.blockers);
      return finalizeWithRunLedger(result, { root, persistLedger, runLedgerOutDir, runId, evidenceRefs, evidenceInput: actionEvidenceInput });
    }
  }
  if (!realExecute) {
    result.runtime = await runSpecialFreedomRuntime({
      tool,
      args,
      authorization,
      realExecute: false,
      root,
      deps,
      evidenceRefs,
      runLedgerOutDir,
    });
    if (result.runtime?.ok === false) result.blockers.push(...collectRuntimeBlockers(result.runtime));
    return finalizeWithRunLedger(result, {
      root,
      persistLedger,
      runLedgerOutDir,
      runId,
      evidenceRefs,
      evidenceInput: actionEvidenceInput,
      notes: 'Noe Freedom dry-run plan; no external side effect.',
    });
  }

  try {
    result.runtime = await runSpecialFreedomRuntime({
      tool,
      args,
      authorization,
      realExecute: true,
      root,
      deps,
      evidenceRefs,
      runLedgerOutDir,
    });
  } catch (error) {
    result.runtime = { ok: false, error: clean(error?.message || error, 1000) };
  }
  if (result.runtime?.ok === false) result.blockers.push(...collectRuntimeBlockers(result.runtime));
  return finalizeWithRunLedger(result, {
    root,
    persistLedger,
    runLedgerOutDir,
    runId,
    evidenceRefs,
    evidenceInput: actionEvidenceInput,
    notes: 'Noe Freedom real execution evidence.',
  });
}

export function buildNoeFreedomCatalog() {
  return {
    ok: true,
    schemaVersion: NOE_FREEDOM_EXECUTION_SCHEMA_VERSION,
    authModes: [...NOE_FREEDOM_AUTH_MODES],
    developerMode: NOE_FREEDOM_DEVELOPER_MODE_PROFILE,
    tools: listNoeFreedomTools(),
    quickStarts: listNoeFreedomQuickStarts(),
  };
}
