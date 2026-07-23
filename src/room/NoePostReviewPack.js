import { createHash } from 'node:crypto';
import { validateNoeActionEvidence } from '../runtime/NoeActionEvidence.js';
import { redactSensitiveText, textContainsSecretLike } from '../runtime/NoeContextScrubber.js';
import {
  normalizeConsensusModelId,
} from './NoeConsensusGate.js';
import {
  validateNoeImplementationExecutor,
} from './NoeExecutionAuthority.js';

export const NOE_POST_REVIEW_PACK_SCHEMA_VERSION = 1;

export const NOE_DEFAULT_POST_REVIEW_MODELS = Object.freeze(['claude', 'm3']);
// P3 复核复活（2026-07-02）：xiaomi 从默认 optional 摘除——生产实测 303/303 全 unavailable（MiMo 已退出模型策略），
//   每轮白占一行审计还制造"4 reviewer"的假阵容。需要时可由调用方显式传 optionalReviewers 加回。
export const NOE_OPTIONAL_POST_REVIEW_MODELS = Object.freeze([]);

const REVIEWER_AUTHORITY = Object.freeze({
  codex: 'readonly_source_reviewer',
  claude: 'readonly_source_reviewer',
  gemini: 'advisory',
  m3: 'suggestion_only',
  xiaomi: 'advisory',
});

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function cleanArray(values = [], maxItem = 1000) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => clean(value, maxItem)).filter(Boolean))];
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

function hashPack(pack = {}) {
  return createHash('sha256').update(JSON.stringify(pack), 'utf8').digest('hex');
}

function normalizeReviewer(model, extra = {}) {
  const id = normalizeConsensusModelId(model);
  if (!id) return null;
  return {
    model: id,
    authority: clean(extra.authority || REVIEWER_AUTHORITY[id] || 'advisory', 120),
    canWrite: false,
    required: extra.required === true,
    expectedRawOutputRef: clean(extra.expectedRawOutputRef || extra.rawOutputRef || '', 1000),
  };
}

function defaultExpectedRawOutputRef(reviewRoundRef, model) {
  const base = clean(reviewRoundRef, 1000).replace(/\/+$/, '');
  return base ? `${base}/${model}-post-review.txt` : '';
}

function normalizeReviewers({
  requiredReviewers = NOE_DEFAULT_POST_REVIEW_MODELS,
  optionalReviewers = NOE_OPTIONAL_POST_REVIEW_MODELS,
  reviewRoundRef = '',
  reviewerOutputRefs = {},
} = {}) {
  const out = [];
  const add = (model, required) => {
    const id = normalizeConsensusModelId(model);
    const expectedRawOutputRef = reviewerOutputRefs[id] || defaultExpectedRawOutputRef(reviewRoundRef, id);
    const reviewer = normalizeReviewer(id, { required, expectedRawOutputRef });
    if (!reviewer || out.some((item) => item.model === reviewer.model)) return;
    out.push(reviewer);
  };
  cleanArray(requiredReviewers, 80).forEach((model) => add(model, true));
  cleanArray(optionalReviewers, 80).forEach((model) => add(model, false));
  return out;
}

function defaultRequiredReviewersFor(activeExecutor = 'codex') {
  const executor = normalizeConsensusModelId(activeExecutor || 'codex');
  return ['codex', 'claude', 'm3'].filter((model) => model !== executor);
}

