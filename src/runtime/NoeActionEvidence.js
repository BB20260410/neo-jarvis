import { createHash } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_ACTION_EVIDENCE_SCHEMA_VERSION = 1;

const SEMANTIC_TRACE_KEY_RE = /^(?:claim|title|name|summary|description|text|content|message|body|detail|details|note|notes|task|goal|goalTitle|action|intent|plan|checkpoint|expectation|expectedClaim|commitment|output|stdoutSummary|stderrSummary|step|stepText)$/i;
const SENSITIVE_TRACE_KEY_RE = /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization|oauth|credential|private[_-]?key|refresh[_-]?token|session[_-]?token)/i;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeObject(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

function refs(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => clean(value, 1000)).filter(Boolean))];
}

function hashEvidence(evidence = {}) {
  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

function pushUnique(out, value, max = 500) {
  const text = clean(value, max).replace(/\s+/g, ' ').trim();
  if (!text || text === '[REDACTED]' || out.includes(text)) return;
  out.push(text);
}

function collectSemanticFragments(value, {
  semanticParent = false,
  key = '',
  depth = 0,
  out = [],
} = {}) {
  if (out.length >= 24 || depth > 6 || value == null) return out;
  if (SENSITIVE_TRACE_KEY_RE.test(String(key || ''))) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    if (semanticParent) pushUnique(out, value);
    return out;
  }
  if (typeof value === 'boolean') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      collectSemanticFragments(item, { semanticParent, key, depth: depth + 1, out });
      if (out.length >= 24) break;
    }
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
    if (SENSITIVE_TRACE_KEY_RE.test(String(childKey || ''))) continue;
    const nextSemantic = semanticParent || SEMANTIC_TRACE_KEY_RE.test(String(childKey || ''));
    collectSemanticFragments(childValue, {
      semanticParent: nextSemantic,
      key: childKey,
      depth: depth + 1,
      out,
    });
    if (out.length >= 24) break;
  }
  return out;
}

function semanticBucket(...values) {
  const out = [];
  for (const value of values) pushUnique(out, value, 240);
  return out.slice(0, 8);
}

export function buildNoeActionSemanticTrace({ act = {}, input = {}, executorResult = null } = {}) {
  const safeAct = safeObject(act);
  const safeActPayload = safeObject(safeAct.payload);
  const safeInput = safeObject(input);
  const safeExecutor = executorResult ? safeObject(executorResult) : null;
  const summary = [];
  collectSemanticFragments({ act: safeAct, input: safeInput, executorResult: safeExecutor }, {
    semanticParent: false,
    out: summary,
  });
  const trace = {
    summary: summary.slice(0, 12),
    action: semanticBucket(
      safeAct.action,
      safeInput.action,
      safeInput.actionSpec?.action,
      safeInput.payload?.action,
      safeActPayload.action,
      safeActPayload.actionSpec?.action,
    ),
    title: semanticBucket(safeAct.title, safeInput.title, safeInput.payload?.title, safeActPayload.title),
    goal: semanticBucket(
      safeInput.goal,
      safeInput.goal?.title,
      safeInput.goalTitle,
      safeInput.payload?.goal,
      safeInput.payload?.goalTitle,
      safeActPayload.goal,
      safeActPayload.goalTitle,
    ),
    expectation: semanticBucket(
      safeInput.expectation,
      safeInput.expectedClaim,
      safeInput.claim,
      safeInput.payload?.expectation,
      safeInput.payload?.expectedClaim,
      safeInput.payload?.claim,
      safeActPayload.expectation,
      safeActPayload.expectedClaim,
      safeActPayload.claim,
    ),
    checkpoint: semanticBucket(
      safeInput.checkpoint,
      safeInput.step,
      safeInput.stepText,
      safeInput.payload?.checkpoint,
      safeInput.payload?.step,
      safeInput.payload?.stepText,
      safeActPayload.checkpoint,
      safeActPayload.step,
      safeActPayload.stepText,
    ),
  };
  const compact = Object.fromEntries(Object.entries(trace).filter(([, value]) => Array.isArray(value) && value.length));
  if (!Object.keys(compact).length) return null;
  return {
    ...compact,
    fingerprint: hashEvidence(compact).slice(0, 24),
  };
}

