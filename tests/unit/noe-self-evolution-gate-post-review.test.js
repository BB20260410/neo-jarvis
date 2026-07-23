// @ts-check
// Task 0.6 收口专项测试：自进化 Gate 的 complete 复核（post-review）必须与 cycle 层对齐，
// 以及内联 ledger 必须要求引用证据文件真实存在（非 dry-run）。
// 从 noe-self-evolution-gate.test.js 拆出，保持单文件 <500 行。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateNoeSelfEvolutionGate } from '../../src/room/NoeSelfEvolutionGate.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';

function vote(model, evidenceRef, extra = {}) {
  const decision = extra.decision || 'approve_with_changes';
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    consensusVote: approval ? 'yes' : 'abstain',
    recommendedFirstSlice: decision === 'approve_with_changes' ? ['first safe slice'] : [],
    verificationRequired: approval ? ['focused verification'] : [],
    rawOutputRef: `output/noe-multimodel/round/${model}.txt`,
    evidenceRef,
    ...extra,
  };
}

function passedLedger() {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution gate',
    evidenceRef,
    votes: ['codex', 'claude', 'm3'].map((model) => vote(model, evidenceRef)),
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

function writeLedgerReferencedFiles(root) {
  const roundDir = join(root, 'output/noe-multimodel/round');
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(root, 'output/noe-multimodel/round/brief.md'), 'consensus brief\n');
  for (const model of ['codex', 'claude', 'm3']) {
    writeFileSync(join(root, `output/noe-multimodel/round/${model}.txt`), `${model} raw output\n`);
  }
}

function baseInput(action = 'implementation') {
  return {
    action,
    dryRun: true,
    ledger: passedLedger(),
    authorization: {
      userApproved: true,
      scope: 'consensus first slice',
      costClass: 'local_or_user_approved_model_calls',
    },
    rollback: { planRef: 'output/noe-multimodel/round/rollback.md' },
  };
}

function postReview(model, decision = 'approve', extra = {}) {
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : 'readonly_source_reviewer',
    canWrite: false,
    rawOutputRef: `output/noe-multimodel/round/${model}-post-review.txt`,
    ...extra,
  };
}

// codex 是 active executor，则必需 reviewer = claude/m3。
// 默认 claude+m3 approve = 动态 quorum 2/2 通过。
function validPostReviews({ unavailable = [], approvals = ['claude', 'm3'], extraByModel = {} } = {}) {
  const unavailableSet = new Set(unavailable);
  const approvalSet = new Set(approvals);
  return ['claude', 'm3'].map((model) => {
    const extra = extraByModel[model] || {};
    if (unavailableSet.has(model)) return postReview(model, 'unavailable', extra);
    return postReview(model, approvalSet.has(model) ? 'approve' : 'reject', extra);
  });
}

function completeBase(extra = {}) {
  return {
    ...baseInput('complete'),
    runtimeVerification: { ok: true, reportRef: 'output/noe-full-current/pass.json' },
    retrospectiveRef: 'docs/Noe四模型协作复盘与改进计划_2026-06-07.md',
    memoryWriteback: { consensusAck: true, summaryRef: 'docs/HANDOFF.md' },
    ...extra,
  };
}

