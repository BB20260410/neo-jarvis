export const NOE_REQUIRED_CONSENSUS_MODELS = Object.freeze(['codex', 'claude', 'm3']);
import {
  validateNoeImplementationExecutor,
} from './NoeExecutionAuthority.js';

export const NOE_REQUIRED_BOUNDARY_IDS = Object.freeze([
  'claude_first_class',
  'codex_only_writer',
  'm3_suggestion_only',
  'no_artificial_model_timeout',
  'no_51735',
  '51835_user_or_consensus_gated',
  'user_cost_authorization',
  'consensus_authorized_sensitive_actions',
  'consensus_authorized_secret_access',
  'system_level_not_consensus_authorizable',
  'runtime_verification_required',
  'rollback_required',
  'memory_writeback_consensus_ack',
]);

const APPROVAL_DECISIONS = new Set(['approve', 'approve_with_changes']);
const KNOWN_DECISIONS = new Set(['approve', 'approve_with_changes', 'reject', 'abstain', 'unavailable']);
const READONLY_AUTHORITIES = new Set(['advisory', 'reviewer', 'readonly_reviewer', 'readonly_source_reviewer']);
const YES_CONSENSUS = new Set(['yes', 'approve', 'approved']);

export function quorumThresholdForAvailableModels(availableCount, opts = {}) {
  const count = Number(availableCount);
  const minimumAvailable = Number.isInteger(opts.minimumAvailableModels) ? opts.minimumAvailableModels : 2;
  if (!Number.isFinite(count) || count < minimumAvailable) {
    return { ok: false, threshold: minimumAvailable, minimumAvailable, reason: `insufficient_available_models:${Number.isFinite(count) ? count : 0}` };
  }
  const policyThreshold = Math.max(2, Math.ceil(count * 2 / 3));
  const explicitThreshold = Number.isInteger(opts.threshold) ? opts.threshold : 0;
  return {
    ok: true,
    threshold: Math.max(policyThreshold, explicitThreshold),
    minimumAvailable,
    reason: 'dynamic_quorum',
  };
}

function cleanString(value) {
  return String(value || '').trim();
}

function hasText(value) {
  return cleanString(value).length > 0;
}