export function buildNoePostReviewPack({
  goal = '',
  actionEvidence = null,
  consensusLedgerRef = '',
  implementation = {},
  runtimeVerification = {},
  rollback = {},
  tests = [],
  changedFiles = [],
  reviewRoundRef = '',
  requiredReviewers = NOE_DEFAULT_POST_REVIEW_MODELS,
  optionalReviewers = NOE_OPTIONAL_POST_REVIEW_MODELS,
  reviewerOutputRefs = {},
  notes = '',
  createdAt = new Date().toISOString(),
} = {}) {
  const evidence = actionEvidence ? safeObject(actionEvidence) : null;
  const safeImplementation = safeObject(implementation);
  const activeExecutor = normalizeConsensusModelId(safeImplementation.activeExecutor || safeImplementation.writer || 'codex') || 'codex';
  const finalRequiredReviewers = requiredReviewers === NOE_DEFAULT_POST_REVIEW_MODELS
    ? defaultRequiredReviewersFor(activeExecutor)
    : requiredReviewers;
  const safeRuntime = safeObject(runtimeVerification);
  const safeRollback = safeObject(rollback);
  const pack = {
    schemaVersion: NOE_POST_REVIEW_PACK_SCHEMA_VERSION,
    createdAt,
    goal: clean(goal, 2000),
    authorityBoundary: {
      writer: activeExecutor,
      reviewersCanWrite: false,
      m3Authority: 'suggestion_only',
      highRiskAuthorization: 'review_only_not_authorization',
    },
    consensus: {
      ledgerRef: clean(consensusLedgerRef || safeImplementation.consensusLedgerRef || '', 1000),
    },
    implementation: {
      writer: normalizeConsensusModelId(safeImplementation.writer || activeExecutor),
      activeExecutor,
      executorSelection: safeObject(safeImplementation.executorSelection || safeImplementation.activeExecutorSelection || {}),
      done: safeImplementation.done === true || safeImplementation.ok === true || safeImplementation.status === 'done',
      diffRef: clean(safeImplementation.diffRef || '', 1000),
      evidenceRef: clean(safeImplementation.evidenceRef || '', 1000),
      touchedFiles: cleanArray(safeImplementation.touchedFiles || changedFiles || [], 1000),
      changedFilesRef: clean(safeImplementation.changedFilesRef || '', 1000),
    },
    runtimeVerification: {
      ok: safeRuntime.ok === true,
      reportRef: clean(safeRuntime.reportRef || safeRuntime.runtimeReportRef || '', 1000),
      summary: clean(safeRuntime.summary || '', 2000),
    },
    rollback: {
      planRef: clean(safeRollback.planRef || safeRollback.rollbackRef || '', 1000),
      summary: clean(safeRollback.summary || '', 2000),
    },
    tests: cleanArray(tests, 1000),
    actionEvidence: evidence,
    postReviewPlan: {
      requiredReviewers: cleanArray(finalRequiredReviewers, 80).map(normalizeConsensusModelId).filter(Boolean),
      optionalReviewers: cleanArray(optionalReviewers, 80).map(normalizeConsensusModelId).filter(Boolean),
      reviewers: normalizeReviewers({ requiredReviewers: finalRequiredReviewers, optionalReviewers, reviewRoundRef, reviewerOutputRefs }),
      dynamicQuorum: 'required reviewer dynamic quorum excludes the active executor; missing reviewer is not unavailable',
    },
    notes: clean(notes, 2000),
  };
  return {
    ...pack,
    sha256: hashPack(pack),
  };
}

