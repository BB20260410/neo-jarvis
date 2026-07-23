import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNoeConsensusLedger,
  writeNoeConsensusLedgerFile,
} from '../../src/room/NoeConsensusLedger.js';
import {
  validateNoeSelfEvolutionCycle,
} from '../../src/room/NoeSelfEvolutionCycle.js';

function vote(model, evidenceRef, rawOutputRef) {
  return {
    model,
    decision: 'approve_with_changes',
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: 'yes',
    recommendedFirstSlice: ['first safe slice'],
    verificationRequired: ['focused verification'],
    rawOutputRef,
    evidenceRef,
  };
}

function voteForActiveExecutor(model, activeExecutor, evidenceRef, rawOutputRef) {
  const isActive = model === activeExecutor;
  return {
    ...vote(model, evidenceRef, rawOutputRef),
    authority: isActive ? 'active_executor' : model === 'm3' ? 'suggestion_only' : 'advisory',
    canWrite: isActive,
  };
}

function cycleLedger(overrides = {}) {
  const evidenceRef = 'output/noe-multimodel/cycle-a/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'cycle-a',
    goal: 'Noe self-evolution evidence cycle',
    evidenceRef,
    votes: [
      vote('codex', evidenceRef, 'output/noe-multimodel/cycle-a/codex.txt'),
      vote('claude', evidenceRef, 'output/noe-multimodel/cycle-a/claude.txt'),
      vote('m3', evidenceRef, 'output/noe-multimodel/cycle-a/m3.txt'),
    ],
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
    ...overrides,
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function claudeExecutorLedger() {
  const evidenceRef = 'output/noe-multimodel/cycle-a/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'cycle-a',
    goal: 'Noe self-evolution evidence cycle',
    evidenceRef,
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
      voteForActiveExecutor('codex', 'claude', evidenceRef, 'output/noe-multimodel/cycle-a/codex.txt'),
      voteForActiveExecutor('claude', 'claude', evidenceRef, 'output/noe-multimodel/cycle-a/claude.txt'),
      voteForActiveExecutor('m3', 'claude', evidenceRef, 'output/noe-multimodel/cycle-a/m3.txt'),
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
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function baseCycle(overrides = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle-a',
    createdAt: '2026-06-07T00:00:00.000Z',
    goal: 'Noe self-evolution evidence cycle',
    ledger: cycleLedger(),
    authorization: {
      consensusApproved: true,
      scope: 'cycle evidence',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/cycle-a/rollback.md' },
    implementation: {
      done: true,
      writer: 'codex',
      diffRef: 'output/noe-multimodel/cycle-a/diff.patch',
      touchedFiles: ['src/room/NoeSelfEvolutionCycle.js'],
    },
    runtimeVerification: {
      ok: true,
      reportRef: 'output/noe-full-current/full-current-pass.json',
    },
    postReview: {
      ok: true,
      reviews: [
        {
          model: 'claude',
          decision: 'approve',
          authority: 'readonly_source_reviewer',
          canWrite: false,
          rawOutputRef: 'output/noe-multimodel/cycle-a/claude-post-review.txt',
        },
        {
          model: 'm3',
          decision: 'approve',
          authority: 'suggestion_only',
          canWrite: false,
          rawOutputRef: 'output/noe-multimodel/cycle-a/m3-post-review.txt',
        },
      ],
    },
    retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    memoryWriteback: {
      done: true,
      consensusAck: true,
      summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
    },
    ...overrides,
  };
}

const REVIEW_MODELS = ['claude', 'm3'];

function combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];
  const out = [];
  for (let i = start; i < items.length; i += 1) {
    out.push(...combinations(items, size, i + 1, [...prefix, items[i]]));
  }
  return out;
}

function review(model, decision = 'approve') {
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef: `output/noe-multimodel/cycle-a/${model}-post-review.txt`,
  };
}

function postReviews({ unavailable = [], approvals = [] } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return REVIEW_MODELS.map((model) => {
    if (unavailableSet.has(model)) return review(model, 'unavailable');
    return review(model, approvalSet.has(model) ? 'approve' : 'reject');
  });
}

