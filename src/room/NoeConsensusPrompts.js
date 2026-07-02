import { NOE_REQUIRED_BOUNDARY_IDS } from './NoeConsensusGate.js';
import { normalizeExecutionActorId } from './NoeExecutionAuthority.js';

export const NOE_CONSENSUS_MODELS = Object.freeze(['codex', 'claude', 'm3']);
export const CORE_ROUND_MODELS = 'Codex, Claude, M3';
export const NOE_CONSENSUS_M3_THINKING = Object.freeze({ type: 'adaptive' });
export const NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS = 524288;
export const NOE_CONSENSUS_M3_SERVICE_TIER = 'priority';

const QUALITY_PROFILES = new Set(['standard', 'exhaustive']);

function cleanString(value) {
  return String(value || '').trim();
}

export function participantAuthority(model, activeExecutor = 'codex') {
  if (model === activeExecutor) return 'active_executor';
  if (model === 'm3') return 'suggestion_only';
  if (model === 'claude') return 'readonly_source_reviewer';
  return 'advisory';
}

export function normalizeQualityProfile(value) {
  const profile = cleanString(value).toLowerCase();
  return QUALITY_PROFILES.has(profile) ? profile : 'exhaustive';
}

export function qualityInstructionLines(profile = 'exhaustive') {
  if (normalizeQualityProfile(profile) !== 'exhaustive') {
    return [
      'Quality profile: standard.',
      '- Review the evidence independently and return the required JSON shape.',
    ];
  }
  return [
    'Quality profile: exhaustive.',
    '- Token cost is not the limiting factor; spend the reasoning needed to reduce false approvals and stale claims.',
    '- Explicitly check scope, authorization, rollback, evidence freshness, secret/private_holdout boundaries, and live/runtime proof status.',
    '- Classify findings as P0/P1/P2 in blockers or recommended_first_slice when relevant.',
    '- Tie every major approval or rejection to a path, command output, ledger entry, or mark it evidence_gap.',
    '- Challenge policy/code mismatches: a written policy is not enough unless evaluator, tests, and runtime evidence enforce it.',
    '- For live 51835, sealed holdout, owner-token, or restart claims, require a fresh evidence pack from this stage; old proofs are stale unless re-probed.',
    '- Avoid duplicate work: focus on your role-specific blind spots and name the minimum next verification that would falsify the conclusion.',
  ];
}