export function buildNoeActionEvidence({
  act = {},
  input = {},
  budgetResult = null,
  permissionResult = null,
  contextSufficiency = null,
  selfEvolutionGate = null,
  dryRunOnly = true,
  executorResult = null,
  evidenceEventId = null,
  logRef = '',
  refs: evidenceRefs = {},
  rollbackRef = '',
  notes = '',
} = {}) {
  const semanticTrace = buildNoeActionSemanticTrace({ act, input, executorResult });
  const evidence = {
    schemaVersion: NOE_ACTION_EVIDENCE_SCHEMA_VERSION,
    actionId: clean(act.id, 160),
    action: clean(act.action || input.action, 160),
    title: clean(act.title || input.title, 240),
    riskLevel: clean(act.riskLevel || input.riskLevel || input.risk_level || 'low', 40),
    dryRunOnly: dryRunOnly !== false,
    permission: permissionResult ? {
      decision: clean(permissionResult.decision || '', 80),
      reason: clean(permissionResult.reason || '', 1000),
      requiresApproval: permissionResult.requiresApproval === true,
      blockedSafety: permissionResult.blockedSafety === true,
    } : null,
    budget: budgetResult ? safeObject(budgetResult) : null,
    contextSufficiency: contextSufficiency ? safeObject(contextSufficiency) : null,
    selfEvolutionGate: selfEvolutionGate ? safeObject(selfEvolutionGate) : null,
    runtime: executorResult ? safeObject(executorResult) : null,
    evidenceEventId: evidenceEventId == null ? null : Number(evidenceEventId),
    logRef: clean(logRef, 1000),
    refs: {
      plan: refs(evidenceRefs.plan || evidenceRefs.planRef),
      dryRun: refs(evidenceRefs.dryRun || evidenceRefs.dryRunRef || logRef),
      permission: refs(evidenceRefs.permission || evidenceRefs.permissionRef),
      runtimeReport: refs(evidenceRefs.runtimeReport || evidenceRefs.runtimeReportRef),
      tests: refs(evidenceRefs.tests || evidenceRefs.testOutputRef),
      changedFiles: refs(evidenceRefs.changedFiles || evidenceRefs.changedFilesRef),
      rollback: refs(evidenceRefs.rollback || evidenceRefs.rollbackRef || rollbackRef),
      postReviewRawOutput: refs(evidenceRefs.postReviewRawOutput || evidenceRefs.postReviewRawOutputRef),
    },
    notes: clean(notes, 2000),
    semanticTrace,
  };
  return {
    ...evidence,
    sha256: hashEvidence(evidence),
  };
}

export function validateNoeActionEvidence(evidence = {}, {
  requireRuntime = false,
  requireReview = false,
  requireRollback = false,
} = {}) {
  const errors = [];
  if (evidence.schemaVersion !== NOE_ACTION_EVIDENCE_SCHEMA_VERSION) errors.push('unsupported_action_evidence_schema_version');
  if (!clean(evidence.actionId, 160)) errors.push('action_id_required');
  if (!clean(evidence.action, 160)) errors.push('action_required');
  if (!evidence.permission) errors.push('permission_evidence_required');
  if (evidence.contextSufficiency && evidence.contextSufficiency.sufficient === false) errors.push('context_sufficiency_not_met');
  if (requireRuntime && !evidence.runtime && !refs(evidence.refs?.runtimeReport).length) errors.push('runtime_evidence_required');
  if (requireReview && !refs(evidence.refs?.postReviewRawOutput).length) errors.push('post_review_raw_output_required');
  if (requireRollback && !refs(evidence.refs?.rollback).length) errors.push('rollback_ref_required');
  return { ok: errors.length === 0, errors };
}