function makeFileBackedCycle() {
  const root = mkdtempSync(join(tmpdir(), 'noe-self-evolution-cycle-'));
  const roundDir = join(root, 'output/noe-multimodel/cycle-a');
  mkdirSync(roundDir, { recursive: true });
  mkdirSync(join(root, 'output/noe-full-current'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  const evidenceRef = 'output/noe-multimodel/cycle-a/brief.md';
  writeFileSync(join(root, evidenceRef), 'brief\n');
  for (const model of ['codex', 'claude', 'm3']) {
    writeFileSync(join(root, `output/noe-multimodel/cycle-a/${model}.txt`), `${model} raw\n`);
  }
  for (const ref of [
    'output/noe-multimodel/cycle-a/rollback.md',
    'output/noe-multimodel/cycle-a/diff.patch',
    'output/noe-multimodel/cycle-a/claude-post-review.txt',
    'output/noe-multimodel/cycle-a/m3-post-review.txt',
    'output/noe-full-current/full-current-pass.json',
    'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    'docs/HANDOFF_2026-06-06_codex交接.md',
  ]) writeFileSync(join(root, ref), `${ref}\n`);

  const ledger = cycleLedger();
  writeNoeConsensusLedgerFile(ledger, { root, outDir: 'output/noe-multimodel' });
  return {
    root,
    cycle: baseCycle({
      ledger: undefined,
      consensus: { ledgerRef: 'output/noe-multimodel/cycle-a/ledger.json' },
    }),
  };
}

describe('Noe self-evolution cycle', () => {
  it('accepts a complete evidence cycle with validated consensus and post-review raw output', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle());

    expect(result.ok).toBe(true);
    expect(result.loop.stage).toBe('complete');
    expect(result.gates.validatedConsensus).toBe(true);
  });

  it('accepts a complete cycle when Claude is the selected active executor', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      ledger: claudeExecutorLedger(),
      implementation: {
        done: true,
        writer: 'claude',
        activeExecutor: 'claude',
        executorSelection: { selectedBy: 'user', reason: 'codex_quota_unavailable' },
        diffRef: 'output/noe-multimodel/cycle-a/diff.patch',
        touchedFiles: ['src/room/NoeSelfEvolutionCycle.js'],
      },
      postReview: {
        ok: true,
          reviews: [
            review('codex', 'approve'),
            review('m3', 'approve'),
          ],
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.loop.stage).toBe('complete');
    expect(result.gates.implementation).toBe(true);
    expect(result.gates.postReview).toBe(true);
  });

  it('requires consensus ledger evidence, not only an ok-shaped gate', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      ledger: undefined,
      consensus: {
        gate: {
          ok: true,
          validated: true,
          source: 'validated_consensus_ledger',
          consensus: { approvedCount: 3, threshold: 2 },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_consensus_ledger_ref_required');
    expect(result.errors).toContain('cycle_consensus:consensus_ledger_artifact_required');
  });

  it('rejects a forged gate with a missing ledger file even when the shape says ok', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      ledger: undefined,
      consensus: {
        ledgerRef: 'output/noe-multimodel/cycle-a/ledger.json',
        gate: {
          ok: true,
          validated: true,
          source: 'validated_consensus_ledger',
          consensus: { approvedCount: 3, threshold: 2 },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_consensus:missing_consensus_ledger_file:output/noe-multimodel/cycle-a/ledger.json');
    expect(result.errors).toContain('cycle_consensus_validated_ledger_required');
    expect(result.errors).toContain('cycle_loop_not_complete:consensus_blocked');
    expect(result.errors).toContain('cycle_loop:validated_consensus_ledger_required');
    expect(result.errors).toContain('cycle_loop:user_or_consensus_authorization_required');
  });

  it('requires implementation evidence from Codex', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      implementation: { done: true, writer: 'codex' },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_implementation_evidence_required');
  });

  it('requires a non-implementer post-review with raw output evidence', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      postReview: { ok: true, approvals: 1 },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_post_review_missing_required_reviewer:claude');
    expect(result.errors).toContain('cycle_post_review_missing_required_reviewer:m3');
    expect(result.errors).toContain('cycle_post_review_insufficient_available_models:0');
  });

  it('requires dynamic quorum across required non-implementer post-review models', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      postReview: {
        ok: true,
        reviews: [
          {
            model: 'claude',
            decision: 'approve',
            authority: 'readonly_source_reviewer',
            canWrite: false,
            rawOutputRef: 'output/noe-multimodel/cycle-a/claude-post-review.txt',
          },
          {
            model: 'm3',
            decision: 'reject',
            authority: 'suggestion_only',
            canWrite: false,
            rawOutputRef: 'output/noe-multimodel/cycle-a/m3-post-review.txt',
          },
          {
            model: 'external-reviewer',
            decision: 'approve',
            authority: 'advisory',
            canWrite: false,
            rawOutputRef: 'output/noe-multimodel/cycle-a/external-post-review.txt',
          },
        ],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_post_review_dynamic_quorum_required:1/2');
  });

  it('rejects every single unavailable required post-review model because only one reviewer remains', () => {
    for (const unavailable of REVIEW_MODELS) {
      const available = REVIEW_MODELS.filter((model) => model !== unavailable);
      const result = validateNoeSelfEvolutionCycle(baseCycle({
        postReview: {
          ok: true,
          reviews: postReviews({ unavailable: [unavailable], approvals: available }),
        },
      }));

      expect(result.ok, `unavailable=${unavailable}`).toBe(false);
      expect(result.errors, `unavailable=${unavailable}`).toContain('cycle_post_review_insufficient_available_models:1');
    }
  });

  it('rejects every two-model unavailable post-review combination because no reviewer remains', () => {
    for (const unavailable of combinations(REVIEW_MODELS, 2)) {
      const available = REVIEW_MODELS.filter((model) => !unavailable.includes(model));
      const result = validateNoeSelfEvolutionCycle(baseCycle({
        postReview: {
          ok: true,
          reviews: postReviews({ unavailable, approvals: available }),
        },
      }));

      expect(result.ok, `unavailable=${unavailable.join(',')}`).toBe(false);
      expect(result.errors, `unavailable=${unavailable.join(',')}`).toContain('cycle_post_review_insufficient_available_models:0');
    }
  });

  it('requires both available post-review models to approve', () => {
    const pass = validateNoeSelfEvolutionCycle(baseCycle({
      postReview: {
        ok: true,
        reviews: postReviews({ approvals: REVIEW_MODELS }),
      },
    }));
    expect(pass.ok).toBe(true);

    for (const rejected of REVIEW_MODELS) {
      const approvals = REVIEW_MODELS.filter((model) => model !== rejected);
      const fail = validateNoeSelfEvolutionCycle(baseCycle({
        postReview: {
          ok: true,
          reviews: postReviews({ approvals }),
        },
      }));

      expect(fail.ok, `rejected=${rejected}`).toBe(false);
      expect(fail.errors, `rejected=${rejected}`).toContain('cycle_post_review_dynamic_quorum_required:1/2');
    }
  });

  it('requires unavailable post-review votes to carry raw output evidence', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      postReview: {
        ok: true,
        reviews: [
          {
            model: 'claude',
            decision: 'approve',
            authority: 'readonly_source_reviewer',
            canWrite: false,
            rawOutputRef: 'output/noe-multimodel/cycle-a/claude-post-review.txt',
          },
          {
            model: 'm3',
            decision: 'unavailable',
            authority: 'suggestion_only',
            canWrite: false,
            rawOutputRef: '',
          },
        ],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_post_review_raw_output_ref:m3_required');
  });

  it('rejects duplicate required post-review reviewers instead of letting a later vote overwrite an earlier one', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      postReview: {
        ok: true,
        reviews: [
          review('claude', 'reject'),
          review('claude', 'approve'),
          review('m3', 'approve'),
        ],
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_post_review_duplicate_reviewer:claude');
  });

  it('requires memory writeback to be done before the cycle is complete', () => {
    const result = validateNoeSelfEvolutionCycle(baseCycle({
      memoryWriteback: {
        consensusAck: true,
        summaryRef: 'docs/HANDOFF_2026-06-06_codex交接.md',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('cycle_memory_writeback_done_required');
    expect(result.errors).toContain('cycle_loop_not_complete:memory_writeback_ready');
  });

  it('can validate a file-backed cycle and rejects missing referenced files', () => {
    const { root, cycle } = makeFileBackedCycle();
    try {
      const pass = validateNoeSelfEvolutionCycle(cycle, { root, requireReferencedFiles: true });
      expect(pass.ok).toBe(true);

      const fail = validateNoeSelfEvolutionCycle({
        ...cycle,
        runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/missing.json' },
      }, { root, requireReferencedFiles: true });
      expect(fail.ok).toBe(false);
      expect(fail.errors).toContain('missing_cycle_runtime_report_ref:output/noe-full-current/missing.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
