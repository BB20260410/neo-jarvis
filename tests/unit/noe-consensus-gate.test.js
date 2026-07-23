import { describe, expect, it } from 'vitest';
import {
  evaluateNoeConsensusVotes,
  validateNoeConsensusLedger,
} from '../../src/room/NoeConsensusGate.js';

function vote(model, decision = 'approve_with_changes', extra = {}) {
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    rawOutputRef: `output/noe-multimodel/${model}.txt`,
    evidenceRef: 'docs/Noe自我进化闭环方案_2026-06-07.md',
    consensusVote: approval ? 'yes' : 'abstain',
    recommendedFirstSlice: decision === 'approve_with_changes' ? ['first safe slice'] : [],
    verificationRequired: approval ? ['focused verification'] : [],
    ...extra,
  };
}

function ledger(overrides = {}) {
  return {
    goal: 'Noe self evolution loop',
    evidenceRef: 'docs/Noe自我进化闭环方案_2026-06-07.md',
    boundaries: [
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
    ],
    votes: [
      vote('codex'),
      vote('claude'),
      vote('m3'),
    ],
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
    ...overrides,
  };
}

const REQUIRED_MODELS = ['codex', 'claude', 'm3'];
const ONLINE_REQUIRED_MODELS = ['codex', 'claude', 'm3', 'xiaomi'];

function combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];
  const out = [];
  for (let i = start; i < items.length; i += 1) {
    out.push(...combinations(items, size, i + 1, [...prefix, items[i]]));
  }
  return out;
}

function quorumVotes({ unavailable = [], approvals = [] } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return REQUIRED_MODELS.map((model) => {
    if (unavailableSet.has(model)) return vote(model, 'unavailable');
    return vote(model, approvalSet.has(model) ? 'approve' : 'reject');
  });
}

function quorumVotesFor(requiredModels, { unavailable = [], approvals = [] } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return requiredModels.map((model) => {
    if (unavailableSet.has(model)) return vote(model, 'unavailable');
    return vote(model, approvalSet.has(model) ? 'approve' : 'reject');
  });
}