export function validateNoePostReviewPack(pack = {}, {
  requireActionEvidence = true,
  requireRuntime = true,
  requireChangedFiles = true,
  requireRollback = true,
  requireReviewerOutputRefs = false,
} = {}) {
  const errors = [];
  if (pack.schemaVersion !== NOE_POST_REVIEW_PACK_SCHEMA_VERSION) errors.push(`unsupported_post_review_pack_schema:${pack.schemaVersion ?? 'missing'}`);
  if (!clean(pack.goal, 2000)) errors.push('post_review_goal_required');
  if (!clean(pack.consensus?.ledgerRef, 1000)) errors.push('post_review_consensus_ledger_ref_required');

  const implementation = pack.implementation || {};
  const executorValidation = validateNoeImplementationExecutor(implementation);
  errors.push(...executorValidation.errors.map((error) => `post_review_${error}`));
  const hasChangedFiles = cleanArray(implementation.touchedFiles || []).length > 0 ||
    Boolean(clean(implementation.diffRef || implementation.evidenceRef || implementation.changedFilesRef, 1000));
  if (requireChangedFiles && !hasChangedFiles) errors.push('post_review_changed_files_required');

  if (requireRuntime) {
    if (pack.runtimeVerification?.ok !== true) errors.push('post_review_runtime_verification_required');
    if (!clean(pack.runtimeVerification?.reportRef, 1000)) errors.push('post_review_runtime_report_ref_required');
  }

  if (requireRollback && !clean(pack.rollback?.planRef, 1000)) errors.push('post_review_rollback_ref_required');

  if (requireActionEvidence) {
    if (!pack.actionEvidence) errors.push('post_review_action_evidence_required');
    else {
      const validation = validateNoeActionEvidence(pack.actionEvidence, {
        requireRuntime,
        requireRollback,
      });
      errors.push(...validation.errors.map((error) => `post_review_action_evidence:${error}`));
    }
  }

  const reviewers = Array.isArray(pack.postReviewPlan?.reviewers) ? pack.postReviewPlan.reviewers : [];
  const byModel = new Map();
  for (const reviewer of reviewers) {
    const model = normalizeConsensusModelId(reviewer?.model);
    if (!model) continue;
    if (byModel.has(model)) errors.push(`post_review_duplicate_reviewer:${model}`);
    byModel.set(model, reviewer);
    if (reviewer.canWrite === true) errors.push(`post_review_reviewer_must_not_write:${model}`);
    if (model === 'm3' && reviewer.authority !== 'suggestion_only') errors.push('post_review_m3_must_be_suggestion_only');
    if (requireReviewerOutputRefs && reviewer.required === true && !clean(reviewer.expectedRawOutputRef, 1000)) {
      errors.push(`post_review_expected_raw_output_ref_required:${model}`);
    }
  }
  for (const model of cleanArray(pack.postReviewPlan?.requiredReviewers || [], 80).map(normalizeConsensusModelId).filter(Boolean)) {
    if (model === executorValidation.activeExecutor) errors.push(`post_review_active_executor_must_not_be_required_reviewer:${model}`);
    if (!byModel.has(model)) errors.push(`post_review_required_reviewer_missing:${model}`);
  }

  // P0/P3 单源化（2026-07-02）：原内联三模式是 SECRET_PATTERNS 的第三份私有副本，改走全仓统一判定。
  if (textContainsSecretLike(JSON.stringify(pack))) {
    errors.push('post_review_pack_contains_secret_like_value');
  }

  return { ok: errors.length === 0, errors };
}

export function buildNoePostReviewPrompt({ pack, reviewer = 'claude' } = {}) {
  const model = normalizeConsensusModelId(reviewer);
  const profile = normalizeReviewer(model, { required: true }) || normalizeReviewer('claude', { required: true });
  const safePack = safeObject(pack);
  return [
    'You are reviewing a Noe implementation evidence pack.',
    'Return only JSON. Do not edit files. Do not run commands. Do not expose secret values.',
    `model: ${profile.model}`,
    `authority: ${profile.authority}`,
    `canWrite: ${profile.canWrite}`,
    'This review is advisory/read-only evidence. It does not authorize high-risk actions by itself.',
    '',
    'Required JSON shape:',
    '{',
    `  "model": "${profile.model}",`,
    '  "decision": "approve|approve_with_changes|reject|abstain|unavailable",',
    '  "confidence": 0.0,',
    `  "authority": "${profile.authority}",`,
    '  "canWrite": false,',
    '  "blockers": [],',
    '  "verification_required": [],',
    '  "evidence_gaps": [],',
    '  "consensus_vote": "yes|no|abstain"',
    '}',
    '',
    '# Evidence Pack',
    JSON.stringify(safePack, null, 2),
  ].join('\n');
}
