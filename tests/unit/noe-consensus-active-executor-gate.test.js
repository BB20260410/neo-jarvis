import { describe, expect, it } from 'vitest';
import { validateNoeConsensusLedger } from '../../src/room/NoeConsensusGate.js';

function vote(model, activeExecutor, decision = 'approve_with_changes', extra = {}) {
  const isActive = model === activeExecutor;
  return {
    model,
    decision,
    authority: isActive ? 'active_executor' : model === 'm3' ? 'suggestion_only' : 'advisory',
    canWrite: isActive,
    firstClass: model === 'claude' ? true : undefined,
    rawOutputRef: `output/noe-multimodel/${model}.txt`,
    evidenceRef: 'docs/Noe自我进化闭环方案_2026-06-07.md',
    consensusVote: 'yes',
    recommendedFirstSlice: ['active executor first slice'],
    verificationRequired: ['verify active executor ledger'],
    ...extra,
  };
}

function claudeExecutorLedger(overrides = {}) {
  return {
    goal: 'Noe self evolution loop',
    evidenceRef: 'docs/Noe自我进化闭环方案_2026-06-07.md',
    boundaries: [
      'claude_first_class',
      'active_executor_single_writer',
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
    ],
    votes: [
      vote('codex', 'claude', 'approve'),
      vote('claude', 'claude', 'approve_with_changes'),
      vote('m3', 'claude', 'approve_with_changes'),
    ],
    implementation: {
      writer: 'claude',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'codex_quota_unavailable' },
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
    ...overrides,
  };
}

describe('Noe consensus active executor gate', () => {
  it('allows Claude to be the selected active executor when Codex is not writer', () => {
    const result = validateNoeConsensusLedger(claudeExecutorLedger());

    expect(result.ok).toBe(true);
    expect(result.consensus.approvedCount).toBe(3);
  });

  it('blocks Claude executor ledgers without explicit selection and single-writer boundary', () => {
    const result = validateNoeConsensusLedger(claudeExecutorLedger({
      boundaries: ['claude_first_class'],
      implementation: {
        writer: 'claude',
        activeExecutor: 'claude',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('active_executor_requires_explicit_selection:claude');
    expect(result.errors).toContain('missing_boundary:active_executor_single_writer');
  });

  it('blocks a ledger when the selected active executor abstains', () => {
    const result = validateNoeConsensusLedger(claudeExecutorLedger({
      votes: [
        vote('codex', 'claude', 'approve'),
        vote('claude', 'claude', 'abstain', {
          consensusVote: 'abstain',
          recommendedFirstSlice: [],
          verificationRequired: ['active executor needs more evidence'],
        }),
        vote('m3', 'claude', 'approve_with_changes'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('active_executor_must_approve:claude');
  });
});