describe('Noe self evolution gate — complete post-review alignment', () => {
  it('blocks completion when post-review only claims ok+approvals without real non-implementer reviews', () => {
    // codex review 指出的授权绕过：complete 只凭 {ok:true, approvals:1}
    // 不带真实非实施者 reviewer / rawOutputRef / 动态 quorum 就放行。
    const result = evaluateNoeSelfEvolutionGate(completeBase({ postReview: { ok: true, approvals: 1 } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_missing_required_reviewer:claude');
    expect(result.errors).toContain('post_review_missing_required_reviewer:m3');
    expect(result.errors).toContain('post_review_insufficient_available_models:0');
  });

  it('blocks completion when the active executor reviews itself instead of independent models', () => {
    const result = evaluateNoeSelfEvolutionGate(completeBase({
      postReview: { ok: true, reviews: [postReview('codex', 'approve', { canWrite: true })] },
    }));

    expect(result.ok).toBe(false);
    // codex 是 active executor，其自评被剔除 => 必需 reviewer 全缺
    expect(result.errors).toContain('post_review_missing_required_reviewer:claude');
    expect(result.errors).toContain('post_review_insufficient_available_models:0');
  });

  it('blocks completion when post-review approvals fall below the dynamic quorum', () => {
    const result = evaluateNoeSelfEvolutionGate(completeBase({
      // m3 不可用时只剩 claude 一个真实复核，无法满足最低两方 quorum。
      postReview: { ok: true, reviews: validPostReviews({ unavailable: ['m3'], approvals: ['claude'] }) },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_dynamic_quorum_required:1/2');
  });

  it('blocks completion when a non-implementer reviewer is missing its raw output reference', () => {
    const result = evaluateNoeSelfEvolutionGate(completeBase({
      postReview: { ok: true, reviews: validPostReviews({ extraByModel: { m3: { rawOutputRef: '' } } }) },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_raw_output_ref:m3_required');
  });

  it('blocks completion when a non-implementer reviewer claims write access', () => {
    const result = evaluateNoeSelfEvolutionGate(completeBase({
      postReview: { ok: true, reviews: validPostReviews({ extraByModel: { claude: { canWrite: true } } }) },
    }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_non_implementer_must_not_write:claude');
  });

  it('blocks completion when a reviewer is duplicated', () => {
    const reviews = validPostReviews();
    reviews.push(postReview('claude', 'approve'));
    const result = evaluateNoeSelfEvolutionGate(completeBase({ postReview: { ok: true, reviews } }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('post_review_duplicate_reviewer:claude');
  });

  it('allows completion with an independent post-review quorum, retrospective, and memory ack', () => {
    const result = evaluateNoeSelfEvolutionGate(completeBase({ postReview: { ok: true, reviews: validPostReviews() } }));

    expect(result.ok).toBe(true);
    expect(result.gates.postReview).toBe(true);
    expect(result.gates.retrospective).toBe(true);
  });

  it('requires post-review raw output files to exist when not dry-run', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-self-evolution-gate-postreview-'));
    try {
      writeLedgerReferencedFiles(root);
      // 内联 ledger 文件已写，但复核 rawOutputRef 文件未写 => 非 dry-run 应被卡
      const result = evaluateNoeSelfEvolutionGate(completeBase({
        dryRun: false,
        root,
        authorization: { userApproved: false, consensusApproved: true, scope: 'file-backed', costClass: 'local_or_user_approved_model_calls' },
        postReview: { ok: true, reviews: validPostReviews() },
      }));

      expect(result.ok).toBe(false);
      // claude/m3 的 rawOutputRef 文件不存在 => missing_post_review_raw_output_ref:<model>:<path>
      expect(result.errors).toContain('missing_post_review_raw_output_ref:claude:output/noe-multimodel/round/claude-post-review.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Noe self evolution gate — inline ledger file existence', () => {
  it('blocks inline ledger objects whose evidence/raw files do not exist unless dry-run', () => {
    // :82 收口：内联 ledger 不能仅凭结构有效 + consensusApproved=true 当 validated_consensus_ledger，
    // 非 dry-run 时必须让 evidenceRef / rawOutputRef 指向真实存在的文件。
    const input = baseInput();
    input.dryRun = false; // passedLedger() 引用的文件不在磁盘上
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus:missing_evidence_file:output/noe-multimodel/round/brief.md');
    expect(result.errors).toContain('consensus:missing_raw_output_file:codex:output/noe-multimodel/round/codex.txt');
    expect(result.errors).toContain('validated_consensus_ledger_required');
  });

  it('honors an explicit requireConsensusLedgerFiles flag to force inline ledger file existence over dry-run', () => {
    const input = baseInput(); // dryRun:true，但显式 requireConsensusLedgerFiles 必须压过
    input.requireConsensusLedgerFiles = true;
    input.authorization.userApproved = false;
    input.authorization.consensusApproved = true;
    const result = evaluateNoeSelfEvolutionGate(input);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus:missing_evidence_file:output/noe-multimodel/round/brief.md');
  });

  it('allows inline ledger objects when referenced evidence/raw files exist on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-self-evolution-gate-inline-'));
    try {
      writeLedgerReferencedFiles(root);
      const input = baseInput();
      input.dryRun = false;
      input.root = root;
      input.authorization.userApproved = false;
      input.authorization.consensusApproved = true;
      const result = evaluateNoeSelfEvolutionGate(input);

      expect(result.ok).toBe(true);
      expect(result.gates.consensusAuthorization).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