describe('Noe consensus gate', () => {
  it('accepts a three-model ledger when at least two models approve', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex', 'approve_with_changes'),
        vote('claude', 'approve_with_changes'),
        vote('m3', 'reject'),
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.consensus.approvedCount).toBe(2);
    expect(result.consensus.rejections).toEqual(['m3']);
  });

  it('blocks if Claude is missing even when three other models approve', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing_required_model:claude');
  });

  it('requires both available models to approve when one core model is unavailable', () => {
    const result = evaluateNoeConsensusVotes([
      vote('codex', 'approve'),
      vote('claude', 'approve_with_changes'),
      vote('m3', 'unavailable'),
    ]);

    expect(result.ok).toBe(true);
    expect(result.threshold).toBe(2);
    expect(result.availableCount).toBe(2);
    expect(result.approvedCount).toBe(2);
    expect(result.abstentions).toEqual([]);
    expect(result.unavailable).toEqual(['m3']);
  });

  it('applies dynamic quorum for every single-model unavailable combination', () => {
    for (const unavailable of REQUIRED_MODELS) {
      const available = REQUIRED_MODELS.filter((model) => model !== unavailable);
      const result = evaluateNoeConsensusVotes(quorumVotes({
        unavailable: [unavailable],
        approvals: available.slice(0, 2),
      }));

      expect(result.ok, `unavailable=${unavailable}`).toBe(true);
      expect(result.threshold, `unavailable=${unavailable}`).toBe(2);
      expect(result.availableCount, `unavailable=${unavailable}`).toBe(2);
      expect(result.approvedCount, `unavailable=${unavailable}`).toBe(2);
      expect(result.unavailable, `unavailable=${unavailable}`).toEqual([unavailable]);
    }
  });

  it('supports Xiaomi MiMo as an advisory required participant in explicit online four-model ledgers', () => {
    const result = validateNoeConsensusLedger(ledger({
      requiredModels: ONLINE_REQUIRED_MODELS,
      votes: [
        vote('codex', 'approve'),
        vote('claude', 'approve_with_changes'),
        vote('m3', 'approve_with_changes'),
        vote('xiaomi', 'reject'),
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.consensus.totalModels).toBe(4);
    expect(result.consensus.availableCount).toBe(4);
    expect(result.consensus.threshold).toBe(3);
    expect(result.consensus.approvedCount).toBe(3);
    expect(result.consensus.rejections).toEqual(['xiaomi']);
  });

  it('applies dynamic quorum across all explicit online four-model unavailable combinations', () => {
    for (const unavailable of combinations(ONLINE_REQUIRED_MODELS, 1)) {
      const available = ONLINE_REQUIRED_MODELS.filter((model) => !unavailable.includes(model));
      const result = evaluateNoeConsensusVotes(quorumVotesFor(ONLINE_REQUIRED_MODELS, {
        unavailable,
        approvals: available.slice(0, 2),
      }), { requiredModels: ONLINE_REQUIRED_MODELS });

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(true);
      expect(result.threshold, `unavailable=${unavailable.join(',')}`).toBe(2);
      expect(result.availableCount, `unavailable=${unavailable.join(',')}`).toBe(3);
      expect(result.approvedCount, `unavailable=${unavailable.join(',')}`).toBe(2);
    }

    for (const unavailable of combinations(ONLINE_REQUIRED_MODELS, 2)) {
      const available = ONLINE_REQUIRED_MODELS.filter((model) => !unavailable.includes(model));
      const result = evaluateNoeConsensusVotes(quorumVotesFor(ONLINE_REQUIRED_MODELS, {
        unavailable,
        approvals: available.slice(0, 2),
      }), { requiredModels: ONLINE_REQUIRED_MODELS });

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(true);
      expect(result.threshold, `unavailable=${unavailable.join(',')}`).toBe(2);
      expect(result.availableCount, `unavailable=${unavailable.join(',')}`).toBe(2);
      expect(result.approvedCount, `unavailable=${unavailable.join(',')}`).toBe(2);
    }

    for (const unavailable of combinations(ONLINE_REQUIRED_MODELS, 3)) {
      const available = ONLINE_REQUIRED_MODELS.filter((model) => !unavailable.includes(model));
      const result = evaluateNoeConsensusVotes(quorumVotesFor(ONLINE_REQUIRED_MODELS, {
        unavailable,
        approvals: available,
      }), { requiredModels: ONLINE_REQUIRED_MODELS });

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(false);
      expect(result.availableCount, `unavailable=${unavailable.join(',')}`).toBe(1);
      expect(result.errors, `unavailable=${unavailable.join(',')}`).toContain('insufficient_available_models:1');
    }
  });

  it('requires both remaining models to agree when only two models are available', () => {
    const passed = evaluateNoeConsensusVotes([
      vote('codex', 'approve'),
      vote('claude', 'approve_with_changes'),
      vote('m3', 'unavailable'),
    ]);
    const failed = evaluateNoeConsensusVotes([
      vote('codex', 'approve'),
      vote('claude', 'reject'),
      vote('m3', 'unavailable'),
    ]);

    expect(passed.ok).toBe(true);
    expect(passed.threshold).toBe(2);
    expect(passed.availableCount).toBe(2);
    expect(failed.ok).toBe(false);
    expect(failed.errors).toContain('insufficient_approvals:1/2');
  });

  it('stops for every two-model unavailable combination because only one core model remains', () => {
    for (const unavailable of combinations(REQUIRED_MODELS, 2)) {
      const available = REQUIRED_MODELS.filter((model) => !unavailable.includes(model));
      const result = evaluateNoeConsensusVotes(quorumVotes({
        unavailable,
        approvals: available,
      }));

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(false);
      expect(result.availableCount, `unavailable=${unavailable.join(',')}`).toBe(1);
      expect(result.errors, `unavailable=${unavailable.join(',')}`).toContain('insufficient_available_models:1');
    }
  });

  it('does not count non-required model approvals toward dynamic quorum', () => {
    const result = evaluateNoeConsensusVotes([
      vote('codex', 'approve'),
      vote('claude', 'reject'),
      vote('m3', 'unavailable'),
      vote('external-reviewer', 'approve', { authority: 'advisory', canWrite: false }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.threshold).toBe(2);
    expect(result.availableCount).toBe(2);
    expect(result.approvedCount).toBe(1);
    expect(result.approvals).toEqual(['codex']);
    expect(result.errors).toContain('insufficient_approvals:1/2');
  });

  it('stops when fewer than two models are available', () => {
    const result = evaluateNoeConsensusVotes([
      vote('codex', 'approve'),
      vote('claude', 'unavailable'),
      vote('m3', 'unavailable'),
    ]);

    expect(result.ok).toBe(false);
    expect(result.availableCount).toBe(1);
    expect(result.errors).toContain('insufficient_available_models:1');
  });

  it('stops when every core model is unavailable', () => {
    for (const unavailable of combinations(REQUIRED_MODELS, 3)) {
      const available = REQUIRED_MODELS.filter((model) => !unavailable.includes(model));
      const result = evaluateNoeConsensusVotes(quorumVotes({
        unavailable,
        approvals: available,
      }));

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(false);
      expect(result.availableCount, `unavailable=${unavailable.join(',')}`).toBe(0);
      expect(result.errors, `unavailable=${unavailable.join(',')}`).toContain('insufficient_available_models:0');
    }
  });

  it('requires raw model output references for auditability', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve', { rawOutputRef: '' }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing_raw_output_ref:claude');
  });

  it('requires every model to vote against the same evidence reference', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve', { evidenceRef: 'output/noe-multimodel/other-brief.md' }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('evidence_ref_mismatch:claude');
  });

  it('allows one required model to be unavailable when the other two core models approve', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude'),
        vote('m3', 'unavailable'),
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.consensus.threshold).toBe(2);
    expect(result.consensus.availableCount).toBe(2);
    expect(result.consensus.unavailable).toEqual(['m3']);
  });

  it('blocks approve decisions that conflict with consensus_vote', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve', { consensusVote: 'no' }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus_vote_conflict:claude');
  });

  it('requires approve decisions to carry an explicit consensus_vote', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve', { consensusVote: '' }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus_vote_required:claude');
  });

  it('requires approval votes to carry verification requirements', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve', { verificationRequired: [] }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('approval_verification_required:claude');
  });

  it('blocks approval votes that still carry blockers', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve_with_changes', { blockers: ['must fix before proceeding'] }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('approval_blockers_must_be_empty:claude');
  });

  it('requires approve_with_changes votes to carry a first safe slice', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'approve_with_changes', { recommendedFirstSlice: [] }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('approve_with_changes_first_slice_required:claude');
  });

  it('blocks non-approval decisions that still claim consensus yes', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude', 'reject', { consensusVote: 'yes' }),
        vote('m3'),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('non_approval_consensus_vote_conflict:claude');
  });

  it('blocks M3 write authority', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude'),
        vote('m3', 'approve', { authority: 'writer', canWrite: true }),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('m3_must_not_write');
    expect(result.errors).toContain('m3_authority_must_be_suggestion_only');
  });

  it('blocks M3 content-level execution artifacts', () => {
    const result = validateNoeConsensusLedger(ledger({
      votes: [
        vote('codex'),
        vote('claude'),
        vote('m3', 'approve', { contentViolations: ['commands', 'diffs'] }),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('m3_content_violation:commands');
    expect(result.errors).toContain('m3_content_violation:diffs');
  });

  it('blocks Xiaomi MiMo write authority', () => {
    const result = validateNoeConsensusLedger(ledger({
      requiredModels: ONLINE_REQUIRED_MODELS,
      votes: [
        vote('codex'),
        vote('claude'),
        vote('m3'),
        vote('xiaomi', 'approve', { authority: 'writer', canWrite: true }),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('xiaomi_must_not_write');
    expect(result.errors).toContain('xiaomi_authority_must_be_advisory');
  });

  it('requires rollback and consensus-approved memory writeback before implementation', () => {
    const result = validateNoeConsensusLedger(ledger({
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: false,
        memoryWritebackAckRequired: false,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('implementation_requires_rollback');
    expect(result.errors).toContain('implementation_requires_memory_writeback_ack');
  });
});