export function buildNoeConsensusM3Options({ model = process.env.MINIMAX_MODEL || 'MiniMax-M3', qualityProfile = 'exhaustive' } = {}) {
  const configuredMax = Number(process.env.NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS || 0);
  const normalizedQualityProfile = normalizeQualityProfile(qualityProfile);
  const defaultMax = normalizedQualityProfile === 'exhaustive' ? NOE_CONSENSUS_M3_MAX_COMPLETION_TOKENS : 131072;
  const serviceTier = process.env.NOE_CONSENSUS_M3_SERVICE_TIER || (normalizedQualityProfile === 'exhaustive' ? NOE_CONSENSUS_M3_SERVICE_TIER : '');
  return {
    model,
    noAbort: true,
    maxCompletionTokens: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : defaultMax,
    reasoningSplit: true,
    thinking: { ...NOE_CONSENSUS_M3_THINKING },
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function boundariesForActiveExecutor(activeExecutor = 'codex', boundaries = null) {
  if (Array.isArray(boundaries) && boundaries.length) return boundaries;
  if (activeExecutor === 'codex') return undefined;
  return [...NOE_REQUIRED_BOUNDARY_IDS.filter((id) => id !== 'codex_only_writer'), 'active_executor_single_writer'];
}

export function buildNoeConsensusPrompt({ model, goal, evidenceRef, evidenceText, activeExecutor = 'codex', qualityProfile = 'exhaustive' }) {
  const normalizedModel = cleanString(model).toLowerCase();
  const executor = normalizeExecutionActorId(activeExecutor) || 'codex';
  const authority = participantAuthority(normalizedModel, executor);
  const canWrite = normalizedModel === executor;
  const normalizedQualityProfile = normalizeQualityProfile(qualityProfile);
  const firstClassLine = normalizedModel === 'claude' ? '"firstClass": true,' : '';
  const scopeLines = ['codex', 'claude', 'm3'].includes(normalizedModel)
    ? [
      `Core participants counted in this round: ${CORE_ROUND_MODELS}.`,
      '- Do not add, infer, or vote on behalf of participants outside that list.',
      '- Gemini is retired from the core quorum and must not be counted in new consensus rounds.',
    ]
    : [
      'This is an explicit non-core advisory profile.',
      `Core participants counted in the default round remain: ${CORE_ROUND_MODELS}.`,
      '- A non-core advisory participant must not be counted in quorum unless requiredModels explicitly includes it.',
    ];
  const m3ScopeLines = normalizedModel === 'm3'
    ? [
      '- M3 finding scope is limited to actionable_risk, evidence_gap, and product_language_issue.',
      '- M3 must not claim file reads, command execution, implementation authority, or final sign-off.',
    ]
    : [];
  return [
    'You are participating in the Noe online multi-model self-evolution consensus gate.',
    'Return one JSON object only. No Markdown, prose, tool calls, or follow-up questions.',
    'Do not edit files. Do not run commands. Do not expose secret values.',
    'Use the provided evidence only. If the evidence is insufficient, choose abstain or unavailable.',
    'You are not being asked to rubber-stamp approval. Do not assume approve or consensus_vote=yes.',
    '',
    `model: ${normalizedModel}`,
    `authority: ${authority}`,
    `canWrite: ${canWrite}`,
    `evidenceRef: ${evidenceRef}`,
    '',
    ...scopeLines,
    ...m3ScopeLines,
    '',
    ...qualityInstructionLines(normalizedQualityProfile),
    '',
    'Required JSON shape:',
    '{',
    `  "model": "${normalizedModel}",`,
    '  "decision": "approve|approve_with_changes|reject|abstain|unavailable",',
    '  "confidence": 0.0,',
    `  "authority": "${authority}",`,
    `  "canWrite": ${canWrite},`,
    firstClassLine,
    '  "blockers": [],',
    '  "recommended_first_slice": [],',
    '  "verification_required": [],',
    '  "consensus_vote": "yes|no|abstain"',
    '}',
    '',
    'Decision rules:',
    '- Choose the decision independently from the evidence; never copy another participant or a requested outcome.',
    '- approve means the current goal or claim is supported and can proceed without known blockers.',
    '- approve_with_changes means a first safe repair or implementation slice can proceed; put contained actions in recommended_first_slice and keep blockers empty for a yes vote.',
    '- reject means this model does not authorize the current goal or claim; use consensus_vote=no.',
    '- abstain means evidence is insufficient or outside your scope; use consensus_vote=abstain.',
    '- unavailable means you could not make an independent judgment due model/tool/policy failure; use consensus_vote=abstain.',
    '- For health audits, failed live verification is a valid reason to reject a full-health claim while still recommending repair slices.',
    '- For repair-plan gates, approve_with_changes is valid only when the first slice is safe and verifiable.',
    '- If decision is approve or approve_with_changes, consensus_vote must be yes.',
    '- If consensus_vote is yes, blockers must be empty; use recommended_first_slice and verification_required for follow-up work.',
    '- If you cannot independently support consensus_vote=yes, set decision to reject or abstain instead of approve.',
    `- Active executor for this round: ${executor}. Exactly one model may write or integrate.`,
    '- Claude must be first-class and independent.',
    '- M3 is suggestion-only and must not write files or run commands.',
    '- Codex is the default active executor, but a user-selected active executor such as Claude may replace Codex when Codex is unavailable or out of quota.',
    '- If a model is unavailable or out of quota, Codex may provide an automatic supplemental fallback review, but that fallback must be recorded as Codex evidence and must not be counted as the unavailable model vote.',
    '- No artificial model timeout.',
    '- 51735 is reserved; live 51835 restart/kill/port takeover requires user confirmation or explicit dynamic quorum consensus.',
    '- Dynamic quorum policy: 3 available required models need 2 approvals, 2 available need 2 approvals, fewer than 2 available stops.',
    '- Delete/upload/external publish/secret access/restart/kill-process actions require explicit dynamic quorum consensus; system-level operations remain outside model-vote authorization.',
    '- Runtime verification, rollback, and consensus-approved memory writeback are required.',
    '',
    '# Goal',
    goal,
    '',
    '# Evidence',
    evidenceText,
  ].filter((line) => line !== '').join('\n');
}

export function buildNoeConsensusBrief({ goal, evidenceText, activeExecutor = 'codex', qualityProfile = 'exhaustive' }) {
  const executor = normalizeExecutionActorId(activeExecutor) || 'codex';
  const normalizedQualityProfile = normalizeQualityProfile(qualityProfile);
  return [
    '# Noe Online Multi-Model Consensus Evidence',
    '',
    '## Goal',
    goal,
    '',
    '## Hard Boundaries',
    `- Active executor for this round: ${executor}; exactly one writer/integrator is allowed.`,
    '- Codex remains the default writer/integrator/final verifier when no explicit executor switch is selected.',
    '- Claude may be active executor only when explicitly selected by the user or validated consensus; otherwise Claude is readonly reviewer.',
    '- Claude first-class readonly reviewer.',
    '- M3 suggestion-only.',
    `- Core participants counted in this round: ${CORE_ROUND_MODELS}.`,
    '- Do not add non-participant models to quorum, approvals, or blockers.',
    '- Gemini is retired from the core quorum and must not be counted in new consensus rounds.',
    '- If a model is unavailable or out of quota, Codex may provide an automatic supplemental fallback review; it must not be counted as that model vote.',
    '- No artificial model timeout.',
    '- Do not touch 51735; live 51835 restart/kill/port takeover requires user confirmation or explicit dynamic quorum consensus.',
    '- Dynamic quorum policy: 3 available required models need 2 approvals, 2 available need 2 approvals, fewer than 2 available stops.',
    '- Secret access/use requires explicit dynamic quorum consensus; secret values must stay out of prompts, raw outputs, ledgers, and docs.',
    '- Delete/upload/external publish/restart/kill-process actions require explicit dynamic quorum consensus; system-level operations remain outside model-vote authorization.',
    '- Runtime verification, rollback, and consensus-approved memory writeback are required.',
    '',
    '## Quality Profile',
    ...qualityInstructionLines(normalizedQualityProfile),
    '',
    '## Evidence',
    evidenceText,
  ].join('\n');
}