export function normalizeConsensusModelId(value) {
  const id = cleanString(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (!id) return '';
  if (id === 'gpt' || id === 'gpt-codex' || id === 'openai-codex') return 'codex';
  if (id === 'claude-code' || id === 'anthropic-claude') return 'claude';
  if (id === 'gemini-cli' || id === 'google-gemini') return 'gemini';
  if (id === 'minimax' || id === 'minimax-m3' || id === 'mini-max-m3') return 'm3';
  if (id === 'xiaomi' || id === 'mimo' || id.startsWith('xiaomi/') || id.startsWith('xiaomi-mimo') || id.startsWith('mimo-')) return 'xiaomi';
  return id;
}

function normalizeRequiredModels(models) {
  const source = Array.isArray(models) && models.length ? models : NOE_REQUIRED_CONSENSUS_MODELS;
  return [...new Set(source.map(normalizeConsensusModelId).filter(Boolean))];
}

export function normalizeConsensusDecision(value) {
  const decision = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (decision === 'approved') return 'approve';
  if (decision === 'approved_with_changes') return 'approve_with_changes';
  if (decision === 'needs_changes') return 'approve_with_changes';
  if (decision === 'rejected') return 'reject';
  if (decision === 'not_available') return 'unavailable';
  if (decision === 'no_vote') return 'abstain';
  return decision;
}

function normalizeAuthority(value) {
  return cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
}

function boundaryId(boundary) {
  if (typeof boundary === 'string') return cleanString(boundary);
  return cleanString(boundary?.id);
}

function voteHasRawEvidence(vote) {
  return hasText(vote?.rawOutputRef) || hasText(vote?.rawOutputSha256) || hasText(vote?.rawOutput);
}

function normalizeConsensusVote(value) {
  return cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
}

function arrayHasText(value) {
  return Array.isArray(value) && value.some((item) => hasText(item));
}

export function evaluateNoeConsensusVotes(votes, opts = {}) {
  const requiredModels = normalizeRequiredModels(opts.requiredModels);
  const requiredModelSet = new Set(requiredModels);
  const errors = [];
  const warnings = [];
  const byModel = new Map();

  if (!Array.isArray(votes)) {
    return {
      ok: false,
      threshold: quorumThresholdForAvailableModels(0, opts).threshold,
      availableCount: 0,
      totalModels: requiredModels.length,
      approvedCount: 0,
      approvals: [],
      availableModels: [],
      missingModels: [...requiredModels],
      errors: ['votes_must_be_array'],
      warnings,
      byModel,
    };
  }

  for (const vote of votes) {
    const model = normalizeConsensusModelId(vote?.model);
    const decision = normalizeConsensusDecision(vote?.decision);
    if (!model) {
      errors.push('vote_missing_model');
      continue;
    }
    if (byModel.has(model)) errors.push(`duplicate_vote:${model}`);
    if (!KNOWN_DECISIONS.has(decision)) errors.push(`unknown_decision:${model}:${decision || 'blank'}`);
    if (!voteHasRawEvidence(vote)) errors.push(`missing_raw_output_ref:${model}`);
    if (!hasText(vote?.evidenceRef)) warnings.push(`missing_evidence_ref:${model}`);
    byModel.set(model, { ...vote, model, decision });
  }

  const missingModels = requiredModels.filter((model) => !byModel.has(model));
  for (const model of missingModels) errors.push(`missing_required_model:${model}`);

  const requiredVotes = [...byModel.values()].filter((vote) => requiredModelSet.has(vote.model));
  const approvals = requiredVotes
    .filter((vote) => APPROVAL_DECISIONS.has(vote.decision))
    .map((vote) => vote.model);
  const availableModels = requiredModels.filter((model) => byModel.has(model) && byModel.get(model)?.decision !== 'unavailable');
  const abstentions = requiredVotes.filter((vote) => vote.decision === 'abstain').map((vote) => vote.model);
  const unavailable = requiredVotes.filter((vote) => vote.decision === 'unavailable').map((vote) => vote.model);
  const rejections = requiredVotes.filter((vote) => vote.decision === 'reject').map((vote) => vote.model);
  const quorum = quorumThresholdForAvailableModels(availableModels.length, opts);
  if (!quorum.ok) errors.push(quorum.reason);
  if (approvals.length < quorum.threshold) errors.push(`insufficient_approvals:${approvals.length}/${quorum.threshold}`);

  return {
    ok: errors.length === 0 && approvals.length >= quorum.threshold,
    threshold: quorum.threshold,
    quorumPolicy: quorum.reason,
    availableCount: availableModels.length,
    totalModels: requiredModels.length,
    approvedCount: approvals.length,
    approvals,
    availableModels,
    abstentions,
    unavailable,
    rejections,
    missingModels,
    errors,
    warnings,
    byModel,
  };
}

export function validateNoeConsensusLedger(ledger, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { ok: false, errors: ['ledger_must_be_object'], warnings, consensus: null };
  }

  if (!hasText(ledger.goal)) errors.push('ledger_goal_required');
  if (!hasText(ledger.evidenceRef)) errors.push('ledger_evidence_ref_required');

  const requiredModels = opts.requiredModels ? normalizeRequiredModels(opts.requiredModels) : normalizeRequiredModels(ledger.requiredModels);
  const consensus = evaluateNoeConsensusVotes(ledger.votes, { ...opts, requiredModels });
  errors.push(...consensus.errors);
  warnings.push(...consensus.warnings);

  const implementation = ledger.implementation || {};
  const executorValidation = validateNoeImplementationExecutor(implementation, {
    availability: ledger.executorAvailability || opts.executorAvailability || {},
  });
  errors.push(...executorValidation.errors);
  warnings.push(...executorValidation.warnings);
  const activeExecutor = executorValidation.activeExecutor || 'codex';
  const activeExecutorVote = consensus.byModel?.get(activeExecutor);
  if (activeExecutorVote && activeExecutorVote.decision === 'unavailable') {
    errors.push(`active_executor_unavailable:${activeExecutor}`);
  }
  if (activeExecutorVote && !APPROVAL_DECISIONS.has(activeExecutorVote.decision)) {
    errors.push(`active_executor_must_approve:${activeExecutor}`);
  }

  const boundaryIds = new Set(Array.isArray(ledger.boundaries) ? ledger.boundaries.map(boundaryId).filter(Boolean) : []);
  for (const id of NOE_REQUIRED_BOUNDARY_IDS) {
    if (id === 'codex_only_writer' && activeExecutor !== 'codex') continue;
    if (!boundaryIds.has(id)) errors.push(`missing_boundary:${id}`);
  }
  if (activeExecutor !== 'codex' && !boundaryIds.has('active_executor_single_writer')) {
    errors.push('missing_boundary:active_executor_single_writer');
  }

  for (const vote of consensus.byModel?.values?.() || []) {
    if (!hasText(vote.evidenceRef)) {
      errors.push(`missing_vote_evidence_ref:${vote.model}`);
    } else if (hasText(ledger.evidenceRef) && vote.evidenceRef !== ledger.evidenceRef) {
      errors.push(`evidence_ref_mismatch:${vote.model}`);
    }
    if (Array.isArray(vote.identityViolations) && vote.identityViolations.length) {
      for (const violation of vote.identityViolations) {
        errors.push(`identity_violation:${vote.model}:${violation}`);
      }
    }
    const rawConsensusVote = vote.consensusVote ?? vote.consensus_vote;
    const consensusVote = normalizeConsensusVote(rawConsensusVote);
    if (APPROVAL_DECISIONS.has(vote.decision)) {
      if (!hasText(rawConsensusVote)) errors.push(`consensus_vote_required:${vote.model}`);
      if (!YES_CONSENSUS.has(consensusVote)) errors.push(`consensus_vote_conflict:${vote.model}`);
      if (arrayHasText(vote.blockers)) errors.push(`approval_blockers_must_be_empty:${vote.model}`);
      if (!arrayHasText(vote.verificationRequired ?? vote.verification_required)) {
        errors.push(`approval_verification_required:${vote.model}`);
      }
      if (vote.decision === 'approve_with_changes' && !arrayHasText(vote.recommendedFirstSlice ?? vote.recommended_first_slice)) {
        errors.push(`approve_with_changes_first_slice_required:${vote.model}`);
      }
    } else if (YES_CONSENSUS.has(consensusVote)) {
      errors.push(`non_approval_consensus_vote_conflict:${vote.model}`);
    }
  }

  const codex = consensus.byModel?.get('codex');
  if (codex && activeExecutor !== 'codex' && codex.canWrite !== false) errors.push('codex_must_not_write_when_not_active_executor');
  if (codex && activeExecutor === 'codex' && codex.canWrite !== true) errors.push('codex_active_executor_must_write');

  const claude = consensus.byModel?.get('claude');
  if (claude && claude.firstClass !== true) errors.push('claude_vote_must_be_first_class');
  if (claude && activeExecutor === 'claude' && claude.canWrite !== true) errors.push('claude_active_executor_must_write');
  if (claude && activeExecutor !== 'claude' && claude.canWrite !== false) errors.push('claude_must_not_write');
  if (claude && activeExecutor !== 'claude' && !READONLY_AUTHORITIES.has(normalizeAuthority(claude.authority))) {
    errors.push('claude_authority_must_be_readonly');
  }

  const gemini = consensus.byModel?.get('gemini');
  if (gemini && gemini.canWrite !== false) errors.push('gemini_must_not_write');
  if (gemini && !READONLY_AUTHORITIES.has(normalizeAuthority(gemini.authority))) {
    errors.push('gemini_authority_must_be_advisory');
  }

  const m3 = consensus.byModel?.get('m3');
  if (m3 && m3.canWrite !== false) errors.push('m3_must_not_write');
  if (m3 && normalizeAuthority(m3.authority) !== 'suggestion_only') {
    errors.push('m3_authority_must_be_suggestion_only');
  }
  if (m3 && Array.isArray(m3.contentViolations) && m3.contentViolations.length) {
    for (const violation of m3.contentViolations) errors.push(`m3_content_violation:${violation}`);
  }

  const xiaomi = consensus.byModel?.get('xiaomi');
  if (xiaomi && xiaomi.canWrite !== false) errors.push('xiaomi_must_not_write');
  if (xiaomi && !READONLY_AUTHORITIES.has(normalizeAuthority(xiaomi.authority))) {
    errors.push('xiaomi_authority_must_be_advisory');
  }

  if (
    implementation.authorizationRequired !== true &&
    implementation.userOrConsensusAuthorizationRequired !== true &&
    implementation.userAuthorizationRequired !== true
  ) {
    errors.push('implementation_requires_authorization');
  }
  if (implementation.runtimeVerificationRequired !== true) errors.push('implementation_requires_runtime_verification');
  if (implementation.rollbackRequired !== true) errors.push('implementation_requires_rollback');
  if (implementation.memoryWritebackAckRequired !== true && implementation.memoryWritebackUserAckRequired !== true) {
    errors.push('implementation_requires_memory_writeback_ack');
  }
  if (implementation.stageMatrixRequired === true) {
    const matrixArtifact = Array.isArray(ledger.artifacts)
      ? ledger.artifacts.find((artifact) => artifact?.type === 'final_stage_matrix')
      : null;
    if (!matrixArtifact) {
      errors.push('stage_matrix_artifact_required');
    } else {
      if (matrixArtifact.ok !== true) errors.push(`stage_matrix_not_ok:${(matrixArtifact.errors || []).join('|') || 'unknown'}`);
      if (implementation.stageMatrixCompleteRequired === true && matrixArtifact.requireComplete !== true) {
        errors.push('stage_matrix_complete_required');
      }
    }
  }

  return {
    ok: consensus.ok && errors.length === 0,
    validated: consensus.ok && errors.length === 0,
    errors,
    warnings,
    consensus: {
      ok: consensus.ok,
      threshold: consensus.threshold,
      quorumPolicy: consensus.quorumPolicy,
      availableCount: consensus.availableCount,
      totalModels: consensus.totalModels,
      approvedCount: consensus.approvedCount,
      approvals: consensus.approvals,
      availableModels: consensus.availableModels,
      abstentions: consensus.abstentions,
      unavailable: consensus.unavailable,
      rejections: consensus.rejections,
      missingModels: consensus.missingModels,
    },
  };
}
